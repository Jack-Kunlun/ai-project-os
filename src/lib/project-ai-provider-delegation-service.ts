import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type AiOperation,
  type AiProviderConnectionStatus,
  type AiProviderKind,
  type ProjectAiEffectiveRouteSelection,
  type ProjectAiProviderDelegation,
  type ProjectAiProviderDelegationAuditAction,
  type ProjectAiProviderDelegationStatus,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  withWebAiProjectAccessTransaction,
  type ProjectAccessAdmission,
  type WebAiActor,
} from "@/lib/access-linearization";
import { WebAiAccessError } from "@/lib/access-linearization";
import {
  type WebAiActor as WebAiAccessActor,
} from "@/lib/web-ai-access";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";
import {
  canonicalProviderBaseUrl,
  getProviderDefinition,
  isSafeModelId,
} from "@/lib/ai-providers/registry";
import { getProjectAiOperationCapability } from "@/lib/project-ai-runtime-capabilities";

const MAX_REASON_LENGTH = 500;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const MAX_MAX_OUTPUT_TOKENS = 65_536;
const MIN_EXPIRY_MS = 10 * 60 * 1_000;
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_VERSION = 2_147_483_646;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

const operationSchema = z.enum([
  "embedding",
  "visionExtract",
  "autoExtract",
  "sourceSummary",
  "projectAnalysis",
  "generateWithContext",
]);
const uuidSchema = z.string().uuid();
const utcDateSchema = z.string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamp must be UTC");
const versionSchema = z.number().int().positive().max(MAX_VERSION);
const reasonSchema = z.string().trim().min(1).max(MAX_REASON_LENGTH);

const proposalSchema = z.object({
  providerConnectionId: uuidSchema,
  operation: operationSchema,
  maxOutputTokens: z.number().int().min(1).max(MAX_MAX_OUTPUT_TOKENS).optional(),
  expiresAt: utcDateSchema,
}).strict().superRefine((value, context) => {
  if (value.operation === "embedding" && value.maxOutputTokens !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["maxOutputTokens"],
      message: "embedding does not accept maxOutputTokens",
    });
  }
});

const ownerConfirmationSchema = z.object({
  expectedVersion: versionSchema,
  acknowledgeProviderCharges: z.literal(true),
}).strict();

const projectConfirmationSchema = z.object({
  expectedVersion: versionSchema,
  acknowledgeDataEgress: z.literal(true),
  acknowledgeIndexImpact: z.literal(true),
}).strict();

const terminalSchema = z.object({
  expectedVersion: versionSchema,
  reason: reasonSchema,
}).strict();

const revocationSchema = terminalSchema.extend({
  switchToPlatformDefault: z.boolean().optional().default(false),
}).strict();

const selectionSchema = z.object({
  source: z.enum(["platformDefault", "personalDelegation"]),
  delegationId: uuidSchema.nullable(),
  expectedVersion: versionSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.source === "platformDefault" && value.delegationId !== null) {
    context.addIssue({ code: "custom", path: ["delegationId"], message: "platformDefault cannot select a delegation" });
  }
  if (value.source === "personalDelegation" && value.delegationId === null) {
    context.addIssue({ code: "custom", path: ["delegationId"], message: "personalDelegation requires a delegation" });
  }
});

export type ProjectAiProviderDelegationServiceErrorCode =
  | "PROJECT_AI_PROVIDER_DELEGATION_INVALID_INPUT"
  | "PROJECT_AI_PROVIDER_DELEGATION_NOT_FOUND"
  | "PROJECT_AI_PROVIDER_DELEGATION_PERSONAL_PROVIDER_NOT_FOUND"
  | "PROJECT_AI_PROVIDER_DELEGATION_FORBIDDEN"
  | "PROJECT_AI_PROVIDER_DELEGATION_PROJECT_OWNER_REQUIRED"
  | "PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_REQUIRED"
  | "PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_EXPIRED"
  | "PROJECT_AI_PROVIDER_DELEGATION_PROJECT_ARCHIVED"
  | "PROJECT_AI_PROVIDER_DELEGATION_CONNECTION_UNAVAILABLE"
  | "PROJECT_AI_PROVIDER_DELEGATION_STATE_CONFLICT"
  | "PROJECT_AI_PROVIDER_DELEGATION_VERSION_CONFLICT"
  | "PROJECT_AI_PROVIDER_DELEGATION_SELECTION_SWITCH_REQUIRED"
  | "PROJECT_AI_PROVIDER_DELEGATION_CONFLICT"
  | "PROJECT_AI_PROVIDER_DELEGATION_EXPIRED";

export class ProjectAiProviderDelegationServiceError extends Error {
  constructor(readonly code: ProjectAiProviderDelegationServiceErrorCode) {
    super(code);
    this.name = "ProjectAiProviderDelegationServiceError";
  }
}

type DelegationDb = PrismaClient | Prisma.TransactionClient;

type DelegationRow = ProjectAiProviderDelegation & {
  providerConnection: {
    id: string;
    name: string;
    kind: AiProviderKind;
    scope: "platform" | "workspace" | "user";
    ownerUserId: string | null;
    protocol: "chatCompletions";
    baseUrl: string;
    defaultGenerationModelId: string | null;
    defaultEmbeddingModelId: string | null;
    defaultVisionModelId: string | null;
    embeddingDimensions: number | null;
    configurationVersion: number;
    status: AiProviderConnectionStatus;
    lastTestedAt: Date | null;
    disabledAt: Date | null;
    credential: { secretFingerprint: string };
  };
  connectionOwner: { id: string; username: string; displayName: string | null };
  projectConfirmer: { id: string; username: string; displayName: string | null } | null;
};

