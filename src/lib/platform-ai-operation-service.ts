import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  Prisma,
  type AiOperation,
  type PlatformProviderProbeCapability,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
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
import { canonicalProviderBaseUrl, getProviderDefinition, isSafeModelId } from "@/lib/ai-providers/registry";
import { getDb } from "@/lib/db";
import {
  PLATFORM_DEFAULT_AI_OPERATIONS,
  type PlatformDefaultAiOperation,
} from "@/lib/platform-default-ai-routes";
import {
  PLATFORM_PROVIDER_PROBE_LEASE_MS,
  PlatformProviderProbeServiceError,
  type PlatformProviderProbeServiceErrorCode,
} from "@/lib/platform-provider-probe-contract";

const operationSchema = z.enum(PLATFORM_DEFAULT_AI_OPERATIONS);
const operationModelSchema = z.string().trim().min(1).max(128).refine(isSafeModelId);
const operationProbeSchema = z.object({
  clientRequestKey: z.string().uuid(),
  providerConnectionId: z.string().uuid(),
  operation: operationSchema,
  modelId: operationModelSchema,
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
  maxOutputTokens: z.number().int().min(1).max(4096).nullable().optional(),
  quotaMultiplierBps: z.number().int().min(1).max(100_000).default(10_000),
}).strict();
const operationApplySchema = operationProbeSchema.extend({
  probeId: z.string().uuid(),
  confirmEmbeddingImpact: z.boolean().optional(),
}).strict();

type OperationProbeInput = z.infer<typeof operationProbeSchema>;
type OperationApplyInput = z.infer<typeof operationApplySchema>;
type OperationDb = PrismaClient | Prisma.TransactionClient;
type OperationPayload = Readonly<{ embeddingDimensions: number | null; maxOutputTokens: number | null; quotaMultiplierBps: number }>;

type ProviderRow = Readonly<{
  id: string;
  name: string;
  kind: "openai" | "deepseek" | "qwen" | "glm";
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
  credential: { secretFingerprint: string | null };
}>;

function fail(code: PlatformProviderProbeServiceErrorCode): never {
  throw new PlatformProviderProbeServiceError(code);
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

async function digest(input: Readonly<{ providerId: string; kind: string; configurationVersion: number; credentialSecretFingerprint: string; operation: PlatformDefaultAiOperation; modelId: string; payload: OperationPayload }>): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update("ai-project-os:platform-provider:route-operation-proof:v1", "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(input), "utf8")
    .digest("hex");
}

function equalDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestKeyHash(key: string): string {
  return createHash("sha256").update(`ai-project-os:platform-provider-operation:key:v1:${key}`, "utf8").digest("hex");
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
  return ["AI_PROVIDER_AUTH_FAILED", "AI_PROVIDER_RATE_LIMITED", "AI_PROVIDER_REJECTED", "AI_PROVIDER_INVALID_RESPONSE", "AI_PROVIDER_RESPONSE_TOO_LARGE", "AI_PROVIDER_EMBEDDING_UNSUPPORTED", "AI_PROVIDER_VISION_UNSUPPORTED"].includes(error.code);
}

function normalizePayload(input: OperationProbeInput): OperationPayload {
  if (input.operation === "embedding") {
    if (input.embeddingDimensions === null || input.embeddingDimensions === undefined || input.maxOutputTokens !== null && input.maxOutputTokens !== undefined) fail("PLATFORM_PROVIDER_PROBE_INVALID_INPUT");
    return { embeddingDimensions: input.embeddingDimensions, maxOutputTokens: null, quotaMultiplierBps: input.quotaMultiplierBps };
  }
  if (input.embeddingDimensions !== null && input.embeddingDimensions !== undefined) fail("PLATFORM_PROVIDER_PROBE_INVALID_INPUT");
  return { embeddingDimensions: null, maxOutputTokens: input.maxOutputTokens ?? 2048, quotaMultiplierBps: input.quotaMultiplierBps };
}

function assertProviderCapability(input: OperationProbeInput, provider: ProviderRow): void {
  const payload = normalizePayload(input);
  const definition = getProviderDefinition(provider.kind);
  if (provider.status !== "verified" || provider.disabledAt !== null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_DISABLED");
  if (provider.protocol !== "chatCompletions" || provider.baseUrl !== canonicalProviderBaseUrl(provider.kind)) fail("PLATFORM_PROVIDER_PROBE_CANONICAL_ENDPOINT_REQUIRED");
  if (input.operation === "embedding") {
    if (!definition.supportsEmbeddings || provider.defaultEmbeddingModelId !== input.modelId || provider.embeddingDimensions !== payload.embeddingDimensions) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_EMBEDDING_UNSUPPORTED");
  } else if (input.operation === "visionExtract") {
    if (!definition.supportsVision || provider.defaultVisionModelId !== input.modelId) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_VISION_UNSUPPORTED");
  } else if (provider.defaultGenerationModelId !== input.modelId) {
    fail("PLATFORM_PROVIDER_PROBE_PROVIDER_REJECTED");
  }
}

async function mutationContext(db: OperationDb): Promise<void> {
  await db.$executeRaw`SELECT set_config('ai_project_os.platform_provider_probe_mutation', 'service-v1', true)`;
}

async function lockBudget(db: OperationDb): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('ai-project-os:platform-provider-probe:budget', 40904005))`;
}

async function lockOperation(db: OperationDb, operation: PlatformDefaultAiOperation): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operation}, 40904004))`;
}

