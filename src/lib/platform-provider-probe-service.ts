import { createHash } from "node:crypto";
import {
  Prisma,
  type PlatformProviderProbeAttemptStatus,
  type PlatformProviderProbeCapability,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";
import { lockMembershipUser } from "@/lib/ai-entitlements";
import {
  assertPlatformProviderAdmin,
  assertPlatformProviderAdminHint,
  lockProviderConfiguration,
  type PlatformProviderActor,
} from "@/lib/ai-providers/service";
import {
  PROVIDER_REQUEST_TIMEOUT_MS,
  ProviderTransportError,
  invokeChatCompletion,
  invokeEmbeddings,
  invokeVisionCompletion,
} from "@/lib/ai-providers/transport";
import { canonicalProviderBaseUrl, getProviderDefinition } from "@/lib/ai-providers/registry";
import { getDb } from "@/lib/db";

export type PlatformProviderProbeServiceErrorCode =
  | "PLATFORM_PROVIDER_PROBE_INVALID_INPUT"
  | "PLATFORM_PROVIDER_PROBE_ADMIN_REQUIRED"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_NOT_FOUND"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_DISABLED"
  | "PLATFORM_PROVIDER_PROBE_CANONICAL_ENDPOINT_REQUIRED"
  | "PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT"
  | "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED"
  | "PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED"
  | "PLATFORM_PROVIDER_PROBE_IDEMPOTENCY_CONFLICT"
  | "PLATFORM_PROVIDER_PROBE_IN_PROGRESS"
  | "PLATFORM_PROVIDER_PROBE_RECONCILIATION_REQUIRED"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_AUTH_FAILED"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_RATE_LIMITED"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_REJECTED"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_INVALID_RESPONSE"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_RESPONSE_TOO_LARGE"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_TIMEOUT"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_EMBEDDING_UNSUPPORTED"
  | "PLATFORM_PROVIDER_PROBE_PROVIDER_VISION_UNSUPPORTED"
  | "PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH"
  | "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD";

export class PlatformProviderProbeServiceError extends Error {
  constructor(readonly code: PlatformProviderProbeServiceErrorCode) {
    super(code);
    this.name = "PlatformProviderProbeServiceError";
  }
}

export const PLATFORM_PROVIDER_PROBE_MAX_BODY_BYTES = 4 * 1024;
export const PLATFORM_PROVIDER_PROBE_MAX_UNITS = 3;
export const PLATFORM_PROVIDER_PROBE_LEASE_MS = PROVIDER_REQUEST_TIMEOUT_MS * PLATFORM_PROVIDER_PROBE_MAX_UNITS + 15_000;
export const PLATFORM_PROVIDER_PROBE_MAX_BUDGET_UNITS = 10_000;
export const PLATFORM_PROVIDER_PROBE_MAX_BUDGET_DURATION_MS = 90 * 24 * 60 * 60 * 1_000;

const probeInputSchema = z.object({
  clientRequestKey: z.string().uuid(),
  expectedConfigurationVersion: z.number().int().positive(),
}).strict();

const budgetInputSchema = z.object({
  unitLimit: z.number().int().min(1).max(PLATFORM_PROVIDER_PROBE_MAX_BUDGET_UNITS),
  alertThresholdUnits: z.number().int().min(0).max(PLATFORM_PROVIDER_PROBE_MAX_BUDGET_UNITS),
  startsAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
  expiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
}).strict().superRefine((value, context) => {
  if (value.alertThresholdUnits > value.unitLimit) {
    context.addIssue({ code: "custom", path: ["alertThresholdUnits"], message: "alertThresholdUnits must not exceed unitLimit" });
  }
  if (value.expiresAt <= value.startsAt) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt must be after startsAt" });
  }
  if (value.expiresAt.getTime() - value.startsAt.getTime() > PLATFORM_PROVIDER_PROBE_MAX_BUDGET_DURATION_MS) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "budget duration exceeds the safety bound" });
  }
});

type ProbeInput = z.infer<typeof probeInputSchema>;
type BudgetInput = z.infer<typeof budgetInputSchema>;
type ProbeDb = PrismaClient | Prisma.TransactionClient;

type ProviderProbeRow = Readonly<{
  id: string;
  kind: "openai" | "deepseek" | "qwen" | "glm";
  scope: "platform" | "user";
  ownerUserId: string | null;
  protocol: "chatCompletions";
  baseUrl: string;
  credentialId: string;
  defaultGenerationModelId: string | null;
  defaultEmbeddingModelId: string | null;
  defaultVisionModelId: string | null;
  embeddingDimensions: number | null;
  configurationVersion: number;
  status: "configured" | "verified" | "error" | "disabled";
  disabledAt: Date | null;
}>;

const providerProbeSelect = {
  id: true,
  kind: true,
  scope: true,
  ownerUserId: true,
  protocol: true,
  baseUrl: true,
  credentialId: true,
  defaultGenerationModelId: true,
  defaultEmbeddingModelId: true,
  defaultVisionModelId: true,
  embeddingDimensions: true,
  configurationVersion: true,
  status: true,
  disabledAt: true,
} as const;

const attemptPublicSelect = {
  id: true,
  actorId: true,
  status: true,
  safeErrorCode: true,
  plannedUnits: true,
  dispatchedUnits: true,
  settledUnits: true,
  releasedUnits: true,
  heldUnits: true,
  ledgerEvents: {
    select: { event: true, capability: true, safeErrorCode: true, dimensions: true, ordinal: true, units: true },
    orderBy: [{ ordinal: "asc" as const }, { createdAt: "asc" as const }],
  },
} satisfies Prisma.PlatformProviderProbeAttemptSelect;

type AttemptPublicRow = Prisma.PlatformProviderProbeAttemptGetPayload<{ select: typeof attemptPublicSelect }>;