const delegationInclude = {
  providerConnection: {
    select: {
      id: true,
      name: true,
      kind: true,
      scope: true,
      ownerUserId: true,
      protocol: true,
      baseUrl: true,
      defaultGenerationModelId: true,
      defaultEmbeddingModelId: true,
      defaultVisionModelId: true,
      embeddingDimensions: true,
      configurationVersion: true,
      status: true,
      lastTestedAt: true,
      disabledAt: true,
      credential: { select: { secretFingerprint: true } },
    },
  },
  connectionOwner: { select: { id: true, username: true, displayName: true } },
  projectConfirmer: { select: { id: true, username: true, displayName: true } },
} as const;

const selectionSelect = {
  id: true,
  projectId: true,
  operation: true,
  source: true,
  delegationId: true,
  selectedById: true,
  selectedByProjectMembershipId: true,
  selectedByMembershipCreatedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

type SelectionRow = ProjectAiEffectiveRouteSelection;

function fail(code: ProjectAiProviderDelegationServiceErrorCode): never {
  throw new ProjectAiProviderDelegationServiceError(code);
}

function parseUuid(value: unknown): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) return fail("PROJECT_AI_PROVIDER_DELEGATION_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("PROJECT_AI_PROVIDER_DELEGATION_INVALID_INPUT");
  return parsed.data;
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof ProjectAiProviderDelegationServiceError) throw error;
  if (error instanceof WebAiAccessError) return fail("PROJECT_AI_PROVIDER_DELEGATION_FORBIDDEN");
  if (isKnown(error, "P2002") || isKnown(error, "P2025") || isKnown(error, "P2003")) {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
  }
  if (isSerializationConflict(error)) return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");

  // The database guards intentionally expose stable markers.  Translate them
  // here, but never return the driver error or its identifiers to an API.
  const message = errorMessage(error);
  if (message.includes("PROJECT_AI_PROVIDER_DELEGATION_LIVE_EXPIRED")) {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_EXPIRED");
  }
  if (message.includes("PROJECT_AI_PROVIDER_DELEGATION_LIVE_PROVIDER_INVALID")
    || message.includes("PROJECT_AI_PROVIDER_DELEGATION_ACTIVE_PROVIDER_INVALID")) {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_CONNECTION_UNAVAILABLE");
  }
  if (message.includes("PROJECT_AI_PROVIDER_DELEGATION_LIVE_OWNER_INVALID")
    || message.includes("PROJECT_AI_PROVIDER_DELEGATION_ACTIVE_OWNER_INVALID")) {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_REQUIRED");
  }
  if (message.includes("PROJECT_AI_PROVIDER_DELEGATION_ACTIVE_PROJECT_OWNER_INVALID")) {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_PROJECT_OWNER_REQUIRED");
  }
  if (message.includes("PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_DELEGATION_INVALID")) {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_STATE_CONFLICT");
  }
  if (message.includes("PROJECT_AI_PROVIDER_DELEGATION_SELECTION_INVALIDATION_REQUIRED")) {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_SELECTION_SWITCH_REQUIRED");
  }
  if (message.includes("PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID")) {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_STATE_CONFLICT");
  }
  if (message.includes("PROJECT_AI_PROVIDER_DELEGATION_")
    || message.includes("PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_")) {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
  }
  throw error;
}

async function runMutation<T>(
  db: DelegationDb,
  actor: WebAiActor,
  projectId: string,
  additionalActorIds: readonly string[],
  operation: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<T>,
): Promise<T> {
  // Keep the shared admission fence (including the archived-project check)
  // inside the transaction, but opt into the helper's lifecycle-aware read so
  // this control-plane surface can return its own stable archived marker.  The
  // callback rejects before any entity query/write when the project is
  // archived; `allowArchived` is not an operation bypass.
  const guardedOperation = async (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission): Promise<T> => {
    if (admission.project.archivedAt !== null) return fail("PROJECT_AI_PROVIDER_DELEGATION_PROJECT_ARCHIVED");
    return operation(tx, admission);
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await withWebAiProjectAccessTransaction(db, {
        actor,
        projectId,
        required: "edit",
        allowArchived: true,
        additionalActorIds,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }, guardedOperation);
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      return mapDatabaseError(error);
    }
  }
  return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
}

async function databaseNow(db: Prisma.TransactionClient): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date | string }>>(Prisma.sql`
    SELECT clock_timestamp() AS "now"
  `);
  const value = rows[0]?.now;
  const parsed = value instanceof Date ? value : new Date(value ?? "");
  if (!Number.isFinite(parsed.getTime())) return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
  return parsed;
}

async function loadDelegation(
  db: DelegationDb,
  projectId: string,
  delegationId: string,
): Promise<DelegationRow | null> {
  return db.projectAiProviderDelegation.findFirst({
    where: { id: delegationId, projectId },
    include: delegationInclude,
  }) as Promise<DelegationRow | null>;
}

async function loadDelegationOwner(db: DelegationDb, projectId: string, delegationId: string): Promise<string | null> {
  const row = await db.projectAiProviderDelegation.findFirst({
    where: { id: delegationId, projectId },
    select: { connectionOwnerId: true },
  });
  return row?.connectionOwnerId ?? null;
}

