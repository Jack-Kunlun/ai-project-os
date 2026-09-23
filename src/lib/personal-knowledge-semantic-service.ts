import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  Prisma,
  type AiProviderConnectionStatus,
  type PersonalKnowledgeSemanticAuditStatus,
  type PersonalKnowledgeSemanticChallengeKind,
  type PersonalKnowledgeSemanticChallengeStatus,
  type PersonalKnowledgeSemanticIndexStatus,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
import { getProviderDefinition } from "@/lib/ai-providers/registry";
import { invokeEmbeddings, ProviderTransportError } from "@/lib/ai-providers/transport";
import { lockProviderConfiguration } from "@/lib/ai-providers/service";
import {
  buildPersonalKnowledgeSemanticChunks,
  canonicalPersonalKnowledgeSemanticJson,
  PERSONAL_KNOWLEDGE_SEMANTIC_CHALLENGE_TTL_MS,
  PERSONAL_KNOWLEDGE_SEMANTIC_MAX_DOCUMENTS,
  PERSONAL_KNOWLEDGE_SEMANTIC_MAX_ENTRIES,
  PERSONAL_KNOWLEDGE_SEMANTIC_MAX_QUERY_LENGTH,
  PERSONAL_KNOWLEDGE_SEMANTIC_MAX_RESULTS,
  PERSONAL_KNOWLEDGE_SEMANTIC_MAX_SOURCE_BYTES,
  personalKnowledgeSemanticClientKeySchema,
  personalKnowledgeSemanticExcerpt,
  personalKnowledgeSemanticManifest,
  personalKnowledgeSemanticManifestFingerprint,
  personalKnowledgeSemanticQuerySchema,
  personalKnowledgeSemanticSha256,
  personalKnowledgeSemanticTotalBytes,
  personalKnowledgeSemanticTotalEntries,
  type PersonalKnowledgeSemanticManifestItem,
  type SemanticChunk,
  type SemanticPage,
} from "@/lib/personal-knowledge-semantic-contract";

const UUID_SCHEMA = z.string().uuid();
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PROVIDER_REQUEST_ID_PATTERN = /^[\x20-\x7e]{1,256}$/u;
const HMAC_CONTEXT = "ai-project-os:personal-knowledge-semantic:v1";
const EMBEDDING_OPERATION_BATCH = 32;
const DEFAULT_SEARCH_RESULTS = PERSONAL_KNOWLEDGE_SEMANTIC_MAX_RESULTS;

export const personalKnowledgeSemanticPrepareSchema = z.object({
  phase: z.literal("prepare").optional(),
  kind: z.enum(["build", "search"]),
  providerId: UUID_SCHEMA,
  clientKey: personalKnowledgeSemanticClientKeySchema,
  query: personalKnowledgeSemanticQuerySchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "build" && value.query !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["query"], message: "query forbidden" });
  }
  if (value.kind === "search" && value.query === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["query"], message: "query required" });
  }
});

export const personalKnowledgeSemanticExecuteSchema = z.object({
  phase: z.literal("execute").optional(),
  challengeId: UUID_SCHEMA,
  clientKey: personalKnowledgeSemanticClientKeySchema,
  query: personalKnowledgeSemanticQuerySchema.optional(),
}).strict();

export type PersonalKnowledgeSemanticErrorCode =
  | "PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_INPUT"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_FORBIDDEN"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_ACCOUNT_DISABLED"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_ACCOUNT_ACCESS_STALE"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_NOT_FOUND"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_NOT_VERIFIED"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_MISMATCH"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_NO_DOCUMENTS"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_TOO_LARGE"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_NOT_AVAILABLE"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_STALE"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_REQUIRED"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_EXPIRED"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_CONSUMED"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNAVAILABLE"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNCERTAIN"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_CONFLICT"
  | "PERSONAL_KNOWLEDGE_SEMANTIC_INTEGRITY_ERROR";

export class PersonalKnowledgeSemanticError extends Error {
  constructor(readonly code: PersonalKnowledgeSemanticErrorCode) {
    super(code);
    this.name = "PersonalKnowledgeSemanticError";
  }
}

function fail(code: PersonalKnowledgeSemanticErrorCode): never {
  throw new PersonalKnowledgeSemanticError(code);
}

type SemanticDb = PrismaClient | Prisma.TransactionClient;
type SemanticActor = Readonly<{ id: string; role: "admin" | "user"; accountAccessVersion?: number }>;

type SemanticProvider = Readonly<{
  id: string;
  name: string;
  kind: "openai" | "deepseek" | "qwen" | "glm";
  protocol: "chatCompletions";
  baseUrl: string;
  credentialId: string;
  configurationVersion: number;
  ownerAccountAccessVersion: number | null;
  status: AiProviderConnectionStatus;
  disabledAt: Date | null;
  defaultEmbeddingModelId: string | null;
  embeddingDimensions: number | null;
  credential: { kind: "aiProvider"; secretFingerprint: string };
}>;

type SemanticPageWithChunks = Readonly<{ page: SemanticPage; chunks: readonly SemanticChunk[] }>;

type SemanticChallengeRow = Readonly<{
  id: string;
  ownerUserId: string;
  kind: PersonalKnowledgeSemanticChallengeKind;
  generationId: string;
  providerConnectionId: string;
  providerConfigurationVersion: number;
  credentialSecretFingerprint: string;
  modelId: string;
  dimensions: number;
  corpusEpoch: number;
  sourceManifest: unknown;
  expectedEntryCount: number;
  queryHash: string | null;
  actorAccountAccessVersion: number;
  clientKeyHash: string;
  inputFingerprint: string;
  status: PersonalKnowledgeSemanticChallengeStatus;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}>;

type SemanticDispatchSnapshot = Readonly<{
  challengeId: string;
  auditId: string;
  actor: SemanticActor;
  kind: PersonalKnowledgeSemanticChallengeKind;
  generationId: string;
  corpusEpoch: number;
  documentManifest: readonly PersonalKnowledgeSemanticManifestItem[];
  pages: readonly SemanticPageWithChunks[];
  query: string | null;
  queryHash: string | null;
  provider: SemanticProvider;
  previousIndexStatus: PersonalKnowledgeSemanticIndexStatus | null;
  previousActiveGenerationId: string | null;
}>;

type SemanticVector = readonly number[];

type SearchRow = Readonly<{
  documentId: string;
  revisionId: string;
  documentVersion: number;
  title: string;
  content: string;
  contentHash: string;
  rangeStart: number;
  rangeEnd: number;
  chunkContentHash: string;
  distance: number;
}>;

function assertActorShape(actor: unknown): asserts actor is SemanticActor {
  if (typeof actor !== "object" || actor === null) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_FORBIDDEN");
  const value = actor as { id?: unknown; role?: unknown; accountAccessVersion?: unknown };
  if (!UUID_SCHEMA.safeParse(value.id).success || value.role !== "user") return fail("PERSONAL_KNOWLEDGE_SEMANTIC_FORBIDDEN");
  if (!Number.isSafeInteger(value.accountAccessVersion) || Number(value.accountAccessVersion) < 1) {
    return fail("PERSONAL_KNOWLEDGE_SEMANTIC_ACCOUNT_ACCESS_STALE");
  }
}