function fail(code: PlatformProviderProbeServiceErrorCode): never {
  throw new PlatformProviderProbeServiceError(code);
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function clientRequestKeyHash(value: string): string {
  return hashValue(`ai-project-os:platform-provider-probe:key:v1:${value}`);
}

function requestFingerprint(providerId: string, expectedConfigurationVersion: number): string {
  return hashValue(JSON.stringify({ providerId, expectedConfigurationVersion }));
}

function safeProviderErrorCode(error: ProviderTransportError): PlatformProviderProbeServiceErrorCode {
  switch (error.code) {
    case "AI_PROVIDER_AUTH_FAILED": return "PLATFORM_PROVIDER_PROBE_PROVIDER_AUTH_FAILED";
    case "AI_PROVIDER_RATE_LIMITED": return "PLATFORM_PROVIDER_PROBE_PROVIDER_RATE_LIMITED";
    case "AI_PROVIDER_REJECTED": return "PLATFORM_PROVIDER_PROBE_PROVIDER_REJECTED";
    case "AI_PROVIDER_INVALID_RESPONSE": return "PLATFORM_PROVIDER_PROBE_PROVIDER_INVALID_RESPONSE";
    case "AI_PROVIDER_RESPONSE_TOO_LARGE": return "PLATFORM_PROVIDER_PROBE_PROVIDER_RESPONSE_TOO_LARGE";
    case "AI_PROVIDER_TIMEOUT": return "PLATFORM_PROVIDER_PROBE_PROVIDER_TIMEOUT";
    case "AI_PROVIDER_EMBEDDING_UNSUPPORTED": return "PLATFORM_PROVIDER_PROBE_PROVIDER_EMBEDDING_UNSUPPORTED";
    case "AI_PROVIDER_VISION_UNSUPPORTED": return "PLATFORM_PROVIDER_PROBE_PROVIDER_VISION_UNSUPPORTED";
    case "AI_PROVIDER_UNAVAILABLE": return "PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE";
  }
}

function knownResponseError(error: ProviderTransportError): boolean {
  return [
    "AI_PROVIDER_AUTH_FAILED",
    "AI_PROVIDER_RATE_LIMITED",
    "AI_PROVIDER_REJECTED",
    "AI_PROVIDER_INVALID_RESPONSE",
    "AI_PROVIDER_RESPONSE_TOO_LARGE",
    "AI_PROVIDER_EMBEDDING_UNSUPPORTED",
    "AI_PROVIDER_VISION_UNSUPPORTED",
  ].includes(error.code);
}

function capabilityList(provider: ProviderProbeRow): readonly Readonly<{
  capability: PlatformProviderProbeCapability;
  modelId: string;
  dimensions: number | null;
}>[] {
  const capabilities: Array<Readonly<{ capability: PlatformProviderProbeCapability; modelId: string; dimensions: number | null }>> = [];
  if (provider.defaultGenerationModelId !== null) {
    capabilities.push({ capability: "generation", modelId: provider.defaultGenerationModelId, dimensions: null });
  }
  if (provider.defaultEmbeddingModelId !== null && provider.embeddingDimensions !== null) {
    capabilities.push({ capability: "embedding", modelId: provider.defaultEmbeddingModelId, dimensions: provider.embeddingDimensions });
  }
  if (provider.defaultVisionModelId !== null && getProviderDefinition(provider.kind).supportsVision) {
    capabilities.push({ capability: "vision", modelId: provider.defaultVisionModelId, dimensions: null });
  }
  return Object.freeze(capabilities);
}

function safeCapabilityStatus(
  rows: AttemptPublicRow["ledgerEvents"],
  capability: PlatformProviderProbeCapability,
): "passed" | "notConfigured" {
  const settled = rows.find((row) => row.event === "settled" && row.capability === capability);
  if (settled === undefined) return "notConfigured";
  return settled.safeErrorCode === null ? "passed" : "notConfigured";
}

function publicAttempt(row: AttemptPublicRow) {
  const capabilities = Object.freeze({
    generation: safeCapabilityStatus(row.ledgerEvents, "generation"),
    embedding: safeCapabilityStatus(row.ledgerEvents, "embedding"),
    vision: safeCapabilityStatus(row.ledgerEvents, "vision"),
  });
  const dimensions = row.ledgerEvents.find((event) => event.event === "settled" && event.capability === "embedding")?.dimensions ?? null;
  const status = row.status === "reserved" || row.status === "running"
    ? "inProgress"
    : row.status;
  return Object.freeze({
    attempt: Object.freeze({
      status,
      safeErrorCode: row.safeErrorCode,
      plannedUnits: row.plannedUnits,
      dispatchedUnits: row.dispatchedUnits,
      settledUnits: row.settledUnits,
      releasedUnits: row.releasedUnits,
      heldUnits: row.heldUnits,
      capabilities,
      embeddingDimensions: dimensions,
    }),
  });
}

async function attemptWithPublic(db: ProbeDb, attemptId: string) {
  const row = await db.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: attemptPublicSelect });
  if (row === null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE");
  return publicAttempt(row);
}