async function requireProjectEditorMembership(
  db: Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<{ id: string; createdAt: Date; role: "owner" | "editor" }> {
  const membership = await db.projectMembership.findFirst({
    where: { projectId, userId, accessState: "confirmed", role: { in: ["owner", "editor"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, createdAt: true, role: true },
  });
  if (membership === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_REQUIRED");
  return membership as { id: string; createdAt: Date; role: "owner" | "editor" };
}

async function requireProjectOwnerMembership(
  db: Prisma.TransactionClient,
  projectId: string,
  userId: string,
): Promise<{ id: string; createdAt: Date; role: "owner" }> {
  const membership = await db.projectMembership.findFirst({
    where: { projectId, userId, accessState: "confirmed", role: "owner" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, createdAt: true, role: true },
  });
  if (membership === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_PROJECT_OWNER_REQUIRED");
  return membership as { id: string; createdAt: Date; role: "owner" };
}

async function loadProviderForOwner(
  db: Prisma.TransactionClient,
  providerConnectionId: string,
  ownerUserId: string,
) {
  // Scope and owner are part of the lookup predicate.  A foreign provider id
  // therefore has the same result as a missing personal provider and cannot
  // disclose another user's connection.
  const provider = await db.aiProviderConnection.findFirst({
    where: { id: providerConnectionId, scope: "user", ownerUserId },
    select: {
      id: true,
      name: true,
      kind: true,
      scope: true,
      ownerUserId: true,
      protocol: true,
      baseUrl: true,
      defaultGenerationModelId: true,
      defaultEmbeddingModelId: true,
      defaultVisionModelId: true,
      embeddingDimensions: true,
      configurationVersion: true,
      status: true,
      lastTestedAt: true,
      disabledAt: true,
      credential: { select: { secretFingerprint: true } },
    },
  });
  if (provider === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_PERSONAL_PROVIDER_NOT_FOUND");
  return provider;
}

function providerModel(
  provider: Awaited<ReturnType<typeof loadProviderForOwner>>,
  operation: AiOperation,
  requestedMaxOutputTokens: number | undefined,
): { modelId: string; embeddingDimensions: number | null; maxOutputTokens: number | null } {
  try {
    const definition = getProviderDefinition(provider.kind);
    if (
      provider.scope !== "user"
      || provider.protocol !== "chatCompletions"
      || provider.baseUrl !== canonicalProviderBaseUrl(provider.kind)
      || provider.status !== "verified"
      || provider.disabledAt !== null
      || provider.ownerUserId === null
      || !FINGERPRINT_PATTERN.test(provider.credential.secretFingerprint)
    ) return fail("PROJECT_AI_PROVIDER_DELEGATION_CONNECTION_UNAVAILABLE");

    if (operation === "embedding") {
      const modelId = provider.defaultEmbeddingModelId;
      if (!definition.supportsEmbeddings || modelId === null || provider.embeddingDimensions === null) {
        return fail("PROJECT_AI_PROVIDER_DELEGATION_CONNECTION_UNAVAILABLE");
      }
      if (!isSafeModelId(modelId) || provider.embeddingDimensions < 8 || provider.embeddingDimensions > 8192) {
        return fail("PROJECT_AI_PROVIDER_DELEGATION_CONNECTION_UNAVAILABLE");
      }
      return { modelId, embeddingDimensions: provider.embeddingDimensions, maxOutputTokens: null };
    }

    const modelId = operation === "visionExtract"
      ? provider.defaultVisionModelId
      : provider.defaultGenerationModelId;
    if (modelId === null || !isSafeModelId(modelId)) {
      return fail("PROJECT_AI_PROVIDER_DELEGATION_CONNECTION_UNAVAILABLE");
    }
    if (operation === "visionExtract" && !definition.supportsVision) {
      return fail("PROJECT_AI_PROVIDER_DELEGATION_CONNECTION_UNAVAILABLE");
    }
    return {
      modelId,
      embeddingDimensions: null,
      maxOutputTokens: requestedMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };
  } catch (error) {
    if (error instanceof ProjectAiProviderDelegationServiceError) throw error;
    return fail("PROJECT_AI_PROVIDER_DELEGATION_CONNECTION_UNAVAILABLE");
  }
}

async function loadSubscription(
  db: Prisma.TransactionClient,
  userId: string,
  now: Date,
) {
  const subscription = await db.membershipSubscription.findUnique({
    where: { userId },
    select: { id: true, userId: true, status: true, startsAt: true, expiresAt: true, version: true },
  });
  if (subscription === null || subscription.status !== "active") {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_REQUIRED");
  }
  if (subscription.startsAt > now || subscription.expiresAt <= now) {
    return fail("PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_EXPIRED");
  }
  return subscription;
}

function canonicalFingerprintPayload(input: Readonly<{
  projectId: string;
  operation: AiOperation;
  providerConnectionId: string;
  connectionOwnerId: string;
  ownerProjectMembershipId: string;
  ownerMembershipCreatedAt: Date;
  connectionOwnerSubscriptionId: string;
  connectionOwnerSubscriptionVersion: number;
  connectionOwnerSubscriptionStartsAt: Date;
  connectionOwnerSubscriptionExpiresAt: Date;
  modelId: string;
  embeddingDimensions: number | null;
  maxOutputTokens: number | null;
  providerConfigurationVersion: number;
  credentialFingerprint: string;
  expiresAt: Date;
}>): string {
  return JSON.stringify({
    projectId: input.projectId,
    operation: input.operation,
    providerConnectionId: input.providerConnectionId,
    connectionOwnerId: input.connectionOwnerId,
    ownerProjectMembershipId: input.ownerProjectMembershipId,
    ownerMembershipCreatedAt: input.ownerMembershipCreatedAt.toISOString(),
    connectionOwnerSubscriptionId: input.connectionOwnerSubscriptionId,
    connectionOwnerSubscriptionVersion: input.connectionOwnerSubscriptionVersion,
    connectionOwnerSubscriptionStartsAt: input.connectionOwnerSubscriptionStartsAt.toISOString(),
    connectionOwnerSubscriptionExpiresAt: input.connectionOwnerSubscriptionExpiresAt.toISOString(),
    modelId: input.modelId,
    embeddingDimensions: input.embeddingDimensions,
    maxOutputTokens: input.maxOutputTokens,
    providerConfigurationVersion: input.providerConfigurationVersion,
    credentialFingerprint: input.credentialFingerprint,
    expiresAt: input.expiresAt.toISOString(),
  });
}

function fingerprint(input: Parameters<typeof canonicalFingerprintPayload>[0]): string {
  return createHash("sha256").update(canonicalFingerprintPayload(input), "utf8").digest("hex");
}

async function appendDelegationAudit(
  db: Prisma.TransactionClient,
  row: ProjectAiProviderDelegation,
  action: ProjectAiProviderDelegationAuditAction,
  statusBefore: ProjectAiProviderDelegationStatus | null,
  actorId: string | null,
  actorMembershipId: string | null,
  actorMembershipCreatedAt: Date | null,
  reason: string,
): Promise<void> {
  const transitionAt = action === "proposed"
    ? row.proposedAt
    : action === "ownerConfirmed"
      ? row.ownerConfirmedAt
      : action === "activated"
        ? row.activatedAt
        : action === "rejected"
          ? row.rejectedAt
          : action === "revoked"
            ? row.revokedAt
            : row.expiredAt;
  if (transitionAt === null || transitionAt === undefined) return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
  await db.projectAiProviderDelegationAudit.create({
    data: {
      id: randomUUID(),
      projectId: row.projectId,
      operation: row.operation,
      entity: "delegation",
      action,
      delegationId: row.id,
      delegationVersion: row.version,
      statusBefore,
      statusAfter: row.status,
      providerConnectionId: row.providerConnectionId,
      connectionOwnerId: row.connectionOwnerId,
      ownerProjectMembershipId: row.ownerProjectMembershipId,
      projectConfirmedProjectMembershipId: row.projectConfirmedProjectMembershipId,
      projectConfirmedMembershipCreatedAt: row.projectConfirmedMembershipCreatedAt,
      connectionOwnerSubscriptionId: row.connectionOwnerSubscriptionId,
      connectionOwnerSubscriptionVersion: row.connectionOwnerSubscriptionVersion,
      connectionOwnerSubscriptionStartsAt: row.connectionOwnerSubscriptionStartsAt,
      connectionOwnerSubscriptionExpiresAt: row.connectionOwnerSubscriptionExpiresAt,
      modelId: row.modelId,
      embeddingDimensions: row.embeddingDimensions,
      maxOutputTokens: row.maxOutputTokens,
      providerConfigurationVersion: row.providerConfigurationVersion,
      credentialFingerprint: row.credentialFingerprint,
      delegationFingerprint: row.delegationFingerprint,
      terminalActorKind: row.terminalActorKind,
      terminalActorId: row.terminalActorId,
      terminalActorProjectMembershipId: row.terminalActorProjectMembershipId,
      terminalActorMembershipCreatedAt: row.terminalActorMembershipCreatedAt,
      terminalReason: row.terminalReason,
      actorKind: "user",
      actorId,
      actorProjectMembershipId: actorMembershipId,
      actorMembershipCreatedAt,
      reason,
      transitionAt,
    },
  });
}

async function appendSelectionAudit(
  db: Prisma.TransactionClient,
  row: SelectionRow,
  action: ProjectAiProviderDelegationAuditAction,
  reason: string,
): Promise<void> {
  await db.projectAiProviderDelegationAudit.create({
    data: {
      id: randomUUID(),
      projectId: row.projectId,
      operation: row.operation,
      entity: "selection",
      action,
      selectionId: row.id,
      selectionVersion: row.version,
      selectionSource: row.source,
      selectedDelegationId: row.delegationId,
      actorKind: "user",
      actorId: row.selectedById,
      actorProjectMembershipId: row.selectedByProjectMembershipId,
      actorMembershipCreatedAt: row.selectedByMembershipCreatedAt,
      selectedByProjectMembershipId: row.selectedByProjectMembershipId,
      selectedByMembershipCreatedAt: row.selectedByMembershipCreatedAt,
      reason,
      transitionAt: row.version === 1 ? row.createdAt : row.updatedAt,
    },
  });
}

async function assertLiveDelegationDependencies(
  db: Prisma.TransactionClient,
  row: ProjectAiProviderDelegation,
  now: Date,
): Promise<void> {
  if (row.expiresAt <= now) return fail("PROJECT_AI_PROVIDER_DELEGATION_EXPIRED");
  const provider = await loadProviderForOwner(db, row.providerConnectionId, row.connectionOwnerId);
  const derived = providerModel(provider, row.operation, row.maxOutputTokens ?? undefined);
  if (
    provider.configurationVersion !== row.providerConfigurationVersion
    || provider.credential.secretFingerprint !== row.credentialFingerprint
    || derived.modelId !== row.modelId
    || derived.embeddingDimensions !== row.embeddingDimensions
    || derived.maxOutputTokens !== row.maxOutputTokens
  ) return fail("PROJECT_AI_PROVIDER_DELEGATION_CONNECTION_UNAVAILABLE");
  const membership = await db.projectMembership.findFirst({
    where: { id: row.ownerProjectMembershipId },
    select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true },
  });
  if (
    membership === null
    || membership.projectId !== row.projectId
    || membership.userId !== row.connectionOwnerId
    || membership.accessState !== "confirmed"
    || (membership.role !== "owner" && membership.role !== "editor")
    || membership.createdAt.getTime() !== row.ownerMembershipCreatedAt.getTime()
  ) return fail("PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_REQUIRED");
  await loadSubscription(db, row.connectionOwnerId, now);
}

function delegationView(
  row: DelegationRow,
  actorId: string,
  explicitProjectOwner: boolean,
  selection: SelectionRow | null,
) {
  const isConnectionOwner = row.connectionOwnerId === actorId;
  const privileged = isConnectionOwner || explicitProjectOwner;
  const ownProvider = isConnectionOwner
    ? {
        name: row.providerConnection.name,
        kind: row.providerConnection.kind,
        modelId: row.modelId,
        status: row.providerConnection.status,
        lastTestedAt: row.providerConnection.lastTestedAt?.toISOString() ?? null,
      }
    : null;
  const projectOwnerProvider = explicitProjectOwner
    ? { kind: row.providerConnection.kind, modelId: row.modelId }
    : null;
  const capability = getProjectAiOperationCapability(row.operation);
  return Object.freeze({
    id: row.id,
    operation: row.operation,
    status: row.status,
    version: row.version,
    expiresAt: row.expiresAt.toISOString(),
    selected: selection?.source === "personalDelegation" && selection.delegationId === row.id,
    selectedSource: selection?.source ?? "platformDefault",
    provider: ownProvider ?? projectOwnerProvider,
    connectionOwner: explicitProjectOwner
      ? { id: row.connectionOwner.id, displayName: row.connectionOwner.displayName ?? row.connectionOwner.username }
      : null,
    projectConfirmer: explicitProjectOwner && row.projectConfirmer !== null
      ? { id: row.projectConfirmer.id, displayName: row.projectConfirmer.displayName ?? row.projectConfirmer.username }
      : null,
    terminalReason: privileged ? row.terminalReason : null,
    ...capability,
  });
}

async function readProjectOwnerFlag(db: DelegationDb, projectId: string, actorId: string): Promise<boolean> {
  const membership = await db.projectMembership.findFirst({
    where: { projectId, userId: actorId, accessState: "confirmed", role: "owner" },
    select: { id: true },
  });
  return membership !== null;
}

async function runRead<T>(
  db: PrismaClient,
  actor: WebAiAccessActor,
  projectId: string,
  operation: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<T>,
): Promise<T> {
  // The access helper discovers the workspace before taking the actor,
  // workspace, and project locks.  A Serializable read could therefore keep
  // a pre-lock snapshot while it waits for a membership revoke.  ReadCommitted
  // ensures the post-lock admission and the projection reads observe the
  // committed authorization state; the access locks stay held for the whole
  // transaction and keep the admission tuple and projection coherent.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await withWebAiProjectAccessTransaction(db, {
        actor,
        projectId,
        required: "view",
        allowArchived: true,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      }, operation);
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      return mapDatabaseError(error);
    }
  }
  return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
}

export async function listProjectAiProviderDelegations(
  projectIdInput: string,
  actor: WebAiAccessActor,
  db: PrismaClient = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  return runRead(db, actor, projectId, async (tx, admission) => {
    const [rows, selections, explicitProjectOwner] = await Promise.all([
      tx.projectAiProviderDelegation.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], include: delegationInclude }),
      tx.projectAiEffectiveRouteSelection.findMany({ where: { projectId }, orderBy: [{ operation: "asc" }], select: selectionSelect }),
      readProjectOwnerFlag(tx, projectId, admission.actor.id),
    ]);
    const selectionByOperation = new Map(selections.map((selection) => [selection.operation, selection]));
    return Object.freeze({
      delegations: rows.map((row) => delegationView(
        row as DelegationRow,
        admission.actor.id,
        explicitProjectOwner,
        selectionByOperation.get(row.operation) ?? null,
      )),
      selections: selections.map((selection) => Object.freeze({
        operation: selection.operation,
        source: selection.source,
        selected: selection.source === "personalDelegation",
        version: selection.version,
        updatedAt: selection.updatedAt.toISOString(),
        ...getProjectAiOperationCapability(selection.operation),
      })),
    });
  });
}