function parsePrepareInput(value: unknown): z.infer<typeof personalKnowledgeSemanticPrepareSchema> {
  const parsed = personalKnowledgeSemanticPrepareSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_INPUT");
  return Object.freeze({ ...parsed.data, providerId: parsed.data.providerId.toLowerCase() });
}

function parseExecuteInput(value: unknown): z.infer<typeof personalKnowledgeSemanticExecuteSchema> {
  const parsed = personalKnowledgeSemanticExecuteSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_INPUT");
  if (parsed.data.query !== undefined && parsed.data.query.length > PERSONAL_KNOWLEDGE_SEMANTIC_MAX_QUERY_LENGTH) {
    return fail("PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_INPUT");
  }
  return Object.freeze({ ...parsed.data, challengeId: parsed.data.challengeId.toLowerCase() });
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function equalHash(left: string | null | undefined, right: string): boolean {
  if (left === undefined || left === null || !HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function providerSelect() {
  return {
    id: true,
    name: true,
    kind: true,
    protocol: true,
    baseUrl: true,
    credentialId: true,
    configurationVersion: true,
    ownerAccountAccessVersion: true,
    status: true,
    disabledAt: true,
    defaultEmbeddingModelId: true,
    embeddingDimensions: true,
    credential: { select: { kind: true, secretFingerprint: true } },
  } as const;
}

async function hmacDigest(value: unknown): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update(HMAC_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(canonicalPersonalKnowledgeSemanticJson(value), "utf8")
    .digest("hex");
}

async function clientKeyHash(clientKey: string): Promise<string> {
  return hmacDigest({ purpose: "client-key", clientKey });
}

async function persistedQueryHash(query: string): Promise<string> {
  return hmacDigest({ purpose: "query", query });
}

async function currentActor(db: SemanticDb, actor: SemanticActor): Promise<Readonly<{ accountAccessVersion: number }>> {
  try {
    return await assertAccountAccessForActor(db, actor);
  } catch (error) {
    if (error instanceof AccountAccessGuardError) {
      if (error.code === "ACCOUNT_DISABLED") return fail("PERSONAL_KNOWLEDGE_SEMANTIC_ACCOUNT_DISABLED");
      if (error.code === "ACCOUNT_ACCESS_STALE") return fail("PERSONAL_KNOWLEDGE_SEMANTIC_ACCOUNT_ACCESS_STALE");
    }
    return fail("PERSONAL_KNOWLEDGE_SEMANTIC_FORBIDDEN");
  }
}

async function assertCurrentOrdinaryUser(db: SemanticDb, actor: SemanticActor): Promise<Readonly<{ accountAccessVersion: number }>> {
  assertActorShape(actor);
  const access = await currentActor(db, actor);
  const row = await db.appUser.findUnique({ where: { id: actor.id }, select: { role: true, disabledAt: true } });
  if (row === null || row.disabledAt !== null || row.role !== "user") return fail("PERSONAL_KNOWLEDGE_SEMANTIC_FORBIDDEN");
  return access;
}

async function mutationContext(db: SemanticDb): Promise<void> {
  await db.$executeRaw`SELECT set_config('app.personal_knowledge_semantic_mutation_context', 'service-v1', true)`;
}

async function databaseNow(db: SemanticDb): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const value = rows[0]?.now;
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
}

async function readVerifiedEmbeddingProvider(db: SemanticDb, ownerUserId: string, providerId: string): Promise<SemanticProvider> {
  const provider = await db.aiProviderConnection.findFirst({
    where: { id: providerId, scope: "user", ownerUserId },
    select: providerSelect(),
  });
  if (provider === null) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_NOT_FOUND");
  let definition: ReturnType<typeof getProviderDefinition>;
  try {
    definition = getProviderDefinition(provider.kind);
  } catch {
    return fail("PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_NOT_VERIFIED");
  }
  if (
    provider.protocol !== "chatCompletions"
    || provider.baseUrl !== definition.baseUrl
    || provider.status !== "verified"
    || provider.disabledAt !== null
    || provider.defaultEmbeddingModelId === null
    || provider.embeddingDimensions === null
    || provider.embeddingDimensions < 8
    || provider.embeddingDimensions > 8_192
    || provider.ownerAccountAccessVersion === null
    || provider.credential.kind !== "aiProvider"
    || !HASH_PATTERN.test(provider.credential.secretFingerprint)
    || !definition.supportsEmbeddings
  ) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_NOT_VERIFIED");
  return provider as SemanticProvider;
}

async function readIndexState(db: SemanticDb, ownerUserId: string) {
  return db.personalKnowledgeSemanticIndexState.findUnique({
    where: { ownerUserId },
    select: { ownerUserId: true, corpusEpoch: true, status: true, activeGenerationId: true, updatedAt: true },
  });
}

async function ensureIndexState(db: SemanticDb, ownerUserId: string) {
  return db.personalKnowledgeSemanticIndexState.upsert({
    where: { ownerUserId },
    create: { ownerUserId, corpusEpoch: 1, status: "notBuilt" },
    update: {},
    select: { ownerUserId: true, corpusEpoch: true, status: true, activeGenerationId: true, updatedAt: true },
  });
}

const pageSelect = {
  id: true,
  ownerUserId: true,
  version: true,
  currentRevision: {
    select: { id: true, version: true, title: true, content: true, contentHash: true, byteCount: true },
  },
} as const;

async function readPagesAndChunks(db: SemanticDb, ownerUserId: string): Promise<readonly SemanticPageWithChunks[]> {
  const rows = await db.personalKnowledgeDocument.findMany({
    where: { ownerUserId, state: "active", deletedAt: null },
    orderBy: [{ id: "asc" }],
    take: PERSONAL_KNOWLEDGE_SEMANTIC_MAX_DOCUMENTS + 1,
    select: pageSelect,
  });
  if (rows.length === 0) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_NO_DOCUMENTS");
  if (rows.length > PERSONAL_KNOWLEDGE_SEMANTIC_MAX_DOCUMENTS) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_TOO_LARGE");
  const pages: SemanticPageWithChunks[] = [];
  let totalBytes = 0;
  let totalEntries = 0;
  for (const row of rows) {
    const revision = row.currentRevision;
    if (revision === null || revision.version !== row.version || row.ownerUserId !== ownerUserId) {
      return fail("PERSONAL_KNOWLEDGE_SEMANTIC_INTEGRITY_ERROR");
    }
    if (personalKnowledgeSemanticSha256(revision.content) !== revision.contentHash || Buffer.byteLength(revision.content, "utf8") !== revision.byteCount) {
      return fail("PERSONAL_KNOWLEDGE_SEMANTIC_INTEGRITY_ERROR");
    }
    const page: SemanticPage = {
      documentId: row.id,
      revisionId: revision.id,
      version: row.version,
      title: revision.title,
      content: revision.content,
      contentHash: revision.contentHash,
    };
    let chunks: readonly SemanticChunk[];
    try {
      chunks = buildPersonalKnowledgeSemanticChunks(page);
    } catch {
      return fail("PERSONAL_KNOWLEDGE_SEMANTIC_INTEGRITY_ERROR");
    }
    totalBytes += revision.byteCount;
    totalEntries += chunks.length;
    if (totalBytes > PERSONAL_KNOWLEDGE_SEMANTIC_MAX_SOURCE_BYTES || totalEntries > PERSONAL_KNOWLEDGE_SEMANTIC_MAX_ENTRIES) {
      return fail("PERSONAL_KNOWLEDGE_SEMANTIC_TOO_LARGE");
    }
    pages.push(Object.freeze({ page, chunks }));
  }
  return Object.freeze(pages);
}

function manifestForPages(pages: readonly SemanticPageWithChunks[]): readonly PersonalKnowledgeSemanticManifestItem[] {
  return personalKnowledgeSemanticManifest(pages.map(({ page, chunks }) => ({ page, chunks })));
}

function providerMatches(provider: SemanticProvider, expected: Readonly<{ id: string; configurationVersion: number; modelId: string; dimensions: number; credentialSecretFingerprint: string }>): boolean {
  return provider.id === expected.id
    && provider.configurationVersion === expected.configurationVersion
    && provider.defaultEmbeddingModelId === expected.modelId
    && provider.embeddingDimensions === expected.dimensions
    && equalHash(provider.credential.secretFingerprint, expected.credentialSecretFingerprint);
}

function summaryForPages(
  pages: readonly SemanticPageWithChunks[],
  provider: SemanticProvider,
  expiresAt: Date,
  kind: PersonalKnowledgeSemanticChallengeKind,
  corpusEpoch: number,
) {
  return Object.freeze({
    action: kind === "build" ? "personalKnowledgeSemanticBuild" as const : "personalKnowledgeSemanticSearch" as const,
    corpusEpoch,
    documents: Object.freeze(pages.map(({ page, chunks }) => Object.freeze({
      documentId: page.documentId,
      title: page.title,
      version: page.version,
      revisionId: page.revisionId,
      chunkCount: chunks.length,
      sourceBytes: Buffer.byteLength(page.content, "utf8"),
    }))),
    totalChunks: pages.reduce((total, item) => total + item.chunks.length, 0),
    totalSourceBytes: personalKnowledgeSemanticTotalBytes(pages.map(({ page }) => page)),
    provider: Object.freeze({ name: provider.name, model: provider.defaultEmbeddingModelId!, dimensions: provider.embeddingDimensions! }),
    expiresAt: expiresAt.toISOString(),
  });
}

function fingerprintMaterial(input: Readonly<{
  actor: SemanticActor;
  kind: PersonalKnowledgeSemanticChallengeKind;
  generationId: string;
  corpusEpoch: number;
  manifestFingerprint: string;
  provider: SemanticProvider;
  queryHash: string | null;
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    protocol: HMAC_CONTEXT,
    actorId: input.actor.id,
    actorRole: input.actor.role,
    actorAccountAccessVersion: input.actor.accountAccessVersion,
    kind: input.kind,
    generationId: input.generationId,
    corpusEpoch: input.corpusEpoch,
    manifestFingerprint: input.manifestFingerprint,
    providerConnectionId: input.provider.id,
    providerConfigurationVersion: input.provider.configurationVersion,
    modelId: input.provider.defaultEmbeddingModelId,
    dimensions: input.provider.embeddingDimensions,
    credentialSecretFingerprint: input.provider.credential.secretFingerprint,
    queryHash: input.queryHash,
  });
}

function challengeSelect() {
  return {
    id: true,
    ownerUserId: true,
    kind: true,
    generationId: true,
    providerConnectionId: true,
    providerConfigurationVersion: true,
    credentialSecretFingerprint: true,
    modelId: true,
    dimensions: true,
    corpusEpoch: true,
    sourceManifest: true,
    expectedEntryCount: true,
    queryHash: true,
    actorAccountAccessVersion: true,
    clientKeyHash: true,
    inputFingerprint: true,
    status: true,
    issuedAt: true,
    expiresAt: true,
    consumedAt: true,
  } as const;
}

async function findChallenge(db: SemanticDb, id: string, ownerUserId: string): Promise<SemanticChallengeRow | null> {
  return db.personalKnowledgeSemanticChallenge.findFirst({ where: { id, ownerUserId }, select: challengeSelect() });
}

async function setAuditStatus(
  snapshot: Pick<SemanticDispatchSnapshot, "actor" | "auditId" | "generationId" | "corpusEpoch" | "kind" | "previousIndexStatus" | "previousActiveGenerationId">,
  update: Readonly<{
    status: PersonalKnowledgeSemanticAuditStatus;
    safeErrorCode: string | null;
    providerRequestId?: string | null;
    requestCount?: number;
    inputTokens?: number;
    usageKnown?: boolean;
  }>,
  db: PrismaClient,
): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await mutationContext(tx);
      await lockActorAccess(tx, snapshot.actor.id);
      await tx.personalKnowledgeSemanticAudit.updateMany({
        where: { id: snapshot.auditId, ownerUserId: snapshot.actor.id, status: "running" },
        data: {
          status: update.status,
          safeErrorCode: update.safeErrorCode,
          providerRequestId: update.providerRequestId === undefined ? undefined : update.providerRequestId,
          requestCount: update.requestCount ?? 0,
          inputTokens: update.inputTokens ?? 0,
          usageKnown: update.usageKnown === true,
          completedAt: new Date(),
        },
      });
      if (snapshot.kind === "build") {
        await tx.personalKnowledgeSemanticGeneration.updateMany({
          where: { id: snapshot.generationId, ownerUserId: snapshot.actor.id, corpusEpoch: snapshot.corpusEpoch, status: "building" },
          data: { status: "failed", safeErrorCode: update.safeErrorCode, completedAt: new Date() },
        });
        const previousReady = snapshot.previousIndexStatus === "ready" && snapshot.previousActiveGenerationId !== null
          ? await tx.personalKnowledgeSemanticGeneration.findFirst({
            where: {
              id: snapshot.previousActiveGenerationId,
              ownerUserId: snapshot.actor.id,
              corpusEpoch: snapshot.corpusEpoch,
              status: "ready",
            },
            select: { id: true },
          })
          : null;
        const restoreStatus = previousReady === null && snapshot.previousIndexStatus === "ready"
          ? "failed"
          : snapshot.previousIndexStatus ?? "failed";
        const restoreGenerationId = previousReady?.id ?? snapshot.previousActiveGenerationId;
        await tx.personalKnowledgeSemanticIndexState.updateMany({
          where: { ownerUserId: snapshot.actor.id, corpusEpoch: snapshot.corpusEpoch, status: "building", activeGenerationId: snapshot.generationId },
          data: { status: restoreStatus, activeGenerationId: restoreGenerationId },
        });
      } else {
        await tx.personalKnowledgeSemanticIndexState.updateMany({
          where: { ownerUserId: snapshot.actor.id, corpusEpoch: snapshot.corpusEpoch, status: "building", activeGenerationId: snapshot.generationId },
          data: { status: "failed", activeGenerationId: null },
        });
      }
    });
  } catch {
    // Keep a provider outcome safe if settlement itself is temporarily unable
    // to commit. The audit remains running and is visible for reconciliation.
  }
}

