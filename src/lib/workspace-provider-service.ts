import { Prisma, type AiProviderConnectionStatus, type AiProviderKind, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessUser } from "@/lib/access-control";
import { assertActiveMembership, getMembershipStatus, lockMembershipUser } from "@/lib/ai-entitlements";
import { createCredential, rotateCredential } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { getProviderDefinition, isSafeModelId } from "@/lib/ai-providers";
import { testProviderConnection } from "@/lib/ai-providers/service";
import { PROVIDER_CONNECTION_TEST_TRANSACTION_TIMEOUT_MS } from "@/lib/ai-providers/transport";

export type WorkspaceProviderServiceErrorCode =
  | "AI_PROVIDER_INVALID_INPUT"
  | "AI_PROVIDER_NOT_FOUND"
  | "AI_PROVIDER_NAME_CONFLICT"
  | "AI_PROVIDER_IN_USE"
  | "AI_PROVIDER_DELETE_REQUIRES_DISABLED"
  | "AI_PROVIDER_CONFIRMATION_MISMATCH"
  | "AI_PROVIDER_SCOPE_FORBIDDEN"
  | "AI_PROVIDER_OWNER_REQUIRED"
  | "AI_MEMBERSHIP_REQUIRED"
  | "AI_MEMBERSHIP_EXPIRED"
  | "AI_PROVIDER_CONNECTION_UNAVAILABLE"
  | "AI_PROVIDER_CONFLICT";

export class WorkspaceProviderServiceError extends Error {
  constructor(readonly code: WorkspaceProviderServiceErrorCode) {
    super(code);
    this.name = "WorkspaceProviderServiceError";
  }
}

type WorkspaceProviderDb = PrismaClient | Prisma.TransactionClient;
type ProviderActor = Readonly<{ id: string; role: AccessUser["role"] }>;

const providerKindSchema = z.enum(["deepseek", "glm"]);
const modelIdSchema = z.string().trim().min(1).max(128).refine(isSafeModelId);
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: providerKindSchema,
  apiKey: z.string().min(8).max(512),
  generationModelId: modelIdSchema.nullable().optional(),
  visionModelId: modelIdSchema.nullable().optional(),
  embeddingModelId: modelIdSchema.nullable().optional(),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
}).strict();
const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  apiKey: z.string().min(8).max(512).optional(),
  generationModelId: modelIdSchema.nullable().optional(),
  visionModelId: modelIdSchema.nullable().optional(),
  embeddingModelId: modelIdSchema.nullable().optional(),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
  enabled: z.boolean().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const deleteSchema = z.object({
  confirmationName: z.string().min(1).max(80),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

function isPureDisablePatch(input: z.infer<typeof updateSchema>): boolean {
  return input.enabled === false &&
    input.name === undefined &&
    input.apiKey === undefined &&
    input.generationModelId === undefined &&
    input.visionModelId === undefined &&
    input.embeddingModelId === undefined &&
    input.embeddingDimensions === undefined;
}

const providerSelect = {
  id: true,
  name: true,
  kind: true,
  scope: true,
  workspaceId: true,
  ownerUserId: true,
  defaultGenerationModelId: true,
  defaultEmbeddingModelId: true,
  defaultVisionModelId: true,
  embeddingDimensions: true,
  status: true,
  lastTestedAt: true,
  lastErrorCode: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
  credential: { select: { maskedSuffix: true, rotatedAt: true, updatedAt: true } },
  _count: { select: { projectRoutes: true } },
} as const;

function fail(code: WorkspaceProviderServiceErrorCode): never {
  throw new WorkspaceProviderServiceError(code);
}

function known(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function assertWorkspaceMember(
  actor: ProviderActor,
  workspaceId: string,
  db: WorkspaceProviderDb,
): Promise<"owner" | "admin" | "member" | "viewer"> {
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: actor.id } },
    select: { role: true },
  });
  if (membership === null) return fail("AI_PROVIDER_SCOPE_FORBIDDEN");
  return membership.role;
}