export async function getProjectAiProviderDelegation(
  projectIdInput: string,
  delegationIdInput: string,
  actor: WebAiAccessActor,
  db: PrismaClient = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  const delegationId = parseUuid(delegationIdInput);
  return runRead(db, actor, projectId, async (tx, admission) => {
    const row = await loadDelegation(tx, projectId, delegationId);
    if (row === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_NOT_FOUND");
    const [selection, explicitProjectOwner] = await Promise.all([
      tx.projectAiEffectiveRouteSelection.findUnique({ where: { projectId_operation: { projectId, operation: row.operation } }, select: selectionSelect }),
      readProjectOwnerFlag(tx, projectId, admission.actor.id),
    ]);
    return delegationView(row, admission.actor.id, explicitProjectOwner, selection);
  });
}

export async function proposeProjectAiProviderDelegation(
  projectIdInput: string,
  input: unknown,
  actor: WebAiActor,
  db: DelegationDb = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  const parsed = parseInput(proposalSchema, input);
  const providerId = parseUuid(parsed.providerConnectionId);
  return runMutation(db, actor, projectId, [actor.id], async (tx, admission) => {
    const membership = await requireProjectEditorMembership(tx, projectId, admission.actor.id);
    const now = await databaseNow(tx);
    const expiresAt = new Date(parsed.expiresAt);
    if (
      expiresAt.getTime() < now.getTime() + MIN_EXPIRY_MS
      || expiresAt.getTime() > now.getTime() + MAX_EXPIRY_MS
    ) return fail("PROJECT_AI_PROVIDER_DELEGATION_INVALID_INPUT");
    const subscription = await loadSubscription(tx, admission.actor.id, now);
    if (expiresAt > subscription.expiresAt) return fail("PROJECT_AI_PROVIDER_DELEGATION_INVALID_INPUT");
    const provider = await loadProviderForOwner(tx, providerId, admission.actor.id);
    const model = providerModel(provider, parsed.operation, parsed.maxOutputTokens);
    const delegationFingerprint = fingerprint({
      projectId,
      operation: parsed.operation,
      providerConnectionId: provider.id,
      connectionOwnerId: admission.actor.id,
      ownerProjectMembershipId: membership.id,
      ownerMembershipCreatedAt: membership.createdAt,
      connectionOwnerSubscriptionId: subscription.id,
      connectionOwnerSubscriptionVersion: subscription.version,
      connectionOwnerSubscriptionStartsAt: subscription.startsAt,
      connectionOwnerSubscriptionExpiresAt: subscription.expiresAt,
      modelId: model.modelId,
      embeddingDimensions: model.embeddingDimensions,
      maxOutputTokens: model.maxOutputTokens,
      providerConfigurationVersion: provider.configurationVersion,
      credentialFingerprint: provider.credential.secretFingerprint,
      expiresAt,
    });
    const draft = await tx.projectAiProviderDelegation.create({
      data: {
        id: randomUUID(),
        projectId,
        operation: parsed.operation,
        providerConnectionId: provider.id,
        connectionOwnerId: admission.actor.id,
        ownerProjectMembershipId: membership.id,
        ownerMembershipCreatedAt: membership.createdAt,
        connectionOwnerSubscriptionId: subscription.id,
        connectionOwnerSubscriptionVersion: subscription.version,
        connectionOwnerSubscriptionStartsAt: subscription.startsAt,
        connectionOwnerSubscriptionExpiresAt: subscription.expiresAt,
        modelId: model.modelId,
        embeddingDimensions: model.embeddingDimensions,
        maxOutputTokens: model.maxOutputTokens,
        providerConfigurationVersion: provider.configurationVersion,
        credentialFingerprint: provider.credential.secretFingerprint,
        delegationFingerprint,
        expiresAt,
        proposedById: admission.actor.id,
      },
    });
    await appendDelegationAudit(tx, draft, "proposed", null, admission.actor.id, membership.id, membership.createdAt, "delegation_proposed");
    const row = await loadDelegation(tx, projectId, draft.id);
    if (row === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
    return delegationView(row, admission.actor.id, membership.role === "owner", null);
  });
}

async function mutateDelegation(
  projectId: string,
  delegationId: string,
  expectedVersion: number,
  actor: WebAiActor,
  db: DelegationDb,
  transition: "ownerConfirmed" | "active" | "rejected" | "revoked",
  reason: string,
  acknowledgements?: { providerCharges?: true; dataEgress?: true; indexImpact?: true },
  switchToPlatformDefault = false,
) {
  const ownerId = await loadDelegationOwner(db, projectId, delegationId);
  const additionalActorIds = ownerId === null ? [] : [ownerId];
  return runMutation(db, actor, projectId, additionalActorIds, async (tx, admission) => {
    const current = await loadDelegation(tx, projectId, delegationId);
    if (current === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_NOT_FOUND");
    if (current.version !== expectedVersion) return fail("PROJECT_AI_PROVIDER_DELEGATION_VERSION_CONFLICT");
    const now = await databaseNow(tx);
    if (transition === "ownerConfirmed") {
      if (current.status !== "draft") return fail("PROJECT_AI_PROVIDER_DELEGATION_STATE_CONFLICT");
      if (acknowledgements?.providerCharges !== true) return fail("PROJECT_AI_PROVIDER_DELEGATION_INVALID_INPUT");
      if (current.expiresAt <= now) return fail("PROJECT_AI_PROVIDER_DELEGATION_EXPIRED");
      if (current.connectionOwnerId !== admission.actor.id) return fail("PROJECT_AI_PROVIDER_DELEGATION_FORBIDDEN");
      const membership = await requireProjectEditorMembership(tx, projectId, admission.actor.id);
      if (membership.id !== current.ownerProjectMembershipId || membership.createdAt.getTime() !== current.ownerMembershipCreatedAt.getTime()) {
        return fail("PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_REQUIRED");
      }
      await assertLiveDelegationDependencies(tx, current, now);
      const changed = await tx.projectAiProviderDelegation.updateMany({
        where: { id: current.id, version: expectedVersion, status: "draft" },
        data: { version: expectedVersion + 1, status: "ownerConfirmed", ownerConfirmedById: admission.actor.id },
      });
      if (changed.count !== 1) return fail("PROJECT_AI_PROVIDER_DELEGATION_VERSION_CONFLICT");
      const next = await tx.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: current.id } });
      await appendDelegationAudit(tx, next, "ownerConfirmed", current.status, admission.actor.id, membership.id, membership.createdAt, "owner_confirmation_acknowledged_provider_charges");
      const row = await loadDelegation(tx, projectId, current.id);
      if (row === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
      return delegationView(row, admission.actor.id, membership.role === "owner", null);
    }

    if (transition === "active") {
      if (current.status !== "ownerConfirmed") return fail("PROJECT_AI_PROVIDER_DELEGATION_STATE_CONFLICT");
      if (acknowledgements?.dataEgress !== true || acknowledgements.indexImpact !== true) return fail("PROJECT_AI_PROVIDER_DELEGATION_INVALID_INPUT");
      if (current.expiresAt <= now) return fail("PROJECT_AI_PROVIDER_DELEGATION_EXPIRED");
      const ownerMembership = await requireProjectOwnerMembership(tx, projectId, admission.actor.id);
      await assertLiveDelegationDependencies(tx, current, now);
      const changed = await tx.projectAiProviderDelegation.updateMany({
        where: { id: current.id, version: expectedVersion, status: "ownerConfirmed" },
        data: {
          version: expectedVersion + 1,
          status: "active",
          projectConfirmedById: admission.actor.id,
          projectConfirmedProjectMembershipId: ownerMembership.id,
          projectConfirmedMembershipCreatedAt: ownerMembership.createdAt,
        },
      });
      if (changed.count !== 1) return fail("PROJECT_AI_PROVIDER_DELEGATION_VERSION_CONFLICT");
      const next = await tx.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: current.id } });
      await appendDelegationAudit(tx, next, "activated", current.status, admission.actor.id, ownerMembership.id, ownerMembership.createdAt, "project_confirmation_acknowledged_data_egress_and_index_impact");
      const row = await loadDelegation(tx, projectId, current.id);
      if (row === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
      return delegationView(row, admission.actor.id, true, null);
    }

    const projectOwnerMembership = await tx.projectMembership.findFirst({
      where: { projectId, userId: admission.actor.id, accessState: "confirmed", role: "owner" },
      select: { id: true, createdAt: true, role: true },
    });
    const isOwner = current.connectionOwnerId === admission.actor.id;
    if (!isOwner && projectOwnerMembership === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_PROJECT_OWNER_REQUIRED");
    const actorMembership = isOwner
      ? await requireProjectEditorMembership(tx, projectId, admission.actor.id)
      : projectOwnerMembership!;

    if (transition === "rejected") {
      if (current.status !== "draft" && current.status !== "ownerConfirmed") return fail("PROJECT_AI_PROVIDER_DELEGATION_STATE_CONFLICT");
    } else {
      if (current.status !== "active") return fail("PROJECT_AI_PROVIDER_DELEGATION_STATE_CONFLICT");
      const selected = await tx.projectAiEffectiveRouteSelection.findUnique({
        where: { projectId_operation: { projectId, operation: current.operation } },
        select: selectionSelect,
      });
      if (selected?.source === "personalDelegation" && selected.delegationId === current.id) {
        if (!switchToPlatformDefault) return fail("PROJECT_AI_PROVIDER_DELEGATION_SELECTION_SWITCH_REQUIRED");
        const switchMembership = projectOwnerMembership ?? (isOwner ? actorMembership : null);
        if (switchMembership === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_PROJECT_OWNER_REQUIRED");
        const changedSelection = await tx.projectAiEffectiveRouteSelection.updateMany({
          where: { id: selected.id, version: selected.version, source: "personalDelegation", delegationId: current.id },
          data: { version: selected.version + 1, source: "platformDefault", delegationId: null, selectedById: admission.actor.id, selectedByProjectMembershipId: switchMembership.id, selectedByMembershipCreatedAt: switchMembership.createdAt },
        });
        if (changedSelection.count !== 1) return fail("PROJECT_AI_PROVIDER_DELEGATION_VERSION_CONFLICT");
        const nextSelection = await tx.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: selected.id } });
        await appendSelectionAudit(
          tx,
          nextSelection,
          "selectionUpdated",
          projectOwnerMembership === null
            ? "delegation_owner_revocation_explicit_platform_switch"
            : "selection_switched_to_platform_before_revocation",
        );
      }
    }

    const changed = await tx.projectAiProviderDelegation.updateMany({
      where: { id: current.id, version: expectedVersion, status: current.status },
      data: {
        version: expectedVersion + 1,
        status: transition,
        terminalActorId: admission.actor.id,
        terminalActorProjectMembershipId: actorMembership.id,
        terminalActorMembershipCreatedAt: actorMembership.createdAt,
        terminalReason: reason,
      },
    });
    if (changed.count !== 1) return fail("PROJECT_AI_PROVIDER_DELEGATION_VERSION_CONFLICT");
    const next = await tx.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: current.id } });
    await appendDelegationAudit(tx, next, transition, current.status, admission.actor.id, actorMembership.id, actorMembership.createdAt, reason);
    const row = await loadDelegation(tx, projectId, current.id);
    if (row === null) return fail("PROJECT_AI_PROVIDER_DELEGATION_CONFLICT");
    return delegationView(row, admission.actor.id, projectOwnerMembership !== null, null);
  });
}