async function assertDispatchStillValid(snapshot: SemanticDispatchSnapshot, db: PrismaClient): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      await lockActorAccess(tx, snapshot.actor.id);
      await lockProviderConfiguration(tx, snapshot.provider.id);
      const current = await assertCurrentOrdinaryUser(tx, snapshot.actor);
      const state = await readIndexState(tx, snapshot.actor.id);
      if (state === null || state.corpusEpoch !== snapshot.corpusEpoch) return false;
      if (snapshot.kind === "build" && (state.status !== "building" || state.activeGenerationId !== snapshot.generationId)) return false;
      if (snapshot.kind === "search" && (state.status !== "ready" || state.activeGenerationId !== snapshot.generationId)) return false;
      const challenge = await findChallenge(tx, snapshot.challengeId, snapshot.actor.id);
      const audit = await tx.personalKnowledgeSemanticAudit.findFirst({ where: { id: snapshot.auditId, ownerUserId: snapshot.actor.id }, select: { status: true } });
      if (challenge === null || challenge.status !== "consumed" || challenge.consumedAt === null || audit?.status !== "running") return false;
      const pages = await readPagesAndChunks(tx, snapshot.actor.id);
      const manifestFingerprint = personalKnowledgeSemanticManifestFingerprint(manifestForPages(pages));
      if (manifestFingerprint !== personalKnowledgeSemanticManifestFingerprint(snapshot.documentManifest)) return false;
      const provider = await readVerifiedEmbeddingProvider(tx, snapshot.actor.id, snapshot.provider.id);
      if (provider.ownerAccountAccessVersion !== current.accountAccessVersion || !providerMatches(provider, {
        id: snapshot.provider.id,
        configurationVersion: snapshot.provider.configurationVersion,
        modelId: snapshot.provider.defaultEmbeddingModelId!,
        dimensions: snapshot.provider.embeddingDimensions!,
        credentialSecretFingerprint: snapshot.provider.credential.secretFingerprint,
      })) return false;
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  } catch {
    return false;
  }
}

