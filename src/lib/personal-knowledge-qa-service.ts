import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  Prisma,
  type AiProviderConnectionStatus,
  type PersonalKnowledgeQaAuditStatus,
  type PersonalKnowledgeQaChallengeStatus,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
import {
  invokeChatCompletion,
  ProviderTransportError,
} from "@/lib/ai-providers";
import { getProviderDefinition } from "@/lib/ai-providers/registry";
import { lockProviderConfiguration } from "@/lib/ai-providers/service";
import {
  buildPersonalKnowledgeQaEvidence,
  buildPersonalKnowledgeQaMessages,
  canonicalPersonalKnowledgeQaJson,
  parsePersonalKnowledgeQaModelOutput,
  personalKnowledgeQaEvidenceManifest,
  personalKnowledgeQaQuestionSchema,
  type PersonalKnowledgeQaEvidence,
  type PersonalKnowledgeQaModelResult,
  type PersonalKnowledgeQaPage,
} from "@/lib/personal-knowledge-qa-contract";

const UUID_SCHEMA = z.string().uuid();
const CLIENT_KEY_SCHEMA = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PROVIDER_REQUEST_ID_PATTERN = /^[\x20-\x7e]{1,256}$/u;
const QA_CHALLENGE_TTL_MS = 10 * 60 * 1_000;
const QA_OPERATION = "generateWithContext" as const;
const HMAC_CONTEXT = "ai-project-os:personal-knowledge-qa:v1";

export const personalKnowledgeQaPrepareSchema = z.object({
  phase: z.literal("prepare").optional(),
  question: personalKnowledgeQaQuestionSchema,
  clientKey: CLIENT_KEY_SCHEMA,
  providerId: UUID_SCHEMA,
}).strict();

export const personalKnowledgeQaExecuteSchema = z.object({
  phase: z.literal("execute").optional(),
  challengeId: UUID_SCHEMA,
  question: personalKnowledgeQaQuestionSchema,
  clientKey: CLIENT_KEY_SCHEMA,
  providerId: UUID_SCHEMA.optional(),
}).strict();

export type PersonalKnowledgeQaErrorCode =
  | "PERSONAL_KNOWLEDGE_QA_INVALID_INPUT"
  | "PERSONAL_KNOWLEDGE_QA_FORBIDDEN"
  | "PERSONAL_KNOWLEDGE_QA_ACCOUNT_DISABLED"
  | "PERSONAL_KNOWLEDGE_QA_ACCOUNT_ACCESS_STALE"
  | "PERSONAL_KNOWLEDGE_QA_DOCUMENT_NOT_FOUND"
  | "PERSONAL_KNOWLEDGE_QA_PROVIDER_NOT_FOUND"
  | "PERSONAL_KNOWLEDGE_QA_PROVIDER_NOT_VERIFIED"
  | "PERSONAL_KNOWLEDGE_QA_NO_EVIDENCE"
  | "PERSONAL_KNOWLEDGE_QA_CONFIRMATION_REQUIRED"
  | "PERSONAL_KNOWLEDGE_QA_CONFIRMATION_STALE"
  | "PERSONAL_KNOWLEDGE_QA_CONFIRMATION_EXPIRED"
  | "PERSONAL_KNOWLEDGE_QA_CONFIRMATION_CONSUMED"
  | "PERSONAL_KNOWLEDGE_QA_PROVIDER_UNAVAILABLE"
  | "PERSONAL_KNOWLEDGE_QA_PROVIDER_UNCERTAIN"
  | "PERSONAL_KNOWLEDGE_QA_INVALID_MODEL_OUTPUT"
  | "PERSONAL_KNOWLEDGE_QA_INVALID_CITATION"
  | "PERSONAL_KNOWLEDGE_QA_CONFLICT";

export class PersonalKnowledgeQaError extends Error {
  constructor(readonly code: PersonalKnowledgeQaErrorCode) {
    super(code);
    this.name = "PersonalKnowledgeQaError";
  }
}

function fail(code: PersonalKnowledgeQaErrorCode): never {
  throw new PersonalKnowledgeQaError(code);
}

type QaDb = PrismaClient | Prisma.TransactionClient;
type QaActor = Readonly<{ id: string; role: "admin" | "user"; accountAccessVersion?: number }>;

type QaProvider = Readonly<{
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
  defaultGenerationModelId: string | null;
  credential: { kind: "aiProvider"; secretFingerprint: string };
}>;