async function lockProbeBudget(db: ProbeDb): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('ai-project-os:platform-provider-probe:budget', 40904005))`;
}

async function setProbeMutationContext(db: ProbeDb): Promise<void> {
  // Probe table triggers require this transaction-local marker. It prevents
  // ad-hoc ORM/raw writes from looking like a valid state transition.
  await db.$executeRaw`SELECT set_config('ai_project_os.platform_provider_probe_mutation', 'service-v1', true)`;
}

async function currentCredentialFingerprint(db: ProbeDb, credentialId: string): Promise<string | null> {
  const credential = await db.externalCredential.findUnique({ where: { id: credentialId }, select: { secretFingerprint: true } });
  return credential?.secretFingerprint ?? null;
}

async function createRejectedAttempt(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    budgetId?: string;
    providerId: string;
    actor: PlatformProviderActor;
    providerConfigurationVersion: number;
    keyHash: string;
    fingerprint: string;
    safeErrorCode: PlatformProviderProbeServiceErrorCode;
    now: Date;
  }>,
) {
  const attempt = await tx.platformProviderProbeAttempt.create({
    data: {
      budgetId: input.budgetId ?? null,
      providerConnectionId: input.providerId,
      actorId: input.actor.id,
      actorAccountAccessVersion: input.actor.accountAccessVersion ?? 1,
      providerConfigurationVersion: input.providerConfigurationVersion,
      clientRequestKeyHash: input.keyHash,
      requestFingerprint: input.fingerprint,
      status: "rejected",
      safeErrorCode: input.safeErrorCode,
      plannedUnits: 0,
      leaseExpiresAt: input.now,
      terminalAt: input.now,
    },
    select: { id: true },
  });
  await tx.platformProviderProbeLedger.create({
    data: {
      budgetId: input.budgetId ?? null,
      attemptId: attempt.id,
      actorId: input.actor.id,
      ordinal: 0,
      event: "rejected",
      capability: null,
      units: 0,
      safeErrorCode: input.safeErrorCode,
    },
  });
  return attempt.id;
}

type Admission = Readonly<{
  attemptId: string;
  provider: ProviderProbeRow;
  credentialSecretFingerprint: string;
  capabilities: readonly Readonly<{ capability: PlatformProviderProbeCapability; modelId: string; dimensions: number | null }>[];
  terminal: boolean;
  deadlineAt: Date;
}>;

async function admitProbe(
  providerId: string,
  actor: PlatformProviderActor,
  input: ProbeInput,
  db: PrismaClient,
  now = new Date(),
  retry = 0,
): Promise<Admission> {
  const actorHint = assertPlatformProviderAdminHint(actor);
  const keyHash = clientRequestKeyHash(input.clientRequestKey);
  const fingerprint = requestFingerprint(providerId, input.expectedConfigurationVersion);
  try {
    return await db.$transaction(async (tx) => {
      await setProbeMutationContext(tx);
      await lockMembershipUser(tx, actorHint.id);
      const currentActor = await assertPlatformProviderAdmin(actorHint, tx);
      await lockProviderConfiguration(tx, providerId);
      const provider = await tx.aiProviderConnection.findFirst({ where: { id: providerId }, select: providerProbeSelect }) as ProviderProbeRow | null;
      if (provider === null || provider.scope !== "platform" || provider.ownerUserId !== null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_NOT_FOUND");
      if (provider.configurationVersion !== input.expectedConfigurationVersion) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
      if (provider.status === "disabled" || provider.disabledAt !== null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_DISABLED");
      if (provider.protocol !== "chatCompletions" || provider.baseUrl !== canonicalProviderBaseUrl(provider.kind)) {
        fail("PLATFORM_PROVIDER_PROBE_CANONICAL_ENDPOINT_REQUIRED");
      }

      const existing = await tx.platformProviderProbeAttempt.findUnique({
        where: { providerConnectionId_actorId_clientRequestKeyHash: { providerConnectionId: providerId, actorId: currentActor.id, clientRequestKeyHash: keyHash } },
        select: { id: true, actorId: true, requestFingerprint: true, status: true },
      });
      if (existing !== null) {
        if (existing.actorId !== currentActor.id || existing.requestFingerprint !== fingerprint) fail("PLATFORM_PROVIDER_PROBE_IDEMPOTENCY_CONFLICT");
        return {
          attemptId: existing.id,
          provider,
          credentialSecretFingerprint: "",
          capabilities: capabilityList(provider),
          // An existing key is always a replay. In particular, a reserved or
          // running row must never be claimed by a second HTTP request.
          terminal: true,
          deadlineAt: now,
        };
      }

      const held = await tx.platformProviderProbeAttempt.findFirst({ where: { providerConnectionId: providerId, providerConfigurationVersion: input.expectedConfigurationVersion, status: "held" }, select: { id: true } });
      if (held !== null) fail("PLATFORM_PROVIDER_PROBE_RECONCILIATION_REQUIRED");

      const active = await tx.platformProviderProbeAttempt.findFirst({
        where: { providerConnectionId: providerId, status: { in: ["reserved", "running"] } },
        select: { id: true },
      });
      if (active !== null) fail("PLATFORM_PROVIDER_PROBE_IN_PROGRESS");

      await lockProbeBudget(tx);
      const budget = await tx.platformProviderProbeBudget.findFirst({
        where: { status: "active", startsAt: { lte: now }, expiresAt: { gt: now } },
        orderBy: { version: "desc" },
      });
      const capabilities = capabilityList(provider);
      if (capabilities.length === 0) {
        const attemptId = await createRejectedAttempt(tx, {
          providerId,
          actor: currentActor,
          providerConfigurationVersion: provider.configurationVersion,
          keyHash,
          fingerprint,
          safeErrorCode: "PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE",
          now,
        });
        return { attemptId, provider, credentialSecretFingerprint: "", capabilities, terminal: true, deadlineAt: now };
      }
      if (budget === null) {
        const attemptId = await createRejectedAttempt(tx, {
          providerId,
          actor: currentActor,
          providerConfigurationVersion: provider.configurationVersion,
          keyHash,
          fingerprint,
          safeErrorCode: "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED",
          now,
        });
        return { attemptId, provider, credentialSecretFingerprint: "", capabilities, terminal: true, deadlineAt: now };
      }
      const available = budget.unitLimit - budget.reservedUnits - budget.settledUnits - budget.heldUnits;
      if (available < capabilities.length) {
        const attemptId = await createRejectedAttempt(tx, {
          budgetId: budget.id,
          providerId,
          actor: currentActor,
          providerConfigurationVersion: provider.configurationVersion,
          keyHash,
          fingerprint,
          safeErrorCode: "PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED",
          now,
        });
        return { attemptId, provider, credentialSecretFingerprint: "", capabilities, terminal: true, deadlineAt: now };
      }
      const credentialSecretFingerprint = await currentCredentialFingerprint(tx, provider.credentialId);
      if (credentialSecretFingerprint === null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE");
      const attempt = await tx.platformProviderProbeAttempt.create({
        data: {
          budgetId: budget.id,
          providerConnectionId: provider.id,
          actorId: currentActor.id,
          actorAccountAccessVersion: currentActor.accountAccessVersion ?? 1,
          providerConfigurationVersion: provider.configurationVersion,
          credentialSecretFingerprint,
          clientRequestKeyHash: keyHash,
          requestFingerprint: fingerprint,
          status: "reserved",
          plannedUnits: capabilities.length,
          leaseExpiresAt: new Date(now.getTime() + PLATFORM_PROVIDER_PROBE_LEASE_MS),
        },
        select: { id: true },
      });
      await tx.platformProviderProbeBudget.update({ where: { id: budget.id }, data: { reservedUnits: { increment: capabilities.length } } });
      for (const [index, capability] of capabilities.entries()) {
        await tx.platformProviderProbeLedger.create({
          data: { budgetId: budget.id, attemptId: attempt.id, actorId: currentActor.id, ordinal: index + 1, event: "reserved", capability: capability.capability, units: 1 },
        });
      }
      return { attemptId: attempt.id, provider, credentialSecretFingerprint, capabilities, terminal: false, deadlineAt: new Date(now.getTime() + PLATFORM_PROVIDER_PROBE_LEASE_MS) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
  } catch (error) {
    if (isKnown(error, "P2002")) {
      const existing = await db.platformProviderProbeAttempt.findUnique({
        where: { providerConnectionId_actorId_clientRequestKeyHash: { providerConnectionId: providerId, actorId: actorHint.id, clientRequestKeyHash: keyHash } },
        select: { id: true },
      });
      if (existing !== null && retry < 1) return admitProbe(providerId, actorHint, input, db, now, retry + 1);
      const active = await db.platformProviderProbeAttempt.findFirst({ where: { providerConnectionId: providerId, status: { in: ["reserved", "running"] } }, select: { id: true } });
      if (active !== null) fail("PLATFORM_PROVIDER_PROBE_IN_PROGRESS");
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && retry < 2) {
      return admitProbe(providerId, actorHint, input, db, now, retry + 1);
    }
    throw error;
  }
}

async function verifyProbeFence(
  attemptId: string,
  providerId: string,
  expectedConfigurationVersion: number,
  expectedCredentialFingerprint: string,
  db: PrismaClient,
): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      const initialAttempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { actorId: true, actorAccountAccessVersion: true, budgetId: true, providerConnectionId: true, status: true } });
      if (initialAttempt === null || initialAttempt.providerConnectionId !== providerId || (initialAttempt.status !== "reserved" && initialAttempt.status !== "running")) return false;
      await lockMembershipUser(tx, initialAttempt.actorId);
      const actor = await tx.appUser.findUnique({ where: { id: initialAttempt.actorId }, select: { role: true, disabledAt: true, accountAccessVersion: true } });
      if (actor === null || actor.role !== "admin" || actor.disabledAt !== null || actor.accountAccessVersion !== initialAttempt.actorAccountAccessVersion) return false;
      await lockProviderConfiguration(tx, providerId);
      const provider = await tx.aiProviderConnection.findFirst({ where: { id: providerId, scope: "platform", ownerUserId: null }, select: providerProbeSelect }) as ProviderProbeRow | null;
      if (provider === null || provider.status === "disabled" || provider.disabledAt !== null) return false;
      if (provider.protocol !== "chatCompletions" || provider.configurationVersion !== expectedConfigurationVersion || provider.baseUrl !== canonicalProviderBaseUrl(provider.kind)) return false;
      const fingerprint = await currentCredentialFingerprint(tx, provider.credentialId);
      if (fingerprint !== expectedCredentialFingerprint) return false;
      const budget = initialAttempt.budgetId === null
        ? null
        : (await lockProbeBudget(tx), await tx.platformProviderProbeBudget.findUnique({ where: { id: initialAttempt.budgetId }, select: { status: true, startsAt: true, expiresAt: true } }));
      const now = new Date();
      return budget !== null && budget.status === "active" && budget.startsAt <= now && budget.expiresAt > now;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 5_000 });
  } catch {
    return false;
  }
}

async function markProbeDispatched(
  attemptId: string,
  providerId: string,
  ordinal: number,
  capability: PlatformProviderProbeCapability,
  expectedConfigurationVersion: number,
  expectedCredentialFingerprint: string,
  db: PrismaClient,
): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      await setProbeMutationContext(tx);
      const initialAttempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { actorId: true, actorAccountAccessVersion: true, budgetId: true, providerConnectionId: true, status: true } });
      if (initialAttempt === null || initialAttempt.providerConnectionId !== providerId || (initialAttempt.status !== "reserved" && initialAttempt.status !== "running")) return false;
      await lockMembershipUser(tx, initialAttempt.actorId);
      const actor = await tx.appUser.findUnique({ where: { id: initialAttempt.actorId }, select: { role: true, disabledAt: true, accountAccessVersion: true } });
      if (actor === null || actor.role !== "admin" || actor.disabledAt !== null || actor.accountAccessVersion !== initialAttempt.actorAccountAccessVersion) return false;
      await lockProviderConfiguration(tx, providerId);
      const provider = await tx.aiProviderConnection.findFirst({ where: { id: providerId, scope: "platform", ownerUserId: null }, select: providerProbeSelect }) as ProviderProbeRow | null;
      if (
        provider === null
        || provider.status === "disabled"
        || provider.disabledAt !== null
        || provider.configurationVersion !== expectedConfigurationVersion
        || provider.protocol !== "chatCompletions"
        || provider.baseUrl !== canonicalProviderBaseUrl(provider.kind)
      ) return false;
      if (initialAttempt.budgetId !== null) await lockProbeBudget(tx);
      const fingerprint = await currentCredentialFingerprint(tx, provider.credentialId);
      if (fingerprint !== expectedCredentialFingerprint) return false;
      const existing = await tx.platformProviderProbeLedger.findUnique({ where: { attemptId_ordinal_event: { attemptId, ordinal, event: "dispatched" } }, select: { id: true } });
      if (existing !== null) return true;
      const budget = initialAttempt.budgetId === null
        ? null
        : await tx.platformProviderProbeBudget.findUnique({ where: { id: initialAttempt.budgetId }, select: { status: true, startsAt: true, expiresAt: true } });
      const now = new Date();
      if (budget === null || budget.status !== "active" || budget.startsAt > now || budget.expiresAt <= now) return false;
      await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: initialAttempt.budgetId, actorId: initialAttempt.actorId, ordinal, event: "dispatched", capability, units: 1 } });
      await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { status: "running", dispatchedUnits: { increment: 1 }, startedAt: new Date() } });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 5_000, maxWait: 5_000 });
  } catch (error) {
    if (isKnown(error, "P2002")) {
      const existing = await db.platformProviderProbeLedger.findUnique({ where: { attemptId_ordinal_event: { attemptId, ordinal, event: "dispatched" } }, select: { capability: true } });
      return existing?.capability === capability;
    }
    return false;
  }
}

async function settleProbeOrdinal(
  attemptId: string,
  providerId: string,
  ordinal: number,
  safeErrorCode: PlatformProviderProbeServiceErrorCode | null,
  dimensions: number | null,
  db: PrismaClient,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await setProbeMutationContext(tx);
    const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { budgetId: true, providerConnectionId: true, actorId: true, status: true } });
    if (attempt === null || attempt.providerConnectionId !== providerId || ["settled", "released", "held", "rejected"].includes(attempt.status)) return;
    await lockMembershipUser(tx, attempt.actorId);
    await lockProviderConfiguration(tx, attempt.providerConnectionId);
    if (attempt.budgetId !== null) await lockProbeBudget(tx);
    const terminal = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: { in: ["settled", "released", "held"] } }, select: { id: true } });
    if (terminal !== null) return;
    const dispatch = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "dispatched" }, select: { budgetId: true, capability: true } });
    const reserved = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "reserved" }, select: { capability: true } });
    if (dispatch === null) return;
    await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal, event: "settled", capability: dispatch.capability ?? reserved?.capability ?? "generation", units: 1, safeErrorCode, dimensions } });
    await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { settledUnits: { increment: 1 }, ...(safeErrorCode === null ? {} : { safeErrorCode }) } });
    if (attempt.budgetId !== null) {
      await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: { reservedUnits: { decrement: 1 }, settledUnits: { increment: 1 } } });
      await createThresholdNotifications(tx, attempt.budgetId);
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 8_000, maxWait: 8_000 });
}

async function releaseProbeOrdinal(
  attemptId: string,
  ordinal: number,
  safeErrorCode: PlatformProviderProbeServiceErrorCode,
  db: PrismaClient,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await setProbeMutationContext(tx);
    const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { budgetId: true, providerConnectionId: true, actorId: true, status: true } });
    if (attempt === null || ["settled", "released", "held", "rejected"].includes(attempt.status)) return;
    await lockMembershipUser(tx, attempt.actorId);
    await lockProviderConfiguration(tx, attempt.providerConnectionId);
    if (attempt.budgetId !== null) await lockProbeBudget(tx);
    const existing = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: { in: ["settled", "released", "held"] } }, select: { id: true } });
    if (existing !== null) return;
    const dispatch = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "dispatched" }, select: { id: true } });
    const reserved = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "reserved" }, select: { capability: true } });
    if (dispatch !== null) return;
    await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal, event: "released", capability: reserved?.capability ?? "generation", units: 1, safeErrorCode } });
    await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { releasedUnits: { increment: 1 }, safeErrorCode } });
    if (attempt.budgetId !== null) await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: { reservedUnits: { decrement: 1 } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 8_000, maxWait: 8_000 });
}

async function holdProbeOrdinal(
  attemptId: string,
  ordinal: number,
  safeErrorCode: PlatformProviderProbeServiceErrorCode,
  db: PrismaClient,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await setProbeMutationContext(tx);
    const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { budgetId: true, providerConnectionId: true, actorId: true, status: true } });
    if (attempt === null || ["settled", "released", "held", "rejected"].includes(attempt.status)) return;
    await lockMembershipUser(tx, attempt.actorId);
    await lockProviderConfiguration(tx, attempt.providerConnectionId);
    if (attempt.budgetId !== null) await lockProbeBudget(tx);
    const existing = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: { in: ["settled", "released", "held"] } }, select: { id: true } });
    if (existing !== null) return;
    const dispatch = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "dispatched" }, select: { id: true, capability: true } });
    const reserved = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "reserved" }, select: { capability: true } });
    if (dispatch === null) return;
    await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal, event: "held", capability: dispatch.capability ?? reserved?.capability ?? "generation", units: 1, safeErrorCode } });
    await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { heldUnits: { increment: 1 }, safeErrorCode } });
    if (attempt.budgetId !== null) {
      await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: { reservedUnits: { decrement: 1 }, heldUnits: { increment: 1 } } });
      await createThresholdNotifications(tx, attempt.budgetId);
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 8_000, maxWait: 8_000 });
}

async function createThresholdNotifications(tx: Prisma.TransactionClient, budgetId: string): Promise<void> {
  const budget = await tx.platformProviderProbeBudget.findUnique({ where: { id: budgetId }, select: { alertThresholdUnits: true, settledUnits: true, heldUnits: true, version: true } });
  if (budget === null || budget.alertThresholdUnits <= 0 || budget.settledUnits + budget.heldUnits < budget.alertThresholdUnits) return;
  const admins = await tx.appUser.findMany({ where: { role: "admin", disabledAt: null }, select: { id: true } });
  const dedupeKey = hashValue(`ai-project-os:platform-provider-probe:threshold:v1:${budget.version}:${budget.alertThresholdUnits}`);
  for (const admin of admins) {
    await tx.notification.upsert({
      where: { userId_dedupeKey: { userId: admin.id, dedupeKey } },
      create: { userId: admin.id, kind: "system", severity: "warning", title: "平台连接探测预算已达到告警阈值", body: "平台连接探测需要管理员关注预算摘要；未知外发不会自动重试。", dedupeKey },
      update: {},
    });
  }
}

async function finalizeProbe(
  attemptId: string,
  safeErrorCode: PlatformProviderProbeServiceErrorCode | null,
  db: PrismaClient,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await setProbeMutationContext(tx);
    const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { budgetId: true, providerConnectionId: true, actorId: true, actorAccountAccessVersion: true, providerConfigurationVersion: true, credentialSecretFingerprint: true, plannedUnits: true, status: true, settledUnits: true, releasedUnits: true, heldUnits: true, safeErrorCode: true } });
    if (attempt === null || ["settled", "released", "held", "rejected"].includes(attempt.status)) return;
    await lockMembershipUser(tx, attempt.actorId);
    const currentActor = await tx.appUser.findUnique({ where: { id: attempt.actorId }, select: { role: true, disabledAt: true, accountAccessVersion: true } });
    const actorCurrent = currentActor !== null
      && currentActor.role === "admin"
      && currentActor.disabledAt === null
      && currentActor.accountAccessVersion === attempt.actorAccountAccessVersion;
    await lockProviderConfiguration(tx, attempt.providerConnectionId);
    if (attempt.budgetId !== null) await lockProbeBudget(tx);
    const events = await tx.platformProviderProbeLedger.findMany({ where: { attemptId }, select: { ordinal: true, event: true } });
    const terminalOrdinals = new Set(events.filter((event) => ["settled", "released", "held"].includes(event.event)).map((event) => event.ordinal));
    const dispatchOrdinals = new Set(events.filter((event) => event.event === "dispatched").map((event) => event.ordinal));
    for (let ordinal = 1; ordinal <= attempt.plannedUnits; ordinal += 1) {
      if (terminalOrdinals.has(ordinal)) continue;
      if (dispatchOrdinals.has(ordinal)) {
        const dispatch = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "dispatched" }, select: { capability: true } });
        const reserved = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "reserved" }, select: { capability: true } });
        await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal, event: "held", capability: dispatch?.capability ?? reserved?.capability ?? "generation", units: 1, safeErrorCode: safeErrorCode ?? "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD" } });
        await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { heldUnits: { increment: 1 }, safeErrorCode: safeErrorCode ?? "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD" } });
        if (attempt.budgetId !== null) await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: { reservedUnits: { decrement: 1 }, heldUnits: { increment: 1 } } });
      } else {
        const reserved = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "reserved" }, select: { capability: true } });
        const releaseError = safeErrorCode ?? attempt.safeErrorCode ?? "PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE";
        await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal, event: "released", capability: reserved?.capability ?? "generation", units: 1, safeErrorCode: releaseError } });
        await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { releasedUnits: { increment: 1 }, safeErrorCode: releaseError } });
        if (attempt.budgetId !== null) await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: { reservedUnits: { decrement: 1 } } });
      }
    }
    const final = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { settledUnits: true, releasedUnits: true, heldUnits: true, safeErrorCode: true } });
    // The append-only ledger is the authoritative record of a known provider
    // outcome.  Do not let a later successful capability, or an older attempt
    // field, clear an error that was already accounted for on the wire.
    const ledgerError = (await tx.platformProviderProbeLedger.findMany({
      where: { attemptId, event: { in: ["settled", "released", "held"] }, safeErrorCode: { not: null } },
      orderBy: [{ ordinal: "asc" }, { createdAt: "asc" }],
      select: { safeErrorCode: true },
    })).find((event) => event.safeErrorCode !== null)?.safeErrorCode ?? null;
    const held = (final?.heldUnits ?? 0) > 0;
    const status: PlatformProviderProbeAttemptStatus = held ? "held" : (final?.settledUnits ?? 0) > 0 ? "settled" : "released";
    const terminalError = ledgerError ?? safeErrorCode ?? final?.safeErrorCode ?? attempt.safeErrorCode;
    await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { status, terminalAt: new Date(), ...(terminalError === null ? {} : { safeErrorCode: terminalError }) } });
    if (status === "settled" && (final?.settledUnits ?? 0) === attempt.plannedUnits && terminalError === null) {
      const provider = await tx.aiProviderConnection.findFirst({ where: { id: attempt.providerConnectionId, scope: "platform", ownerUserId: null }, select: providerProbeSelect }) as ProviderProbeRow | null;
      const fingerprint = provider === null ? null : await currentCredentialFingerprint(tx, provider.credentialId);
      if (actorCurrent && provider !== null && provider.configurationVersion === attempt.providerConfigurationVersion && fingerprint === attempt.credentialSecretFingerprint) {
        await tx.aiProviderConnection.updateMany({ where: { id: provider.id, scope: "platform", configurationVersion: attempt.providerConfigurationVersion, status: { not: "disabled" } }, data: { status: "verified", lastTestedAt: new Date(), lastErrorCode: null, disabledAt: null } });
      }
    } else if (status === "settled" && terminalError !== null) {
      const provider = await tx.aiProviderConnection.findFirst({ where: { id: attempt.providerConnectionId, scope: "platform", ownerUserId: null }, select: providerProbeSelect }) as ProviderProbeRow | null;
      const fingerprint = provider === null ? null : await currentCredentialFingerprint(tx, provider.credentialId);
      if (actorCurrent && provider !== null && provider.configurationVersion === attempt.providerConfigurationVersion && fingerprint === attempt.credentialSecretFingerprint) {
        await tx.aiProviderConnection.updateMany({ where: { id: provider.id, scope: "platform", configurationVersion: attempt.providerConfigurationVersion, status: { not: "disabled" } }, data: { status: "error", lastTestedAt: new Date(), lastErrorCode: terminalError, disabledAt: null } });
      }
    }
    if (held && attempt.budgetId !== null) await createThresholdNotifications(tx, attempt.budgetId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
}

async function executeProbe(admission: Admission, input: ProbeInput, db: PrismaClient): Promise<void> {
  let stop = false;
  for (const [index, capability] of admission.capabilities.entries()) {
    if (stop) break;
    const ordinal = index + 1;
    let dispatched = false;
    const connection = {
      id: admission.provider.id,
      kind: admission.provider.kind,
      baseUrl: admission.provider.baseUrl,
      credentialId: admission.provider.credentialId,
      status: admission.provider.status,
      credentialSecretFingerprint: admission.credentialSecretFingerprint,
      onBeforeCredentialRead: () => verifyProbeFence(admission.attemptId, admission.provider.id, input.expectedConfigurationVersion, admission.credentialSecretFingerprint, db),
      onBeforeRequest: async () => {
        const accepted = await markProbeDispatched(admission.attemptId, admission.provider.id, ordinal, capability.capability, input.expectedConfigurationVersion, admission.credentialSecretFingerprint, db);
        dispatched = accepted;
        return accepted;
      },
    } as const;
    try {
      // Every capability shares one bounded attempt deadline. A worker lease
      // therefore cannot reclaim a healthy three-capability probe mid-flight.
      const absoluteDeadlineAt = admission.deadlineAt;
      if (capability.capability === "generation") {
        await invokeChatCompletion({ connection, operation: "projectAnalysis", modelId: capability.modelId, messages: [{ role: "system", content: "Connectivity check. Reply OK." }, { role: "user", content: "OK" }], maxOutputTokens: 8, temperature: 0, absoluteDeadlineAt });
      } else if (capability.capability === "embedding") {
        const result = await invokeEmbeddings({ connection, modelId: capability.modelId, texts: ["AI Project OS platform connectivity check"], expectedDimensions: capability.dimensions, absoluteDeadlineAt });
        await settleProbeOrdinal(admission.attemptId, admission.provider.id, ordinal, null, result.dimensions, db);
        continue;
      } else {
        const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
        await invokeVisionCompletion({ connection, modelId: capability.modelId, image, mimeType: "image/png", prompt: "Reply OK", maxOutputTokens: 8, absoluteDeadlineAt });
      }
      await settleProbeOrdinal(admission.attemptId, admission.provider.id, ordinal, null, null, db);
    } catch (error) {
      const transportError = error instanceof ProviderTransportError ? error : null;
      if (transportError !== null && transportError.requestDispatched === false && !dispatched) {
        await releaseProbeOrdinal(admission.attemptId, ordinal, safeProviderErrorCode(transportError), db);
        stop = true;
      } else if (transportError !== null && (transportError.responseReceived || knownResponseError(transportError))) {
        // A response, including an explicit provider error response, is a
        // known accounting outcome.  Configuration/actor drift is handled
        // separately by finalizeProbe and must not turn consumed units into
        // an artificial reconciliation hold.
        await settleProbeOrdinal(admission.attemptId, admission.provider.id, ordinal, safeProviderErrorCode(transportError), null, db);
      } else {
        await holdProbeOrdinal(admission.attemptId, ordinal, transportError === null ? "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD" : safeProviderErrorCode(transportError), db);
        stop = true;
      }
    }
  }
  await finalizeProbe(admission.attemptId, null, db);
}

export function parsePlatformProviderProbeInput(input: unknown): ProbeInput {
  try {
    return probeInputSchema.parse(input);
  } catch {
    fail("PLATFORM_PROVIDER_PROBE_INVALID_INPUT");
  }
}

export function parsePlatformProviderProbeBudgetInput(input: unknown): BudgetInput {
  try {
    return budgetInputSchema.parse(input);
  } catch {
    fail("PLATFORM_PROVIDER_PROBE_INVALID_INPUT");
  }
}

export async function runPlatformProviderProbe(
  providerId: string,
  actor: PlatformProviderActor,
  rawInput: unknown,
  db: PrismaClient = getDb(),
) {
  const parsedId = z.string().uuid().safeParse(providerId);
  if (!parsedId.success) fail("PLATFORM_PROVIDER_PROBE_INVALID_INPUT");
  const input = parsePlatformProviderProbeInput(rawInput);
  const admission = await admitProbe(providerId, actor, input, db);
  if (admission.terminal) return attemptWithPublic(db, admission.attemptId);
  await executeProbe(admission, input, db);
  return attemptWithPublic(db, admission.attemptId);
}

export async function getPlatformProviderProbeBudgetSummary(
  actor: PlatformProviderActor,
  db: PrismaClient = getDb(),
  now = new Date(),
) {
  await assertPlatformProviderAdmin(actor, db);
  const budget = await db.platformProviderProbeBudget.findFirst({ where: { status: "active" }, orderBy: { version: "desc" }, select: { version: true, status: true, unitLimit: true, alertThresholdUnits: true, reservedUnits: true, settledUnits: true, heldUnits: true, startsAt: true, expiresAt: true } });
  if (budget === null) return Object.freeze({ budget: null });
  const lifecycle = budget.expiresAt <= now ? "expired" : budget.startsAt > now ? "scheduled" : "active";
  return Object.freeze({ budget: Object.freeze({ version: budget.version, status: lifecycle, unitLimit: budget.unitLimit, alertThresholdUnits: budget.alertThresholdUnits, reservedUnits: budget.reservedUnits, settledUnits: budget.settledUnits, heldUnits: budget.heldUnits, availableUnits: Math.max(0, budget.unitLimit - budget.reservedUnits - budget.settledUnits - budget.heldUnits), startsAt: budget.startsAt.toISOString(), expiresAt: budget.expiresAt.toISOString() }) });
}

export async function createAndActivatePlatformProviderProbeBudget(
  rawInput: unknown,
  actor: PlatformProviderActor,
  db: PrismaClient = getDb(),
) {
  const input = parsePlatformProviderProbeBudgetInput(rawInput);
  const actorHint = assertPlatformProviderAdminHint(actor);
  try {
    return await db.$transaction(async (tx) => {
      await setProbeMutationContext(tx);
      await lockMembershipUser(tx, actorHint.id);
      const current = await assertPlatformProviderAdmin(actorHint, tx);
      await lockProbeBudget(tx);
      const previous = await tx.platformProviderProbeBudget.findFirst({ where: { status: "active" }, orderBy: { version: "desc" }, select: { id: true } });
      if (previous !== null) await tx.platformProviderProbeBudget.update({ where: { id: previous.id }, data: { status: "retired", retiredById: current.id, retiredAt: new Date() } });
      const latest = await tx.platformProviderProbeBudget.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
      const budget = await tx.platformProviderProbeBudget.create({
        data: { version: (latest?.version ?? 0) + 1, status: "active", unitLimit: input.unitLimit, alertThresholdUnits: input.alertThresholdUnits, startsAt: input.startsAt, expiresAt: input.expiresAt, createdById: current.id, activatedById: current.id, activatedAt: new Date() },
        select: { version: true, status: true, unitLimit: true, alertThresholdUnits: true, startsAt: true, expiresAt: true },
      });
      return Object.freeze({ version: budget.version, status: budget.status, unitLimit: budget.unitLimit, alertThresholdUnits: budget.alertThresholdUnits, startsAt: budget.startsAt.toISOString(), expiresAt: budget.expiresAt.toISOString() });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
    throw error;
  }
}

export async function reconcilePlatformProviderProbeAttempts(
  db: PrismaClient = getDb(),
  now = new Date(),
): Promise<number> {
  const candidates = await db.platformProviderProbeAttempt.findMany({ where: { status: { in: ["reserved", "running"] }, leaseExpiresAt: { lte: now } }, select: { id: true }, orderBy: { leaseExpiresAt: "asc" }, take: 50 });
  let reconciled = 0;
  for (const candidate of candidates) {
    try {
      await db.$transaction(async (tx) => {
        await setProbeMutationContext(tx);
        const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: candidate.id }, select: { budgetId: true, providerConnectionId: true, actorId: true, plannedUnits: true, status: true, settledUnits: true, releasedUnits: true, heldUnits: true, safeErrorCode: true } });
        if (attempt === null || !["reserved", "running"].includes(attempt.status)) return;
        await lockMembershipUser(tx, attempt.actorId);
        await lockProviderConfiguration(tx, attempt.providerConnectionId);
        if (attempt.budgetId !== null) await lockProbeBudget(tx);
        const events = await tx.platformProviderProbeLedger.findMany({ where: { attemptId: candidate.id }, select: { ordinal: true, event: true } });
        const dispatched = new Set(events.filter((event) => event.event === "dispatched").map((event) => event.ordinal));
        const terminal = new Set(events.filter((event) => ["settled", "released", "held"].includes(event.event)).map((event) => event.ordinal));
        let held = 0;
        let released = 0;
        for (let ordinal = 1; ordinal <= attempt.plannedUnits; ordinal += 1) {
          if (terminal.has(ordinal)) continue;
          const event = dispatched.has(ordinal) ? "held" : "released";
          const dispatch = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId: candidate.id, ordinal, event: "dispatched" }, select: { capability: true } });
          const reserved = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId: candidate.id, ordinal, event: "reserved" }, select: { capability: true } });
          await tx.platformProviderProbeLedger.create({ data: { attemptId: candidate.id, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal, event, capability: dispatch?.capability ?? reserved?.capability ?? "generation", units: 1, safeErrorCode: event === "held" ? "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD" : "PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH" } });
          if (event === "held") held += 1;
          else released += 1;
        }
        if (attempt.budgetId !== null && (held > 0 || released > 0)) {
          await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: { reservedUnits: { decrement: held + released }, heldUnits: { increment: held } } });
          if (held > 0) await createThresholdNotifications(tx, attempt.budgetId);
        }
        const totalHeld = attempt.heldUnits + held;
        const totalSettled = attempt.settledUnits;
        const status: PlatformProviderProbeAttemptStatus = totalHeld > 0 ? "held" : totalSettled > 0 ? "settled" : "released";
        const terminalError = totalHeld > 0
          ? attempt.safeErrorCode ?? "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD"
          : attempt.safeErrorCode ?? (released > 0 ? "PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH" : null);
        await tx.platformProviderProbeAttempt.update({ where: { id: candidate.id }, data: { status, heldUnits: { increment: held }, releasedUnits: { increment: released }, ...(terminalError === null ? {} : { safeErrorCode: terminalError }), terminalAt: now } });
        reconciled += 1;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
    } catch {
      // A concurrent admission/settlement owns the row; the next bounded
      // worker cycle can retry without making an external request.
    }
  }
  return reconciled;
}

export function isPlatformProviderProbeServiceError(error: unknown): error is PlatformProviderProbeServiceError {
  return error instanceof PlatformProviderProbeServiceError;
}
