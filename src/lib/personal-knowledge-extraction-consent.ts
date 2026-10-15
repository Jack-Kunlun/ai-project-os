import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { lockActorAccess } from "@/lib/access-linearization";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { getProviderDefinition, isSafeModelId } from "@/lib/ai-providers/registry";
import { lockProviderConfiguration } from "@/lib/ai-providers/service";
import { getDb } from "@/lib/db";
import { isSerializableTransactionConflict, withSerializableRetry } from "@/lib/prisma-transaction";
import { lockPersonalVisionRoute, personalVisionBillingMatches, personalVisionProviderVerified, readPersonalVisionPlatformProvider, PERSONAL_VISION_MAX_OUTPUT_TOKENS, type PersonalVisionProvider } from "@/lib/personal-knowledge-vision-provider";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = Readonly<{ id: string; role: "admin" | "user"; accountAccessVersion?: number }>;
type Operation = "graph" | "vision";
type Source = Readonly<{
  operation: Operation;
  input: Buffer;
  documentId?: string;
  revisionId?: string;
  pageManifestHash?: string;
  visionPageManifest?: readonly Readonly<{ ordinal: number; pageNumber: number | null; locatorLabel: string }>[];
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
      id: true, name: true, kind: true, protocol: true, baseUrl: true, credentialId: true,
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
  if (!modelId || !isSafeModelId(modelId) || provider.protocol !== "chatCompletions" || provider.baseUrl !== definition.baseUrl
    || operation === "vision" && (!definition.supportsVision
      || provider.kind === "deepseek" && modelId !== "deepseek-flash" && modelId !== "deepseek-v4-flash-vision-exp")) {
    fail("PERSONAL_EXTRACTION_PROVIDER_UNAVAILABLE", "请选择已验证的个人模型", 422);
  }
  return { ...provider, modelId, billingMode: "byok" as const, accountAccessVersion: access.accountAccessVersion };
}

async function currentVisionProvider(
  db: Db,
  actor: Actor,
  providerId: string,
  billingMode?: "platform" | "byok",
) {
  if (actor.role !== "user") fail("PERSONAL_EXTRACTION_FORBIDDEN", "当前账号不能使用个人提取", 403);
  const access = await assertAccountAccessForActor(db, actor);
  if (billingMode !== "platform") {
    const personal = await db.aiProviderConnection.findFirst({
      where: { id: providerId, scope: "user", ownerUserId: actor.id },
      select: { id: true },
    });
    if (personal !== null) {
      const provider = await currentProvider(db, actor, providerId, "vision");
      return Object.freeze({ ...provider, billingMode: "byok" as const, accountAccessVersion: access.accountAccessVersion });
    }
  }
  if (billingMode === "byok") {
    fail("PERSONAL_EXTRACTION_PROVIDER_UNAVAILABLE", "请选择已验证的个人模型", 422);
  }
  const platform = await readPersonalVisionPlatformProvider(db);
  if (platform === null || platform.id !== providerId || !personalVisionProviderVerified(platform)) {
    fail("PERSONAL_EXTRACTION_PROVIDER_UNAVAILABLE", "请选择当前可用的视觉模型", 422);
  }
  return Object.freeze({
    ...platform,
    modelId: platform.defaultVisionModelId!,
    billingMode: "platform" as const,
    accountAccessVersion: access.accountAccessVersion,
  });
}

function sourceManifestIsValid(source: Source): boolean {
  if (source.operation !== "vision") return source.visionPageManifest === undefined;
  const pages = source.visionPageManifest;
  if (pages === undefined || pages.length < 1 || pages.length > 3
    || pages.some((page, index) => !Number.isSafeInteger(page.ordinal) || page.ordinal < 0
      || page.pageNumber !== null && (!Number.isSafeInteger(page.pageNumber) || page.pageNumber < 1)
      || typeof page.locatorLabel !== "string" || page.locatorLabel.trim() !== page.locatorLabel
      || page.locatorLabel.length < 1 || page.locatorLabel.length > 200
      || index > 0 && pages[index - 1]!.ordinal >= page.ordinal)) return false;
  const manifestHash = visionPageManifestHash(pages.map((page) => ({ ...page, requiresVision: true })));
  return manifestHash === source.pageManifestHash;
}