export async function confirmProjectAiProviderDelegationOwner(
  projectIdInput: string,
  delegationIdInput: string,
  input: unknown,
  actor: WebAiActor,
  db: DelegationDb = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  const delegationId = parseUuid(delegationIdInput);
  const parsed = parseInput(ownerConfirmationSchema, input);
  return mutateDelegation(projectId, delegationId, parsed.expectedVersion, actor, db, "ownerConfirmed", "owner_confirmation_acknowledged_provider_charges", { providerCharges: true });
}

export async function confirmProjectAiProviderDelegationProject(
  projectIdInput: string,
  delegationIdInput: string,
  input: unknown,
  actor: WebAiActor,
  db: DelegationDb = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  const delegationId = parseUuid(delegationIdInput);
  const parsed = parseInput(projectConfirmationSchema, input);
  return mutateDelegation(projectId, delegationId, parsed.expectedVersion, actor, db, "active", "project_confirmation_acknowledged_data_egress_and_index_impact", { dataEgress: true, indexImpact: true });
}

export async function rejectProjectAiProviderDelegation(
  projectIdInput: string,
  delegationIdInput: string,
  input: unknown,
  actor: WebAiActor,
  db: DelegationDb = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  const delegationId = parseUuid(delegationIdInput);
  const parsed = parseInput(terminalSchema, input);
  return mutateDelegation(projectId, delegationId, parsed.expectedVersion, actor, db, "rejected", parsed.reason);
}