const providerSelect = {
  id: true,
  name: true,
  kind: true,
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
  credential: { select: { secretFingerprint: true } },
} as const;

async function admittedProvider(providerId: string, input: OperationProbeInput, actor: PlatformProviderActor, digestValue: string, db: PrismaClient) {
  const actorHint = assertPlatformProviderAdminHint(actor);
  const key = requestKeyHash(input.clientRequestKey);
  const now = new Date();
  return db.$transaction(async (tx) => {
    await mutationContext(tx);
    await lockMembershipUser(tx, actorHint.id);
    const currentActor = await assertPlatformProviderAdmin(actorHint, tx);
    await lockProviderConfiguration(tx, providerId);
    const provider = await tx.aiProviderConnection.findFirst({ where: { id: providerId, scope: "platform", ownerUserId: null }, select: providerSelect }) as ProviderRow | null;
    if (provider === null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_NOT_FOUND");
    assertProviderCapability(input, provider);
    const existing = await tx.platformProviderProbeAttempt.findFirst({ where: { subject: "routeOperation", actorId: currentActor.id, clientRequestKeyHash: key }, select: { id: true, requestFingerprint: true, status: true } });
    if (existing !== null) {
      if (!equalDigest(existing.requestFingerprint, digestValue)) fail("PLATFORM_PROVIDER_PROBE_IDEMPOTENCY_CONFLICT");
      return { attemptId: existing.id, provider, terminal: true as const, deadlineAt: now };
    }
    await lockBudget(tx);
    const budget = await tx.platformProviderProbeBudget.findFirst({ where: { status: "active", startsAt: { lte: now }, expiresAt: { gt: now } }, orderBy: { version: "desc" } });
    const base = {
      subject: "routeOperation" as const,
      providerConnectionId: provider.id,
      providerKind: provider.kind,
      actorId: currentActor.id,
      actorAccountAccessVersion: currentActor.accountAccessVersion ?? 1,
      providerConfigurationVersion: provider.configurationVersion,
      credentialSecretFingerprint: provider.credential.secretFingerprint,
      targetOperation: input.operation,
      targetModelId: input.modelId,
      targetPayload: { ...normalizePayload(input) } as Prisma.InputJsonValue,
      configurationDigest: digestValue,
      evidenceExpiresAt: null,
      consumedAt: null,
      consumedProviderConnectionId: null,
      clientRequestKeyHash: key,
      requestFingerprint: digestValue,
    };
    if (provider.credential.secretFingerprint === null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE");
    if (budget === null) {
      const attempt = await tx.platformProviderProbeAttempt.create({ data: { ...base, budgetId: null, status: "rejected", safeErrorCode: "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED", plannedUnits: 0, leaseExpiresAt: now, terminalAt: now }, select: { id: true } });
      await tx.platformProviderProbeLedger.create({ data: { budgetId: null, attemptId: attempt.id, actorId: currentActor.id, ordinal: 0, event: "rejected", capability: null, units: 0, safeErrorCode: "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED" } });
      return { attemptId: attempt.id, provider, terminal: true as const, deadlineAt: now };
    }
    const available = budget.unitLimit - budget.reservedUnits - budget.settledUnits - budget.heldUnits;
    if (available < 1) {
      const attempt = await tx.platformProviderProbeAttempt.create({ data: { ...base, budgetId: budget.id, status: "rejected", safeErrorCode: "PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED", plannedUnits: 0, leaseExpiresAt: now, terminalAt: now }, select: { id: true } });
      await tx.platformProviderProbeLedger.create({ data: { budgetId: budget.id, attemptId: attempt.id, actorId: currentActor.id, ordinal: 0, event: "rejected", capability: null, units: 0, safeErrorCode: "PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED" } });
      return { attemptId: attempt.id, provider, terminal: true as const, deadlineAt: now };
    }
    const attempt = await tx.platformProviderProbeAttempt.create({ data: { ...base, budgetId: budget.id, status: "reserved", safeErrorCode: null, plannedUnits: 1, leaseExpiresAt: new Date(now.getTime() + PROVIDER_REQUEST_TIMEOUT_MS + 15_000) }, select: { id: true } });
    await tx.platformProviderProbeBudget.update({ where: { id: budget.id }, data: { reservedUnits: { increment: 1 } } });
    const capability: PlatformProviderProbeCapability = input.operation === "embedding" ? "embedding" : input.operation === "visionExtract" ? "vision" : "generation";
    await tx.platformProviderProbeLedger.create({ data: { budgetId: budget.id, attemptId: attempt.id, actorId: currentActor.id, ordinal: 1, event: "reserved", capability, units: 1 } });
    return { attemptId: attempt.id, provider, terminal: false as const, deadlineAt: new Date(now.getTime() + PLATFORM_PROVIDER_PROBE_LEASE_MS) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
}

async function verifyFence(attemptId: string, expectedProviderId: string, expectedVersion: number, expectedFingerprint: string, db: PrismaClient): Promise<boolean> {
  const attempt = await db.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { actorId: true, actorAccountAccessVersion: true, providerConnectionId: true, providerConfigurationVersion: true, credentialSecretFingerprint: true, budgetId: true, subject: true, status: true } });
  if (attempt === null || attempt.subject !== "routeOperation" || attempt.providerConnectionId !== expectedProviderId || attempt.providerConfigurationVersion !== expectedVersion || attempt.credentialSecretFingerprint !== expectedFingerprint || attempt.budgetId === null || !["reserved", "running"].includes(attempt.status)) return false;
  const actor = await db.appUser.findUnique({ where: { id: attempt.actorId }, select: { role: true, disabledAt: true, accountAccessVersion: true } });
  if (actor === null || actor.role !== "admin" || actor.disabledAt !== null || actor.accountAccessVersion !== attempt.actorAccountAccessVersion) return false;
  const provider = await db.aiProviderConnection.findUnique({ where: { id: expectedProviderId }, select: { configurationVersion: true, status: true, disabledAt: true, credential: { select: { secretFingerprint: true } } } });
  if (provider === null || provider.configurationVersion !== expectedVersion || provider.status !== "verified" || provider.disabledAt !== null || provider.credential.secretFingerprint !== expectedFingerprint) return false;
  const budget = await db.platformProviderProbeBudget.findUnique({ where: { id: attempt.budgetId }, select: { status: true, startsAt: true, expiresAt: true } });
  const now = new Date();
  return budget?.status === "active" && budget.startsAt <= now && budget.expiresAt > now;
}

async function markDispatched(attemptId: string, providerId: string, ordinal: number, capability: PlatformProviderProbeCapability, db: PrismaClient): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      await mutationContext(tx);
      const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { actorId: true, actorAccountAccessVersion: true, providerConnectionId: true, budgetId: true, subject: true, status: true } });
      if (attempt === null || attempt.subject !== "routeOperation" || attempt.providerConnectionId !== providerId || attempt.budgetId === null || !["reserved", "running"].includes(attempt.status)) return false;
      await lockMembershipUser(tx, attempt.actorId);
      await lockProviderConfiguration(tx, providerId);
      await lockBudget(tx);
      const actor = await tx.appUser.findUnique({ where: { id: attempt.actorId }, select: { role: true, disabledAt: true, accountAccessVersion: true } });
      if (actor === null || actor.role !== "admin" || actor.disabledAt !== null || actor.accountAccessVersion !== attempt.actorAccountAccessVersion) return false;
      const budget = await tx.platformProviderProbeBudget.findUnique({ where: { id: attempt.budgetId }, select: { status: true, startsAt: true, expiresAt: true } });
      const now = new Date();
      if (budget?.status !== "active" || budget.startsAt > now || budget.expiresAt <= now) return false;
      const existing = await tx.platformProviderProbeLedger.findUnique({ where: { attemptId_ordinal_event: { attemptId, ordinal, event: "dispatched" } }, select: { id: true } });
      if (existing !== null) return true;
      await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal, event: "dispatched", capability, units: 1 } });
      await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { status: "running", dispatchedUnits: { increment: 1 }, startedAt: new Date() } });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 5_000, maxWait: 5_000 });
  } catch (error) {
    if (isKnown(error, "P2002")) return true;
    return false;
  }
}