async function currentStateAndGeneration(db: SemanticDb, ownerUserId: string) {
  const state = await readIndexState(db, ownerUserId);
  if (state === null || state.activeGenerationId === null || state.status !== "ready") return fail("PERSONAL_KNOWLEDGE_SEMANTIC_NOT_AVAILABLE");
  const generation = await db.personalKnowledgeSemanticGeneration.findFirst({
    where: { id: state.activeGenerationId, ownerUserId, corpusEpoch: state.corpusEpoch, status: "ready" },
    select: {
      id: true,
      ownerUserId: true,
      corpusEpoch: true,
      providerConnectionId: true,
      providerConfigurationVersion: true,
      credentialSecretFingerprint: true,
      modelId: true,
      dimensions: true,
      status: true,
      expectedEntryCount: true,
      indexedEntryCount: true,
      sourceManifestFingerprint: true,
    },
  });
  if (generation === null || generation.expectedEntryCount !== generation.indexedEntryCount) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_NOT_AVAILABLE");
  return Object.freeze({ state, generation });
}

export type PersonalKnowledgeSemanticConfirmation = Readonly<{
  challengeId: string;
  kind: PersonalKnowledgeSemanticChallengeKind;
  issuedAt: string;
  expiresAt: string;
  safeSummary: Readonly<Record<string, unknown>>;
}>;