type QaPageRow = Readonly<{
  id: string;
  ownerUserId: string;
  version: number;
  currentRevision: Readonly<{
    id: string;
    version: number;
    title: string;
    content: string;
    contentHash: string;
    byteCount: number;
  }> | null;
}>;

type QaChallengeRow = Readonly<{
  id: string;
  ownerUserId: string;
  documentId: string;
  revisionId: string;
  documentVersion: number;
  contentHash: string;
  questionHash: string;
  evidenceManifest: unknown;
  providerConnectionId: string;
  providerConfigurationVersion: number;
  modelId: string;
  credentialSecretFingerprint: string;
  actorAccountAccessVersion: number;
  clientKeyHash: string;
  inputFingerprint: string;
  status: PersonalKnowledgeQaChallengeStatus;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}>;

type QaDispatchSnapshot = Readonly<{
  challengeId: string;
  auditId: string;
  actor: QaActor;
  documentId: string;
  revisionId: string;
  documentVersion: number;
  contentHash: string;
  questionHash: string;
  evidence: readonly PersonalKnowledgeQaEvidence[];
  provider: QaProvider;
}>;

function assertActorShape(actor: unknown): asserts actor is QaActor {
  if (typeof actor !== "object" || actor === null) return fail("PERSONAL_KNOWLEDGE_QA_FORBIDDEN");
  const value = actor as { id?: unknown; role?: unknown; accountAccessVersion?: unknown };
  if (!UUID_SCHEMA.safeParse(value.id).success || value.role !== "user") return fail("PERSONAL_KNOWLEDGE_QA_FORBIDDEN");
  if (!Number.isSafeInteger(value.accountAccessVersion) || Number(value.accountAccessVersion) < 1) {
    return fail("PERSONAL_KNOWLEDGE_QA_ACCOUNT_ACCESS_STALE");
  }
}