async function settle(attemptId: string, errorCode: PlatformProviderProbeServiceErrorCode | null, dimensions: number | null, db: PrismaClient): Promise<void> {
  await db.$transaction(async (tx) => {
    await mutationContext(tx);
    const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { actorId: true, providerConnectionId: true, budgetId: true, subject: true, status: true } });
    if (attempt === null || attempt.subject !== "routeOperation" || attempt.providerConnectionId === null || attempt.budgetId === null || ["settled", "released", "held", "rejected"].includes(attempt.status)) return;
    await lockMembershipUser(tx, attempt.actorId);
    await lockProviderConfiguration(tx, attempt.providerConnectionId);
    await lockBudget(tx);
    const terminal = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal: 1, event: { in: ["settled", "released", "held"] } }, select: { id: true } });
    if (terminal !== null) return;
    const dispatch = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal: 1, event: "dispatched" }, select: { capability: true } });
    if (dispatch === null) return;
    await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal: 1, event: "settled", capability: dispatch.capability ?? "generation", units: 1, safeErrorCode: errorCode, dimensions } });
    await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { settledUnits: 1, ...(errorCode === null ? {} : { safeErrorCode: errorCode }) } });
    await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: { reservedUnits: { decrement: 1 }, settledUnits: { increment: 1 } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 8_000, maxWait: 8_000 });
}