export async function preparePersonalKnowledgeSemantic(
  input: unknown,
  actor: SemanticActor,
  db: PrismaClient = getDb(),
): Promise<PersonalKnowledgeSemanticConfirmation> {
  const parsed = parsePrepareInput(input);
  assertActorShape(actor);
  const keyHash = await clientKeyHash(parsed.clientKey);
  try {
    return await db.$transaction(async (tx) => {
      await lockActorAccess(tx, actor.id);
      const current = await assertCurrentOrdinaryUser(tx, actor);
      const state = await ensureIndexState(tx, actor.id);
      let generationId: string;
      let corpusEpoch = state.corpusEpoch;
      const providerId = parsed.providerId.toLowerCase();
      let generation: { id: string; providerConnectionId: string; providerConfigurationVersion: number; credentialSecretFingerprint: string; modelId: string; dimensions: number; corpusEpoch: number; sourceManifestFingerprint: string; expectedEntryCount: number } | null = null;
      if (parsed.kind === "search") {
        const currentGeneration = await currentStateAndGeneration(tx, actor.id);
        if (currentGeneration.generation.providerConnectionId !== providerId) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_MISMATCH");
        generationId = currentGeneration.generation.id;
        corpusEpoch = currentGeneration.state.corpusEpoch;
        generation = currentGeneration.generation;
      } else {
        // A confirmed build is the only operation allowed to move the
        // index fence into `building`.  Preparing a replacement must leave a
        // currently ready generation searchable if the user never confirms,
        // cancels, or lets this challenge expire.
        if (state.status === "building") return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFLICT");
        const pages = await readPagesAndChunks(tx, actor.id);
        await lockProviderConfiguration(tx, providerId);
        const lockedProvider = await readVerifiedEmbeddingProvider(tx, actor.id, providerId);
        if (lockedProvider.ownerAccountAccessVersion !== current.accountAccessVersion) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_ACCOUNT_ACCESS_STALE");
        const manifest = manifestForPages(pages);
        const expectedEntryCount = personalKnowledgeSemanticTotalEntries(manifest);
        const manifestFingerprint = personalKnowledgeSemanticManifestFingerprint(manifest);
        const now = await databaseNow(tx);
        await mutationContext(tx);
        await tx.personalKnowledgeSemanticGeneration.updateMany({
          where: { ownerUserId: actor.id, corpusEpoch, status: "building" },
          data: { status: "failed", safeErrorCode: "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_EXPIRED", completedAt: now },
        });
        const created = await tx.personalKnowledgeSemanticGeneration.create({
          data: {
            id: randomUUID(),
            ownerUserId: actor.id,
            corpusEpoch,
            providerConnectionId: lockedProvider.id,
            providerConfigurationVersion: lockedProvider.configurationVersion,
            credentialSecretFingerprint: lockedProvider.credential.secretFingerprint,
            modelId: lockedProvider.defaultEmbeddingModelId!,
            dimensions: lockedProvider.embeddingDimensions!,
            status: "building",
            expectedEntryCount,
            indexedEntryCount: 0,
            sourceManifestFingerprint: manifestFingerprint,
            chunkerVersion: "unicode-text:v1",
            createdAt: now,
            startedAt: null,
          },
          select: { id: true },
        });
        generationId = created.id;
        generation = {
          id: created.id,
          providerConnectionId: lockedProvider.id,
          providerConfigurationVersion: lockedProvider.configurationVersion,
          credentialSecretFingerprint: lockedProvider.credential.secretFingerprint,
          modelId: lockedProvider.defaultEmbeddingModelId!,
          dimensions: lockedProvider.embeddingDimensions!,
          corpusEpoch,
          sourceManifestFingerprint: manifestFingerprint,
          expectedEntryCount,
        };
      }
      const pages = await readPagesAndChunks(tx, actor.id);
      const manifest = manifestForPages(pages);
      const manifestFingerprint = personalKnowledgeSemanticManifestFingerprint(manifest);
      if (generation === null || generation.sourceManifestFingerprint !== manifestFingerprint) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_STALE");
      const provider = await readVerifiedEmbeddingProvider(tx, actor.id, providerId);
      await lockProviderConfiguration(tx, provider.id);
      const lockedProvider = await readVerifiedEmbeddingProvider(tx, actor.id, provider.id);
      if (
        lockedProvider.ownerAccountAccessVersion !== current.accountAccessVersion
        || !providerMatches(lockedProvider, { id: generation.providerConnectionId, configurationVersion: generation.providerConfigurationVersion, modelId: generation.modelId, dimensions: generation.dimensions, credentialSecretFingerprint: generation.credentialSecretFingerprint })
      ) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_STALE");
      const queryHash = parsed.kind === "search" ? await persistedQueryHash(parsed.query!) : null;
      const now = await databaseNow(tx);
      const expiresAt = new Date(now.getTime() + PERSONAL_KNOWLEDGE_SEMANTIC_CHALLENGE_TTL_MS);
      await mutationContext(tx);
      const challenge = await tx.personalKnowledgeSemanticChallenge.create({
        data: {
          id: randomUUID(),
          ownerUserId: actor.id,
          kind: parsed.kind,
          generationId,
          providerConnectionId: lockedProvider.id,
          providerConfigurationVersion: lockedProvider.configurationVersion,
          credentialSecretFingerprint: lockedProvider.credential.secretFingerprint,
          modelId: lockedProvider.defaultEmbeddingModelId!,
          dimensions: lockedProvider.embeddingDimensions!,
          corpusEpoch,
          sourceManifest: manifest as Prisma.InputJsonValue,
          expectedEntryCount: personalKnowledgeSemanticTotalEntries(manifest),
          queryHash,
          actorAccountAccessVersion: current.accountAccessVersion,
          clientKeyHash: keyHash,
          inputFingerprint: await hmacDigest(fingerprintMaterial({ actor, kind: parsed.kind, generationId, corpusEpoch, manifestFingerprint, provider: lockedProvider, queryHash })),
          status: "issued",
          issuedAt: now,
          expiresAt,
        },
        select: { id: true, issuedAt: true, expiresAt: true },
      });
      return Object.freeze({
        challengeId: challenge.id,
        kind: parsed.kind,
        issuedAt: challenge.issuedAt.toISOString(),
        expiresAt: challenge.expiresAt.toISOString(),
        safeSummary: summaryForPages(pages, lockedProvider, challenge.expiresAt, parsed.kind, corpusEpoch),
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 });
  } catch (error) {
    if (isKnown(error, "P2002")) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFLICT");
    throw error;
  }
}

async function admitExecution(
  parsed: z.infer<typeof personalKnowledgeSemanticExecuteSchema>,
  actor: SemanticActor,
  db: PrismaClient,
): Promise<SemanticDispatchSnapshot> {
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, actor.id);
    // The challenge identifies the provider whose writer lock must be held
    // before any dispatch admission state is read.  This first lookup only
    // discovers that lock key; the complete challenge is read again below.
    const challengeHint = await tx.personalKnowledgeSemanticChallenge.findFirst({
      where: { id: parsed.challengeId, ownerUserId: actor.id },
      select: { providerConnectionId: true },
    });
    if (challengeHint === null) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_REQUIRED");
    await lockProviderConfiguration(tx, challengeHint.providerConnectionId);
    const current = await assertCurrentOrdinaryUser(tx, actor);
    const challenge = await findChallenge(tx, parsed.challengeId, actor.id);
    if (challenge === null) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_REQUIRED");
    if (challenge.status === "consumed" || challenge.consumedAt !== null) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_CONSUMED");
    const now = await databaseNow(tx);
    if (challenge.expiresAt.getTime() <= now.getTime()) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_EXPIRED");
    const pages = await readPagesAndChunks(tx, actor.id);
    const manifest = manifestForPages(pages);
    const manifestFingerprint = personalKnowledgeSemanticManifestFingerprint(manifest);
    const expectedClientHash = await clientKeyHash(parsed.clientKey);
    if (!equalHash(challenge.clientKeyHash, expectedClientHash)) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_REQUIRED");
    const suppliedQueryHash = challenge.kind === "search"
      ? parsed.query === undefined ? null : await persistedQueryHash(parsed.query)
      : null;
    if (challenge.kind === "search" && suppliedQueryHash === null) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_REQUIRED");
    if (challenge.queryHash === null ? suppliedQueryHash !== null : suppliedQueryHash === null || !equalHash(challenge.queryHash, suppliedQueryHash)) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
    if (challenge.expectedEntryCount !== personalKnowledgeSemanticTotalEntries(manifest) || !equalHash(challenge.sourceManifest === undefined ? null : personalKnowledgeSemanticManifestFingerprint(challenge.sourceManifest as PersonalKnowledgeSemanticManifestItem[]), manifestFingerprint)) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
    const state = await readIndexState(tx, actor.id);
    if (state === null || state.corpusEpoch !== challenge.corpusEpoch) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
    const generation = await tx.personalKnowledgeSemanticGeneration.findFirst({
      where: { id: challenge.generationId, ownerUserId: actor.id, corpusEpoch: challenge.corpusEpoch },
      select: { id: true, status: true },
    });
    if (generation === null) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
    if (challenge.kind === "build") {
      if (generation.status !== "building" || state.status === "building") return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
      if (state.status === "ready") {
        if (state.activeGenerationId === null || state.activeGenerationId === challenge.generationId) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
        const previousReady = await tx.personalKnowledgeSemanticGeneration.findFirst({
          where: { id: state.activeGenerationId, ownerUserId: actor.id, corpusEpoch: state.corpusEpoch, status: "ready" },
          select: { id: true },
        });
        if (previousReady === null) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
      }
    } else if (generation.status !== "ready" || state.status !== "ready" || state.activeGenerationId !== challenge.generationId) {
      return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
    }
    const provider = await readVerifiedEmbeddingProvider(tx, actor.id, challenge.providerConnectionId);
    if (provider.ownerAccountAccessVersion !== current.accountAccessVersion || !providerMatches(provider, {
      id: challenge.providerConnectionId,
      configurationVersion: challenge.providerConfigurationVersion,
      modelId: challenge.modelId,
      dimensions: challenge.dimensions,
      credentialSecretFingerprint: challenge.credentialSecretFingerprint,
    })) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
    const expectedInputFingerprint = await hmacDigest(fingerprintMaterial({ actor, kind: challenge.kind, generationId: challenge.generationId, corpusEpoch: challenge.corpusEpoch, manifestFingerprint, provider, queryHash: suppliedQueryHash }));
    if (!equalHash(challenge.inputFingerprint, expectedInputFingerprint)) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
    await mutationContext(tx);
    const previousIndexStatus = state.status;
    const previousActiveGenerationId = state.activeGenerationId;
    if (challenge.kind === "build") {
      const transitioned = await tx.personalKnowledgeSemanticIndexState.updateMany({
        where: {
          ownerUserId: actor.id,
          corpusEpoch: challenge.corpusEpoch,
          status: previousIndexStatus,
          activeGenerationId: previousActiveGenerationId,
        },
        data: { status: "building", activeGenerationId: challenge.generationId, updatedAt: now },
      });
      if (transitioned.count !== 1) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE");
    }
    const consumed = await tx.personalKnowledgeSemanticChallenge.updateMany({ where: { id: challenge.id, ownerUserId: actor.id, status: "issued", consumedAt: null }, data: { status: "consumed", consumedAt: now } });
    if (consumed.count !== 1) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_CONSUMED");
    const audit = await tx.personalKnowledgeSemanticAudit.create({
      data: {
        id: randomUUID(),
        ownerUserId: actor.id,
        challengeId: challenge.id,
        generationId: challenge.generationId,
        kind: challenge.kind,
        providerConnectionId: provider.id,
        providerConfigurationVersion: provider.configurationVersion,
        credentialSecretFingerprint: provider.credential.secretFingerprint,
        modelId: provider.defaultEmbeddingModelId!,
        dimensions: provider.embeddingDimensions!,
        corpusEpoch: challenge.corpusEpoch,
        expectedEntryCount: challenge.expectedEntryCount,
        status: "running",
        createdAt: now,
      },
      select: { id: true },
    });
    return Object.freeze({
      challengeId: challenge.id,
      auditId: audit.id,
      actor,
      kind: challenge.kind,
      generationId: challenge.generationId,
      corpusEpoch: challenge.corpusEpoch,
      documentManifest: manifest,
      pages,
      query: parsed.query ?? null,
      queryHash: suppliedQueryHash,
      provider,
      previousIndexStatus: challenge.kind === "build" ? previousIndexStatus : null,
      previousActiveGenerationId: challenge.kind === "build" ? previousActiveGenerationId : null,
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
}

function vectorLiteral(vector: SemanticVector): string {
  if (vector.length < 1 || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return fail("PERSONAL_KNOWLEDGE_SEMANTIC_INTEGRITY_ERROR");
  }
  return `[${vector.map((value) => String(value)).join(",")}]`;
}

function vectorFingerprint(vector: SemanticVector): string {
  return createHash("sha256").update(vectorLiteral(vector), "utf8").digest("hex");
}

async function publishBuild(
  snapshot: SemanticDispatchSnapshot,
  vectors: readonly SemanticVector[],
  usage: Readonly<{ requestCount: number; inputTokens: number; usageKnown: boolean }>,
  db: PrismaClient,
): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      await lockActorAccess(tx, snapshot.actor.id);
      await lockProviderConfiguration(tx, snapshot.provider.id);
      const current = await assertCurrentOrdinaryUser(tx, snapshot.actor);
      const state = await readIndexState(tx, snapshot.actor.id);
      if (state === null || state.corpusEpoch !== snapshot.corpusEpoch || state.status !== "building" || state.activeGenerationId !== snapshot.generationId) return false;
      const pages = await readPagesAndChunks(tx, snapshot.actor.id);
      const manifest = manifestForPages(pages);
      if (personalKnowledgeSemanticManifestFingerprint(manifest) !== personalKnowledgeSemanticManifestFingerprint(snapshot.documentManifest)) return false;
      const provider = await readVerifiedEmbeddingProvider(tx, snapshot.actor.id, snapshot.provider.id);
      if (provider.ownerAccountAccessVersion !== current.accountAccessVersion || !providerMatches(provider, {
        id: snapshot.provider.id,
        configurationVersion: snapshot.provider.configurationVersion,
        modelId: snapshot.provider.defaultEmbeddingModelId!,
        dimensions: snapshot.provider.embeddingDimensions!,
        credentialSecretFingerprint: snapshot.provider.credential.secretFingerprint,
      })) return false;
      const generation = await tx.personalKnowledgeSemanticGeneration.findFirst({ where: { id: snapshot.generationId, ownerUserId: snapshot.actor.id, corpusEpoch: snapshot.corpusEpoch, status: "building" }, select: { expectedEntryCount: true, dimensions: true } });
      if (generation === null || generation.expectedEntryCount !== vectors.length || generation.dimensions !== provider.embeddingDimensions) return false;
      const flatChunks = pages.flatMap(({ page, chunks }) => chunks.map((chunk) => ({ page, chunk })));
      if (flatChunks.length !== vectors.length) return false;
      await mutationContext(tx);
      for (let index = 0; index < flatChunks.length; index += 1) {
        const item = flatChunks[index]!;
        const vector = vectors[index]!;
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "PersonalKnowledgeSemanticEntry"
            ("id", "ownerUserId", "generationId", "documentId", "revisionId", "documentVersion", "ordinal", "rangeStart", "rangeEnd", "contentHash", "vector", "vectorFingerprint", "createdAt")
          VALUES
            (${randomUUID()}::uuid, ${snapshot.actor.id}::uuid, ${snapshot.generationId}::uuid, ${item.page.documentId}::uuid, ${item.page.revisionId}::uuid, ${item.page.version}, ${item.chunk.ordinal}, ${item.chunk.rangeStart}, ${item.chunk.rangeEnd}, ${item.chunk.contentHash}, ${vectorLiteral(vector)}::vector, ${vectorFingerprint(vector)}, clock_timestamp())
        `);
      }
      const now = await databaseNow(tx);
      await tx.personalKnowledgeSemanticGeneration.update({ where: { id: snapshot.generationId }, data: { status: "ready", indexedEntryCount: flatChunks.length, completedAt: now, safeErrorCode: null } });
      await tx.personalKnowledgeSemanticGeneration.updateMany({ where: { ownerUserId: snapshot.actor.id, status: "ready", id: { not: snapshot.generationId } }, data: { status: "superseded" } });
      const stateUpdate = await tx.personalKnowledgeSemanticIndexState.updateMany({ where: { ownerUserId: snapshot.actor.id, corpusEpoch: snapshot.corpusEpoch, status: "building", activeGenerationId: snapshot.generationId }, data: { status: "ready", activeGenerationId: snapshot.generationId, updatedAt: now } });
      if (stateUpdate.count !== 1) throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_STATE_SETTLEMENT_CONFLICT");
      const auditUpdate = await tx.personalKnowledgeSemanticAudit.updateMany({
        where: { id: snapshot.auditId, ownerUserId: snapshot.actor.id, status: "running" },
        data: {
          status: "succeeded",
          safeErrorCode: null,
          providerRequestId: null,
          requestCount: usage.requestCount,
          inputTokens: usage.inputTokens,
          usageKnown: usage.usageKnown,
          completedAt: now,
        },
      });
      if (auditUpdate.count !== 1) throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_AUDIT_SETTLEMENT_CONFLICT");
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
  } catch {
    return false;
  }
}

function transportUncertain(error: unknown): boolean {
  if (!(error instanceof ProviderTransportError)) return true;
  if (error.requestDispatched === false) return false;
  return error.code === "AI_PROVIDER_TIMEOUT" || error.code === "AI_PROVIDER_UNAVAILABLE";
}

function safeProviderRequestId(value: string | null): string | null {
  return value !== null && PROVIDER_REQUEST_ID_PATTERN.test(value) ? value : null;
}

function providerSafeCode(error: unknown): string {
  if (error instanceof ProviderTransportError) return error.code;
  return "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNAVAILABLE";
}

function dispatchAuditStatus(
  error: unknown,
  stale: boolean,
  uncertain: boolean,
): PersonalKnowledgeSemanticAuditStatus {
  // A rejected boundary is still pre-dispatch. The control-plane change is a
  // settled failure; only a request that may have reached the provider needs
  // reconciliation as unknown.
  if (stale && error instanceof ProviderTransportError && error.requestDispatched === false) return "failed";
  return stale || uncertain ? "unknown" : "failed";
}

export type PersonalKnowledgeSemanticSearchResult = Readonly<{
  generationId: string;
  results: readonly Readonly<{
    rank: number;
    score: number;
    documentId: string;
    revisionId: string;
    version: number;
    title: string;
    rangeStart: number;
    rangeEnd: number;
    contentHash: string;
    excerpt: string;
  }>[];
}>;

async function runSearch(snapshot: SemanticDispatchSnapshot, queryVector: SemanticVector, db: PrismaClient): Promise<PersonalKnowledgeSemanticSearchResult> {
  if (!(await assertDispatchStillValid(snapshot, db))) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_STALE");
  const literal = vectorLiteral(queryVector);
  try {
    const rows = await db.$transaction(async (tx) => {
      await lockActorAccess(tx, snapshot.actor.id);
      await lockProviderConfiguration(tx, snapshot.provider.id);
      const current = await assertCurrentOrdinaryUser(tx, snapshot.actor);
      const state = await readIndexState(tx, snapshot.actor.id);
      if (state === null || state.corpusEpoch !== snapshot.corpusEpoch || state.status !== "ready" || state.activeGenerationId !== snapshot.generationId) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_STALE");
      const provider = await readVerifiedEmbeddingProvider(tx, snapshot.actor.id, snapshot.provider.id);
      if (provider.ownerAccountAccessVersion !== current.accountAccessVersion || !providerMatches(provider, {
        id: snapshot.provider.id,
        configurationVersion: snapshot.provider.configurationVersion,
        modelId: snapshot.provider.defaultEmbeddingModelId!,
        dimensions: snapshot.provider.embeddingDimensions!,
        credentialSecretFingerprint: snapshot.provider.credential.secretFingerprint,
      })) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_STALE");
      const result = await tx.$queryRaw<SearchRow[]>(Prisma.sql`
        SELECT
          e."documentId" AS "documentId",
          e."revisionId" AS "revisionId",
          e."documentVersion" AS "documentVersion",
          r."title" AS "title",
          r."content" AS "content",
          r."contentHash" AS "contentHash",
          e."rangeStart" AS "rangeStart",
          e."rangeEnd" AS "rangeEnd",
          e."contentHash" AS "chunkContentHash",
          (e."vector" <=> ${literal}::vector) AS "distance"
        FROM "PersonalKnowledgeSemanticEntry" e
        INNER JOIN "PersonalKnowledgeDocument" d
          ON d."id" = e."documentId" AND d."ownerUserId" = e."ownerUserId"
        INNER JOIN "PersonalKnowledgeRevision" r
          ON r."documentId" = e."documentId" AND r."ownerUserId" = e."ownerUserId" AND r."id" = e."revisionId"
        WHERE e."ownerUserId" = ${snapshot.actor.id}::uuid
          AND e."generationId" = ${snapshot.generationId}::uuid
          AND vector_dims(e."vector") = ${snapshot.provider.embeddingDimensions!}
          AND d."state" = 'active'
          AND d."version" = e."documentVersion"
          AND d."currentRevisionId" = e."revisionId"
        ORDER BY e."vector" <=> ${literal}::vector ASC
        LIMIT ${DEFAULT_SEARCH_RESULTS}
      `);
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
    const results = rows.flatMap((row, index) => {
      try {
        const excerpt = personalKnowledgeSemanticExcerpt(row.content, row.rangeStart, row.rangeEnd);
        if (personalKnowledgeSemanticSha256(excerpt) !== row.chunkContentHash) return [];
        return [Object.freeze({
          rank: index + 1,
          score: Number.isFinite(Number(row.distance)) ? Math.max(-1, Math.min(1, 1 - Number(row.distance))) : 0,
          documentId: row.documentId,
          revisionId: row.revisionId,
          version: row.documentVersion,
          title: row.title,
          rangeStart: row.rangeStart,
          rangeEnd: row.rangeEnd,
          contentHash: row.chunkContentHash,
          excerpt,
        })];
      } catch {
        return [];
      }
    });
    return Object.freeze({ generationId: snapshot.generationId, results: Object.freeze(results) });
  } catch (error) {
    if (error instanceof PersonalKnowledgeSemanticError) throw error;
    return fail("PERSONAL_KNOWLEDGE_SEMANTIC_INTEGRITY_ERROR");
  }
}

export async function executePersonalKnowledgeSemantic(
  input: unknown,
  actor: SemanticActor,
  db: PrismaClient = getDb(),
): Promise<PersonalKnowledgeSemanticSearchResult | Readonly<{ generationId: string; indexedEntryCount: number; status: "ready" }>> {
  const parsed = parseExecuteInput(input);
  assertActorShape(actor);
  const snapshot = await admitExecution(parsed, actor, db);
  if (snapshot.kind === "search") {
    let generated: Awaited<ReturnType<typeof invokeEmbeddings>>;
    try {
      generated = await invokeEmbeddings({
        connection: {
          id: snapshot.provider.id,
          kind: snapshot.provider.kind,
          baseUrl: snapshot.provider.baseUrl,
          credentialId: snapshot.provider.credentialId,
          status: snapshot.provider.status,
          credentialSecretFingerprint: snapshot.provider.credential.secretFingerprint,
          onBeforeCredentialRead: () => assertDispatchStillValid(snapshot, db),
          onBeforeRequest: () => assertDispatchStillValid(snapshot, db),
        },
        modelId: snapshot.provider.defaultEmbeddingModelId!,
        texts: [snapshot.query!],
        expectedDimensions: snapshot.provider.embeddingDimensions,
      });
    } catch (error) {
      const stale = !(await assertDispatchStillValid(snapshot, db));
      const uncertain = transportUncertain(error);
      await setAuditStatus(snapshot, { status: dispatchAuditStatus(error, stale, uncertain), safeErrorCode: stale ? "PERSONAL_KNOWLEDGE_SEMANTIC_STALE" : uncertain ? "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNCERTAIN" : providerSafeCode(error), requestCount: 1 }, db);
      if (stale) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_STALE");
      if (uncertain) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNCERTAIN");
      return fail("PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNAVAILABLE");
    }
    let result: PersonalKnowledgeSemanticSearchResult;
    try {
      result = await runSearch(snapshot, generated.vectors[0]!, db);
    } catch (error) {
      const stale = error instanceof PersonalKnowledgeSemanticError && error.code === "PERSONAL_KNOWLEDGE_SEMANTIC_STALE";
      await setAuditStatus(snapshot, { status: stale ? "unknown" : "failed", safeErrorCode: stale ? "PERSONAL_KNOWLEDGE_SEMANTIC_STALE" : "PERSONAL_KNOWLEDGE_SEMANTIC_INTEGRITY_ERROR", requestCount: 1, inputTokens: generated.inputTokens, usageKnown: generated.usageKnown }, db);
      throw error;
    }
    await setAuditStatus(snapshot, { status: "succeeded", safeErrorCode: null, providerRequestId: safeProviderRequestId(generated.providerRequestId), requestCount: 1, inputTokens: generated.inputTokens, usageKnown: generated.usageKnown }, db);
    return result;
  }

  const vectors: SemanticVector[] = [];
  let requestCount = 0;
  let inputTokens = 0;
  let usageKnown = true;
  const chunks = snapshot.pages.flatMap(({ chunks }) => chunks);
  try {
    for (let start = 0; start < chunks.length; start += EMBEDDING_OPERATION_BATCH) {
      if (!(await assertDispatchStillValid(snapshot, db))) {
        await setAuditStatus(snapshot, { status: "failed", safeErrorCode: "PERSONAL_KNOWLEDGE_SEMANTIC_STALE", requestCount, inputTokens, usageKnown }, db);
        return fail("PERSONAL_KNOWLEDGE_SEMANTIC_STALE");
      }
      const batch = chunks.slice(start, start + EMBEDDING_OPERATION_BATCH);
      const generated = await invokeEmbeddings({
        connection: {
          id: snapshot.provider.id,
          kind: snapshot.provider.kind,
          baseUrl: snapshot.provider.baseUrl,
          credentialId: snapshot.provider.credentialId,
          status: snapshot.provider.status,
          credentialSecretFingerprint: snapshot.provider.credential.secretFingerprint,
          onBeforeCredentialRead: () => assertDispatchStillValid(snapshot, db),
          onBeforeRequest: () => assertDispatchStillValid(snapshot, db),
        },
        modelId: snapshot.provider.defaultEmbeddingModelId!,
        texts: batch.map((chunk) => chunk.contentText),
        expectedDimensions: snapshot.provider.embeddingDimensions,
      });
      requestCount += 1;
      inputTokens += generated.inputTokens;
      usageKnown = usageKnown && generated.usageKnown;
      vectors.push(...generated.vectors);
    }
  } catch (error) {
    const stale = !(await assertDispatchStillValid(snapshot, db));
    const uncertain = transportUncertain(error);
    await setAuditStatus(snapshot, { status: dispatchAuditStatus(error, stale, uncertain), safeErrorCode: stale ? "PERSONAL_KNOWLEDGE_SEMANTIC_STALE" : uncertain ? "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNCERTAIN" : providerSafeCode(error), requestCount, inputTokens, usageKnown }, db);
    if (stale) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_STALE");
    if (uncertain) return fail("PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNCERTAIN");
    return fail("PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNAVAILABLE");
  }
  if (vectors.length !== chunks.length) {
    await setAuditStatus(snapshot, { status: "failed", safeErrorCode: "PERSONAL_KNOWLEDGE_SEMANTIC_INTEGRITY_ERROR", requestCount, inputTokens, usageKnown }, db);
    return fail("PERSONAL_KNOWLEDGE_SEMANTIC_INTEGRITY_ERROR");
  }
  if (!(await publishBuild(snapshot, vectors, { requestCount, inputTokens, usageKnown }, db))) {
    await setAuditStatus(snapshot, { status: "failed", safeErrorCode: "PERSONAL_KNOWLEDGE_SEMANTIC_STALE", requestCount, inputTokens, usageKnown }, db);
    return fail("PERSONAL_KNOWLEDGE_SEMANTIC_STALE");
  }
  return Object.freeze({ generationId: snapshot.generationId, indexedEntryCount: vectors.length, status: "ready" as const });
}

export async function getPersonalKnowledgeSemanticOverview(actor: SemanticActor, db: PrismaClient = getDb()) {
  assertActorShape(actor);
  await assertCurrentOrdinaryUser(db, actor);
  const state = await readIndexState(db, actor.id);
  if (state === null) return Object.freeze({ status: "not_available" as const, label: "尚未建立/不可用" as const });
  const generation = state.activeGenerationId === null ? null : await db.personalKnowledgeSemanticGeneration.findFirst({ where: { id: state.activeGenerationId, ownerUserId: actor.id, corpusEpoch: state.corpusEpoch, status: "ready" }, select: { id: true, expectedEntryCount: true, indexedEntryCount: true, dimensions: true, modelId: true, completedAt: true } });
  if (state.status !== "ready" || generation === null || generation.expectedEntryCount !== generation.indexedEntryCount) {
    return Object.freeze({ status: state.status === "building" ? "building" as const : "not_available" as const, label: state.status === "building" ? "正在建立" as const : "尚未建立/不可用" as const });
  }
  return Object.freeze({ status: "ready" as const, label: "可用于语义搜索" as const, generationId: generation.id, indexedEntryCount: generation.indexedEntryCount, dimensions: generation.dimensions, modelId: generation.modelId, completedAt: generation.completedAt });
}