async function assertManager(
  actor: ProviderActor,
  workspaceId: string,
  db: WorkspaceProviderDb,
  options: Readonly<{ connectionOwnerId?: string | null; action: "view" | "write" | "disable" | "delete" | "test" }>,
): Promise<void> {
  const workspaceRole = await assertWorkspaceMember(actor, workspaceId, db);
  if (options.action === "view") return;
  if (workspaceRole !== "owner" && workspaceRole !== "admin") return fail("AI_PROVIDER_OWNER_REQUIRED");
  if (options.connectionOwnerId !== actor.id) return fail("AI_PROVIDER_OWNER_REQUIRED");
  const membership = await getMembershipStatus(actor.id, db);
  if (membership.status === "active") return;
  if ((options.action === "disable" || options.action === "delete") && (membership.status === "expired" || membership.status === "revoked")) {
    // A lapsed owner must still be able to disable or remove their own
    // connection so an encrypted key cannot become permanently stranded.
    return;
  }
  if (membership.status === "none" || membership.status === "revoked") return fail("AI_MEMBERSHIP_REQUIRED");
  return fail("AI_MEMBERSHIP_EXPIRED");
}

async function providerForWorkspace(
  workspaceId: string,
  providerId: string,
  db: WorkspaceProviderDb,
) {
  const provider = await db.aiProviderConnection.findFirst({
    where: { id: providerId, scope: "workspace", workspaceId },
    select: { ...providerSelect, credentialId: true },
  });
  if (provider === null) return fail("AI_PROVIDER_NOT_FOUND");
  return provider;
}

function assertCapabilities(
  kind: AiProviderKind,
  generationModelId: string | null | undefined,
  visionModelId: string | null | undefined,
  embeddingModelId: string | null | undefined,
  embeddingDimensions: number | null | undefined,
): void {
  if (generationModelId == null && embeddingModelId == null) return fail("AI_PROVIDER_INVALID_INPUT");
  const definition = getProviderDefinition(kind);
  if (!definition.supportsEmbeddings && (embeddingModelId != null || embeddingDimensions != null)) {
    return fail("AI_PROVIDER_INVALID_INPUT");
  }
  if ((embeddingModelId == null) !== (embeddingDimensions == null)) return fail("AI_PROVIDER_INVALID_INPUT");
  if (!definition.supportsVision && visionModelId != null) return fail("AI_PROVIDER_INVALID_INPUT");
  if (kind === "deepseek" && visionModelId != null && visionModelId !== "deepseek-v4-flash-vision-exp") {
    return fail("AI_PROVIDER_INVALID_INPUT");
  }
}

function expectedDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fail("AI_PROVIDER_INVALID_INPUT");
  return date;
}