async function terminal(attemptId: string, event: "released" | "held", errorCode: PlatformProviderProbeServiceErrorCode, db: PrismaClient): Promise<void> {
  await db.$transaction(async (tx) => {
    await mutationContext(tx);
    const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { actorId: true, providerConnectionId: true, budgetId: true, subject: true, status: true } });
    if (attempt === null || attempt.subject !== "routeOperation" || attempt.providerConnectionId === null || attempt.budgetId === null || ["settled", "released", "held", "rejected"].includes(attempt.status)) return;
    await lockMembershipUser(tx, attempt.actorId);
    await lockProviderConfiguration(tx, attempt.providerConnectionId);
    await lockBudget(tx);
    const existing = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal: 1, event: { in: ["settled", "released", "held"] } }, select: { id: true } });
    if (existing !== null) return;
    const dispatch = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal: 1, event: "dispatched" }, select: { capability: true } });
    const reserved = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal: 1, event: "reserved" }, select: { capability: true } });
    if (event === "released" && dispatch !== null) return;
    await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal: 1, event, capability: dispatch?.capability ?? reserved?.capability ?? "generation", units: 1, safeErrorCode: errorCode } });
    await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: event === "held" ? { heldUnits: 1, safeErrorCode: errorCode } : { releasedUnits: 1, safeErrorCode: errorCode } });
    await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: event === "held" ? { reservedUnits: { decrement: 1 }, heldUnits: { increment: 1 } } : { reservedUnits: { decrement: 1 } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 8_000, maxWait: 8_000 });
}