function parseDocumentId(value: unknown): string {
  const parsed = UUID_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_QA_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function parseProviderId(value: unknown): string {
  const parsed = UUID_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_QA_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function parsePrepareInput(value: unknown): z.infer<typeof personalKnowledgeQaPrepareSchema> {
  const parsed = personalKnowledgeQaPrepareSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_QA_INVALID_INPUT");
  return Object.freeze({ ...parsed.data, providerId: parsed.data.providerId.toLowerCase() });
}

function parseExecuteInput(value: unknown): z.infer<typeof personalKnowledgeQaExecuteSchema> {
  const parsed = personalKnowledgeQaExecuteSchema.safeParse(value);
  if (!parsed.success) return fail("PERSONAL_KNOWLEDGE_QA_INVALID_INPUT");
  return Object.freeze({
    ...parsed.data,
    challengeId: parsed.data.challengeId.toLowerCase(),
    ...(parsed.data.providerId === undefined ? {} : { providerId: parsed.data.providerId.toLowerCase() }),
  });
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function hmacDigest(value: unknown): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update(HMAC_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(canonicalPersonalKnowledgeQaJson(value), "utf8")
    .digest("hex");
}

async function clientKeyHash(clientKey: string): Promise<string> {
  return hmacDigest({ purpose: "client-key", clientKey });
}

/** Keep the question binding opaque at rest; short questions are dictionary-friendly. */
async function persistedQuestionHash(question: string): Promise<string> {
  return hmacDigest({ purpose: "question-hash", question });
}

function evidenceManifestEquals(left: unknown, right: readonly Readonly<Record<string, unknown>>[]): boolean {
  return canonicalPersonalKnowledgeQaJson(left) === canonicalPersonalKnowledgeQaJson(right);
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
    defaultGenerationModelId: true,
    credential: { select: { kind: true, secretFingerprint: true } },
  } as const;
}

async function currentActor(db: QaDb, actor: QaActor): Promise<Readonly<{ accountAccessVersion: number }>> {
  try {
    return await assertAccountAccessForActor(db, actor);
  } catch (error) {
    if (error instanceof AccountAccessGuardError) {
      if (error.code === "ACCOUNT_DISABLED") return fail("PERSONAL_KNOWLEDGE_QA_ACCOUNT_DISABLED");
      if (error.code === "ACCOUNT_ACCESS_STALE") return fail("PERSONAL_KNOWLEDGE_QA_ACCOUNT_ACCESS_STALE");
    }
    return fail("PERSONAL_KNOWLEDGE_QA_FORBIDDEN");
  }
}

async function assertCurrentOrdinaryUser(db: QaDb, actor: QaActor): Promise<Readonly<{ accountAccessVersion: number }>> {
  assertActorShape(actor);
  const access = await currentActor(db, actor);
  const row = await db.appUser.findUnique({ where: { id: actor.id }, select: { role: true, disabledAt: true } });
  if (row === null || row.disabledAt !== null || row.role !== "user") return fail("PERSONAL_KNOWLEDGE_QA_FORBIDDEN");
  return access;
}

async function readPage(db: QaDb, ownerUserId: string, documentId: string): Promise<QaPageRow> {
  const row = await db.personalKnowledgeDocument.findFirst({
    where: { id: documentId, ownerUserId, state: "active", deletedAt: null },
    select: {
      id: true,
      ownerUserId: true,
      version: true,
      currentRevision: {
        select: { id: true, version: true, title: true, content: true, contentHash: true, byteCount: true },
      },
    },
  });
  if (row === null || row.currentRevision === null || row.currentRevision.version !== row.version) {
    return fail("PERSONAL_KNOWLEDGE_QA_DOCUMENT_NOT_FOUND");
  }
  if (row.ownerUserId !== ownerUserId || sha256(row.currentRevision.content) !== row.currentRevision.contentHash || Buffer.byteLength(row.currentRevision.content, "utf8") !== row.currentRevision.byteCount) {
    return fail("PERSONAL_KNOWLEDGE_QA_CONFLICT");
  }
  return row;
}

function toQaPage(row: QaPageRow): PersonalKnowledgeQaPage {
  if (row.currentRevision === null) return fail("PERSONAL_KNOWLEDGE_QA_DOCUMENT_NOT_FOUND");
  return Object.freeze({
    documentId: row.id,
    revisionId: row.currentRevision.id,
    version: row.version,
    title: row.currentRevision.title,
    content: row.currentRevision.content,
    contentHash: row.currentRevision.contentHash,
  });
}

async function readVerifiedProvider(db: QaDb, ownerUserId: string, providerId: string): Promise<QaProvider> {
  const provider = await db.aiProviderConnection.findFirst({
    where: { id: providerId, scope: "user", ownerUserId },
    select: providerSelect(),
  });
  if (provider === null) return fail("PERSONAL_KNOWLEDGE_QA_PROVIDER_NOT_FOUND");
  let definition: ReturnType<typeof getProviderDefinition>;
  try {
    definition = getProviderDefinition(provider.kind);
  } catch {
    return fail("PERSONAL_KNOWLEDGE_QA_PROVIDER_NOT_VERIFIED");
  }
  if (
    provider.protocol !== "chatCompletions"
    || provider.baseUrl !== definition.baseUrl
    || provider.status !== "verified"
    || provider.disabledAt !== null
    || provider.defaultGenerationModelId === null
    || provider.ownerAccountAccessVersion === null
    || provider.credential.kind !== "aiProvider"
    || !HASH_PATTERN.test(provider.credential.secretFingerprint)
  ) return fail("PERSONAL_KNOWLEDGE_QA_PROVIDER_NOT_VERIFIED");
  return provider as QaProvider;
}

function confirmationSummary(page: PersonalKnowledgeQaPage, evidence: readonly PersonalKnowledgeQaEvidence[], provider: QaProvider, expiresAt: Date) {
  return Object.freeze({
    action: "personalKnowledgeQa" as const,
    documentBytes: Buffer.byteLength(page.content, "utf8"),
    evidenceChunks: evidence.length,
    evidenceBytes: evidence.reduce((total, item) => total + Buffer.byteLength(item.excerpt, "utf8"), 0),
    provider: provider.name,
    model: provider.defaultGenerationModelId!,
    expiresAt: expiresAt.toISOString(),
  });
}

function fingerprintMaterial(input: Readonly<{
  actor: QaActor;
  page: PersonalKnowledgeQaPage;
  questionHash: string;
  evidenceManifest: readonly Readonly<Record<string, unknown>>[];
  provider: QaProvider;
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    protocol: HMAC_CONTEXT,
    actorId: input.actor.id,
    actorRole: input.actor.role,
    actorAccountAccessVersion: input.actor.accountAccessVersion,
    documentId: input.page.documentId,
    revisionId: input.page.revisionId,
    documentVersion: input.page.version,
    contentHash: input.page.contentHash,
    questionHash: input.questionHash,
    evidenceManifest: input.evidenceManifest,
    providerConnectionId: input.provider.id,
    providerName: input.provider.name,
    providerConfigurationVersion: input.provider.configurationVersion,
    modelId: input.provider.defaultGenerationModelId,
    credentialSecretFingerprint: input.provider.credential.secretFingerprint,
  });
}

function safeProviderRequestId(value: string | null): string | null {
  return value !== null && PROVIDER_REQUEST_ID_PATTERN.test(value) ? value : null;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof PersonalKnowledgeQaError) return error.code;
  if (error instanceof ProviderTransportError) return error.code;
  return "PERSONAL_KNOWLEDGE_QA_PROVIDER_UNAVAILABLE";
}