export async function listWorkspaceProviderConnections(
  workspaceId: string,
  actor: ProviderActor,
  db: PrismaClient = getDb(),
) {
  await assertManager(actor, workspaceId, db, { action: "view" });
  return db.aiProviderConnection.findMany({
    where: { scope: "workspace", workspaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: providerSelect,
  });
}

export async function createWorkspaceProviderConnection(
  workspaceId: string,
  input: unknown,
  actor: ProviderActor,
  db: PrismaClient = getDb(),
) {
  const parsed = createSchema.parse(input);
  assertCapabilities(parsed.kind, parsed.generationModelId, parsed.visionModelId, parsed.embeddingModelId, parsed.embeddingDimensions);
  try {
    return await db.$transaction(async (tx) => {
      // Serialize membership revoke/extend with creation. The actor is also
      // the immutable payer/owner for a workspace connection.
      await lockMembershipUser(tx, actor.id);
      await assertManager(actor, workspaceId, tx, { action: "write", connectionOwnerId: actor.id });
      const credential = await createCredential("aiProvider", parsed.apiKey, tx);
      return tx.aiProviderConnection.create({
        data: {
          name: parsed.name,
          kind: parsed.kind,
          scope: "workspace",
          workspaceId,
          ownerUserId: actor.id,
          baseUrl: getProviderDefinition(parsed.kind).baseUrl,
          credentialId: credential.id,
          defaultGenerationModelId: parsed.generationModelId ?? null,
          defaultVisionModelId: parsed.visionModelId ?? null,
          defaultEmbeddingModelId: parsed.embeddingModelId ?? null,
          embeddingDimensions: parsed.embeddingDimensions ?? null,
        },
        select: providerSelect,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (known(error, "P2002")) return fail("AI_PROVIDER_NAME_CONFLICT");
    if (known(error, "P2034")) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

export async function updateWorkspaceProviderConnection(
  workspaceId: string,
  providerId: string,
  input: unknown,
  actor: ProviderActor,
  db: PrismaClient = getDb(),
) {
  const parsed = updateSchema.parse(input);
  const expected = expectedDate(parsed.expectedUpdatedAt);
  try {
    return await db.$transaction(async (tx) => {
      // Read authorization, the current revision, and the connection inside
      // one user-serialized transaction. Membership revoke therefore cannot
      // pass the preflight and then be bypassed by this write.
      await lockMembershipUser(tx, actor.id);
      const current = await providerForWorkspace(workspaceId, providerId, tx);
      // Only an explicit, metadata-only disable may use the expired-owner
      // cleanup exception. Any name, key, model, or dimension field remains a
      // configuration write and therefore requires an active membership.
      const action = isPureDisablePatch(parsed) ? "disable" : "write";
      await assertManager(actor, workspaceId, tx, { action, connectionOwnerId: current.ownerUserId });
      if (expected !== undefined && current.updatedAt.getTime() !== expected.getTime()) return fail("AI_PROVIDER_CONFLICT");
      const nextGeneration = parsed.generationModelId === undefined ? current.defaultGenerationModelId : parsed.generationModelId;
      const nextVision = parsed.visionModelId === undefined ? current.defaultVisionModelId : parsed.visionModelId;
      const nextEmbedding = parsed.embeddingModelId === undefined ? current.defaultEmbeddingModelId : parsed.embeddingModelId;
      const nextDimensions = parsed.embeddingDimensions === undefined ? current.embeddingDimensions : parsed.embeddingDimensions;
      assertCapabilities(current.kind, nextGeneration, nextVision, nextEmbedding, nextDimensions);
      if (parsed.enabled === false && current._count.projectRoutes > 0) return fail("AI_PROVIDER_IN_USE");

      const configurationChanged = parsed.apiKey !== undefined ||
        parsed.generationModelId !== undefined ||
        parsed.visionModelId !== undefined ||
        parsed.embeddingModelId !== undefined ||
        parsed.embeddingDimensions !== undefined;
      if (parsed.apiKey !== undefined) await rotateCredential(current.credentialId, "aiProvider", parsed.apiKey, tx);
      const data = {
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        ...(parsed.generationModelId === undefined ? {} : { defaultGenerationModelId: parsed.generationModelId }),
        ...(parsed.visionModelId === undefined ? {} : { defaultVisionModelId: parsed.visionModelId }),
        ...(parsed.embeddingModelId === undefined ? {} : { defaultEmbeddingModelId: parsed.embeddingModelId }),
        ...(parsed.embeddingDimensions === undefined ? {} : { embeddingDimensions: parsed.embeddingDimensions }),
        ...(parsed.enabled === false
          ? { status: "disabled" as AiProviderConnectionStatus, disabledAt: new Date(), ...(configurationChanged ? { lastTestedAt: null, lastErrorCode: null } : {}) }
          : parsed.enabled === true || configurationChanged
            ? { status: "configured" as AiProviderConnectionStatus, disabledAt: null, lastErrorCode: null, lastTestedAt: null }
            : {}),
      };
      const updated = await tx.aiProviderConnection.updateMany({
        where: { id: current.id, scope: "workspace", workspaceId, updatedAt: current.updatedAt },
        data,
      });
      if (updated.count !== 1) return fail("AI_PROVIDER_CONFLICT");
      return tx.aiProviderConnection.findFirstOrThrow({ where: { id: current.id, scope: "workspace", workspaceId }, select: providerSelect });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (known(error, "P2002")) return fail("AI_PROVIDER_NAME_CONFLICT");
    if (known(error, "P2034")) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

export async function testWorkspaceProviderConnection(
  workspaceId: string,
  providerId: string,
  actor: ProviderActor,
  db: PrismaClient = getDb(),
) {
  try {
    return await db.$transaction(async (tx) => {
      // Hold the same transaction-scoped owner lock through the bounded
      // provider probe. A revoke that wins first therefore fails before any
      // HTTP; a test that wins first keeps revoke from committing until the
      // probe and final CAS write have completed.
      await lockMembershipUser(tx, actor.id);
      const provider = await providerForWorkspace(workspaceId, providerId, tx);
      await assertManager(actor, workspaceId, tx, { action: "test", connectionOwnerId: provider.ownerUserId });
      if (provider.status === "disabled" || provider.disabledAt !== null) return fail("AI_PROVIDER_CONNECTION_UNAVAILABLE");
      const touched = await tx.aiProviderConnection.updateMany({
        where: { id: provider.id, scope: "workspace", workspaceId, status: { not: "disabled" }, updatedAt: provider.updatedAt },
        data: { lastTestedAt: new Date() },
      });
      if (touched.count !== 1) return fail("AI_PROVIDER_CONFLICT");
      const leased = await tx.aiProviderConnection.findFirst({
        where: { id: provider.id, scope: "workspace", workspaceId },
        select: { updatedAt: true, ownerUserId: true },
      });
      if (leased === null) return fail("AI_PROVIDER_CONFLICT");
      return testProviderConnection(providerId, tx, "workspace", {
        expectedUpdatedAt: leased.updatedAt,
        expectedWorkspaceId: workspaceId,
        expectedOwnerUserId: leased.ownerUserId,
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: PROVIDER_CONNECTION_TEST_TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    if (known(error, "P2034")) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

export async function deleteWorkspaceProviderConnection(
  workspaceId: string,
  providerId: string,
  input: unknown,
  actor: ProviderActor,
  db: PrismaClient = getDb(),
) {
  const parsed = deleteSchema.parse(input);
  const expected = expectedDate(parsed.expectedUpdatedAt);
  try {
    return await db.$transaction(async (tx) => {
      await lockMembershipUser(tx, actor.id);
      const current = await providerForWorkspace(workspaceId, providerId, tx);
      await assertManager(actor, workspaceId, tx, { action: "delete", connectionOwnerId: current.ownerUserId });
      if (expected !== undefined && current.updatedAt.getTime() !== expected.getTime()) return fail("AI_PROVIDER_CONFLICT");
      if (current.status !== "disabled") return fail("AI_PROVIDER_DELETE_REQUIRES_DISABLED");
      if (current.name !== parsed.confirmationName) return fail("AI_PROVIDER_CONFIRMATION_MISMATCH");
      if (Object.values(current._count).some((count) => count > 0)) return fail("AI_PROVIDER_IN_USE");
      const deleted = await tx.aiProviderConnection.deleteMany({
        where: { id: current.id, scope: "workspace", workspaceId, status: "disabled", updatedAt: current.updatedAt },
      });
      if (deleted.count !== 1) return fail("AI_PROVIDER_CONFLICT");
      await tx.externalCredential.delete({ where: { id: current.credentialId } });
      return Object.freeze({ id: current.id });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (known(error, "P2003")) return fail("AI_PROVIDER_IN_USE");
    if (known(error, "P2034")) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

export async function assertWorkspaceProviderOutbound(
  workspaceId: string,
  providerId: string,
  actor: ProviderActor,
  db: PrismaClient = getDb(),
): Promise<void> {
  const provider = await providerForWorkspace(workspaceId, providerId, db);
  // The request actor may be any real workspace member; the connection owner
  // is the payer and must independently remain an Owner/Admin with an active
  // membership. A global system-admin role is never a workspace membership.
  await assertWorkspaceMember(actor, workspaceId, db);
  if (provider.status !== "verified") return fail("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  if (provider.ownerUserId === null) return fail("AI_PROVIDER_OWNER_REQUIRED");
  const ownerMembership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: provider.ownerUserId } },
    select: { role: true },
  });
  if (ownerMembership === null || (ownerMembership.role !== "owner" && ownerMembership.role !== "admin")) {
    return fail("AI_PROVIDER_OWNER_REQUIRED");
  }
  await assertActiveMembership(provider.ownerUserId, db);
}
