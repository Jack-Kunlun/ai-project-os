import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type PlatformProviderProbeCapability, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
import { lockMembershipUser } from "@/lib/ai-entitlements";
import {
  assertPlatformProviderAdmin,
  assertPlatformProviderAdminHint,
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
  PLATFORM_PROVIDER_PROBE_LEASE_MS,
  PLATFORM_PROVIDER_PROBE_MAX_BODY_BYTES,
  PlatformProviderProbeServiceError,
  type PlatformProviderProbeServiceErrorCode,
} from "@/lib/platform-provider-probe-contract";

/**
 * This endpoint is deliberately separate from the saved-provider probe. The
 * API key is accepted only as an in-memory transport override and is never
 * passed to Prisma, an audit projection, or a response serializer.
 */

const providerKindSchema = z.enum(["openai", "deepseek", "qwen", "glm"]);
const modelIdSchema = z.string().trim().min(1).max(128).refine(isSafeModelId);
const draftProbeSchema = z.object({
  clientRequestKey: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  kind: providerKindSchema,
  apiKey: z.string().min(8).max(512),
  generationModelId: modelIdSchema.nullable().optional(),
  visionModelId: modelIdSchema.nullable().optional(),
  embeddingModelId: modelIdSchema.nullable().optional(),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.generationModelId == null && value.embeddingModelId == null) {
    context.addIssue({ code: "custom", path: ["generationModelId"], message: "至少配置一种模型能力" });
  }
  if ((value.embeddingModelId == null) !== (value.embeddingDimensions == null)) {
    context.addIssue({ code: "custom", path: ["embeddingDimensions"], message: "向量模型和维度必须同时配置" });
  }
});

type DraftProbeInput = z.infer<typeof draftProbeSchema>;
export type PlatformProviderDraftProviderInput = DraftProbeInput & Readonly<{ draftProbeId: string; createRequestKey: string }>;
type DraftDb = PrismaClient | Prisma.TransactionClient;
type DraftCapability = Readonly<{ capability: PlatformProviderProbeCapability; modelId: string; dimensions: number | null }>;