function transportWasUncertain(error: unknown): boolean {
  if (!(error instanceof ProviderTransportError)) return true;
  if (error.requestDispatched === false) return false;
  return error.code === "AI_PROVIDER_TIMEOUT" || error.code === "AI_PROVIDER_UNAVAILABLE";
}

function mapModelError(error: unknown): never {
  if (error instanceof Error && error.message === "PERSONAL_KNOWLEDGE_QA_INVALID_CITATION") return fail("PERSONAL_KNOWLEDGE_QA_INVALID_CITATION");
  if (error instanceof Error && error.message === "PERSONAL_KNOWLEDGE_QA_INVALID_MODEL_OUTPUT") return fail("PERSONAL_KNOWLEDGE_QA_INVALID_MODEL_OUTPUT");
  throw error;
}

async function databaseNow(db: QaDb): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const value = rows[0]?.now;
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
}

async function mutationContext(db: QaDb): Promise<void> {
  await db.$executeRaw`SELECT set_config('app.personal_knowledge_qa_mutation_context', 'service-v1', true)`;
}

async function findChallenge(db: QaDb, id: string, ownerUserId: string): Promise<QaChallengeRow | null> {
  return db.personalKnowledgeQaChallenge.findFirst({
    where: { id, ownerUserId },
    select: {
      id: true,
      ownerUserId: true,
      documentId: true,
      revisionId: true,
      documentVersion: true,
      contentHash: true,
      questionHash: true,
      evidenceManifest: true,
      providerConnectionId: true,
      providerConfigurationVersion: true,
      modelId: true,
      credentialSecretFingerprint: true,
      actorAccountAccessVersion: true,
      clientKeyHash: true,
      inputFingerprint: true,
      status: true,
      issuedAt: true,
      expiresAt: true,
      consumedAt: true,
    },
  });
}

async function assertDispatchStillValid(snapshot: QaDispatchSnapshot, db: PrismaClient): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      // Keep the lock order identical to account/provider mutations.  The
      // actor must be locked before the provider and re-read only after both
      // locks are held; otherwise a revoke can commit between the actor read
      // and the provider fence while this callback still sees a stale snapshot.
      await lockActorAccess(tx, snapshot.actor.id);
      await lockProviderConfiguration(tx, snapshot.provider.id);
      const current = await assertCurrentOrdinaryUser(tx, snapshot.actor);
      const [challenge, audit, page, provider] = await Promise.all([
        findChallenge(tx, snapshot.challengeId, snapshot.actor.id),
        tx.personalKnowledgeQaAudit.findFirst({ where: { id: snapshot.auditId, ownerUserId: snapshot.actor.id }, select: { status: true } }),
        readPage(tx, snapshot.actor.id, snapshot.documentId),
        readVerifiedProvider(tx, snapshot.actor.id, snapshot.provider.id),
      ]);
      if (
        challenge === null
        || challenge.status !== "consumed"
        || challenge.consumedAt === null
        || challenge.ownerUserId !== snapshot.actor.id
        || challenge.documentId !== snapshot.documentId
        || challenge.revisionId !== snapshot.revisionId
        || challenge.documentVersion !== snapshot.documentVersion
        || !equalHash(challenge.contentHash, snapshot.contentHash)
        || !equalHash(challenge.questionHash, snapshot.questionHash)
        || challenge.providerConnectionId !== snapshot.provider.id
        || challenge.actorAccountAccessVersion !== current.accountAccessVersion
      ) return false;
      if (audit === null || audit.status !== "running") return false;
      if (page.version !== snapshot.documentVersion || page.currentRevision?.id !== snapshot.revisionId || page.currentRevision?.contentHash !== snapshot.contentHash) return false;
      if (
        provider.id !== snapshot.provider.id
        || provider.name !== snapshot.provider.name
        || provider.configurationVersion !== snapshot.provider.configurationVersion
        || provider.credential.secretFingerprint !== snapshot.provider.credential.secretFingerprint
        || provider.defaultGenerationModelId !== snapshot.provider.defaultGenerationModelId
        || provider.ownerAccountAccessVersion !== current.accountAccessVersion
      ) return false;
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  } catch {
    return false;
  }
}