async function finalize(attemptId: string, db: PrismaClient): Promise<void> {
  await db.$transaction(async (tx) => {
    await mutationContext(tx);
    const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { actorId: true, budgetId: true, status: true, settledUnits: true, releasedUnits: true, heldUnits: true, safeErrorCode: true } });
    if (attempt === null || attempt.budgetId === null || ["settled", "released", "held", "rejected"].includes(attempt.status)) return;
    await lockMembershipUser(tx, attempt.actorId);
    await lockBudget(tx);
    const events = await tx.platformProviderProbeLedger.findMany({ where: { attemptId }, select: { event: true, capability: true } });
    if (!events.some((event) => ["settled", "released", "held"].includes(event.event))) {
      await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal: 1, event: "released", capability: events.find((event) => event.event === "reserved")?.capability ?? "generation", units: 1, safeErrorCode: "PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH" } });
      await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { releasedUnits: 1, safeErrorCode: "PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH" } });
      await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: { reservedUnits: { decrement: 1 } } });
    }
    const final = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { settledUnits: true, releasedUnits: true, heldUnits: true, safeErrorCode: true } });
    const status = (final?.heldUnits ?? 0) > 0 ? "held" : (final?.settledUnits ?? 0) > 0 ? "settled" : "released";
    await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { status, terminalAt: new Date(), evidenceExpiresAt: status === "settled" ? new Date(Date.now() + 5 * 60_000) : null } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
}

async function execute(admission: Readonly<{ attemptId: string; provider: ProviderRow; deadlineAt: Date }>, input: OperationProbeInput, db: PrismaClient): Promise<void> {
  const capability: PlatformProviderProbeCapability = input.operation === "embedding" ? "embedding" : input.operation === "visionExtract" ? "vision" : "generation";
  let dispatched = false;
  const connection = {
    id: admission.provider.id,
    kind: admission.provider.kind,
    baseUrl: admission.provider.baseUrl,
    credentialId: admission.provider.credentialId,
    status: admission.provider.status,
    credentialSecretFingerprint: admission.provider.credential.secretFingerprint ?? undefined,
    onBeforeCredentialRead: () => admission.provider.credential.secretFingerprint !== null && verifyFence(admission.attemptId, admission.provider.id, admission.provider.configurationVersion, admission.provider.credential.secretFingerprint, db),
    onBeforeRequest: async () => { dispatched = await markDispatched(admission.attemptId, admission.provider.id, 1, capability, db); return dispatched; },
  } as const;
  try {
    if (input.operation === "embedding") {
      const result = await invokeEmbeddings({ connection, modelId: input.modelId, texts: ["AI Project OS platform operation connectivity check"], expectedDimensions: input.embeddingDimensions ?? undefined, absoluteDeadlineAt: admission.deadlineAt });
      await settle(admission.attemptId, null, result.dimensions, db);
    } else if (input.operation === "visionExtract") {
      const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      await invokeVisionCompletion({ connection, modelId: input.modelId, image, mimeType: "image/png", prompt: "Reply OK", maxOutputTokens: input.maxOutputTokens ?? 2048, disableThinking: true, absoluteDeadlineAt: admission.deadlineAt });
      await settle(admission.attemptId, null, null, db);
    } else {
      await invokeChatCompletion({ connection, operation: input.operation as Exclude<AiOperation, "embedding">, modelId: input.modelId, messages: [{ role: "system", content: "Connectivity check. Reply OK." }, { role: "user", content: "OK" }], maxOutputTokens: input.maxOutputTokens ?? 2048, temperature: 0, disableThinking: true, absoluteDeadlineAt: admission.deadlineAt });
      await settle(admission.attemptId, null, null, db);
    }
  } catch (error) {
    const transportError = error instanceof ProviderTransportError ? error : null;
    if (transportError !== null && transportError.requestDispatched === false && !dispatched) await terminal(admission.attemptId, "released", safeProviderErrorCode(transportError), db);
    else if (transportError !== null && (transportError.responseReceived || knownResponseError(transportError))) await settle(admission.attemptId, safeProviderErrorCode(transportError), null, db);
    else await terminal(admission.attemptId, "held", transportError === null ? "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD" : safeProviderErrorCode(transportError), db);
  }
  await finalize(admission.attemptId, db);
}

function publicProbe(row: Readonly<{ id: string; status: string; safeErrorCode: string | null; evidenceExpiresAt: Date | null }>) {
  const succeeded = row.status === "settled" && row.safeErrorCode === null;
  return Object.freeze({ probeId: succeeded ? row.id : null, status: row.status === "reserved" || row.status === "running" ? "inProgress" : row.status, safeErrorCode: row.safeErrorCode, expiresAt: succeeded && row.evidenceExpiresAt !== null ? row.evidenceExpiresAt.toISOString() : null });
}