function fail(code: PlatformProviderProbeServiceErrorCode): never {
  throw new PlatformProviderProbeServiceError(code);
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function keyHash(value: string): string {
  return hashValue(`ai-project-os:platform-provider-draft-probe:key:v1:${value}`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

async function configurationDigest(input: DraftProbeInput): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update("ai-project-os:platform-provider:draft-configuration:v1", "utf8")
    .update("\0", "utf8")
    .update(canonicalJson({
      name: input.name,
      kind: input.kind,
      protocol: "chatCompletions",
      baseUrl: canonicalProviderBaseUrl(input.kind),
      generationModelId: input.generationModelId ?? null,
      visionModelId: input.visionModelId ?? null,
      embeddingModelId: input.embeddingModelId ?? null,
      embeddingDimensions: input.embeddingDimensions ?? null,
      apiKey: input.apiKey,
    }), "utf8")
    .digest("hex");
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

function capabilities(input: DraftProbeInput): readonly DraftCapability[] {
  const result: DraftCapability[] = [];
  const definition = getProviderDefinition(input.kind);
  if (input.generationModelId !== null && input.generationModelId !== undefined) result.push({ capability: "generation", modelId: input.generationModelId, dimensions: null });
  if (input.embeddingModelId !== null && input.embeddingModelId !== undefined && input.embeddingDimensions !== null && input.embeddingDimensions !== undefined && definition.supportsEmbeddings) {
    result.push({ capability: "embedding", modelId: input.embeddingModelId, dimensions: input.embeddingDimensions });
  }
  if (input.visionModelId !== null && input.visionModelId !== undefined && definition.supportsVision) result.push({ capability: "vision", modelId: input.visionModelId, dimensions: null });
  return Object.freeze(result);
}

async function mutationContext(db: DraftDb): Promise<void> {
  await db.$executeRaw`SELECT set_config('ai_project_os.platform_provider_probe_mutation', 'service-v1', true)`;
}

async function lockBudget(db: DraftDb): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('ai-project-os:platform-provider-probe:budget', 40904005))`;
}

async function createRejected(
  tx: Prisma.TransactionClient,
  input: Readonly<{ actor: PlatformProviderActor; keyHash: string; digest: string; kind: DraftProbeInput["kind"]; budgetId?: string; code: PlatformProviderProbeServiceErrorCode; now: Date }>,
): Promise<string> {
  const attempt = await tx.platformProviderProbeAttempt.create({
    data: {
      subject: "draftConnection",
      budgetId: input.budgetId ?? null,
      providerConnectionId: null,
      providerKind: input.kind,
      actorId: input.actor.id,
      actorAccountAccessVersion: input.actor.accountAccessVersion ?? 1,
      providerConfigurationVersion: 1,
      credentialSecretFingerprint: null,
      targetOperation: null,
      targetModelId: null,
      targetPayload: undefined,
      configurationDigest: input.digest,
      evidenceExpiresAt: null,
      consumedAt: null,
      consumedProviderConnectionId: null,
      clientRequestKeyHash: input.keyHash,
      requestFingerprint: input.digest,
      status: "rejected",
      safeErrorCode: input.code,
      plannedUnits: 0,
      leaseExpiresAt: input.now,
      terminalAt: input.now,
    },
    select: { id: true },
  });
  await tx.platformProviderProbeLedger.create({
    data: { budgetId: input.budgetId ?? null, attemptId: attempt.id, actorId: input.actor.id, ordinal: 0, event: "rejected", capability: null, units: 0, safeErrorCode: input.code },
  });
  return attempt.id;
}

async function admitDraft(
  input: DraftProbeInput,
  actor: PlatformProviderActor,
  digest: string,
  db: PrismaClient,
): Promise<Readonly<{ attemptId: string; capabilities: readonly DraftCapability[]; terminal: boolean; deadlineAt: Date }>> {
  const actorHint = assertPlatformProviderAdminHint(actor);
  const key = keyHash(input.clientRequestKey);
  const capabilityList = capabilities(input);
  const now = new Date();
  try {
    return await db.$transaction(async (tx) => {
      await mutationContext(tx);
      await lockMembershipUser(tx, actorHint.id);
      const currentActor = await assertPlatformProviderAdmin(actorHint, tx);
      const existing = await tx.platformProviderProbeAttempt.findFirst({
        where: { subject: "draftConnection", actorId: currentActor.id, clientRequestKeyHash: key },
        select: { id: true, requestFingerprint: true, status: true },
      });
      if (existing !== null) {
        if (existing.requestFingerprint !== digest) fail("PLATFORM_PROVIDER_PROBE_IDEMPOTENCY_CONFLICT");
        return { attemptId: existing.id, capabilities: capabilityList, terminal: true, deadlineAt: now };
      }
      if (capabilityList.length === 0) {
        const attemptId = await createRejected(tx, { actor: currentActor, keyHash: key, digest, kind: input.kind, code: "PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE", now });
        return { attemptId, capabilities: capabilityList, terminal: true, deadlineAt: now };
      }
      await lockBudget(tx);
      const budget = await tx.platformProviderProbeBudget.findFirst({ where: { status: "active", startsAt: { lte: now }, expiresAt: { gt: now } }, orderBy: { version: "desc" } });
      if (budget === null) {
        const attemptId = await createRejected(tx, { actor: currentActor, keyHash: key, digest, kind: input.kind, code: "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED", now });
        return { attemptId, capabilities: capabilityList, terminal: true, deadlineAt: now };
      }
      const available = budget.unitLimit - budget.reservedUnits - budget.settledUnits - budget.heldUnits;
      if (available < capabilityList.length) {
        const attemptId = await createRejected(tx, { actor: currentActor, keyHash: key, digest, kind: input.kind, budgetId: budget.id, code: "PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED", now });
        return { attemptId, capabilities: capabilityList, terminal: true, deadlineAt: now };
      }
      const attempt = await tx.platformProviderProbeAttempt.create({
        data: {
          subject: "draftConnection",
          budgetId: budget.id,
          providerConnectionId: null,
          providerKind: input.kind,
          actorId: currentActor.id,
          actorAccountAccessVersion: currentActor.accountAccessVersion ?? 1,
          providerConfigurationVersion: 1,
          credentialSecretFingerprint: null,
          targetOperation: null,
          targetModelId: null,
          targetPayload: Prisma.JsonNull,
          configurationDigest: digest,
          evidenceExpiresAt: null,
          consumedAt: null,
          consumedProviderConnectionId: null,
          clientRequestKeyHash: key,
          requestFingerprint: digest,
          status: "reserved",
          plannedUnits: capabilityList.length,
          leaseExpiresAt: new Date(now.getTime() + PLATFORM_PROVIDER_PROBE_LEASE_MS),
        },
        select: { id: true },
      });
      await tx.platformProviderProbeBudget.update({ where: { id: budget.id }, data: { reservedUnits: { increment: capabilityList.length } } });
      for (const [index, capability] of capabilityList.entries()) {
        await tx.platformProviderProbeLedger.create({ data: { budgetId: budget.id, attemptId: attempt.id, actorId: currentActor.id, ordinal: index + 1, event: "reserved", capability: capability.capability, units: 1 } });
      }
      return { attemptId: attempt.id, capabilities: capabilityList, terminal: false, deadlineAt: new Date(now.getTime() + PROVIDER_REQUEST_TIMEOUT_MS * capabilityList.length + 15_000) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
  } catch (error) {
    if (isKnown(error, "P2002")) {
      const existing = await db.platformProviderProbeAttempt.findFirst({ where: { subject: "draftConnection", actorId: actorHint.id, clientRequestKeyHash: key }, select: { id: true, requestFingerprint: true } });
      if (existing !== null && existing.requestFingerprint === digest) return { attemptId: existing.id, capabilities: capabilityList, terminal: true, deadlineAt: now };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
    throw error;
  }
}

async function verifyDraftFence(attemptId: string, db: PrismaClient): Promise<boolean> {
  const attempt = await db.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { actorId: true, actorAccountAccessVersion: true, budgetId: true, subject: true, status: true } });
  if (attempt === null || attempt.subject !== "draftConnection" || !["reserved", "running"].includes(attempt.status) || attempt.budgetId === null) return false;
  const actor = await db.appUser.findUnique({ where: { id: attempt.actorId }, select: { role: true, disabledAt: true, accountAccessVersion: true } });
  if (actor === null || actor.role !== "admin" || actor.disabledAt !== null || actor.accountAccessVersion !== attempt.actorAccountAccessVersion) return false;
  const budget = await db.platformProviderProbeBudget.findUnique({ where: { id: attempt.budgetId }, select: { status: true, startsAt: true, expiresAt: true } });
  const now = new Date();
  return budget?.status === "active" && budget.startsAt <= now && budget.expiresAt > now;
}

async function markDispatched(attemptId: string, ordinal: number, capability: PlatformProviderProbeCapability, db: PrismaClient): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      await mutationContext(tx);
      const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { actorId: true, actorAccountAccessVersion: true, budgetId: true, subject: true, status: true } });
      if (attempt === null || attempt.subject !== "draftConnection" || attempt.budgetId === null || !["reserved", "running"].includes(attempt.status)) return false;
      await lockMembershipUser(tx, attempt.actorId);
      const actor = await tx.appUser.findUnique({ where: { id: attempt.actorId }, select: { role: true, disabledAt: true, accountAccessVersion: true } });
      if (actor === null || actor.role !== "admin" || actor.disabledAt !== null || actor.accountAccessVersion !== attempt.actorAccountAccessVersion) return false;
      await lockBudget(tx);
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

async function settleOrdinal(attemptId: string, ordinal: number, safeErrorCode: PlatformProviderProbeServiceErrorCode | null, dimensions: number | null, db: PrismaClient): Promise<void> {
  await db.$transaction(async (tx) => {
    await mutationContext(tx);
    const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { budgetId: true, actorId: true, status: true, subject: true } });
    if (attempt === null || attempt.subject !== "draftConnection" || attempt.budgetId === null || ["settled", "released", "held", "rejected"].includes(attempt.status)) return;
    await lockMembershipUser(tx, attempt.actorId);
    await lockBudget(tx);
    const terminal = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: { in: ["settled", "released", "held"] } }, select: { id: true } });
    if (terminal !== null) return;
    const dispatch = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "dispatched" }, select: { capability: true } });
    if (dispatch === null) return;
    await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal, event: "settled", capability: dispatch.capability ?? "generation", units: 1, safeErrorCode, dimensions } });
    await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { settledUnits: { increment: 1 }, ...(safeErrorCode === null ? {} : { safeErrorCode }) } });
    await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: { reservedUnits: { decrement: 1 }, settledUnits: { increment: 1 } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 8_000, maxWait: 8_000 });
}

async function releaseOrdinal(attemptId: string, ordinal: number, safeErrorCode: PlatformProviderProbeServiceErrorCode, db: PrismaClient): Promise<void> {
  await terminalOrdinal(attemptId, ordinal, "released", safeErrorCode, db);
}

async function holdOrdinal(attemptId: string, ordinal: number, safeErrorCode: PlatformProviderProbeServiceErrorCode, db: PrismaClient): Promise<void> {
  await terminalOrdinal(attemptId, ordinal, "held", safeErrorCode, db);
}

async function terminalOrdinal(attemptId: string, ordinal: number, event: "released" | "held", safeErrorCode: PlatformProviderProbeServiceErrorCode, db: PrismaClient): Promise<void> {
  await db.$transaction(async (tx) => {
    await mutationContext(tx);
    const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { budgetId: true, actorId: true, status: true, subject: true } });
    if (attempt === null || attempt.subject !== "draftConnection" || attempt.budgetId === null || ["settled", "released", "held", "rejected"].includes(attempt.status)) return;
    await lockMembershipUser(tx, attempt.actorId);
    await lockBudget(tx);
    const existing = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: { in: ["settled", "released", "held"] } }, select: { id: true } });
    if (existing !== null) return;
    const dispatch = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "dispatched" }, select: { capability: true } });
    const reserved = await tx.platformProviderProbeLedger.findFirst({ where: { attemptId, ordinal, event: "reserved" }, select: { capability: true } });
    if (event === "released" && dispatch !== null) return;
    await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal, event, capability: dispatch?.capability ?? reserved?.capability ?? "generation", units: 1, safeErrorCode } });
    await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: event === "held" ? { heldUnits: { increment: 1 }, safeErrorCode } : { releasedUnits: { increment: 1 }, safeErrorCode } });
    await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: event === "held" ? { reservedUnits: { decrement: 1 }, heldUnits: { increment: 1 } } : { reservedUnits: { decrement: 1 } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 8_000, maxWait: 8_000 });
}

async function finalizeDraft(attemptId: string, db: PrismaClient): Promise<void> {
  await db.$transaction(async (tx) => {
    await mutationContext(tx);
    const attempt = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { actorId: true, budgetId: true, plannedUnits: true, settledUnits: true, releasedUnits: true, heldUnits: true, status: true, safeErrorCode: true } });
    if (attempt === null || attempt.budgetId === null || ["settled", "released", "held", "rejected"].includes(attempt.status)) return;
    await lockMembershipUser(tx, attempt.actorId);
    await lockBudget(tx);
    const events = await tx.platformProviderProbeLedger.findMany({ where: { attemptId }, select: { ordinal: true, event: true, capability: true } });
    const terminal = new Set(events.filter((row) => ["settled", "released", "held"].includes(row.event)).map((row) => row.ordinal));
    for (let ordinal = 1; ordinal <= attempt.plannedUnits; ordinal += 1) {
      if (terminal.has(ordinal)) continue;
      const dispatched = events.some((row) => row.ordinal === ordinal && row.event === "dispatched");
      const reserved = events.find((row) => row.ordinal === ordinal && row.event === "reserved");
      const event = dispatched ? "held" : "released";
      await tx.platformProviderProbeLedger.create({ data: { attemptId, budgetId: attempt.budgetId, actorId: attempt.actorId, ordinal, event, capability: reserved?.capability ?? "generation", units: 1, safeErrorCode: dispatched ? "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD" : "PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH" } });
      await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: event === "held" ? { heldUnits: { increment: 1 }, safeErrorCode: "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD" } : { releasedUnits: { increment: 1 }, safeErrorCode: "PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH" } });
      await tx.platformProviderProbeBudget.update({ where: { id: attempt.budgetId }, data: event === "held" ? { reservedUnits: { decrement: 1 }, heldUnits: { increment: 1 } } : { reservedUnits: { decrement: 1 } } });
    }
    const final = await tx.platformProviderProbeAttempt.findUnique({ where: { id: attemptId }, select: { settledUnits: true, releasedUnits: true, heldUnits: true, safeErrorCode: true } });
    const status = (final?.heldUnits ?? 0) > 0 ? "held" : (final?.settledUnits ?? 0) > 0 ? "settled" : "released";
    await tx.platformProviderProbeAttempt.update({ where: { id: attemptId }, data: { status, terminalAt: new Date(), evidenceExpiresAt: status === "settled" ? new Date(Date.now() + 5 * 60_000) : null } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 10_000 });
}

async function executeDraft(admission: Readonly<{ attemptId: string; capabilities: readonly DraftCapability[]; deadlineAt: Date }>, input: DraftProbeInput, db: PrismaClient): Promise<void> {
  const connection = {
    id: `draft-${admission.attemptId}`,
    kind: input.kind,
    baseUrl: canonicalProviderBaseUrl(input.kind),
    credentialId: "",
    status: "configured" as const,
    apiKey: input.apiKey,
    onBeforeCredentialRead: () => verifyDraftFence(admission.attemptId, db),
  };
  for (const [index, capability] of admission.capabilities.entries()) {
    const ordinal = index + 1;
    let dispatched = false;
    const governedConnection = { ...connection, onBeforeRequest: async () => { dispatched = await markDispatched(admission.attemptId, ordinal, capability.capability, db); return dispatched; } };
    try {
      if (capability.capability === "generation") {
        await invokeChatCompletion({ connection: governedConnection, operation: "projectAnalysis", modelId: capability.modelId, messages: [{ role: "system", content: "Connectivity check. Reply OK." }, { role: "user", content: "OK" }], maxOutputTokens: 8, temperature: 0, disableThinking: true, absoluteDeadlineAt: admission.deadlineAt });
        await settleOrdinal(admission.attemptId, ordinal, null, null, db);
      } else if (capability.capability === "embedding") {
        const result = await invokeEmbeddings({ connection: governedConnection, modelId: capability.modelId, texts: ["AI Project OS platform connectivity check"], expectedDimensions: capability.dimensions, absoluteDeadlineAt: admission.deadlineAt });
        await settleOrdinal(admission.attemptId, ordinal, null, result.dimensions, db);
      } else {
        const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
        await invokeVisionCompletion({ connection: governedConnection, modelId: capability.modelId, image, mimeType: "image/png", prompt: "Reply OK", maxOutputTokens: 8, disableThinking: true, absoluteDeadlineAt: admission.deadlineAt });
        await settleOrdinal(admission.attemptId, ordinal, null, null, db);
      }
    } catch (error) {
      const transportError = error instanceof ProviderTransportError ? error : null;
      if (transportError !== null && transportError.requestDispatched === false && !dispatched) await releaseOrdinal(admission.attemptId, ordinal, safeProviderErrorCode(transportError), db);
      else if (transportError !== null && (transportError.responseReceived || knownResponseError(transportError))) await settleOrdinal(admission.attemptId, ordinal, safeProviderErrorCode(transportError), null, db);
      else { await holdOrdinal(admission.attemptId, ordinal, transportError === null ? "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD" : safeProviderErrorCode(transportError), db); break; }
    }
  }
  await finalizeDraft(admission.attemptId, db);
}

function publicDraftAttempt(row: Readonly<{ id: string; status: string; safeErrorCode: string | null; evidenceExpiresAt: Date | null; ledgerEvents: readonly Readonly<{ event: string; capability: PlatformProviderProbeCapability | null; safeErrorCode: string | null; dimensions: number | null }>[] }>) {
  const status = row.status === "reserved" || row.status === "running" ? "inProgress" : row.status;
  const settled = (capability: PlatformProviderProbeCapability) => row.ledgerEvents.find((event) => event.event === "settled" && event.capability === capability);
  const embedding = settled("embedding");
  const result = { generation: settled("generation")?.safeErrorCode === null ? "passed" : "notConfigured", embedding: embedding?.safeErrorCode === null ? "passed" : "notConfigured", vision: settled("vision")?.safeErrorCode === null ? "passed" : "notConfigured" } as const;
  const succeeded = status === "settled" && row.safeErrorCode === null;
  return Object.freeze({ draftProbeId: succeeded ? row.id : null, attempt: Object.freeze({ status, safeErrorCode: row.safeErrorCode, capabilities: result, embeddingDimensions: embedding?.dimensions ?? null }), expiresAt: succeeded && row.evidenceExpiresAt !== null ? row.evidenceExpiresAt.toISOString() : null });
}

export const PLATFORM_PROVIDER_DRAFT_PROBE_MAX_BODY_BYTES = PLATFORM_PROVIDER_PROBE_MAX_BODY_BYTES;

export function parsePlatformProviderDraftProbeInput(input: unknown): DraftProbeInput {
  const parsed = draftProbeSchema.safeParse(input);
  if (!parsed.success) fail("PLATFORM_PROVIDER_PROBE_INVALID_INPUT");
  return parsed.data;
}

export async function runPlatformProviderDraftProbe(rawInput: unknown, actor: PlatformProviderActor, db: PrismaClient = getDb()) {
  const input = parsePlatformProviderDraftProbeInput(rawInput);
  const digest = await configurationDigest(input);
  const admission = await admitDraft(input, actor, digest, db);
  if (!admission.terminal) await executeDraft(admission, input, db);
  const row = await db.platformProviderProbeAttempt.findUnique({ where: { id: admission.attemptId }, select: { id: true, status: true, safeErrorCode: true, evidenceExpiresAt: true, ledgerEvents: { select: { event: true, capability: true, safeErrorCode: true, dimensions: true }, orderBy: [{ ordinal: "asc" }, { createdAt: "asc" }] } } });
  if (row === null) fail("PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE");
  return publicDraftAttempt(row);
}

export async function computeDraftProbeConfigurationDigest(rawInput: unknown): Promise<string> {
  return configurationDigest(parsePlatformProviderDraftProbeInput(rawInput));
}

export function draftProbeRequestKeyHash(value: string): string {
  return keyHash(value);
}

function equalDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * CAS-consume a successful draft proof inside the provider-creation
 * transaction. The caller supplies the UUID it will use for the provider row;
 * a retry can therefore return the same provider without creating a second
 * credential. No API key is accepted by this helper's persisted operations.
 */
export async function consumeDraftProviderProbe(
  rawInput: PlatformProviderDraftProviderInput,
  actor: PlatformProviderActor,
  providerConnectionId: string,
  tx: Prisma.TransactionClient,
): Promise<Readonly<{ alreadyConsumedProviderConnectionId: string | null }>> {
  const actorHint = assertPlatformProviderAdminHint(actor);
  const parsedId = z.string().uuid().safeParse(rawInput.draftProbeId);
  if (!parsedId.success || !z.string().uuid().safeParse(rawInput.createRequestKey).success) fail("PLATFORM_PROVIDER_PROBE_INVALID_INPUT");
  const digest = await configurationDigest(rawInput);
  const requestKey = keyHash(rawInput.createRequestKey);
  await mutationContext(tx);
  await lockMembershipUser(tx, actorHint.id);
  const currentActor = await assertPlatformProviderAdmin(actorHint, tx);
  await tx.$queryRaw`SELECT "id" FROM "PlatformProviderProbeAttempt" WHERE "id" = ${parsedId.data}::uuid FOR UPDATE`;
  const proof = await tx.platformProviderProbeAttempt.findUnique({
    where: { id: parsedId.data },
    select: { id: true, subject: true, actorId: true, actorAccountAccessVersion: true, status: true, safeErrorCode: true, clientRequestKeyHash: true, requestFingerprint: true, configurationDigest: true, evidenceExpiresAt: true, consumedAt: true, consumedProviderConnectionId: true, providerKind: true, providerConnectionId: true },
  });
  if (proof === null || proof.subject !== "draftConnection" || proof.providerConnectionId !== null || proof.actorId !== currentActor.id || proof.actorAccountAccessVersion !== (currentActor.accountAccessVersion ?? 1) || proof.clientRequestKeyHash !== requestKey || proof.configurationDigest === null || !equalDigest(proof.configurationDigest, digest) || !equalDigest(proof.requestFingerprint, digest) || proof.providerKind !== rawInput.kind) {
    fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
  }
  if (proof.consumedAt !== null || proof.consumedProviderConnectionId !== null) {
    if (proof.consumedProviderConnectionId !== null && proof.safeErrorCode === null) {
      return { alreadyConsumedProviderConnectionId: proof.consumedProviderConnectionId };
    }
    fail("PLATFORM_PROVIDER_PROBE_IDEMPOTENCY_CONFLICT");
  }
  const now = new Date();
  if (proof.status !== "settled" || proof.safeErrorCode !== null || proof.evidenceExpiresAt === null || proof.evidenceExpiresAt <= now) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
  const consumed = await tx.platformProviderProbeAttempt.updateMany({
    where: { id: proof.id, consumedAt: null, consumedProviderConnectionId: null, status: "settled", safeErrorCode: null, evidenceExpiresAt: { gt: now } },
    data: { consumedAt: now, consumedProviderConnectionId: providerConnectionId },
  });
  if (consumed.count !== 1) fail("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
  return { alreadyConsumedProviderConnectionId: null };
}