async function finalizeAudit(
  snapshot: QaDispatchSnapshot,
  update: Readonly<{
    status: PersonalKnowledgeQaAuditStatus;
    safeErrorCode: string | null;
    providerRequestId?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    usageKnown?: boolean;
  }>,
  db: PrismaClient,
): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await mutationContext(tx);
      await lockActorAccess(tx, snapshot.actor.id);
      await tx.personalKnowledgeQaAudit.updateMany({
        where: { id: snapshot.auditId, ownerUserId: snapshot.actor.id, status: "running" },
        data: {
          status: update.status,
          safeErrorCode: update.safeErrorCode,
          providerRequestId: update.providerRequestId === undefined ? undefined : update.providerRequestId,
          inputTokens: update.inputTokens ?? 0,
          outputTokens: update.outputTokens ?? 0,
          usageKnown: update.usageKnown === true,
          completedAt: new Date(),
        },
      });
    });
  } catch {
    // Preserve the provider outcome for the caller while the audit remains
    // safely running if the final write itself cannot be committed.
  }
}

export type PersonalKnowledgeQaConfirmation = Readonly<{
  challengeId: string;
  providerId: string;
  issuedAt: string;
  expiresAt: string;
  safeSummary: Readonly<{
    action: "personalKnowledgeQa";
    documentBytes: number;
    evidenceChunks: number;
    evidenceBytes: number;
    provider: string;
    model: string;
    expiresAt: string;
  }>;
}>;