export async function revokeProjectAiProviderDelegation(
  projectIdInput: string,
  delegationIdInput: string,
  input: unknown,
  actor: WebAiActor,
  db: DelegationDb = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  const delegationId = parseUuid(delegationIdInput);
  const parsed = parseInput(revocationSchema, input);
  return mutateDelegation(projectId, delegationId, parsed.expectedVersion, actor, db, "revoked", parsed.reason, undefined, parsed.switchToPlatformDefault);
}

async function selectionOwnerId(db: DelegationDb, projectId: string, input: z.infer<typeof selectionSchema>): Promise<string | null> {
  if (input.delegationId === null) return null;
  return loadDelegationOwner(db, projectId, input.delegationId);
}

export async function putProjectAiEffectiveRouteSelection(
  projectIdInput: string,
  operationInput: string,
  input: unknown,
  actor: WebAiActor,
  db: DelegationDb = getDb(),
) {
  const projectId = parseUuid(projectIdInput);
  const operation = operationSchema.safeParse(operationInput);
  if (!operation.success) return fail("PROJECT_AI_PROVIDER_DELEGATION_INVALID_INPUT");
  const parsed = parseInput(selectionSchema, input);
  const ownerId = await selectionOwnerId(db, projectId, parsed);
  return runMutation(db, actor, projectId, ownerId === null ? [] : [ownerId], async (tx, admission) => {
    const ownerMembership = await requireProjectOwnerMembership(tx, projectId, admission.actor.id);
    const existing = await tx.projectAiEffectiveRouteSelection.findUnique({
      where: { projectId_operation: { projectId, operation: operation.data } },
      select: selectionSelect,
    });
    if (existing === null && parsed.expectedVersion !== null) return fail("PROJECT_AI_PROVIDER_DELEGATION_VERSION_CONFLICT");
    if (existing !== null && (parsed.expectedVersion === null || existing.version !== parsed.expectedVersion)) return fail("PROJECT_AI_PROVIDER_DELEGATION_VERSION_CONFLICT");

    if (parsed.source === "personalDelegation") {
      const delegation = await loadDelegation(tx, projectId, parsed.delegationId!);
      if (delegation === null || delegation.operation !== operation.data || delegation.status !== "active") return fail("PROJECT_AI_PROVIDER_DELEGATION_STATE_CONFLICT");
      await assertLiveDelegationDependencies(tx, delegation, await databaseNow(tx));
    }

    const row = existing === null
      ? await tx.projectAiEffectiveRouteSelection.create({
          data: {
            id: randomUUID(),
            projectId,
            operation: operation.data,
            source: parsed.source,
            delegationId: parsed.delegationId,
            selectedById: admission.actor.id,
            selectedByProjectMembershipId: ownerMembership.id,
            selectedByMembershipCreatedAt: ownerMembership.createdAt,
          },
          select: selectionSelect,
        })
      : await tx.projectAiEffectiveRouteSelection.updateMany({
          where: { id: existing.id, version: existing.version },
          data: {
            version: existing.version + 1,
            source: parsed.source,
            delegationId: parsed.delegationId,
            selectedById: admission.actor.id,
            selectedByProjectMembershipId: ownerMembership.id,
            selectedByMembershipCreatedAt: ownerMembership.createdAt,
          },
        }).then(async (result) => {
          if (result.count !== 1) return fail("PROJECT_AI_PROVIDER_DELEGATION_VERSION_CONFLICT");
          return tx.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: existing.id }, select: selectionSelect });
        });
    await appendSelectionAudit(tx, row, existing === null
      ? (parsed.source === "platformDefault" ? "platformSelected" : "personalSelected")
      : "selectionUpdated", existing === null ? "selection_created" : "selection_updated");
    return Object.freeze({
      id: row.id,
      projectId: row.projectId,
      operation: row.operation,
      source: row.source,
      version: row.version,
      selected: true,
      ...getProjectAiOperationCapability(row.operation),
      updatedAt: row.updatedAt.toISOString(),
    });
  });
}