export function parsePlatformAiOperationProbeInput(value: unknown): OperationProbeInput {
  const parsed = operationProbeSchema.safeParse(value);
  if (!parsed.success) fail("PLATFORM_PROVIDER_PROBE_INVALID_INPUT");
  return parsed.data;
}

export function parsePlatformAiOperationApplyInput(value: unknown): OperationApplyInput {
  const parsed = operationApplySchema.safeParse(value);
  if (!parsed.success) fail("PLATFORM_PROVIDER_PROBE_INVALID_INPUT");
  return parsed.data;
}

export async function probePlatformAiOperation(rawInput: unknown, actor: PlatformProviderActor, db: PrismaClient = getDb()) {
  // Authenticate against the current account row before parsing capability
  // state or touching any provider row.  Provider existence/capability
  // differences must never become an oracle for ordinary or stale sessions.
  const actorHint = assertPlatformProviderAdminHint(actor);
  await assertPlatformProviderAdmin(actorHint, db);
  const input = parsePlatformAiOperationProbeInput(rawInput);
  const provider = await db.aiProviderConnection.findFirst({ where: { id: input.providerConnectionId, scope: "platform", ownerUserId: null }, select: providerSelect }) as ProviderRow | null;
  if (provider === null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_NOT_FOUND");
  assertProviderCapability(input, provider);
  const payload = normalizePayload(input);
  const fingerprint = provider.credential.secretFingerprint;
  if (fingerprint === null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE");
  const proofDigest = await digest({ providerId: provider.id, kind: provider.kind, configurationVersion: provider.configurationVersion, credentialSecretFingerprint: fingerprint, operation: input.operation, modelId: input.modelId, payload });
  const admission = await admittedProvider(provider.id, input, actor, proofDigest, db);
  if (!admission.terminal) await execute(admission, input, db);
  const row = await db.platformProviderProbeAttempt.findUnique({ where: { id: admission.attemptId }, select: { id: true, status: true, safeErrorCode: true, evidenceExpiresAt: true } });
  if (row === null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE");
  return Object.freeze({ operation: input.operation, modelId: input.modelId, ...publicProbe(row) });
}

export async function getPlatformAiOperationView(actor: PlatformProviderActor, db: PrismaClient = getDb()) {
  const actorHint = assertPlatformProviderAdminHint(actor);
  await assertPlatformProviderAdmin(actorHint, db);
  const [providers, routes] = await Promise.all([
    db.aiProviderConnection.findMany({ where: { scope: "platform", ownerUserId: null, status: "verified", disabledAt: null }, orderBy: { createdAt: "asc" }, select: providerSelect }),
    db.platformDefaultAiRoute.findMany({ where: { status: "active" }, select: { id: true, operation: true, version: true, providerConnectionId: true, modelId: true, embeddingDimensions: true, maxOutputTokens: true, quotaMultiplierBps: true, validatedAt: true } }),
  ]);
  const activeByOperation = new Map(routes.map((route) => [route.operation, route]));
  const candidates = Object.fromEntries(PLATFORM_DEFAULT_AI_OPERATIONS.map((operation) => {
    const values = providers.flatMap((provider) => {
      const modelId = operation === "embedding" ? provider.defaultEmbeddingModelId : operation === "visionExtract" ? provider.defaultVisionModelId : provider.defaultGenerationModelId;
      if (modelId === null) return [];
      if (operation === "embedding" && (provider.embeddingDimensions === null || !getProviderDefinition(provider.kind).supportsEmbeddings)) return [];
      if (operation === "visionExtract" && !getProviderDefinition(provider.kind).supportsVision) return [];
      return [{ providerConnectionId: provider.id, providerName: provider.name, providerKind: provider.kind, modelId, embeddingDimensions: operation === "embedding" ? provider.embeddingDimensions : null, maxOutputTokens: operation === "embedding" ? null : 2048 }];
    });
    const active = activeByOperation.get(operation);
    return [operation, { readiness: active === undefined ? "missing" : "ready", active: active === undefined ? null : { id: active.id, version: active.version, providerConnectionId: active.providerConnectionId, modelId: active.modelId, embeddingDimensions: active.embeddingDimensions, maxOutputTokens: active.maxOutputTokens, quotaMultiplierBps: active.quotaMultiplierBps, validatedAt: active.validatedAt }, candidates: values }];
  }));
  return Object.freeze({ operations: PLATFORM_DEFAULT_AI_OPERATIONS, candidates, providers: providers.map((provider) => ({ id: provider.id, name: provider.name, kind: provider.kind, status: provider.status })), runtimeConnected: true as const });
}

function routeSnapshot(route: Readonly<{ operation: AiOperation; version: number; status: string; modelId: string; embeddingDimensions: number | null; maxOutputTokens: number | null; quotaMultiplierBps: number }>, status = route.status): Prisma.InputJsonValue {
  return { operation: route.operation, version: route.version, status, modelId: route.modelId, embeddingDimensions: route.embeddingDimensions, maxOutputTokens: route.maxOutputTokens, quotaMultiplierBps: route.quotaMultiplierBps } as Prisma.InputJsonValue;
}

export async function applyPlatformAiOperation(rawInput: unknown, actor: PlatformProviderActor, db: PrismaClient = getDb()) {
  const input = parsePlatformAiOperationApplyInput(rawInput);
  const actorHint = assertPlatformProviderAdminHint(actor);
  try {
    return await db.$transaction(async (tx) => {
      await mutationContext(tx);
      await lockMembershipUser(tx, actorHint.id);
      const currentActor = await assertPlatformProviderAdmin(actorHint, tx);
      await lockOperation(tx, input.operation);
      await lockProviderConfiguration(tx, input.providerConnectionId);
      await tx.$queryRaw`SELECT "id" FROM "AiProviderConnection" WHERE "id" = ${input.providerConnectionId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "PlatformProviderProbeAttempt" WHERE "id" = ${input.probeId}::uuid FOR UPDATE`;
      const provider = await tx.aiProviderConnection.findFirst({ where: { id: input.providerConnectionId, scope: "platform", ownerUserId: null }, select: providerSelect }) as ProviderRow | null;
      if (provider === null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_NOT_FOUND");
      assertProviderCapability(input, provider);
      const fingerprint = provider.credential.secretFingerprint;
      if (fingerprint === null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE");
      const payload = normalizePayload(input);
      const proofDigest = await digest({ providerId: provider.id, kind: provider.kind, configurationVersion: provider.configurationVersion, credentialSecretFingerprint: fingerprint, operation: input.operation, modelId: input.modelId, payload });
      const proof = await tx.platformProviderProbeAttempt.findUnique({ where: { id: input.probeId }, select: { id: true, subject: true, actorId: true, actorAccountAccessVersion: true, providerConnectionId: true, providerConfigurationVersion: true, credentialSecretFingerprint: true, clientRequestKeyHash: true, requestFingerprint: true, configurationDigest: true, targetOperation: true, targetModelId: true, targetPayload: true, status: true, safeErrorCode: true, evidenceExpiresAt: true, consumedAt: true, consumedProviderConnectionId: true, consumedRouteId: true } });
      if (proof === null || proof.subject !== "routeOperation" || proof.actorId !== currentActor.id || proof.actorAccountAccessVersion !== (currentActor.accountAccessVersion ?? 1) || proof.providerConnectionId !== provider.id || proof.providerConfigurationVersion !== provider.configurationVersion || proof.credentialSecretFingerprint !== fingerprint || proof.clientRequestKeyHash !== requestKeyHash(input.clientRequestKey) || proof.requestFingerprint === null || !equalDigest(proof.requestFingerprint, proofDigest) || proof.configurationDigest === null || !equalDigest(proof.configurationDigest, proofDigest) || proof.targetOperation !== input.operation || proof.targetModelId !== input.modelId || canonicalJson(proof.targetPayload) !== canonicalJson(payload)) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
      if (proof.consumedRouteId !== null) {
        if (proof.consumedAt === null || proof.consumedProviderConnectionId !== provider.id) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
        const consumedRoute = await tx.platformDefaultAiRoute.findUnique({ where: { id: proof.consumedRouteId }, select: { id: true, operation: true, version: true, status: true, providerConnectionId: true, modelId: true, embeddingDimensions: true, maxOutputTokens: true, quotaMultiplierBps: true, validatedAt: true } });
        if (consumedRoute === null || consumedRoute.operation !== input.operation || consumedRoute.providerConnectionId !== provider.id || consumedRoute.modelId !== input.modelId) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
        return Object.freeze({ route: consumedRoute, impactConfirmed: input.operation === "embedding" });
      }
      if (proof.consumedAt !== null || proof.consumedProviderConnectionId !== null) fail("PLATFORM_PROVIDER_PROBE_IDEMPOTENCY_CONFLICT");
      const now = new Date();
      if (proof.status !== "settled" || proof.safeErrorCode !== null || proof.evidenceExpiresAt === null || proof.evidenceExpiresAt <= now) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
      const active = await tx.platformDefaultAiRoute.findFirst({ where: { operation: input.operation, status: "active" }, orderBy: { version: "desc" }, select: { id: true, operation: true, version: true, status: true, modelId: true, embeddingDimensions: true, maxOutputTokens: true, quotaMultiplierBps: true, providerConnectionId: true, providerConnection: { select: { configurationVersion: true } } } });
      if (input.operation === "embedding" && active !== null && (active.providerConnectionId !== provider.id || active.modelId !== input.modelId || active.embeddingDimensions !== payload.embeddingDimensions) && input.confirmEmbeddingImpact !== true) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
      if (active !== null) {
        // The active-route partial unique index is intentionally strict. Retire
        // the old row while both provider/operation locks are held, then create
        // the replacement in this same transaction. Any later failure rolls
        // the old active row back into place.
        const retired = await tx.platformDefaultAiRoute.updateMany({ where: { id: active.id, status: "active" }, data: { status: "retired", updatedById: currentActor.id } });
        if (retired.count !== 1) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
        await tx.platformDefaultAiRouteAudit.create({ data: { action: "retired", routeId: active.id, operation: active.operation, routeVersion: active.version, providerConnectionId: active.providerConnectionId, providerConfigurationVersion: active.providerConnection.configurationVersion, actorId: currentActor.id, reason: "replaced by a tested operation configuration", safeSnapshot: routeSnapshot(active, "retired") } });
      }
      const latest = await tx.platformDefaultAiRoute.findFirst({ where: { operation: input.operation }, orderBy: { version: "desc" }, select: { version: true } });
      const route = await tx.platformDefaultAiRoute.create({ data: { operation: input.operation, version: (latest?.version ?? 0) + 1, status: "active", providerConnectionId: provider.id, modelId: input.modelId, embeddingDimensions: payload.embeddingDimensions, maxOutputTokens: payload.maxOutputTokens, quotaMultiplierBps: payload.quotaMultiplierBps, validatedProviderConfigurationVersion: provider.configurationVersion, validatedAt: now, createdById: currentActor.id, updatedById: currentActor.id }, select: { id: true, operation: true, version: true, status: true, providerConnectionId: true, modelId: true, embeddingDimensions: true, maxOutputTokens: true, quotaMultiplierBps: true } });
      const auditBase = { routeId: route.id, operation: route.operation, routeVersion: route.version, providerConnectionId: route.providerConnectionId, providerConfigurationVersion: provider.configurationVersion, actorId: currentActor.id, reason: null };
      await tx.platformDefaultAiRouteAudit.createMany({ data: [
        { ...auditBase, action: "draftCreated", safeSnapshot: routeSnapshot(route, "draft") },
        { ...auditBase, action: "validated", safeSnapshot: routeSnapshot(route, "verified") },
        { ...auditBase, action: "activated", safeSnapshot: routeSnapshot(route, "active") },
      ] });
      const consumed = await tx.platformProviderProbeAttempt.updateMany({ where: { id: proof.id, consumedAt: null, consumedProviderConnectionId: null, consumedRouteId: null, status: "settled", safeErrorCode: null, evidenceExpiresAt: { gt: now } }, data: { consumedAt: now, consumedProviderConnectionId: provider.id, consumedRouteId: route.id } });
      if (consumed.count !== 1) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
      return Object.freeze({ route: { ...route, validatedAt: now }, impactConfirmed: input.operation === "embedding" && active !== null });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000, maxWait: 10_000 });
  } catch (error) {
    if (isKnown(error, "P2002") || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
    throw error;
  }
}