export async function preparePersonalKnowledgeQa(
  documentIdInput: unknown,
  input: unknown,
  actor: QaActor,
  db: PrismaClient = getDb(),
): Promise<PersonalKnowledgeQaConfirmation> {
  const documentId = parseDocumentId(documentIdInput);
  const parsed = parsePrepareInput(input);
  assertActorShape(actor);
  const clientHash = await clientKeyHash(parsed.clientKey);
  try {
    return await db.$transaction(async (tx) => {
      const current = await assertCurrentOrdinaryUser(tx, actor);
      const pageRow = await readPage(tx, actor.id, documentId);
      const page = toQaPage(pageRow);
      const questionHash = await persistedQuestionHash(parsed.question);
      const evidence = buildPersonalKnowledgeQaEvidence(page, parsed.question);
      if (evidence.length === 0) return fail("PERSONAL_KNOWLEDGE_QA_NO_EVIDENCE");
      const manifest = personalKnowledgeQaEvidenceManifest(evidence);
      const selectedProviderId = parseProviderId(parsed.providerId);
      const initialProvider = await readVerifiedProvider(tx, actor.id, selectedProviderId);
      await lockProviderConfiguration(tx, initialProvider.id);
      const provider = await readVerifiedProvider(tx, actor.id, selectedProviderId);
      if (provider.ownerAccountAccessVersion !== current.accountAccessVersion) return fail("PERSONAL_KNOWLEDGE_QA_ACCOUNT_ACCESS_STALE");
      const now = await databaseNow(tx);
      const expiresAt = new Date(now.getTime() + QA_CHALLENGE_TTL_MS);
      await mutationContext(tx);
      const challenge = await tx.personalKnowledgeQaChallenge.create({
        data: {
          id: randomUUID(),
          ownerUserId: actor.id,
          documentId: page.documentId,
          revisionId: page.revisionId,
          documentVersion: page.version,
          contentHash: page.contentHash,
          questionHash,
          evidenceManifest: manifest as Prisma.InputJsonValue,
          providerConnectionId: provider.id,
          providerConfigurationVersion: provider.configurationVersion,
          modelId: provider.defaultGenerationModelId!,
          credentialSecretFingerprint: provider.credential.secretFingerprint,
          actorAccountAccessVersion: current.accountAccessVersion,
          clientKeyHash: clientHash,
          inputFingerprint: await hmacDigest(fingerprintMaterial({ actor, page, questionHash, evidenceManifest: manifest, provider })),
          status: "issued",
          issuedAt: now,
          expiresAt,
        },
        select: { id: true, issuedAt: true, expiresAt: true },
      });
      return Object.freeze({
        challengeId: challenge.id,
        providerId: provider.id,
        issuedAt: challenge.issuedAt.toISOString(),
        expiresAt: challenge.expiresAt.toISOString(),
        safeSummary: confirmationSummary(page, evidence, provider, challenge.expiresAt),
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  } catch (error) {
    if (isKnown(error, "P2002")) return fail("PERSONAL_KNOWLEDGE_QA_CONFLICT");
    throw error;
  }
}

async function admitExecution(
  documentId: string,
  parsed: z.infer<typeof personalKnowledgeQaExecuteSchema>,
  actor: QaActor,
  db: PrismaClient,
): Promise<QaDispatchSnapshot> {
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, actor.id);
    const current = await assertCurrentOrdinaryUser(tx, actor);
    const challenge = await findChallenge(tx, parsed.challengeId.toLowerCase(), actor.id);
    if (challenge === null) return fail("PERSONAL_KNOWLEDGE_QA_CONFIRMATION_REQUIRED");
    if (parsed.providerId !== undefined && parsed.providerId !== challenge.providerConnectionId) return fail("PERSONAL_KNOWLEDGE_QA_CONFIRMATION_STALE");
    if (challenge.status === "consumed" || challenge.consumedAt !== null) return fail("PERSONAL_KNOWLEDGE_QA_CONFIRMATION_CONSUMED");
    const now = await databaseNow(tx);
    if (challenge.expiresAt.getTime() <= now.getTime()) return fail("PERSONAL_KNOWLEDGE_QA_CONFIRMATION_EXPIRED");
    const pageRow = await readPage(tx, actor.id, documentId);
    const page = toQaPage(pageRow);
    const questionHash = await persistedQuestionHash(parsed.question);
    if (challenge.documentId !== page.documentId || challenge.revisionId !== page.revisionId || challenge.documentVersion !== page.version || !equalHash(challenge.contentHash, page.contentHash) || !equalHash(challenge.questionHash, questionHash)) return fail("PERSONAL_KNOWLEDGE_QA_CONFIRMATION_STALE");
    const evidence = buildPersonalKnowledgeQaEvidence(page, parsed.question);
    const manifest = personalKnowledgeQaEvidenceManifest(evidence);
    if (evidence.length === 0 || !evidenceManifestEquals(challenge.evidenceManifest, manifest)) return fail("PERSONAL_KNOWLEDGE_QA_CONFIRMATION_STALE");
    const expectedClientHash = await clientKeyHash(parsed.clientKey);
    if (!equalHash(challenge.clientKeyHash, expectedClientHash)) return fail("PERSONAL_KNOWLEDGE_QA_CONFIRMATION_REQUIRED");
    await lockProviderConfiguration(tx, challenge.providerConnectionId);
    const provider = await readVerifiedProvider(tx, actor.id, challenge.providerConnectionId);
    if (provider.configurationVersion !== challenge.providerConfigurationVersion || provider.defaultGenerationModelId !== challenge.modelId || !equalHash(provider.credential.secretFingerprint, challenge.credentialSecretFingerprint) || provider.ownerAccountAccessVersion !== current.accountAccessVersion) return fail("PERSONAL_KNOWLEDGE_QA_CONFIRMATION_STALE");
    const expectedInputFingerprint = await hmacDigest(fingerprintMaterial({ actor, page, questionHash, evidenceManifest: manifest, provider }));
    if (!equalHash(challenge.inputFingerprint, expectedInputFingerprint)) return fail("PERSONAL_KNOWLEDGE_QA_CONFIRMATION_STALE");

    await mutationContext(tx);
    const consumed = await tx.personalKnowledgeQaChallenge.updateMany({
      where: { id: challenge.id, ownerUserId: actor.id, status: "issued", consumedAt: null },
      data: { status: "consumed", consumedAt: now },
    });
    if (consumed.count !== 1) return fail("PERSONAL_KNOWLEDGE_QA_CONFIRMATION_CONSUMED");
    const audit = await tx.personalKnowledgeQaAudit.create({
      data: {
        id: randomUUID(),
        ownerUserId: actor.id,
        challengeId: challenge.id,
        documentId: page.documentId,
        revisionId: page.revisionId,
        documentVersion: page.version,
        contentHash: page.contentHash,
        questionHash,
        evidenceManifest: manifest as Prisma.InputJsonValue,
        providerConnectionId: provider.id,
        providerConfigurationVersion: provider.configurationVersion,
        modelId: provider.defaultGenerationModelId!,
        credentialSecretFingerprint: provider.credential.secretFingerprint,
        actorAccountAccessVersion: current.accountAccessVersion,
        status: "running",
        createdAt: now,
      },
      select: { id: true },
    });
    return Object.freeze({
      challengeId: challenge.id,
      auditId: audit.id,
      actor,
      documentId: page.documentId,
      revisionId: page.revisionId,
      documentVersion: page.version,
      contentHash: page.contentHash,
      questionHash,
      evidence,
      provider,
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
}

export type PersonalKnowledgeQaAnswer = Readonly<{
  answer: string;
  citations: readonly Readonly<{
    citationKey: string;
    title: string;
    rangeStart: number;
    rangeEnd: number;
    excerpt: string;
  }>[];
}>;

export async function executePersonalKnowledgeQa(
  documentIdInput: unknown,
  input: unknown,
  actor: QaActor,
  db: PrismaClient = getDb(),
): Promise<PersonalKnowledgeQaAnswer> {
  const documentId = parseDocumentId(documentIdInput);
  const parsed = parseExecuteInput(input);
  assertActorShape(actor);
  const snapshot = await admitExecution(documentId, parsed, actor, db);
  const messages = buildPersonalKnowledgeQaMessages(parsed.question, snapshot.evidence);
  let generated: Awaited<ReturnType<typeof invokeChatCompletion>>;
  try {
    generated = await invokeChatCompletion({
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
      operation: QA_OPERATION,
      modelId: snapshot.provider.defaultGenerationModelId!,
      messages,
      maxOutputTokens: 2_048,
      temperature: 0,
    });
  } catch (error) {
    const uncertain = transportWasUncertain(error);
    await finalizeAudit(snapshot, {
      status: uncertain ? "unknown" : "failed",
      safeErrorCode: uncertain ? "PERSONAL_KNOWLEDGE_QA_PROVIDER_UNCERTAIN" : safeErrorCode(error),
      providerRequestId: error instanceof ProviderTransportError ? null : undefined,
    }, db);
    if (uncertain) return fail("PERSONAL_KNOWLEDGE_QA_PROVIDER_UNCERTAIN");
    if (error instanceof ProviderTransportError) return fail("PERSONAL_KNOWLEDGE_QA_PROVIDER_UNAVAILABLE");
    throw error;
  }

  let modelResult: PersonalKnowledgeQaModelResult;
  try {
    modelResult = parsePersonalKnowledgeQaModelOutput(generated.content, new Set(snapshot.evidence.map((item) => item.citationKey)));
  } catch (error) {
    await finalizeAudit(snapshot, {
      status: "failed",
      safeErrorCode: error instanceof Error ? error.message : "PERSONAL_KNOWLEDGE_QA_INVALID_MODEL_OUTPUT",
      providerRequestId: safeProviderRequestId(generated.providerRequestId),
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
      usageKnown: generated.usageKnown,
    }, db);
    return mapModelError(error);
  }

  await finalizeAudit(snapshot, {
    status: "succeeded",
    safeErrorCode: null,
    providerRequestId: safeProviderRequestId(generated.providerRequestId),
    inputTokens: generated.inputTokens,
    outputTokens: generated.outputTokens,
    usageKnown: generated.usageKnown,
  }, db);
  const citations = modelResult.citations.map((citationKey) => {
    const evidence = snapshot.evidence.find((item) => item.citationKey === citationKey);
    if (evidence === undefined) return fail("PERSONAL_KNOWLEDGE_QA_INVALID_CITATION");
    return Object.freeze({ citationKey: evidence.citationKey, title: evidence.title, rangeStart: evidence.rangeStart, rangeEnd: evidence.rangeEnd, excerpt: evidence.excerpt });
  });
  return Object.freeze({ answer: modelResult.answer, citations: Object.freeze(citations) });
}
