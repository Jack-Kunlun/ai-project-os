import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  OPENAI_EMBEDDINGS_CONTRACT_VERSION,
  OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
  OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
  OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
  OPENAI_EMBEDDING_MODEL_FINGERPRINT,
  OPENAI_EMBEDDING_MODEL_ID,
  OPENAI_EMBEDDING_PROFILE_FINGERPRINT,
  OPENAI_HTTP_TRANSPORT_VERSION,
  OPENAI_PROCESSOR_REGION_FINGERPRINT,
  buildOpenAiEmbeddingsTransportPlan,
  classifyProviderResult,
  executeOpenAiEmbeddingsTransport,
  getOpenAiEmbeddingProfile,
  isAiRuntimeServiceError,
  type ExecuteOpenAiEmbeddingsOptions,
  type OpenAiCredentialHandle,
  type ProviderClassification,
  type VerifiedOpenAiEmbeddingVector,
} from "@/lib/ai-runtime";
import { hashSourceContent } from "@/lib/source";
import { SOURCE_CHUNKER_VERSION, chunkSourceText } from "./chunking";
import { createSourceChunkService } from "./source-chunks";

export const PROJECT_CORPUS_GENERATION_VERSION =
  "project-corpus-generation:v1" as const;
export const PROJECT_CORPUS_INDEX_VERSION =
  "project-corpus-index:v1" as const;
export const EMBEDDING_STORAGE_PROFILE_ID =
  "00000000-0000-4000-8000-000000001536" as const;
export const EMBEDDING_STORAGE_PROFILE_FINGERPRINT =
  "b6ea9b216ae969788bdf629f9cb31be5fd4d4e221fc87d433303bc3c363ee8d6" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_RETRY_LIMIT = 3;

export type CorpusIndexErrorCode =
  | "CORPUS_INDEX_INVALID_INPUT"
  | "CORPUS_INDEX_PROJECT_NOT_FOUND"
  | "CORPUS_INDEX_GRANT_INELIGIBLE"
  | "CORPUS_INDEX_SOURCE_INELIGIBLE"
  | "CORPUS_INDEX_CORPUS_NOT_FOUND"
  | "CORPUS_INDEX_CORPUS_INELIGIBLE"
  | "CORPUS_INDEX_RECONCILIATION_REQUIRED"
  | "CORPUS_INDEX_BUILD_TERMINAL"
  | "CORPUS_INDEX_CONFLICT"
  | "CORPUS_INDEX_WRITE_CONFLICT";

export class CorpusIndexError extends Error {
  constructor(readonly code: CorpusIndexErrorCode) {
    super(code);
    this.name = "CorpusIndexError";
  }
}

export type ProjectCorpusGenerationView = Readonly<{
  id: string;
  projectId: string;
  grantId: string;
  policyRevisionId: string;
  status: "complete";
  generationKey: string;
  sourceManifestFingerprint: string;
  chunkManifestFingerprint: string;
  sourceCount: number;
  expectedChunkCount: number;
  chunkerVersion: string;
  completedAt: Date;
}>;

export type ProjectCorpusIndexView = Readonly<{
  id: string;
  projectId: string;
  corpusGenerationId: string;
  grantId: string;
  policyRevisionId: string;
  embeddingProfileId: string;
  status: "building" | "ragReady" | "ragReadyEmpty";
  generationKey: string;
  inputManifestFingerprint: string;
  processingBoundaryFingerprint: string;
  expectedInputCount: number;
  indexedInputCount: number;
  attemptId: string;
  attemptStatus: "queued" | "running" | "succeeded" | "unknown";
}>;

export type ProjectCorpusIndexExecutionResult =
  | Readonly<{
      kind: "published";
      index: ProjectCorpusIndexView;
    }>
  | Readonly<{
      kind: "terminal";
      status: "failed" | "unknown" | "cancelled";
      safeCode: string;
      indexGenerationId: string;
      attemptId: string;
    }>;

type EligibleGrantRow = {
  projectId: string;
  grantId: string;
  policyRevisionId: string;
  policyRevision: number;
  profileFingerprint: string;
  providerFingerprint: string;
  modelId: string;
  modelFingerprint: string;
  processorFingerprint: string;
  regionFingerprint: string;
  retentionFingerprint: string;
  endpointFingerprint: string;
  grantFingerprint: string;
  budgetFingerprint: string;
  scannerFingerprint: string;
  scannerVersion: string;
};

type EligibleSourceRow = {
  grantSourceId: string;
  sourceId: string;
  contentFingerprint: string;
  contentBytes: number;
  originScope: string;
  revisionKey: string;
  contentHash: string;
  contentText: string;
};

type EligibleGrantSnapshot = Readonly<{
  grant: Readonly<EligibleGrantRow>;
  sources: readonly Readonly<EligibleSourceRow>[];
}>;

type CorpusEntryManifest = Readonly<{
  id: string;
  grantSourceId: string;
  projectSourceId: string;
  originScope: "project";
  sourceRevisionKey: string;
  sourceContentHash: string;
  sourceChunkId: string;
  ordinal: number;
  chunkContentHash: string;
  chunkContentBytes: number;
}>;

type IndexInputManifest = Readonly<{
  id: string;
  corpusEntryId: string;
  sourceChunkId: string;
  ordinal: number;
  contentHash: string;
  contentBytes: number;
}>;

type ClaimedIndexInput = Readonly<{
  id: string;
  sourceChunkId: string;
  contentText: string;
  contentHash: string;
  contentBytes: number;
}>;

type ClaimedIndexBuild = Readonly<{
  kind: "claimed";
  projectId: string;
  indexGenerationId: string;
  corpusGenerationId: string;
  attemptId: string;
  attemptOperationKey: string;
  expectedInputCount: number;
  inputs: readonly ClaimedIndexInput[];
}>;

type CompletedEmbeddingBatch = Readonly<{
  vectors: readonly Readonly<VerifiedOpenAiEmbeddingVector>[];
  inputTokens: number;
  providerRequestId: string | null;
}>;

function fail(code: CorpusIndexErrorCode): never {
  throw new CorpusIndexError(code);
}

function safeUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("CORPUS_INDEX_INVALID_INPUT");
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uuidFromStableInput(value: string): string {
  const bytes = createHash("sha256").update(value, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalRow(fields: readonly (string | number)[]): string {
  return fields.map(String).join("\x1f");
}

function fingerprintRows(rows: readonly string[]): string {
  if (rows.length === 0) return fail("CORPUS_INDEX_SOURCE_INELIGIBLE");
  return sha256(rows.join("\x1e"));
}

function stableFingerprint(label: string, fields: readonly (string | number)[]): string {
  return sha256(canonicalRow([label, ...fields]));
}

function vectorLiteral(vector: readonly number[]): string {
  if (
    vector.length !== 1_536 ||
    vector.some((component) => typeof component !== "number" || !Number.isFinite(component))
  ) {
    return fail("CORPUS_INDEX_CONFLICT");
  }
  return `[${vector.map((component) => Math.fround(component).toString()).join(",")}]`;
}

function embeddingBatches(
  inputs: readonly ClaimedIndexInput[],
): readonly (readonly ClaimedIndexInput[])[] {
  const batches: ClaimedIndexInput[][] = [];
  let current: ClaimedIndexInput[] = [];
  let currentBytes = 0;
  for (const input of inputs) {
    if (input.contentBytes > 8_192) return fail("CORPUS_INDEX_SOURCE_INELIGIBLE");
    if (
      current.length > 0 &&
      (current.length >= 100 || currentBytes + input.contentBytes > 256_000)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(input);
    currentBytes += input.contentBytes;
  }
  if (current.length > 0) batches.push(current);
  if (batches.length === 0) return fail("CORPUS_INDEX_CORPUS_INELIGIBLE");
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

function terminalResult(
  indexGenerationId: string,
  attemptId: string,
  status: "failed" | "unknown" | "cancelled",
  safeCode: string,
): ProjectCorpusIndexExecutionResult {
  return frozen({
    kind: "terminal" as const,
    status,
    safeCode,
    indexGenerationId,
    attemptId,
  });
}

function isPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === code;
  } catch {
    return false;
  }
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

async function readEligibleEmbeddingGrant(
  tx: Prisma.TransactionClient,
  projectId: string,
  grantId: string,
): Promise<EligibleGrantSnapshot> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (project === null) return fail("CORPUS_INDEX_PROJECT_NOT_FOUND");

  const grantRows = await tx.$queryRaw<EligibleGrantRow[]>(Prisma.sql`
    SELECT
      g."projectId"::text AS "projectId",
      g."id"::text AS "grantId",
      g."policyRevisionId"::text AS "policyRevisionId",
      r."revision" AS "policyRevision",
      g."profileFingerprint",
      g."providerFingerprint",
      g."modelId",
      g."modelFingerprint",
      g."processorFingerprint",
      g."regionFingerprint",
      g."retentionFingerprint",
      g."endpointFingerprint",
      g."grantFingerprint",
      g."budgetFingerprint",
      g."scannerFingerprint",
      g."scannerVersion"
    FROM "Project" AS p
    JOIN "ProjectAiPolicy" AS ap
      ON ap."projectId" = p."id"
    JOIN "ProjectAiPolicyRevision" AS r
      ON r."projectId" = ap."projectId"
     AND r."id" = ap."currentRevisionId"
    JOIN "ModelProcessingGrant" AS g
      ON g."projectId" = p."id"
     AND g."id" = ${grantId}::uuid
     AND g."policyRevisionId" = r."id"
    JOIN "ModelProcessingGrantOperation" AS op
      ON op."projectId" = g."projectId"
     AND op."grantId" = g."id"
     AND op."operation" = 'embedding'
    JOIN "ProjectAiPolicyOperationProfile" AS opp
      ON opp."projectId" = r."projectId"
     AND opp."policyRevisionId" = r."id"
     AND opp."operation" = op."operation"
    WHERE p."id" = ${projectId}::uuid
      AND r."outboundEnabled" = TRUE
      AND g."status" = 'issued'
      AND g."sourceKind" = 'manual_text'
      AND g."issuedAt" IS NOT NULL
      AND g."revokedAt" IS NULL
      AND g."expiresAt" IS NOT NULL
      AND g."expiresAt" > CURRENT_TIMESTAMP
      AND g."effectivePolicyVersion" = r."revision"
      AND g."profileFingerprint" = opp."profileFingerprint"
      AND g."providerFingerprint" = opp."providerFingerprint"
      AND g."modelFingerprint" = opp."modelFingerprint"
      AND g."modelId" = opp."modelId"
      AND g."processorFingerprint" = opp."processorFingerprint"
      AND g."regionFingerprint" = opp."regionFingerprint"
      AND g."retentionFingerprint" = opp."retentionFingerprint"
      AND g."endpointFingerprint" = opp."endpointFingerprint"
      AND g."budgetFingerprint" = r."budgetFingerprint"
      AND g."scannerFingerprint" = r."scannerFingerprint"
    FOR SHARE OF p, ap, r, g, op, opp
  `);
  if (grantRows.length !== 1) return fail("CORPUS_INDEX_GRANT_INELIGIBLE");
  const grant = grantRows[0]!;
  const embeddingProfile = getOpenAiEmbeddingProfile();
  if (
    grant.profileFingerprint !== OPENAI_EMBEDDING_PROFILE_FINGERPRINT ||
    grant.providerFingerprint !== OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT ||
    grant.modelId !== OPENAI_EMBEDDING_MODEL_ID ||
    grant.modelFingerprint !== OPENAI_EMBEDDING_MODEL_FINGERPRINT ||
    grant.regionFingerprint !== OPENAI_PROCESSOR_REGION_FINGERPRINT ||
    grant.retentionFingerprint !== OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT ||
    grant.endpointFingerprint !== OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT ||
    embeddingProfile.profileFingerprint !== grant.profileFingerprint ||
    !FINGERPRINT_PATTERN.test(grant.processorFingerprint) ||
    !FINGERPRINT_PATTERN.test(grant.grantFingerprint)
  ) {
    return fail("CORPUS_INDEX_GRANT_INELIGIBLE");
  }

  const sourceRows = await tx.$queryRaw<EligibleSourceRow[]>(Prisma.sql`
    SELECT
      gs."id"::text AS "grantSourceId",
      gs."sourceId"::text AS "sourceId",
      gs."contentFingerprint",
      gs."contentBytes",
      s."originScope"::text AS "originScope",
      s."revisionKey"::text AS "revisionKey",
      s."contentHash",
      s."contentText"
    FROM "ModelProcessingGrantSource" AS gs
    JOIN "ProjectSource" AS s
      ON s."projectId" = gs."projectId"
     AND s."id" = gs."sourceId"
    WHERE gs."projectId" = ${projectId}::uuid
      AND gs."grantId" = ${grantId}::uuid
    ORDER BY gs."sourceId"
    FOR SHARE OF gs, s
  `);
  if (sourceRows.length === 0) return fail("CORPUS_INDEX_GRANT_INELIGIBLE");
  for (const source of sourceRows) {
    const contentBytes = Buffer.byteLength(source.contentText, "utf8");
    const contentHash = hashSourceContent(source.contentText);
    if (
      source.originScope !== "project" ||
      source.contentFingerprint !== source.contentHash ||
      source.contentFingerprint !== contentHash ||
      source.contentBytes !== contentBytes
    ) {
      return fail("CORPUS_INDEX_SOURCE_INELIGIBLE");
    }
  }
  return frozen({
    grant: frozen({ ...grant }),
    sources: Object.freeze(sourceRows.map((source) => frozen({ ...source }))),
  });
}

function sourceManifestFingerprint(sources: EligibleGrantSnapshot["sources"]): string {
  return fingerprintRows(
    sources
      .map((source) => canonicalRow([
        source.sourceId,
        source.revisionKey,
        source.contentHash,
      ]))
      .sort(),
  );
}

function chunkManifestFingerprint(entries: readonly CorpusEntryManifest[]): string {
  return fingerprintRows(entries.map((entry) => canonicalRow([
    entry.ordinal,
    entry.sourceChunkId,
    entry.chunkContentHash,
    entry.chunkContentBytes,
  ])));
}

function inputManifestFingerprint(entries: readonly IndexInputManifest[]): string {
  return fingerprintRows(entries.map((entry) => canonicalRow([
    entry.ordinal,
    entry.id,
    entry.sourceChunkId,
    entry.contentHash,
    entry.contentBytes,
  ])));
}

function toCorpusView(row: {
  id: string;
  projectId: string;
  grantId: string;
  policyRevisionId: string;
  status: string;
  generationKey: string;
  sourceManifestFingerprint: string;
  chunkManifestFingerprint: string;
  sourceCount: number;
  expectedChunkCount: number;
  chunkerVersion: string;
  completedAt: Date | null;
}): ProjectCorpusGenerationView {
  if (row.status !== "complete" || row.completedAt === null) {
    return fail("CORPUS_INDEX_CONFLICT");
  }
  return frozen({
    ...row,
    status: "complete" as const,
    completedAt: row.completedAt,
  });
}

function toIndexView(row: {
  id: string;
  projectId: string;
  grantId: string;
  policyRevisionId: string;
  embeddingProfileId: string;
  status: string;
  generationKey: string;
  inputManifestFingerprint: string;
  processingBoundaryFingerprint: string;
  expectedInputCount: number;
  indexedInputCount: number;
  projectCorpus: { corpusGenerationId: string } | null;
  attempts: readonly { id: string; status: string }[];
}): ProjectCorpusIndexView {
  const attempt = row.attempts[0];
  if (
    row.projectCorpus === null ||
    attempt === undefined ||
    !["building", "ragReady", "ragReadyEmpty"].includes(row.status) ||
    !["queued", "running", "succeeded", "unknown"].includes(attempt.status)
  ) {
    return fail("CORPUS_INDEX_CONFLICT");
  }
  return frozen({
    id: row.id,
    projectId: row.projectId,
    corpusGenerationId: row.projectCorpus.corpusGenerationId,
    grantId: row.grantId,
    policyRevisionId: row.policyRevisionId,
    embeddingProfileId: row.embeddingProfileId,
    status: row.status as ProjectCorpusIndexView["status"],
    generationKey: row.generationKey,
    inputManifestFingerprint: row.inputManifestFingerprint,
    processingBoundaryFingerprint: row.processingBoundaryFingerprint,
    expectedInputCount: row.expectedInputCount,
    indexedInputCount: row.indexedInputCount,
    attemptId: attempt.id,
    attemptStatus: attempt.status as ProjectCorpusIndexView["attemptStatus"],
  });
}

export function createCorpusIndexService(options: {
  db: PrismaClient;
  idFactory?: () => string;
  now?: () => Date;
  transactionRetryLimit?: number;
}): {
  ensureProjectCorpusGeneration(input: {
    projectId: string;
    grantId: string;
  }): Promise<ProjectCorpusGenerationView>;
  prepareProjectCorpusIndex(input: {
    projectId: string;
    corpusGenerationId: string;
  }): Promise<ProjectCorpusIndexView>;
  executeProjectCorpusIndex(
    input: { projectId: string; indexGenerationId: string },
    credential: OpenAiCredentialHandle,
    transportOptions?: ExecuteOpenAiEmbeddingsOptions,
  ): Promise<ProjectCorpusIndexExecutionResult>;
} {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function"
  ) {
    fail("CORPUS_INDEX_INVALID_INPUT");
  }
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const retryLimit = options.transactionRetryLimit ?? DEFAULT_RETRY_LIMIT;
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 1 || retryLimit > 5) {
    fail("CORPUS_INDEX_INVALID_INPUT");
  }
  const chunkService = createSourceChunkService({
    db: options.db,
    transactionRetryLimit: retryLimit,
  });

  async function eligibleSnapshot(projectId: string, grantId: string) {
    return options.db.$transaction(
      (tx) => readEligibleEmbeddingGrant(tx, projectId, grantId),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async function claimIndexBuild(
    projectId: string,
    indexGenerationId: string,
  ): Promise<ClaimedIndexBuild | Readonly<{ kind: "ready"; index: ProjectCorpusIndexView }>> {
    return options.db.$transaction(async (tx) => {
      const initial = await tx.indexGeneration.findUnique({
        where: { projectId_id: { projectId, id: indexGenerationId } },
        include: {
          projectCorpus: { select: { corpusGenerationId: true } },
          attempts: {
            orderBy: { attemptNumber: "desc" },
            take: 1,
            select: { id: true, status: true, operationKey: true, expectedInputCount: true },
          },
        },
      });
      if (initial === null) {
        const project = await tx.project.findUnique({
          where: { id: projectId },
          select: { id: true },
        });
        return fail(project === null
          ? "CORPUS_INDEX_PROJECT_NOT_FOUND"
          : "CORPUS_INDEX_CORPUS_NOT_FOUND");
      }
      if (initial.status === "ragReady" || initial.status === "ragReadyEmpty") {
        return frozen({ kind: "ready" as const, index: toIndexView(initial) });
      }
      if (initial.status === "unknown") {
        return fail("CORPUS_INDEX_RECONCILIATION_REQUIRED");
      }
      if (["failed", "cancelled", "ineligible", "superseded"].includes(initial.status)) {
        return fail("CORPUS_INDEX_BUILD_TERMINAL");
      }
      if (
        initial.status !== "building" ||
        initial.kind !== "projectCorpus" ||
        initial.projectCorpus === null ||
        initial.expectedInputCount <= 0 ||
        initial.indexedInputCount !== 0
      ) {
        return fail("CORPUS_INDEX_CONFLICT");
      }

      const snapshot = await readEligibleEmbeddingGrant(tx, projectId, initial.grantId);
      if (
        snapshot.grant.policyRevisionId !== initial.policyRevisionId ||
        initial.embeddingProfileId !== EMBEDDING_STORAGE_PROFILE_ID
      ) {
        return fail("CORPUS_INDEX_GRANT_INELIGIBLE");
      }
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "IndexGeneration"
        WHERE "projectId" = ${projectId}::uuid
          AND "id" = ${indexGenerationId}::uuid
        FOR UPDATE
      `);
      const attempt = initial.attempts[0];
      if (attempt === undefined) return fail("CORPUS_INDEX_CONFLICT");
      if (attempt.status === "running" || attempt.status === "unknown") {
        return fail("CORPUS_INDEX_RECONCILIATION_REQUIRED");
      }
      if (attempt.status !== "queued") return fail("CORPUS_INDEX_BUILD_TERMINAL");
      if (attempt.expectedInputCount !== initial.expectedInputCount) {
        return fail("CORPUS_INDEX_CONFLICT");
      }

      const inputs = await tx.indexGenerationInputEntry.findMany({
        where: { projectId, indexGenerationId },
        orderBy: { ordinal: "asc" },
        select: {
          id: true,
          ordinal: true,
          sourceChunkId: true,
          contentHash: true,
          contentBytes: true,
          sourceChunk: {
            select: {
              state: true,
              contentText: true,
              contentHash: true,
              contentBytes: true,
            },
          },
          workItem: {
            select: { status: true, attemptId: true },
          },
        },
      });
      if (
        inputs.length !== initial.expectedInputCount ||
        inputs.some((input, ordinal) =>
          input.ordinal !== ordinal ||
          input.sourceChunk.state !== "active" ||
          input.sourceChunk.contentText === null ||
          input.sourceChunk.contentHash !== input.contentHash ||
          input.sourceChunk.contentBytes !== input.contentBytes ||
          input.workItem?.status !== "queued" ||
          input.workItem.attemptId !== null ||
          hashSourceContent(input.sourceChunk.contentText) !== input.contentHash ||
          Buffer.byteLength(input.sourceChunk.contentText, "utf8") !== input.contentBytes
        )
      ) {
        return fail("CORPUS_INDEX_CONFLICT");
      }
      const claimedAt = now();
      if (!(claimedAt instanceof Date) || !Number.isFinite(claimedAt.getTime())) {
        return fail("CORPUS_INDEX_INVALID_INPUT");
      }
      const claimedAttempt = await tx.indexBuildAttempt.updateMany({
        where: {
          projectId,
          indexGenerationId,
          id: attempt.id,
          status: "queued",
        },
        data: { status: "running", startedAt: claimedAt },
      });
      const claimedWork = await tx.indexWorkItem.updateMany({
        where: {
          projectId,
          indexGenerationId,
          status: "queued",
          attemptId: null,
        },
        data: {
          status: "running",
          attemptId: attempt.id,
          claimedAt,
        },
      });
      if (
        claimedAttempt.count !== 1 ||
        claimedWork.count !== initial.expectedInputCount
      ) {
        return fail("CORPUS_INDEX_RECONCILIATION_REQUIRED");
      }
      return frozen({
        kind: "claimed" as const,
        projectId,
        indexGenerationId,
        corpusGenerationId: initial.projectCorpus.corpusGenerationId,
        attemptId: attempt.id,
        attemptOperationKey: attempt.operationKey,
        expectedInputCount: initial.expectedInputCount,
        inputs: Object.freeze(inputs.map((input) => frozen({
          id: input.id,
          sourceChunkId: input.sourceChunkId,
          contentText: input.sourceChunk.contentText!,
          contentHash: input.contentHash,
          contentBytes: input.contentBytes,
        }))),
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async function closeIndexBuild(
    claim: ClaimedIndexBuild,
    status: "failed" | "unknown" | "cancelled",
    safeCode: string,
    values: {
      requestCount: number;
      inputTokens: number;
      providerRequestId: string | null;
      sentAt: Date | null;
    },
  ): Promise<ProjectCorpusIndexExecutionResult> {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(safeCode)) {
      safeCode = "AI_PROVIDER_UNKNOWN";
      status = "unknown";
    }
    const completedAt = now();
    if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) {
      return fail("CORPUS_INDEX_INVALID_INPUT");
    }
    return options.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT "status"::text AS "status"
        FROM "IndexGeneration"
        WHERE "projectId" = ${claim.projectId}::uuid
          AND "id" = ${claim.indexGenerationId}::uuid
        FOR UPDATE
      `);
      if (locked.length !== 1) return fail("CORPUS_INDEX_CONFLICT");
      const attempt = await tx.indexBuildAttempt.findUnique({
        where: { id: claim.attemptId },
        select: { status: true },
      });
      if (attempt?.status !== "running") {
        if (attempt?.status === "unknown") {
          return terminalResult(
            claim.indexGenerationId,
            claim.attemptId,
            "unknown",
            safeCode,
          );
        }
        return fail("CORPUS_INDEX_RECONCILIATION_REQUIRED");
      }
      const closedWork = await tx.indexWorkItem.updateMany({
        where: {
          projectId: claim.projectId,
          indexGenerationId: claim.indexGenerationId,
          attemptId: claim.attemptId,
          status: "running",
        },
        data: { status, safeErrorCode: safeCode, completedAt },
      });
      if (closedWork.count !== claim.expectedInputCount) {
        return fail("CORPUS_INDEX_RECONCILIATION_REQUIRED");
      }
      await tx.indexBuildAttempt.update({
        where: { id: claim.attemptId },
        data: {
          status,
          requestCount: values.requestCount,
          inputTokens: values.inputTokens,
          safeErrorCode: safeCode,
          providerRequestId: values.providerRequestId,
          sentAt: values.sentAt,
          completedAt,
        },
      });
      await tx.indexGeneration.update({
        where: {
          projectId_id: {
            projectId: claim.projectId,
            id: claim.indexGenerationId,
          },
        },
        data: {
          status,
          failureCode: safeCode,
          completedAt,
          indexedInputCount: 0,
        },
      });
      return terminalResult(
        claim.indexGenerationId,
        claim.attemptId,
        status,
        safeCode,
      );
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async function publishCompletedIndex(
    claim: ClaimedIndexBuild,
    batches: readonly CompletedEmbeddingBatch[],
    sentAt: Date,
  ): Promise<ProjectCorpusIndexExecutionResult> {
    const vectors = batches.flatMap((batch) => batch.vectors);
    const vectorsByInput = new Map(vectors.map((vector) => [vector.inputId, vector]));
    if (
      vectors.length !== claim.expectedInputCount ||
      vectorsByInput.size !== claim.expectedInputCount ||
      claim.inputs.some((input) => !vectorsByInput.has(input.id))
    ) {
      return closeIndexBuild(claim, "unknown", "AI_PROVIDER_UNKNOWN", {
        requestCount: batches.length,
        inputTokens: batches.reduce((sum, batch) => sum + batch.inputTokens, 0),
        providerRequestId: batches.length === 1 ? batches[0]!.providerRequestId : null,
        sentAt,
      });
    }
    const completedAt = now();
    if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) {
      return fail("CORPUS_INDEX_INVALID_INPUT");
    }
    try {
      return await options.db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
          SELECT "status"::text AS "status"
          FROM "IndexGeneration"
          WHERE "projectId" = ${claim.projectId}::uuid
            AND "id" = ${claim.indexGenerationId}::uuid
          FOR UPDATE
        `);
        if (locked[0]?.status !== "building") {
          return fail("CORPUS_INDEX_RECONCILIATION_REQUIRED");
        }
        const attempt = await tx.indexBuildAttempt.findUnique({
          where: { id: claim.attemptId },
          select: { status: true },
        });
        if (attempt?.status !== "running") {
          return fail("CORPUS_INDEX_RECONCILIATION_REQUIRED");
        }
        const workCount = await tx.indexWorkItem.count({
          where: {
            projectId: claim.projectId,
            indexGenerationId: claim.indexGenerationId,
            attemptId: claim.attemptId,
            status: "running",
          },
        });
        if (workCount !== claim.expectedInputCount) {
          return fail("CORPUS_INDEX_RECONCILIATION_REQUIRED");
        }
        for (const input of claim.inputs) {
          const vector = vectorsByInput.get(input.id)!;
          const embeddingId = safeUuid(idFactory());
          const literal = vectorLiteral(vector.vector);
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "ChunkEmbedding" (
              "id", "projectId", "indexGenerationId", "inputEntryId",
              "sourceChunkId", "embeddingProfileId", "attemptId", "vector",
              "vectorFingerprint"
            ) VALUES (
              ${embeddingId}::uuid,
              ${claim.projectId}::uuid,
              ${claim.indexGenerationId}::uuid,
              ${input.id}::uuid,
              ${input.sourceChunkId}::uuid,
              ${EMBEDDING_STORAGE_PROFILE_ID}::uuid,
              ${claim.attemptId}::uuid,
              CAST(${literal} AS vector(1536)),
              ${vector.vectorFingerprint}
            )
          `);
        }
        const succeededWork = await tx.indexWorkItem.updateMany({
          where: {
            projectId: claim.projectId,
            indexGenerationId: claim.indexGenerationId,
            attemptId: claim.attemptId,
            status: "running",
          },
          data: { status: "succeeded", completedAt },
        });
        if (succeededWork.count !== claim.expectedInputCount) {
          return fail("CORPUS_INDEX_RECONCILIATION_REQUIRED");
        }
        await tx.indexBuildAttempt.update({
          where: { id: claim.attemptId },
          data: {
            status: "succeeded",
            requestCount: batches.length,
            inputTokens: batches.reduce((sum, batch) => sum + batch.inputTokens, 0),
            providerRequestId: batches.length === 1 ? batches[0]!.providerRequestId : null,
            sentAt,
            completedAt,
          },
        });
        await tx.indexGeneration.update({
          where: {
            projectId_id: {
              projectId: claim.projectId,
              id: claim.indexGenerationId,
            },
          },
          data: {
            status: "ragReady",
            indexedInputCount: claim.expectedInputCount,
            completedAt,
          },
        });
        await tx.projectCorpusIndexPointer.upsert({
          where: { projectId: claim.projectId },
          create: {
            projectId: claim.projectId,
            indexGenerationId: claim.indexGenerationId,
            corpusGenerationId: claim.corpusGenerationId,
            publishedAt: completedAt,
          },
          update: {
            indexGenerationId: claim.indexGenerationId,
            corpusGenerationId: claim.corpusGenerationId,
            publishedAt: completedAt,
          },
        });
        const published = await tx.indexGeneration.findUniqueOrThrow({
          where: {
            projectId_id: {
              projectId: claim.projectId,
              id: claim.indexGenerationId,
            },
          },
          include: {
            projectCorpus: { select: { corpusGenerationId: true } },
            attempts: {
              orderBy: { attemptNumber: "desc" },
              take: 1,
              select: { id: true, status: true },
            },
          },
        });
        return frozen({ kind: "published" as const, index: toIndexView(published) });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof CorpusIndexError && error.code !== "CORPUS_INDEX_WRITE_CONFLICT") {
        const closed = await closeIndexBuild(
          claim,
          "unknown",
          "AI_PROVIDER_UNKNOWN",
          {
            requestCount: batches.length,
            inputTokens: batches.reduce((sum, batch) => sum + batch.inputTokens, 0),
            providerRequestId: batches.length === 1 ? batches[0]!.providerRequestId : null,
            sentAt,
          },
        );
        return closed;
      }
      try {
        return await closeIndexBuild(
          claim,
          "unknown",
          "AI_PROVIDER_UNKNOWN",
          {
            requestCount: batches.length,
            inputTokens: batches.reduce((sum, batch) => sum + batch.inputTokens, 0),
            providerRequestId: batches.length === 1 ? batches[0]!.providerRequestId : null,
            sentAt,
          },
        );
      } catch {
        throw error;
      }
    }
  }

  return {
    async ensureProjectCorpusGeneration(input) {
      const projectId = safeUuid(input?.projectId);
      const grantId = safeUuid(input?.grantId);
      const initial = await eligibleSnapshot(projectId, grantId);
      for (const source of initial.sources) {
        await chunkService.ensureProjectSourceChunks({
          projectId,
          sourceId: source.sourceId,
        });
      }

      for (let attempt = 0; attempt < retryLimit; attempt += 1) {
        try {
          return await options.db.$transaction(async (tx) => {
            const snapshot = await readEligibleEmbeddingGrant(tx, projectId, grantId);
            const entries: CorpusEntryManifest[] = [];
            for (const source of snapshot.sources) {
              const expectedChunks = chunkSourceText(source.contentText);
              const chunks = await tx.sourceChunk.findMany({
                where: {
                  projectId,
                  projectSourceId: source.sourceId,
                  sourceRevisionKey: source.revisionKey,
                  sourceContentHash: source.contentHash,
                  chunkerVersion: SOURCE_CHUNKER_VERSION,
                  state: "active",
                },
                orderBy: { ordinal: "asc" },
                select: {
                  id: true,
                  ordinal: true,
                  contentHash: true,
                  contentBytes: true,
                  rangeStart: true,
                  rangeEnd: true,
                  contentText: true,
                },
              });
              if (
                chunks.length !== expectedChunks.length ||
                chunks.some((chunk, index) => {
                  const expected = expectedChunks[index]!;
                  return chunk.ordinal !== expected.ordinal ||
                    chunk.contentHash !== expected.contentHash ||
                    chunk.contentBytes !== expected.contentBytes ||
                    chunk.rangeStart !== expected.rangeStart ||
                    chunk.rangeEnd !== expected.rangeEnd ||
                    chunk.contentText !== expected.contentText;
                })
              ) {
                return fail("CORPUS_INDEX_SOURCE_INELIGIBLE");
              }
              for (const chunk of chunks) {
                if (chunk.contentHash === null || chunk.contentBytes === null) {
                  return fail("CORPUS_INDEX_SOURCE_INELIGIBLE");
                }
                entries.push(frozen({
                  id: uuidFromStableInput(canonicalRow([
                    PROJECT_CORPUS_GENERATION_VERSION,
                    projectId,
                    grantId,
                    source.sourceId,
                    chunk.id,
                  ])),
                  grantSourceId: source.grantSourceId,
                  projectSourceId: source.sourceId,
                  originScope: "project" as const,
                  sourceRevisionKey: source.revisionKey,
                  sourceContentHash: source.contentHash,
                  sourceChunkId: chunk.id,
                  ordinal: entries.length,
                  chunkContentHash: chunk.contentHash,
                  chunkContentBytes: chunk.contentBytes,
                }));
              }
            }
            if (entries.length === 0) return fail("CORPUS_INDEX_SOURCE_INELIGIBLE");

            const sourceManifest = sourceManifestFingerprint(snapshot.sources);
            const chunkManifest = chunkManifestFingerprint(entries);
            const generationKey = stableFingerprint(
              PROJECT_CORPUS_GENERATION_VERSION,
              [
                projectId,
                grantId,
                snapshot.grant.grantFingerprint,
                snapshot.grant.policyRevisionId,
                snapshot.grant.policyRevision,
                sourceManifest,
                chunkManifest,
                SOURCE_CHUNKER_VERSION,
              ],
            );
            const existing = await tx.projectCorpusGeneration.findUnique({
              where: { projectId_generationKey: { projectId, generationKey } },
            });
            if (existing !== null) {
              if (
                existing.grantId !== grantId ||
                existing.policyRevisionId !== snapshot.grant.policyRevisionId ||
                existing.sourceManifestFingerprint !== sourceManifest ||
                existing.chunkManifestFingerprint !== chunkManifest ||
                existing.sourceCount !== snapshot.sources.length ||
                existing.expectedChunkCount !== entries.length ||
                existing.chunkerVersion !== SOURCE_CHUNKER_VERSION
              ) {
                return fail("CORPUS_INDEX_CONFLICT");
              }
              return toCorpusView(existing);
            }

            const generationId = safeUuid(idFactory());
            await tx.projectCorpusGeneration.create({
              data: {
                id: generationId,
                projectId,
                grantId,
                policyRevisionId: snapshot.grant.policyRevisionId,
                status: "staging",
                generationKey,
                sourceManifestFingerprint: sourceManifest,
                chunkManifestFingerprint: chunkManifest,
                sourceCount: snapshot.sources.length,
                expectedChunkCount: entries.length,
                chunkerVersion: SOURCE_CHUNKER_VERSION,
              },
            });
            await tx.projectCorpusGenerationEntry.createMany({
              data: entries.map((entry) => ({
                ...entry,
                projectId,
                corpusGenerationId: generationId,
                grantId,
              })),
            });
            const completedAt = now();
            if (!(completedAt instanceof Date) || !Number.isFinite(completedAt.getTime())) {
              return fail("CORPUS_INDEX_INVALID_INPUT");
            }
            const completed = await tx.projectCorpusGeneration.update({
              where: { projectId_id: { projectId, id: generationId } },
              data: { status: "complete", completedAt },
            });
            return toCorpusView(completed);
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
          if (error instanceof CorpusIndexError) throw error;
          const retryable = isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034");
          if (retryable && attempt + 1 < retryLimit) continue;
          if (retryable) return fail("CORPUS_INDEX_WRITE_CONFLICT");
          throw error;
        }
      }
      return fail("CORPUS_INDEX_WRITE_CONFLICT");
    },

    async prepareProjectCorpusIndex(input) {
      const projectId = safeUuid(input?.projectId);
      const corpusGenerationId = safeUuid(input?.corpusGenerationId);
      for (let attempt = 0; attempt < retryLimit; attempt += 1) {
        try {
          return await options.db.$transaction(async (tx) => {
            const corpusRows = await tx.$queryRaw<Array<{
              id: string;
              grantId: string;
              policyRevisionId: string;
              status: string;
              generationKey: string;
              expectedChunkCount: number;
              chunkerVersion: string;
            }>>(Prisma.sql`
              SELECT
                c."id"::text AS "id",
                c."grantId"::text AS "grantId",
                c."policyRevisionId"::text AS "policyRevisionId",
                c."status"::text AS "status",
                c."generationKey",
                c."expectedChunkCount",
                c."chunkerVersion"
              FROM "ProjectCorpusGeneration" AS c
              WHERE c."projectId" = ${projectId}::uuid
                AND c."id" = ${corpusGenerationId}::uuid
              FOR SHARE
            `);
            if (corpusRows.length === 0) {
              const project = await tx.project.findUnique({
                where: { id: projectId },
                select: { id: true },
              });
              return fail(project === null
                ? "CORPUS_INDEX_PROJECT_NOT_FOUND"
                : "CORPUS_INDEX_CORPUS_NOT_FOUND");
            }
            const corpus = corpusRows[0]!;
            if (
              corpus.status !== "complete" ||
              corpus.chunkerVersion !== SOURCE_CHUNKER_VERSION ||
              corpus.expectedChunkCount <= 0
            ) {
              return fail("CORPUS_INDEX_CORPUS_INELIGIBLE");
            }
            const snapshot = await readEligibleEmbeddingGrant(
              tx,
              projectId,
              corpus.grantId,
            );
            if (snapshot.grant.policyRevisionId !== corpus.policyRevisionId) {
              return fail("CORPUS_INDEX_GRANT_INELIGIBLE");
            }
            const storageProfile = await tx.embeddingProfile.findUnique({
              where: { id: EMBEDDING_STORAGE_PROFILE_ID },
              select: {
                id: true,
                modelId: true,
                dimensions: true,
                profileFingerprint: true,
              },
            });
            if (
              storageProfile === null ||
              storageProfile.modelId !== OPENAI_EMBEDDING_MODEL_ID ||
              storageProfile.dimensions !== 1_536 ||
              storageProfile.profileFingerprint !== EMBEDDING_STORAGE_PROFILE_FINGERPRINT
            ) {
              return fail("CORPUS_INDEX_CONFLICT");
            }
            const corpusEntries = await tx.projectCorpusGenerationEntry.findMany({
              where: { projectId, corpusGenerationId },
              orderBy: { ordinal: "asc" },
              select: {
                id: true,
                sourceChunkId: true,
                ordinal: true,
                chunkContentHash: true,
                chunkContentBytes: true,
              },
            });
            if (
              corpusEntries.length !== corpus.expectedChunkCount ||
              corpusEntries.some((entry, index) => entry.ordinal !== index)
            ) {
              return fail("CORPUS_INDEX_CORPUS_INELIGIBLE");
            }

            const processingBoundary = stableFingerprint(
              PROJECT_CORPUS_INDEX_VERSION,
              [
                snapshot.grant.grantFingerprint,
                snapshot.grant.policyRevisionId,
                snapshot.grant.policyRevision,
                snapshot.grant.profileFingerprint,
                snapshot.grant.providerFingerprint,
                snapshot.grant.modelFingerprint,
                snapshot.grant.processorFingerprint,
                snapshot.grant.regionFingerprint,
                snapshot.grant.retentionFingerprint,
                snapshot.grant.endpointFingerprint,
                snapshot.grant.budgetFingerprint,
                snapshot.grant.scannerFingerprint,
                snapshot.grant.scannerVersion,
                EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
                OPENAI_EMBEDDINGS_CONTRACT_VERSION,
                OPENAI_HTTP_TRANSPORT_VERSION,
                SOURCE_CHUNKER_VERSION,
              ],
            );
            const inputEntries: IndexInputManifest[] = corpusEntries.map((entry) =>
              frozen({
                id: uuidFromStableInput(canonicalRow([
                  PROJECT_CORPUS_INDEX_VERSION,
                  projectId,
                  entry.id,
                  processingBoundary,
                ])),
                corpusEntryId: entry.id,
                sourceChunkId: entry.sourceChunkId,
                ordinal: entry.ordinal,
                contentHash: entry.chunkContentHash,
                contentBytes: entry.chunkContentBytes,
              }),
            );
            const inputManifest = inputManifestFingerprint(inputEntries);
            const generationKey = stableFingerprint(
              PROJECT_CORPUS_INDEX_VERSION,
              [
                projectId,
                corpus.generationKey,
                inputManifest,
                processingBoundary,
                EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
              ],
            );
            const existing = await tx.indexGeneration.findUnique({
              where: { projectId_generationKey: { projectId, generationKey } },
              include: {
                projectCorpus: { select: { corpusGenerationId: true } },
                attempts: {
                  orderBy: { attemptNumber: "desc" },
                  take: 1,
                  select: { id: true, status: true },
                },
              },
            });
            if (existing !== null) {
              if (
                existing.kind !== "projectCorpus" ||
                existing.grantId !== corpus.grantId ||
                existing.policyRevisionId !== corpus.policyRevisionId ||
                existing.embeddingProfileId !== storageProfile.id ||
                existing.inputManifestFingerprint !== inputManifest ||
                existing.processingBoundaryFingerprint !== processingBoundary ||
                existing.expectedInputCount !== inputEntries.length
              ) {
                return fail("CORPUS_INDEX_CONFLICT");
              }
              return toIndexView(existing);
            }

            const indexGenerationId = safeUuid(idFactory());
            await tx.indexGeneration.create({
              data: {
                id: indexGenerationId,
                projectId,
                kind: "projectCorpus",
                grantId: corpus.grantId,
                policyRevisionId: corpus.policyRevisionId,
                embeddingProfileId: storageProfile.id,
                status: "staging",
                generationKey,
                inputManifestFingerprint: inputManifest,
                processingBoundaryFingerprint: processingBoundary,
                expectedInputCount: inputEntries.length,
              },
            });
            await tx.projectCorpusIndexGeneration.create({
              data: {
                projectId,
                indexGenerationId,
                corpusGenerationId,
                grantId: corpus.grantId,
                policyRevisionId: corpus.policyRevisionId,
              },
            });
            await tx.indexGenerationInputEntry.createMany({
              data: inputEntries.map((entry) => ({
                id: entry.id,
                projectId,
                indexGenerationId,
                ordinal: entry.ordinal,
                entryKind: "projectCorpus",
                sourceChunkId: entry.sourceChunkId,
                contentHash: entry.contentHash,
                contentBytes: entry.contentBytes,
              })),
            });
            await tx.projectCorpusIndexInput.createMany({
              data: inputEntries.map((entry) => ({
                projectId,
                indexGenerationId,
                inputEntryId: entry.id,
                corpusGenerationId,
                corpusEntryId: entry.corpusEntryId,
                sourceChunkId: entry.sourceChunkId,
              })),
            });
            await tx.indexWorkItem.createMany({
              data: inputEntries.map((entry) => ({
                id: uuidFromStableInput(canonicalRow([
                  PROJECT_CORPUS_INDEX_VERSION,
                  "work-item",
                  projectId,
                  entry.id,
                  processingBoundary,
                ])),
                projectId,
                indexGenerationId,
                inputEntryId: entry.id,
                sourceChunkId: entry.sourceChunkId,
                operationKey: stableFingerprint(
                  PROJECT_CORPUS_INDEX_VERSION,
                  ["work-item", projectId, entry.id, processingBoundary],
                ),
                processingBoundaryFingerprint: processingBoundary,
                status: "queued",
              })),
            });
            const startedAt = now();
            if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) {
              return fail("CORPUS_INDEX_INVALID_INPUT");
            }
            await tx.indexGeneration.update({
              where: { projectId_id: { projectId, id: indexGenerationId } },
              data: { status: "building", buildStartedAt: startedAt },
            });
            const attemptId = safeUuid(idFactory());
            await tx.indexBuildAttempt.create({
              data: {
                id: attemptId,
                projectId,
                indexGenerationId,
                grantId: corpus.grantId,
                policyRevisionId: corpus.policyRevisionId,
                attemptNumber: 1,
                operationKey: stableFingerprint(
                  PROJECT_CORPUS_INDEX_VERSION,
                  ["attempt", projectId, generationKey, 1],
                ),
                status: "queued",
                expectedInputCount: inputEntries.length,
              },
            });
            const created = await tx.indexGeneration.findUniqueOrThrow({
              where: { projectId_id: { projectId, id: indexGenerationId } },
              include: {
                projectCorpus: { select: { corpusGenerationId: true } },
                attempts: {
                  orderBy: { attemptNumber: "desc" },
                  take: 1,
                  select: { id: true, status: true },
                },
              },
            });
            return toIndexView(created);
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
          if (error instanceof CorpusIndexError) throw error;
          const retryable = isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034");
          if (retryable && attempt + 1 < retryLimit) continue;
          if (retryable) return fail("CORPUS_INDEX_WRITE_CONFLICT");
          throw error;
        }
      }
      return fail("CORPUS_INDEX_WRITE_CONFLICT");
    },

    async executeProjectCorpusIndex(input, credential, transportOptions = {}) {
      const projectId = safeUuid(input?.projectId);
      const indexGenerationId = safeUuid(input?.indexGenerationId);
      const claim = await claimIndexBuild(projectId, indexGenerationId);
      if (claim.kind === "ready") {
        return frozen({ kind: "published" as const, index: claim.index });
      }

      const batches = embeddingBatches(claim.inputs);
      const completedBatches: CompletedEmbeddingBatch[] = [];
      let sentAt: Date | null = null;
      let requestCount = 0;
      try {
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          const batch = batches[batchIndex]!;
          const calledAt = now();
          if (!(calledAt instanceof Date) || !Number.isFinite(calledAt.getTime())) {
            return fail("CORPUS_INDEX_INVALID_INPUT");
          }
          const plan = buildOpenAiEmbeddingsTransportPlan(
            getOpenAiEmbeddingProfile(),
            {
              runId: claim.attemptId,
              operationKey: stableFingerprint(
                PROJECT_CORPUS_INDEX_VERSION,
                [
                  "embedding-batch",
                  claim.attemptOperationKey,
                  batchIndex,
                  ...batch.map((entry) => entry.id),
                ],
              ),
              inputs: batch.map((entry) => ({
                inputId: entry.id,
                content: entry.contentText,
              })),
            },
          );
          const result = await executeOpenAiEmbeddingsTransport(
            plan,
            credential,
            transportOptions,
          );
          requestCount += 1;
          sentAt ??= calledAt;
          const classification: ProviderClassification = classifyProviderResult(
            result.providerResult,
          );
          if (
            classification.runStatus !== "succeeded" ||
            result.verifiedResponse === null ||
            classification.usage === null
          ) {
            const status = classification.runStatus === "cancelled"
              ? "cancelled"
              : classification.runStatus === "failed"
                ? "failed"
                : "unknown";
            return closeIndexBuild(
              claim,
              status,
              classification.safeCode ?? "AI_PROVIDER_UNKNOWN",
              {
                requestCount,
                inputTokens: completedBatches.reduce(
                  (sum, completed) => sum + completed.inputTokens,
                  0,
                ),
                providerRequestId: requestCount === 1
                  ? classification.providerRequestId
                  : null,
                sentAt,
              },
            );
          }
          completedBatches.push(frozen({
            vectors: result.verifiedResponse.vectors,
            inputTokens: classification.usage.inputTokens,
            providerRequestId: classification.providerRequestId,
          }));
        }
      } catch (error) {
        const dispatched = sentAt !== null || requestCount > 0;
        const safeCode = !dispatched && isAiRuntimeServiceError(error)
          ? error.code
          : "AI_PROVIDER_UNKNOWN";
        return closeIndexBuild(
          claim,
          dispatched ? "unknown" : "failed",
          safeCode,
          {
            requestCount,
            inputTokens: completedBatches.reduce(
              (sum, completed) => sum + completed.inputTokens,
              0,
            ),
            providerRequestId: completedBatches.length === 1
              ? completedBatches[0]!.providerRequestId
              : null,
            sentAt,
          },
        );
      }
      if (sentAt === null) return fail("CORPUS_INDEX_CONFLICT");
      return publishCompletedIndex(claim, completedBatches, sentAt);
    },
  };
}