function billingSnapshotMatches(attempt: {
  billingMode: string;
  platformRouteId: string | null;
  platformRouteVersion: number | null;
  platformRouteUpdatedAt: Date | null;
  platformQuotaMultiplierBps: number | null;
  platformMaxOutputTokens: number | null;
  visionMaxOutputTokens: number | null;
  platformRouteFenceFingerprint: string | null;
}, provider: { billingMode: "platform" | "byok"; billingRoute?: PersonalVisionProvider["billingRoute"] }): boolean {
  if (attempt.billingMode !== provider.billingMode) return false;
  const route = provider.billingRoute;
  if (provider.billingMode === "byok") {
    return route === undefined && attempt.platformRouteId === null && attempt.platformRouteVersion === null
      && attempt.platformRouteUpdatedAt === null && attempt.platformQuotaMultiplierBps === null
      && attempt.platformMaxOutputTokens === null
      && (attempt.visionMaxOutputTokens === null || attempt.visionMaxOutputTokens === PERSONAL_VISION_MAX_OUTPUT_TOKENS)
      && attempt.platformRouteFenceFingerprint === null;
  }
  return route !== undefined
    && route.routeId === attempt.platformRouteId
    && route.routeVersion === attempt.platformRouteVersion
    && route.routeUpdatedAt.getTime() === attempt.platformRouteUpdatedAt?.getTime()
    && route.quotaMultiplierBps === attempt.platformQuotaMultiplierBps
    && route.maxOutputTokens === attempt.platformMaxOutputTokens
    && route.effectiveMaxOutputTokens === attempt.visionMaxOutputTokens
    && route.routeFenceFingerprint === attempt.platformRouteFenceFingerprint;
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
  if (input.source.operation === "vision" && (!input.source.pageManifestHash || !sourceManifestIsValid(input.source))) fail("PERSONAL_EXTRACTION_SOURCE_INVALID", "扫描页清单无效", 422);
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, input.actor.id);
    if (input.source.operation === "vision") await lockPersonalVisionRoute(tx);
    await lockProviderConfiguration(tx, input.providerId);
    const provider = input.source.operation === "vision"
      ? await currentVisionProvider(tx, input.actor, input.providerId)
      : await currentProvider(tx, input.actor, input.providerId, input.source.operation);
    await reconcileStaleRunning(tx, input.actor.id);
    if (!await sourceStillCurrent(tx, input.actor, input.source)) fail("PERSONAL_EXTRACTION_SOURCE_CHANGED", "来源已变化，请重新确认");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + TTL_MS);
    const row = await tx.personalKnowledgeExtractionAttempt.create({ data: {
      id: randomUUID(), ownerUserId: input.actor.id, operation: input.source.operation,
      documentId: input.source.documentId ?? null, revisionId: input.source.revisionId ?? null,
      inputHash: digest(input.source.input), inputBytes: input.source.input.length,
      pageManifestHash: input.source.pageManifestHash ?? null,
      visionPageCount: input.source.visionPageManifest?.length ?? null,
      visionPageManifest: input.source.visionPageManifest === undefined ? Prisma.DbNull : input.source.visionPageManifest.map((page, index) => ({ pageIndex: index + 1, ...page })) as Prisma.InputJsonValue,
      billingMode: "billingMode" in provider ? provider.billingMode : "byok",
      platformRouteId: "billingRoute" in provider ? provider.billingRoute?.routeId ?? null : null,
      platformRouteVersion: "billingRoute" in provider ? provider.billingRoute?.routeVersion ?? null : null,
      platformRouteUpdatedAt: "billingRoute" in provider ? provider.billingRoute?.routeUpdatedAt ?? null : null,
      platformQuotaMultiplierBps: "billingRoute" in provider ? provider.billingRoute?.quotaMultiplierBps ?? null : null,
      platformMaxOutputTokens: "billingRoute" in provider ? provider.billingRoute?.maxOutputTokens ?? null : null,
      visionMaxOutputTokens: input.source.operation === "vision"
        ? ("billingRoute" in provider ? provider.billingRoute?.effectiveMaxOutputTokens : undefined) ?? PERSONAL_VISION_MAX_OUTPUT_TOKENS
        : null,
      platformRouteFenceFingerprint: "billingRoute" in provider ? provider.billingRoute?.routeFenceFingerprint ?? null : null,
      providerConnectionId: provider.id, providerConfigurationVersion: provider.configurationVersion,
      modelId: provider.modelId, credentialSecretFingerprint: provider.credential.secretFingerprint,
      actorAccountAccessVersion: provider.accountAccessVersion, issuedAt, expiresAt,
    }, select: { id: true, expiresAt: true } });
    return {
      attemptId: row.id, expiresAt: row.expiresAt, providerName: provider.name, modelId: provider.modelId,
      billingMode: "billingMode" in provider ? provider.billingMode : "byok",
      quotaMultiplierBps: "billingRoute" in provider ? provider.billingRoute?.quotaMultiplierBps ?? null : null,
      maxOutputTokens: input.source.operation === "vision"
        ? ("billingRoute" in provider ? provider.billingRoute?.effectiveMaxOutputTokens : undefined) ?? PERSONAL_VISION_MAX_OUTPUT_TOKENS
        : null,
      pages: input.source.visionPageManifest?.map((page, index) => ({ pageIndex: index + 1, ...page })) ?? [],
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function consumePersonalExtraction(input: Readonly<{
  actor: Actor; attemptId: string; source: Source; db?: PrismaClient;
}>) {
  const db = input.db ?? getDb();
  const sourceHash = digest(input.source.input);
  return withSerializableRetry(db, async (tx) => {
    await lockActorAccess(tx, input.actor.id);
    const attempt = await tx.personalKnowledgeExtractionAttempt.findFirst({
      where: { id: input.attemptId, ownerUserId: input.actor.id },
    });
    if (attempt && attempt.status !== "issued") {
      fail("PERSONAL_EXTRACTION_CONFIRMATION_USED", "确认已被使用，请重新开始");
    }
    if (!attempt || attempt.expiresAt.getTime() <= Date.now()) {
      fail("PERSONAL_EXTRACTION_CONFIRMATION_EXPIRED", "确认已过期，请重新开始");
    }
    if (attempt.operation === "vision") await lockPersonalVisionRoute(tx);
    await lockProviderConfiguration(tx, attempt.providerConnectionId);
    const provider = attempt.operation === "vision"
      ? await currentVisionProvider(tx, input.actor, attempt.providerConnectionId, attempt.billingMode === "platform" ? "platform" : "byok")
      : await currentProvider(tx, input.actor, attempt.providerConnectionId, input.source.operation);
    if (attempt.operation !== input.source.operation || attempt.inputHash !== sourceHash
      || attempt.inputBytes !== input.source.input.length
      || attempt.pageManifestHash !== (input.source.pageManifestHash ?? null)
      || !sourceManifestIsValid(input.source)
      || attempt.visionPageCount !== (input.source.visionPageManifest?.length ?? null)
      || attempt.documentId !== (input.source.documentId ?? null)
      || attempt.revisionId !== (input.source.revisionId ?? null)
      || attempt.providerConfigurationVersion !== provider.configurationVersion
      || attempt.modelId !== provider.modelId
      || attempt.credentialSecretFingerprint !== provider.credential.secretFingerprint
      || attempt.actorAccountAccessVersion !== provider.accountAccessVersion
      || !billingSnapshotMatches(attempt, provider)
      || !await sourceStillCurrent(tx, input.actor, input.source)) {
      fail("PERSONAL_EXTRACTION_CONFIRMATION_STALE", "文件、文档或模型已变化，请重新确认");
    }
    const updated = await tx.personalKnowledgeExtractionAttempt.updateMany({
      where: { id: attempt.id, ownerUserId: input.actor.id, status: "issued", consumedAt: null },
      data: { status: "running", consumedAt: new Date() },
    });
    if (updated.count !== 1) fail("PERSONAL_EXTRACTION_CONFIRMATION_USED", "确认已被使用，请重新开始");
    return { attemptId: attempt.id, source: input.source, provider };
  }, 2).catch((error: unknown) => {
    if (isSerializableTransactionConflict(error)) {
      fail("PERSONAL_EXTRACTION_CONFIRMATION_STALE", "确认状态正在变化，请重新开始");
    }
    throw error;
  });
}

type ExtractionSnapshot = Awaited<ReturnType<typeof consumePersonalExtraction>>;

export async function withPersonalExtractionRouteFence<T>(
  snapshot: ExtractionSnapshot,
  actor: Actor,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  db: PrismaClient = getDb(),
): Promise<T> {
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, actor.id);
    if (snapshot.source.operation === "vision") await lockPersonalVisionRoute(tx);
    await lockProviderConfiguration(tx, snapshot.provider.id);
    const provider = snapshot.source.operation === "vision"
      ? await currentVisionProvider(tx, actor, snapshot.provider.id, snapshot.provider.billingMode)
      : await currentProvider(tx, actor, snapshot.provider.id, snapshot.source.operation);
    const attempt = await tx.personalKnowledgeExtractionAttempt.findFirst({ where: { id: snapshot.attemptId, ownerUserId: actor.id, status: "running" } });
    const matches = attempt !== null
      && attempt.operation === snapshot.source.operation
      && attempt.providerConnectionId === provider.id
      && attempt.inputHash === digest(snapshot.source.input)
      && attempt.inputBytes === snapshot.source.input.length
      && attempt.providerConfigurationVersion === provider.configurationVersion
      && provider.configurationVersion === snapshot.provider.configurationVersion
      && attempt.modelId === provider.modelId
      && provider.modelId === snapshot.provider.modelId
      && attempt.credentialSecretFingerprint === provider.credential.secretFingerprint
      && provider.credential.secretFingerprint === snapshot.provider.credential.secretFingerprint
      && attempt.actorAccountAccessVersion === provider.accountAccessVersion
      && attempt.pageManifestHash === (snapshot.source.pageManifestHash ?? null)
      && attempt.visionPageCount === (snapshot.source.visionPageManifest?.length ?? null)
      && attempt.documentId === (snapshot.source.documentId ?? null)
      && attempt.revisionId === (snapshot.source.revisionId ?? null)
      && sourceManifestIsValid(snapshot.source)
      && (snapshot.source.operation !== "vision"
        || billingSnapshotMatches(attempt, provider)
          && personalVisionBillingMatches(provider as PersonalVisionProvider, snapshot.provider as PersonalVisionProvider))
      && await sourceStillCurrent(tx, actor, snapshot.source);
    if (!matches) fail("PERSONAL_EXTRACTION_CONFIRMATION_STALE", "文件、模型或计费路由已变化，请重新确认");
    return callback(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function personalExtractionDispatchValid(snapshot: ExtractionSnapshot, actor: Actor, db: PrismaClient = getDb()): Promise<boolean> {
  try {
    await withPersonalExtractionRouteFence(snapshot, actor, async () => undefined, db);
    return true;
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
