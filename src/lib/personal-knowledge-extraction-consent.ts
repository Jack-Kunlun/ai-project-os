import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { lockActorAccess } from "@/lib/access-linearization";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { getProviderDefinition } from "@/lib/ai-providers/registry";
import { lockProviderConfiguration } from "@/lib/ai-providers/service";
import { getDb } from "@/lib/db";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = Readonly<{ id: string; role: "admin" | "user"; accountAccessVersion?: number }>;
type Operation = "graph" | "vision";
type Source = Readonly<{
  operation: Operation;
  input: Buffer;
  documentId?: string;
  revisionId?: string;
  pageManifestHash?: string;
}>;
const TTL_MS = 2 * 60_000;
const STALE_RUNNING_MS = 10 * 60_000;

function fail(code: string, message: string, status = 409): never { throw new ApiError(status, code, message); }
function digest(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

export function visionPageManifestHash(segments: readonly Readonly<{ ordinal: number; pageNumber: number | null; locatorLabel: string; requiresVision: boolean }>[]): string {
  const pages = segments.filter((row) => row.requiresVision).map((row) => [row.ordinal, row.pageNumber, row.locatorLabel]);
  return digest(Buffer.from(JSON.stringify(pages), "utf8"));
}

async function currentProvider(db: Db, actor: Actor, providerId: string, operation: Operation) {
  if (actor.role !== "user") fail("PERSONAL_EXTRACTION_FORBIDDEN", "当前账号不能使用个人提取", 403);
  const access = await assertAccountAccessForActor(db, actor);
  const provider = await db.aiProviderConnection.findFirst({
    where: { id: providerId, scope: "user", ownerUserId: actor.id },
    select: {
      id: true, name: true, kind: true, baseUrl: true, credentialId: true,
      configurationVersion: true, ownerAccountAccessVersion: true,
      defaultGenerationModelId: true, defaultVisionModelId: true,
      status: true, disabledAt: true,
      credential: { select: { kind: true, secretFingerprint: true } },
    },
  });
  if (!provider || provider.status !== "verified" || provider.disabledAt !== null
    || provider.ownerAccountAccessVersion !== access.accountAccessVersion
    || provider.credential.kind !== "aiProvider"
    || !/^[0-9a-f]{64}$/u.test(provider.credential.secretFingerprint)) {
    fail("PERSONAL_EXTRACTION_PROVIDER_UNAVAILABLE", "请选择已验证的个人模型", 422);
  }
  let definition;
  try { definition = getProviderDefinition(provider.kind); }
  catch { fail("PERSONAL_EXTRACTION_PROVIDER_UNAVAILABLE", "请选择已验证的个人模型", 422); }
  const modelId = operation === "graph" ? provider.defaultGenerationModelId : provider.defaultVisionModelId;
  if (!modelId || provider.baseUrl !== definition.baseUrl || operation === "vision" && !definition.supportsVision) {
    fail("PERSONAL_EXTRACTION_PROVIDER_UNAVAILABLE", "请选择已验证的个人模型", 422);
  }
  return { ...provider, modelId, accountAccessVersion: access.accountAccessVersion };
}

async function sourceStillCurrent(db: Db, actor: Actor, source: Source): Promise<boolean> {
  if (source.operation !== "graph") return true;
  if (!source.documentId || !source.revisionId) return false;
  const document = await db.personalKnowledgeDocument.findFirst({
    where: { id: source.documentId, ownerUserId: actor.id, state: "active", deletedAt: null },
    select: { currentRevisionId: true, currentRevision: { select: { contentHash: true } } },
  });
  return document?.currentRevisionId === source.revisionId
    && document.currentRevision?.contentHash === digest(source.input);
}

async function reconcileStaleRunning(db: Db, ownerUserId: string) {
  await db.personalKnowledgeExtractionAttempt.updateMany({
    where: { ownerUserId, status: "running", consumedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
    data: { status: "unknown", finalizedAt: new Date(), safeErrorCode: "PERSONAL_EXTRACTION_INTERRUPTED" },
  });
}

export async function preparePersonalExtraction(input: Readonly<{
  actor: Actor; providerId: string; source: Source; db?: PrismaClient;
}>) {
  const db = input.db ?? getDb();
  if (input.source.input.length < 1 || input.source.input.length > 2 * 1024 * 1024) {
    fail("PERSONAL_EXTRACTION_SOURCE_INVALID", "提取内容大小无效", 422);
  }
  if (input.source.operation === "vision" && !input.source.pageManifestHash) fail("PERSONAL_EXTRACTION_SOURCE_INVALID", "扫描页清单无效", 422);
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, input.actor.id);
    await lockProviderConfiguration(tx, input.providerId);
    const provider = await currentProvider(tx, input.actor, input.providerId, input.source.operation);
    await reconcileStaleRunning(tx, input.actor.id);
    if (!await sourceStillCurrent(tx, input.actor, input.source)) fail("PERSONAL_EXTRACTION_SOURCE_CHANGED", "来源已变化，请重新确认");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + TTL_MS);
    const row = await tx.personalKnowledgeExtractionAttempt.create({ data: {
      id: randomUUID(), ownerUserId: input.actor.id, operation: input.source.operation,
      documentId: input.source.documentId ?? null, revisionId: input.source.revisionId ?? null,
      inputHash: digest(input.source.input), inputBytes: input.source.input.length,
      pageManifestHash: input.source.pageManifestHash ?? null,
      providerConnectionId: provider.id, providerConfigurationVersion: provider.configurationVersion,
      modelId: provider.modelId, credentialSecretFingerprint: provider.credential.secretFingerprint,
      actorAccountAccessVersion: provider.accountAccessVersion, issuedAt, expiresAt,
    }, select: { id: true, expiresAt: true } });
    return { attemptId: row.id, expiresAt: row.expiresAt, providerName: provider.name, modelId: provider.modelId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function consumePersonalExtraction(input: Readonly<{
  actor: Actor; attemptId: string; source: Source; db?: PrismaClient;
}>) {
  const db = input.db ?? getDb();
  const sourceHash = digest(input.source.input);
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, input.actor.id);
    const attempt = await tx.personalKnowledgeExtractionAttempt.findFirst({
      where: { id: input.attemptId, ownerUserId: input.actor.id },
    });
    if (!attempt || attempt.status !== "issued" || attempt.expiresAt.getTime() <= Date.now()) {
      fail("PERSONAL_EXTRACTION_CONFIRMATION_EXPIRED", "确认已过期或已使用，请重新开始");
    }
    await lockProviderConfiguration(tx, attempt.providerConnectionId);
    const provider = await currentProvider(tx, input.actor, attempt.providerConnectionId, input.source.operation);
    if (attempt.operation !== input.source.operation || attempt.inputHash !== sourceHash
      || attempt.inputBytes !== input.source.input.length
      || attempt.pageManifestHash !== (input.source.pageManifestHash ?? null)
      || attempt.documentId !== (input.source.documentId ?? null)
      || attempt.revisionId !== (input.source.revisionId ?? null)
      || attempt.providerConfigurationVersion !== provider.configurationVersion
      || attempt.modelId !== provider.modelId
      || attempt.credentialSecretFingerprint !== provider.credential.secretFingerprint
      || attempt.actorAccountAccessVersion !== provider.accountAccessVersion
      || !await sourceStillCurrent(tx, input.actor, input.source)) {
      fail("PERSONAL_EXTRACTION_CONFIRMATION_STALE", "文件、文档或模型已变化，请重新确认");
    }
    const updated = await tx.personalKnowledgeExtractionAttempt.updateMany({
      where: { id: attempt.id, ownerUserId: input.actor.id, status: "issued", consumedAt: null },
      data: { status: "running", consumedAt: new Date() },
    });
    if (updated.count !== 1) fail("PERSONAL_EXTRACTION_CONFIRMATION_USED", "确认已被使用，请重新开始");
    return { attemptId: attempt.id, source: input.source, provider };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function personalExtractionDispatchValid(snapshot: Awaited<ReturnType<typeof consumePersonalExtraction>>, actor: Actor, db: PrismaClient = getDb()): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      await lockActorAccess(tx, actor.id);
      await lockProviderConfiguration(tx, snapshot.provider.id);
      const provider = await currentProvider(tx, actor, snapshot.provider.id, snapshot.source.operation);
      const attempt = await tx.personalKnowledgeExtractionAttempt.findFirst({ where: { id: snapshot.attemptId, ownerUserId: actor.id, status: "running" }, select: { id: true } });
      return attempt !== null
        && provider.configurationVersion === snapshot.provider.configurationVersion
        && provider.modelId === snapshot.provider.modelId
        && provider.credential.secretFingerprint === snapshot.provider.credential.secretFingerprint
        && await sourceStillCurrent(tx, actor, snapshot.source);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch { return false; }
}

export async function finalizePersonalExtraction(input: Readonly<{
  actor: Actor; attemptId: string; status: "succeeded" | "failed" | "unknown";
  requestIds?: readonly (string | null)[]; inputTokens?: number; outputTokens?: number;
  usageKnown?: boolean; safeErrorCode?: string | null; requestCount?: number;
  db?: PrismaClient;
}>) {
  const db = input.db ?? getDb();
  const requestIds = (input.requestIds ?? []).filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value)).slice(0, 8);
  const result = await db.personalKnowledgeExtractionAttempt.updateMany({
    where: { id: input.attemptId, ownerUserId: input.actor.id, status: "running" },
    data: {
      status: input.status, finalizedAt: new Date(), requestCount: input.requestCount ?? requestIds.length,
      providerRequestIds: requestIds as Prisma.InputJsonValue,
      inputTokens: Math.max(0, input.inputTokens ?? 0), outputTokens: Math.max(0, input.outputTokens ?? 0),
      usageKnown: input.usageKnown === true,
      safeErrorCode: input.safeErrorCode?.slice(0, 100) ?? null,
    },
  });
  if (result.count !== 1) fail("PERSONAL_EXTRACTION_AUDIT_CONFLICT", "提取审计状态无法确认", 503);
}
