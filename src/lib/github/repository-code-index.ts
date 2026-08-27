import { createHash, randomUUID } from "node:crypto";
import {
  AiOperation,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import {
  EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
  EMBEDDING_STORAGE_PROFILE_ID,
} from "@/lib/ai-memory/corpus-index";
import {
  OPENAI_EMBEDDINGS_CONTRACT_VERSION,
  OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT,
  OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT,
  OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT,
  OPENAI_EMBEDDING_MODEL_FINGERPRINT,
  OPENAI_EMBEDDING_MODEL_ID,
  OPENAI_EMBEDDING_PROCESSOR_FINGERPRINT,
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
import {
  REPOSITORY_CODE_CHUNKER_VERSION,
  chunkRepositoryCode,
} from "./code-chunking";
import {
  REPOSITORY_MODEL_GRANT_VERSION,
  REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
} from "./repository-model-grant";

export const REPOSITORY_CODE_INDEX_VERSION =
  "repository-code-index:v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_RETRY_LIMIT = 3;
const CREATE_BATCH_SIZE = 200;

export type RepositoryCodeIndexErrorCode =
  | "REPOSITORY_CODE_INDEX_INVALID_INPUT"
  | "REPOSITORY_CODE_INDEX_PROJECT_NOT_FOUND"
  | "REPOSITORY_CODE_INDEX_LINK_NOT_FOUND"
  | "REPOSITORY_CODE_INDEX_LINK_INELIGIBLE"
  | "REPOSITORY_CODE_INDEX_GRANT_INELIGIBLE"
  | "REPOSITORY_CODE_INDEX_CODE_NOT_READY"
  | "REPOSITORY_CODE_INDEX_INDEX_NOT_FOUND"
  | "REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED"
  | "REPOSITORY_CODE_INDEX_BUILD_TERMINAL"
  | "REPOSITORY_CODE_INDEX_CONFLICT"
  | "REPOSITORY_CODE_INDEX_WRITE_CONFLICT";

export class RepositoryCodeIndexError extends Error {
  constructor(readonly code: RepositoryCodeIndexErrorCode) {
    super(code);
    this.name = "RepositoryCodeIndexError";
  }
}

export type RepositoryCodeIndexView = Readonly<{
  id: string;
  projectId: string;
  projectRepositoryLinkId: string;
  repositoryCodeGenerationId: string;
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
  capturedFullName: string;
  frozenCommitSha: string;
}>;

export type RepositoryCodeIndexExecutionResult =
  | Readonly<{
      kind: "published";
      index: RepositoryCodeIndexView;
    }>
  | Readonly<{
      kind: "terminal";
      status: "failed" | "unknown" | "cancelled";
      safeCode: string;
      indexGenerationId: string;
      attemptId: string;
    }>;

type RepositoryCodeSource = Readonly<{
  codeGenerationEntryId: string;
  repositoryFileRevisionId: string;
  ordinal: number;
  normalizedPath: string;
  contentText: string;
  contentHash: string;
  contentBytes: number;
  lineCount: number;
}>;

type EligibleRepositorySnapshot = Readonly<{
  grant: Readonly<{
    id: string;
    policyRevisionId: string;
    aiEffectivePolicyVersion: number;
    grantFingerprint: string;
    profileFingerprint: string;
    providerFingerprint: string;
    modelFingerprint: string;
    processorFingerprint: string;
    regionFingerprint: string;
    retentionFingerprint: string;
    endpointFingerprint: string;
    budgetFingerprint: string;
    scannerFingerprint: string;
    scannerVersion: string;
  }>;
  boundary: Readonly<{
    projectRepositoryLinkId: string;
    repositoryCodeGenerationId: string;
    linkConfigVersion: number;
    linkEffectivePolicyVersion: number;
    expectedActiveIndexGenerationId: string | null;
    scanScopeFingerprint: string;
    manifestFingerprint: string;
    scannerVersion: string;
    scannerFingerprint: string;
    capturedFullName: string;
    frozenCommitSha: string;
    fileCount: number;
    decodedTextBytes: number;
  }>;
  sources: readonly RepositoryCodeSource[];
}>;

type RepositoryChunkManifestEntry = Readonly<{
  sourceChunkId: string;
  codeGenerationEntryId: string;
  repositoryFileRevisionId: string;
  fileOrdinal: number;
  chunkOrdinal: number;
  normalizedPath: string;
  rangeStart: number;
  rangeEnd: number;
  contentText: string;
  contentHash: string;
  contentBytes: number;
}>;

type RepositoryIndexInput = Readonly<{
  id: string;
  sourceChunkId: string;
  codeGenerationEntryId: string;
  repositoryFileRevisionId: string;
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

type ClaimedRepositoryIndex = Readonly<{
  kind: "claimed";
  projectId: string;
  projectRepositoryLinkId: string;
  indexGenerationId: string;
  repositoryCodeGenerationId: string;
  linkConfigVersion: number;
  linkEffectivePolicyVersion: number;
  grantId: string;
  policyRevisionId: string;
  aiEffectivePolicyVersion: number;
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

function fail(code: RepositoryCodeIndexErrorCode): never {
  throw new RepositoryCodeIndexError(code);
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function safeUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("REPOSITORY_CODE_INDEX_INVALID_INPUT");
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
  if (rows.length === 0) return fail("REPOSITORY_CODE_INDEX_CODE_NOT_READY");
  return sha256(rows.join("\x1e"));
}

function stableFingerprint(label: string, fields: readonly (string | number)[]): string {
  return sha256(canonicalRow([label, ...fields]));
}

function expectedRepositoryGrantFingerprint(input: Readonly<{
  projectId: string;
  projectRepositoryLinkId: string;
  policyRevisionId: string;
  effectivePolicyVersion: number;
  linkConfigVersion: number;
  linkEffectivePolicyVersion: number;
  repositoryCodeGenerationId: string;
  scanScopeFingerprint: string;
  sourceManifestFingerprint: string;
  profileFingerprint: string;
  providerFingerprint: string;
  modelFingerprint: string;
  processorFingerprint: string;
  endpointFingerprint: string;
}>): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: REPOSITORY_MODEL_GRANT_VERSION,
      label: "repository-model-grant",
      value: {
        consentVersion: REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
        projectId: input.projectId,
        projectRepositoryLinkId: input.projectRepositoryLinkId,
        operation: AiOperation.embedding,
        policyRevisionId: input.policyRevisionId,
        effectivePolicyVersion: input.effectivePolicyVersion,
        linkConfigVersion: input.linkConfigVersion,
        linkEffectivePolicyVersion: input.linkEffectivePolicyVersion,
        repositoryCodeGenerationId: input.repositoryCodeGenerationId,
        scanScopeFingerprint: input.scanScopeFingerprint,
        sourceManifestFingerprint: input.sourceManifestFingerprint,
        profileFingerprint: input.profileFingerprint,
        providerFingerprint: input.providerFingerprint,
        modelFingerprint: input.modelFingerprint,
        processorFingerprint: input.processorFingerprint,
        endpointFingerprint: input.endpointFingerprint,
      },
    }), "utf8")
    .digest("hex");
}

function vectorLiteral(vector: readonly number[]): string {
  if (
    vector.length !== 1_536 ||
    vector.some((component) =>
      typeof component !== "number" || !Number.isFinite(component))
  ) {
    return fail("REPOSITORY_CODE_INDEX_CONFLICT");
  }
  return `[${vector.map((component) => Math.fround(component).toString()).join(",")}]`;
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

function isSerializationFailure(error: unknown): boolean {
  if (isPrismaCode(error, "P2034")) return true;
  if (!isPrismaCode(error, "P2010") || typeof error !== "object" || error === null) {
    return false;
  }
  try {
    const meta = Object.getOwnPropertyDescriptor(error, "meta");
    if (meta === undefined || !("value" in meta)) return false;
    const value = meta.value;
    return typeof value === "object" && value !== null &&
      Object.values(value).some((entry) => entry === "40001");
  } catch {
    return false;
  }
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function repositoryChunks(
  snapshot: EligibleRepositorySnapshot,
): readonly RepositoryChunkManifestEntry[] {
  const result: RepositoryChunkManifestEntry[] = [];
  for (const source of snapshot.sources) {
    let chunks;
    try {
      chunks = chunkRepositoryCode(source.contentText);
    } catch {
      return fail("REPOSITORY_CODE_INDEX_CODE_NOT_READY");
    }
    if (chunks.length === 0) return fail("REPOSITORY_CODE_INDEX_CODE_NOT_READY");
    for (const chunk of chunks) {
      result.push(frozen({
        sourceChunkId: uuidFromStableInput(canonicalRow([
          REPOSITORY_CODE_CHUNKER_VERSION,
          snapshot.boundary.projectRepositoryLinkId,
          source.repositoryFileRevisionId,
          chunk.ordinal,
          chunk.rangeStart,
          chunk.rangeEnd,
          chunk.contentHash,
        ])),
        codeGenerationEntryId: source.codeGenerationEntryId,
        repositoryFileRevisionId: source.repositoryFileRevisionId,
        fileOrdinal: source.ordinal,
        chunkOrdinal: chunk.ordinal,
        normalizedPath: source.normalizedPath,
        rangeStart: chunk.rangeStart,
        rangeEnd: chunk.rangeEnd,
        contentText: chunk.contentText,
        contentHash: chunk.contentHash,
        contentBytes: chunk.contentBytes,
      }));
    }
  }
  if (result.length < snapshot.boundary.fileCount) {
    return fail("REPOSITORY_CODE_INDEX_CODE_NOT_READY");
  }
  return Object.freeze(result);
}

function inputManifestFingerprint(entries: readonly RepositoryIndexInput[]): string {
  return fingerprintRows(entries.map((entry) => canonicalRow([
    entry.ordinal,
    entry.id,
    entry.sourceChunkId,
    entry.contentHash,
    entry.contentBytes,
  ])));
}

function chunkManifestFingerprint(
  entries: readonly RepositoryChunkManifestEntry[],
): string {
  return fingerprintRows(entries.map((entry) => canonicalRow([
    entry.fileOrdinal,
    entry.chunkOrdinal,
    entry.codeGenerationEntryId,
    entry.repositoryFileRevisionId,
    entry.normalizedPath,
    entry.rangeStart,
    entry.rangeEnd,
    entry.sourceChunkId,
    entry.contentHash,
    entry.contentBytes,
  ])));
}

function embeddingBatches(
  inputs: readonly ClaimedIndexInput[],
): readonly (readonly ClaimedIndexInput[])[] {
  const batches: ClaimedIndexInput[][] = [];
  let current: ClaimedIndexInput[] = [];
  let currentBytes = 0;
  for (const input of inputs) {
    if (input.contentBytes <= 0 || input.contentBytes > 8_192) {
      return fail("REPOSITORY_CODE_INDEX_CODE_NOT_READY");
    }
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
  if (batches.length === 0) return fail("REPOSITORY_CODE_INDEX_CODE_NOT_READY");
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

function terminalResult(
  indexGenerationId: string,
  attemptId: string,
  status: "failed" | "unknown" | "cancelled",
  safeCode: string,
): RepositoryCodeIndexExecutionResult {
  return frozen({
    kind: "terminal" as const,
    status,
    safeCode,
    indexGenerationId,
    attemptId,
  });
}

function toIndexView(row: {
  id: string;
  projectId: string;
  projectRepositoryLinkId: string | null;
  grantId: string;
  policyRevisionId: string;
  embeddingProfileId: string;
  status: string;
  generationKey: string;
  inputManifestFingerprint: string;
  processingBoundaryFingerprint: string;
  expectedInputCount: number;
  indexedInputCount: number;
  repositoryCode: {
    repositoryCodeGenerationId: string;
    codeGeneration: {
      capturedFullName: string;
      frozenCommitSha: string;
    };
  } | null;
  attempts: readonly { id: string; status: string }[];
}): RepositoryCodeIndexView {
  const attempt = row.attempts[0];
  if (
    row.projectRepositoryLinkId === null ||
    row.repositoryCode === null ||
    attempt === undefined ||
    !["building", "ragReady", "ragReadyEmpty"].includes(row.status) ||
    !["queued", "running", "succeeded", "unknown"].includes(attempt.status)
  ) {
    return fail("REPOSITORY_CODE_INDEX_CONFLICT");
  }
  return frozen({
    id: row.id,
    projectId: row.projectId,
    projectRepositoryLinkId: row.projectRepositoryLinkId,
    repositoryCodeGenerationId: row.repositoryCode.repositoryCodeGenerationId,
    grantId: row.grantId,
    policyRevisionId: row.policyRevisionId,
    embeddingProfileId: row.embeddingProfileId,
    status: row.status as RepositoryCodeIndexView["status"],
    generationKey: row.generationKey,
    inputManifestFingerprint: row.inputManifestFingerprint,
    processingBoundaryFingerprint: row.processingBoundaryFingerprint,
    expectedInputCount: row.expectedInputCount,
    indexedInputCount: row.indexedInputCount,
    attemptId: attempt.id,
    attemptStatus: attempt.status as RepositoryCodeIndexView["attemptStatus"],
    capturedFullName: row.repositoryCode.codeGeneration.capturedFullName,
    frozenCommitSha: row.repositoryCode.codeGeneration.frozenCommitSha,
  });
}

async function readEligibleRepositoryEmbeddingGrant(
  tx: Prisma.TransactionClient,
  projectId: string,
  projectRepositoryLinkId: string,
  grantId: string,
  at: Date,
): Promise<EligibleRepositorySnapshot> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (project === null) return fail("REPOSITORY_CODE_INDEX_PROJECT_NOT_FOUND");

  const link = await tx.projectRepositoryLink.findUnique({
    where: {
      projectId_id: { projectId, id: projectRepositoryLinkId },
    },
    include: {
      configPointer: { include: { config: true } },
      codeGenerationPointer: { include: { generation: true } },
      codeIndexPointer: { select: { indexGenerationId: true } },
    },
  });
  if (link === null) return fail("REPOSITORY_CODE_INDEX_LINK_NOT_FOUND");
  const configPointer = link.configPointer;
  const codePointer = link.codeGenerationPointer;
  if (
    link.status !== "active" ||
    configPointer === null ||
    codePointer === null ||
    !configPointer.config.codeEnabled ||
    link.effectivePolicyVersion !== configPointer.effectivePolicyVersion ||
    configPointer.configVersion !== configPointer.config.version ||
    configPointer.effectivePolicyVersion !== configPointer.config.effectivePolicyVersion ||
    codePointer.linkConfigVersion !== configPointer.configVersion ||
    codePointer.effectivePolicyVersion !== configPointer.effectivePolicyVersion
  ) {
    return fail("REPOSITORY_CODE_INDEX_LINK_INELIGIBLE");
  }
  const generation = codePointer.generation;
  if (
    generation.id !== codePointer.repositoryCodeGenerationId ||
    generation.status !== "codeReady" ||
    generation.modelTransferScanResult !== "passed" ||
    generation.linkConfigVersion !== configPointer.configVersion ||
    generation.effectivePolicyVersion !== configPointer.effectivePolicyVersion ||
    generation.scanScopeFingerprint !== configPointer.config.scanScopeFingerprint ||
    !FINGERPRINT_PATTERN.test(generation.scanScopeFingerprint) ||
    !FINGERPRINT_PATTERN.test(generation.manifestFingerprint) ||
    !FINGERPRINT_PATTERN.test(generation.scannerFingerprint) ||
    !COMMIT_SHA_PATTERN.test(generation.frozenCommitSha) ||
    generation.fileCount < 1 ||
    generation.decodedTextBytes < 1
  ) {
    return fail("REPOSITORY_CODE_INDEX_CODE_NOT_READY");
  }

  const policy = await tx.projectAiPolicy.findUnique({
    where: { projectId },
    include: { currentRevision: { include: { operationProfiles: true } } },
  });
  const revision = policy?.currentRevision;
  const operationProfile = revision?.operationProfiles.find(
    (candidate) => candidate.operation === AiOperation.embedding,
  );
  if (
    revision === undefined ||
    operationProfile === undefined ||
    !revision.outboundEnabled ||
    !revision.embeddingEnabled
  ) {
    return fail("REPOSITORY_CODE_INDEX_GRANT_INELIGIBLE");
  }

  const grant = await tx.modelProcessingGrant.findUnique({
    where: { id: grantId },
    include: { operations: true },
  });
  if (
    grant === null ||
    grant.projectId !== projectId ||
    grant.sourceKind !== "repository_code" ||
    grant.projectRepositoryLinkId !== projectRepositoryLinkId ||
    grant.repositoryCodeGenerationId !== generation.id ||
    grant.linkConfigVersion !== configPointer.configVersion ||
    grant.linkEffectivePolicyVersion !== configPointer.effectivePolicyVersion ||
    grant.scanScopeFingerprint !== generation.scanScopeFingerprint ||
    grant.sourceManifestFingerprint !== generation.manifestFingerprint ||
    grant.status !== "issued" ||
    grant.issuedAt === null ||
    grant.expiresAt === null ||
    grant.revokedAt !== null ||
    grant.issuedAt.getTime() > at.getTime() ||
    grant.expiresAt.getTime() <= at.getTime() ||
    grant.expiresAt.getTime() <= grant.issuedAt.getTime() ||
    grant.policyRevisionId !== revision.id ||
    grant.effectivePolicyVersion !== revision.revision ||
    grant.budgetFingerprint !== revision.budgetFingerprint ||
    grant.scannerFingerprint !== revision.scannerFingerprint ||
    grant.scannerVersion !== generation.scannerVersion ||
    grant.budgetProfile !== "standard" ||
    grant.issuedBy !== "local:user" ||
    grant.purposeCode !== "repository-memory-v1" ||
    !FINGERPRINT_PATTERN.test(grant.grantFingerprint) ||
    !FINGERPRINT_PATTERN.test(grant.budgetFingerprint) ||
    !FINGERPRINT_PATTERN.test(grant.scannerFingerprint) ||
    grant.operations.length !== 1 ||
    grant.operations[0]?.operation !== AiOperation.embedding
  ) {
    return fail("REPOSITORY_CODE_INDEX_GRANT_INELIGIBLE");
  }
  if (grant.grantFingerprint !== expectedRepositoryGrantFingerprint({
    projectId,
    projectRepositoryLinkId,
    policyRevisionId: revision.id,
    effectivePolicyVersion: revision.revision,
    linkConfigVersion: configPointer.configVersion,
    linkEffectivePolicyVersion: configPointer.effectivePolicyVersion,
    repositoryCodeGenerationId: generation.id,
    scanScopeFingerprint: generation.scanScopeFingerprint,
    sourceManifestFingerprint: generation.manifestFingerprint,
    profileFingerprint: grant.profileFingerprint,
    providerFingerprint: grant.providerFingerprint,
    modelFingerprint: grant.modelFingerprint,
    processorFingerprint: grant.processorFingerprint,
    endpointFingerprint: grant.endpointFingerprint,
  })) {
    return fail("REPOSITORY_CODE_INDEX_GRANT_INELIGIBLE");
  }

  const embeddingProfile = getOpenAiEmbeddingProfile();
  if (
    grant.profileFingerprint !== OPENAI_EMBEDDING_PROFILE_FINGERPRINT ||
    grant.providerFingerprint !== OPENAI_EMBEDDINGS_PROVIDER_FINGERPRINT ||
    grant.modelId !== OPENAI_EMBEDDING_MODEL_ID ||
    grant.modelFingerprint !== OPENAI_EMBEDDING_MODEL_FINGERPRINT ||
    grant.processorFingerprint !== OPENAI_EMBEDDING_PROCESSOR_FINGERPRINT ||
    grant.regionFingerprint !== OPENAI_PROCESSOR_REGION_FINGERPRINT ||
    grant.retentionFingerprint !== OPENAI_EMBEDDINGS_RETENTION_FINGERPRINT ||
    grant.endpointFingerprint !== OPENAI_EMBEDDINGS_ENDPOINT_FINGERPRINT ||
    operationProfile.profileFingerprint !== grant.profileFingerprint ||
    operationProfile.providerFingerprint !== grant.providerFingerprint ||
    operationProfile.modelId !== grant.modelId ||
    operationProfile.modelFingerprint !== grant.modelFingerprint ||
    operationProfile.processorFingerprint !== grant.processorFingerprint ||
    operationProfile.regionFingerprint !== grant.regionFingerprint ||
    operationProfile.retentionFingerprint !== grant.retentionFingerprint ||
    operationProfile.endpointFingerprint !== grant.endpointFingerprint ||
    embeddingProfile.profileFingerprint !== grant.profileFingerprint
  ) {
    return fail("REPOSITORY_CODE_INDEX_GRANT_INELIGIBLE");
  }

  const entries = await tx.repositoryCodeGenerationEntry.findMany({
    where: {
      projectId,
      projectRepositoryLinkId,
      repositoryCodeGenerationId: generation.id,
    },
    orderBy: { ordinal: "asc" },
    include: { fileRevision: true },
  });
  if (entries.length !== generation.fileCount) {
    return fail("REPOSITORY_CODE_INDEX_CODE_NOT_READY");
  }
  let decodedTextBytes = 0;
  const sources = entries.map((entry, ordinal) => {
    const file = entry.fileRevision;
    const contentBytes = Buffer.byteLength(file.contentText, "utf8");
    if (
      entry.ordinal !== ordinal ||
      entry.repositoryFileRevisionId !== file.id ||
      entry.contentHash !== file.contentHash ||
      entry.contentBytes !== file.contentBytes ||
      entry.lineCount !== file.lineCount ||
      file.projectRepositoryLinkId !== projectRepositoryLinkId ||
      file.contentHash !== hashSourceContent(file.contentText) ||
      file.contentBytes !== contentBytes ||
      file.scannerVersion !== generation.scannerVersion ||
      file.scannerFingerprint !== generation.scannerFingerprint
    ) {
      return fail("REPOSITORY_CODE_INDEX_CODE_NOT_READY");
    }
    decodedTextBytes += contentBytes;
    return frozen({
      codeGenerationEntryId: entry.id,
      repositoryFileRevisionId: file.id,
      ordinal: entry.ordinal,
      normalizedPath: entry.normalizedPath,
      contentText: file.contentText,
      contentHash: file.contentHash,
      contentBytes,
      lineCount: file.lineCount,
    });
  });
  if (decodedTextBytes !== generation.decodedTextBytes) {
    return fail("REPOSITORY_CODE_INDEX_CODE_NOT_READY");
  }

  return frozen({
    grant: frozen({
      id: grant.id,
      policyRevisionId: revision.id,
      aiEffectivePolicyVersion: revision.revision,
      grantFingerprint: grant.grantFingerprint,
      profileFingerprint: grant.profileFingerprint,
      providerFingerprint: grant.providerFingerprint,
      modelFingerprint: grant.modelFingerprint,
      processorFingerprint: grant.processorFingerprint,
      regionFingerprint: grant.regionFingerprint,
      retentionFingerprint: grant.retentionFingerprint,
      endpointFingerprint: grant.endpointFingerprint,
      budgetFingerprint: grant.budgetFingerprint,
      scannerFingerprint: grant.scannerFingerprint,
      scannerVersion: grant.scannerVersion,
    }),
    boundary: frozen({
      projectRepositoryLinkId,
      repositoryCodeGenerationId: generation.id,
      linkConfigVersion: configPointer.configVersion,
      linkEffectivePolicyVersion: configPointer.effectivePolicyVersion,
      expectedActiveIndexGenerationId:
        link.codeIndexPointer?.indexGenerationId ?? null,
      scanScopeFingerprint: generation.scanScopeFingerprint,
      manifestFingerprint: generation.manifestFingerprint,
      scannerVersion: generation.scannerVersion,
      scannerFingerprint: generation.scannerFingerprint,
      capturedFullName: generation.capturedFullName,
      frozenCommitSha: generation.frozenCommitSha,
      fileCount: generation.fileCount,
      decodedTextBytes: generation.decodedTextBytes,
    }),
    sources: Object.freeze(sources),
  });
}

export function createRepositoryCodeIndexService(options: {
  db: PrismaClient;
  idFactory?: () => string;
  now?: () => Date;
  transactionRetryLimit?: number;
}): {
  prepareRepositoryCodeIndex(input: Readonly<{
    projectId: string;
    projectRepositoryLinkId: string;
    grantId: string;
  }>): Promise<RepositoryCodeIndexView>;
  executeRepositoryCodeIndex(
    input: Readonly<{
      projectId: string;
      projectRepositoryLinkId: string;
      indexGenerationId: string;
    }>,
    credential: OpenAiCredentialHandle,
    transportOptions?: ExecuteOpenAiEmbeddingsOptions,
  ): Promise<RepositoryCodeIndexExecutionResult>;
} {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function"
  ) {
    return fail("REPOSITORY_CODE_INDEX_INVALID_INPUT");
  }
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const retryLimit = options.transactionRetryLimit ?? DEFAULT_RETRY_LIMIT;
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 1 || retryLimit > 5) {
    return fail("REPOSITORY_CODE_INDEX_INVALID_INPUT");
  }

  function currentTime(): Date {
    const value = now();
    if (!validDate(value)) return fail("REPOSITORY_CODE_INDEX_INVALID_INPUT");
    return value;
  }

  async function eligibleSnapshot(
    projectId: string,
    projectRepositoryLinkId: string,
    grantId: string,
  ): Promise<EligibleRepositorySnapshot> {
    const at = currentTime();
    return options.db.$transaction(
      (tx) => readEligibleRepositoryEmbeddingGrant(
        tx,
        projectId,
        projectRepositoryLinkId,
        grantId,
        at,
      ),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async function claimIndexBuild(
    projectId: string,
    projectRepositoryLinkId: string,
    indexGenerationId: string,
  ): Promise<
    | ClaimedRepositoryIndex
    | Readonly<{ kind: "ready"; index: RepositoryCodeIndexView }>
  > {
    return options.db.$transaction(async (tx) => {
      const initial = await tx.indexGeneration.findUnique({
        where: { projectId_id: { projectId, id: indexGenerationId } },
        include: {
          repositoryCode: {
            include: {
              codeGeneration: {
                select: { capturedFullName: true, frozenCommitSha: true },
              },
            },
          },
          attempts: {
            orderBy: { attemptNumber: "desc" },
            take: 1,
            select: {
              id: true,
              status: true,
              operationKey: true,
              expectedInputCount: true,
            },
          },
        },
      });
      if (initial === null) {
        const project = await tx.project.findUnique({
          where: { id: projectId },
          select: { id: true },
        });
        if (project === null) return fail("REPOSITORY_CODE_INDEX_PROJECT_NOT_FOUND");
        const link = await tx.projectRepositoryLink.findUnique({
          where: { projectId_id: { projectId, id: projectRepositoryLinkId } },
          select: { id: true },
        });
        return fail(link === null
          ? "REPOSITORY_CODE_INDEX_LINK_NOT_FOUND"
          : "REPOSITORY_CODE_INDEX_INDEX_NOT_FOUND");
      }
      if (
        initial.projectRepositoryLinkId !== projectRepositoryLinkId ||
        initial.kind !== "repositoryCode" ||
        initial.originScope !== "repository_link" ||
        initial.repositoryCode === null
      ) {
        return fail("REPOSITORY_CODE_INDEX_CONFLICT");
      }
      if (initial.status === "ragReady" || initial.status === "ragReadyEmpty") {
        return frozen({ kind: "ready" as const, index: toIndexView(initial) });
      }
      if (initial.status === "unknown") {
        return fail("REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED");
      }
      if (["failed", "cancelled", "ineligible", "superseded"].includes(initial.status)) {
        return fail("REPOSITORY_CODE_INDEX_BUILD_TERMINAL");
      }
      if (
        initial.status !== "building" ||
        initial.expectedInputCount <= 0 ||
        initial.indexedInputCount !== 0
      ) {
        return fail("REPOSITORY_CODE_INDEX_CONFLICT");
      }

      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "IndexGeneration"
        WHERE "projectId" = ${projectId}::uuid
          AND "id" = ${indexGenerationId}::uuid
        FOR UPDATE
      `);
      const snapshot = await readEligibleRepositoryEmbeddingGrant(
        tx,
        projectId,
        projectRepositoryLinkId,
        initial.grantId,
        currentTime(),
      );
      const repositoryIndex = initial.repositoryCode;
      if (
        snapshot.grant.policyRevisionId !== initial.policyRevisionId ||
        initial.embeddingProfileId !== EMBEDDING_STORAGE_PROFILE_ID ||
        repositoryIndex.repositoryCodeGenerationId !==
          snapshot.boundary.repositoryCodeGenerationId ||
        repositoryIndex.linkConfigVersion !== snapshot.boundary.linkConfigVersion ||
        repositoryIndex.effectivePolicyVersion !==
          snapshot.boundary.linkEffectivePolicyVersion ||
        repositoryIndex.chunkerVersion !== REPOSITORY_CODE_CHUNKER_VERSION
      ) {
        return fail("REPOSITORY_CODE_INDEX_GRANT_INELIGIBLE");
      }
      const attempt = initial.attempts[0];
      if (attempt === undefined) return fail("REPOSITORY_CODE_INDEX_CONFLICT");
      if (attempt.status === "running" || attempt.status === "unknown") {
        return fail("REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED");
      }
      if (attempt.status !== "queued") {
        return fail("REPOSITORY_CODE_INDEX_BUILD_TERMINAL");
      }
      if (attempt.expectedInputCount !== initial.expectedInputCount) {
        return fail("REPOSITORY_CODE_INDEX_CONFLICT");
      }

      const inputs = await tx.indexGenerationInputEntry.findMany({
        where: { projectId, indexGenerationId },
        orderBy: { ordinal: "asc" },
        select: {
          id: true,
          ordinal: true,
          entryKind: true,
          originScope: true,
          projectRepositoryLinkId: true,
          sourceChunkId: true,
          contentHash: true,
          contentBytes: true,
          sourceChunk: {
            select: {
              state: true,
              originScope: true,
              projectRepositoryLinkId: true,
              repositoryFileRevisionId: true,
              contentText: true,
              contentHash: true,
              contentBytes: true,
            },
          },
          repositoryCodeInput: {
            select: {
              projectRepositoryLinkId: true,
              repositoryCodeGenerationId: true,
              repositoryFileRevisionId: true,
              sourceChunkId: true,
            },
          },
          workItem: { select: { status: true, attemptId: true } },
        },
      });
      if (
        inputs.length !== initial.expectedInputCount ||
        inputs.some((input, ordinal) =>
          input.ordinal !== ordinal ||
          input.entryKind !== "repositoryCode" ||
          input.originScope !== "repository_link" ||
          input.projectRepositoryLinkId !== projectRepositoryLinkId ||
          input.sourceChunk.state !== "active" ||
          input.sourceChunk.originScope !== "repository_link" ||
          input.sourceChunk.projectRepositoryLinkId !== projectRepositoryLinkId ||
          input.sourceChunk.contentText === null ||
          input.sourceChunk.contentHash !== input.contentHash ||
          input.sourceChunk.contentBytes !== input.contentBytes ||
          hashSourceContent(input.sourceChunk.contentText) !== input.contentHash ||
          Buffer.byteLength(input.sourceChunk.contentText, "utf8") !== input.contentBytes ||
          input.repositoryCodeInput?.projectRepositoryLinkId !==
            projectRepositoryLinkId ||
          input.repositoryCodeInput.repositoryCodeGenerationId !==
            repositoryIndex.repositoryCodeGenerationId ||
          input.repositoryCodeInput.repositoryFileRevisionId !==
            input.sourceChunk.repositoryFileRevisionId ||
          input.repositoryCodeInput.sourceChunkId !== input.sourceChunkId ||
          input.workItem?.status !== "queued" ||
          input.workItem.attemptId !== null
        )
      ) {
        return fail("REPOSITORY_CODE_INDEX_CONFLICT");
      }

      const claimedAt = currentTime();
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
        data: { status: "running", attemptId: attempt.id, claimedAt },
      });
      if (
        claimedAttempt.count !== 1 ||
        claimedWork.count !== initial.expectedInputCount
      ) {
        return fail("REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED");
      }
      return frozen({
        kind: "claimed" as const,
        projectId,
        projectRepositoryLinkId,
        indexGenerationId,
        repositoryCodeGenerationId: repositoryIndex.repositoryCodeGenerationId,
        linkConfigVersion: repositoryIndex.linkConfigVersion,
        linkEffectivePolicyVersion: repositoryIndex.effectivePolicyVersion,
        grantId: initial.grantId,
        policyRevisionId: initial.policyRevisionId,
        aiEffectivePolicyVersion: snapshot.grant.aiEffectivePolicyVersion,
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
    claim: ClaimedRepositoryIndex,
    status: "failed" | "unknown" | "cancelled",
    safeCode: string,
    values: {
      requestCount: number;
      inputTokens: number;
      providerRequestId: string | null;
      sentAt: Date | null;
    },
  ): Promise<RepositoryCodeIndexExecutionResult> {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(safeCode)) {
      safeCode = "AI_PROVIDER_UNKNOWN";
      status = "unknown";
    }
    const completedAt = currentTime();
    return options.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT "status"::text AS "status"
        FROM "IndexGeneration"
        WHERE "projectId" = ${claim.projectId}::uuid
          AND "id" = ${claim.indexGenerationId}::uuid
        FOR UPDATE
      `);
      if (locked.length !== 1) return fail("REPOSITORY_CODE_INDEX_CONFLICT");
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
        return fail("REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED");
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
        return fail("REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED");
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
    claim: ClaimedRepositoryIndex,
    batches: readonly CompletedEmbeddingBatch[],
    sentAt: Date,
  ): Promise<RepositoryCodeIndexExecutionResult> {
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
        providerRequestId: batches.length === 1
          ? batches[0]!.providerRequestId
          : null,
        sentAt,
      });
    }
    const completedAt = currentTime();
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
          return fail("REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED");
        }
        const eligible = await readEligibleRepositoryEmbeddingGrant(
          tx,
          claim.projectId,
          claim.projectRepositoryLinkId,
          claim.grantId,
          completedAt,
        );
        if (
          eligible.boundary.repositoryCodeGenerationId !==
            claim.repositoryCodeGenerationId ||
          eligible.boundary.linkConfigVersion !== claim.linkConfigVersion ||
          eligible.boundary.linkEffectivePolicyVersion !==
            claim.linkEffectivePolicyVersion ||
          eligible.grant.policyRevisionId !== claim.policyRevisionId ||
          eligible.grant.aiEffectivePolicyVersion !==
            claim.aiEffectivePolicyVersion
        ) {
          return fail("REPOSITORY_CODE_INDEX_GRANT_INELIGIBLE");
        }
        const attempt = await tx.indexBuildAttempt.findUnique({
          where: { id: claim.attemptId },
          select: { status: true },
        });
        if (attempt?.status !== "running") {
          return fail("REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED");
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
          return fail("REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED");
        }

        for (const input of claim.inputs) {
          const vector = vectorsByInput.get(input.id)!;
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "ChunkEmbedding" (
              "id", "projectId", "indexGenerationId", "inputEntryId",
              "sourceChunkId", "embeddingProfileId", "attemptId", "vector",
              "vectorFingerprint"
            ) VALUES (
              ${safeUuid(idFactory())}::uuid,
              ${claim.projectId}::uuid,
              ${claim.indexGenerationId}::uuid,
              ${input.id}::uuid,
              ${input.sourceChunkId}::uuid,
              ${EMBEDDING_STORAGE_PROFILE_ID}::uuid,
              ${claim.attemptId}::uuid,
              CAST(${vectorLiteral(vector.vector)} AS vector(1536)),
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
          return fail("REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED");
        }
        await tx.indexBuildAttempt.update({
          where: { id: claim.attemptId },
          data: {
            status: "succeeded",
            requestCount: batches.length,
            inputTokens: batches.reduce((sum, batch) => sum + batch.inputTokens, 0),
            providerRequestId: batches.length === 1
              ? batches[0]!.providerRequestId
              : null,
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
        await tx.repositoryCodeIndexPointer.upsert({
          where: {
            projectId_projectRepositoryLinkId: {
              projectId: claim.projectId,
              projectRepositoryLinkId: claim.projectRepositoryLinkId,
            },
          },
          create: {
            projectId: claim.projectId,
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            indexGenerationId: claim.indexGenerationId,
            repositoryCodeGenerationId: claim.repositoryCodeGenerationId,
            linkConfigVersion: claim.linkConfigVersion,
            effectivePolicyVersion: claim.linkEffectivePolicyVersion,
            publishedAt: completedAt,
          },
          update: {
            indexGenerationId: claim.indexGenerationId,
            repositoryCodeGenerationId: claim.repositoryCodeGenerationId,
            linkConfigVersion: claim.linkConfigVersion,
            effectivePolicyVersion: claim.linkEffectivePolicyVersion,
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
            repositoryCode: {
              include: {
                codeGeneration: {
                  select: { capturedFullName: true, frozenCommitSha: true },
                },
              },
            },
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
      try {
        return await closeIndexBuild(
          claim,
          "unknown",
          "AI_PROVIDER_UNKNOWN",
          {
            requestCount: batches.length,
            inputTokens: batches.reduce((sum, batch) => sum + batch.inputTokens, 0),
            providerRequestId: batches.length === 1
              ? batches[0]!.providerRequestId
              : null,
            sentAt,
          },
        );
      } catch {
        throw error;
      }
    }
  }

  return Object.freeze({
    async prepareRepositoryCodeIndex(input) {
      const projectId = safeUuid(input?.projectId);
      const projectRepositoryLinkId = safeUuid(input?.projectRepositoryLinkId);
      const grantId = safeUuid(input?.grantId);
      const initial = await eligibleSnapshot(
        projectId,
        projectRepositoryLinkId,
        grantId,
      );
      const initialChunks = repositoryChunks(initial);
      for (let offset = 0; offset < initialChunks.length; offset += CREATE_BATCH_SIZE) {
        const batch = initialChunks.slice(offset, offset + CREATE_BATCH_SIZE);
        await options.db.sourceChunk.createMany({
          data: batch.map((chunk) => ({
            id: chunk.sourceChunkId,
            projectId,
            originScope: "repository_link",
            projectRepositoryLinkId,
            projectSourceId: null,
            sourceRevisionKey: null,
            sourceContentHash: initial.sources.find((source) =>
              source.repositoryFileRevisionId === chunk.repositoryFileRevisionId
            )!.contentHash,
            repositoryFileRevisionId: chunk.repositoryFileRevisionId,
            ordinal: chunk.chunkOrdinal,
            rangeUnit: "line",
            rangeStart: chunk.rangeStart,
            rangeEnd: chunk.rangeEnd,
            chunkerVersion: REPOSITORY_CODE_CHUNKER_VERSION,
            contentText: chunk.contentText,
            contentHash: chunk.contentHash,
            contentBytes: chunk.contentBytes,
            state: "active",
          })),
          skipDuplicates: true,
        });
      }

      for (let attempt = 0; attempt < retryLimit; attempt += 1) {
        try {
          return await options.db.$transaction(async (tx) => {
            const snapshot = await readEligibleRepositoryEmbeddingGrant(
              tx,
              projectId,
              projectRepositoryLinkId,
              grantId,
              currentTime(),
            );
            if (
              snapshot.boundary.repositoryCodeGenerationId !==
                initial.boundary.repositoryCodeGenerationId
            ) {
              return fail("REPOSITORY_CODE_INDEX_LINK_INELIGIBLE");
            }
            const chunks = repositoryChunks(snapshot);
            const chunkRows = await tx.sourceChunk.findMany({
              where: {
                projectId,
                id: { in: chunks.map((chunk) => chunk.sourceChunkId) },
              },
              select: {
                id: true,
                originScope: true,
                projectRepositoryLinkId: true,
                repositoryFileRevisionId: true,
                ordinal: true,
                rangeUnit: true,
                rangeStart: true,
                rangeEnd: true,
                chunkerVersion: true,
                contentText: true,
                contentHash: true,
                contentBytes: true,
                state: true,
              },
            });
            const chunkById = new Map(chunkRows.map((chunk) => [chunk.id, chunk]));
            if (
              chunkRows.length !== chunks.length ||
              chunks.some((chunk) => {
                const row = chunkById.get(chunk.sourceChunkId);
                return row === undefined ||
                  row.originScope !== "repository_link" ||
                  row.projectRepositoryLinkId !== projectRepositoryLinkId ||
                  row.repositoryFileRevisionId !== chunk.repositoryFileRevisionId ||
                  row.ordinal !== chunk.chunkOrdinal ||
                  row.rangeUnit !== "line" ||
                  row.rangeStart !== chunk.rangeStart ||
                  row.rangeEnd !== chunk.rangeEnd ||
                  row.chunkerVersion !== REPOSITORY_CODE_CHUNKER_VERSION ||
                  row.contentText !== chunk.contentText ||
                  row.contentHash !== chunk.contentHash ||
                  row.contentBytes !== chunk.contentBytes ||
                  row.state !== "active";
              })
            ) {
              return fail("REPOSITORY_CODE_INDEX_CONFLICT");
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
              storageProfile.profileFingerprint !==
                EMBEDDING_STORAGE_PROFILE_FINGERPRINT
            ) {
              return fail("REPOSITORY_CODE_INDEX_CONFLICT");
            }

            const codeChunkManifest = chunkManifestFingerprint(chunks);
            const processingBoundary = stableFingerprint(
              REPOSITORY_CODE_INDEX_VERSION,
              [
                snapshot.grant.grantFingerprint,
                snapshot.grant.policyRevisionId,
                snapshot.grant.aiEffectivePolicyVersion,
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
                snapshot.boundary.repositoryCodeGenerationId,
                snapshot.boundary.linkConfigVersion,
                snapshot.boundary.linkEffectivePolicyVersion,
                snapshot.boundary.scanScopeFingerprint,
                snapshot.boundary.manifestFingerprint,
                snapshot.boundary.scannerVersion,
                snapshot.boundary.scannerFingerprint,
                codeChunkManifest,
                EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
                OPENAI_EMBEDDINGS_CONTRACT_VERSION,
                OPENAI_HTTP_TRANSPORT_VERSION,
                REPOSITORY_CODE_CHUNKER_VERSION,
              ],
            );
            const inputEntries: RepositoryIndexInput[] = chunks.map((chunk, ordinal) =>
              frozen({
                id: uuidFromStableInput(canonicalRow([
                  REPOSITORY_CODE_INDEX_VERSION,
                  projectId,
                  projectRepositoryLinkId,
                  snapshot.boundary.repositoryCodeGenerationId,
                  chunk.sourceChunkId,
                  processingBoundary,
                ])),
                sourceChunkId: chunk.sourceChunkId,
                codeGenerationEntryId: chunk.codeGenerationEntryId,
                repositoryFileRevisionId: chunk.repositoryFileRevisionId,
                ordinal,
                contentHash: chunk.contentHash,
                contentBytes: chunk.contentBytes,
              }),
            );
            const inputManifest = inputManifestFingerprint(inputEntries);
            const generationKey = stableFingerprint(
              REPOSITORY_CODE_INDEX_VERSION,
              [
                projectId,
                projectRepositoryLinkId,
                snapshot.boundary.repositoryCodeGenerationId,
                snapshot.boundary.manifestFingerprint,
                inputManifest,
                processingBoundary,
                EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
              ],
            );
            const existing = await tx.indexGeneration.findUnique({
              where: { projectId_generationKey: { projectId, generationKey } },
              include: {
                repositoryCode: {
                  include: {
                    codeGeneration: {
                      select: { capturedFullName: true, frozenCommitSha: true },
                    },
                  },
                },
                attempts: {
                  orderBy: { attemptNumber: "desc" },
                  take: 1,
                  select: { id: true, status: true },
                },
              },
            });
            if (existing !== null) {
              if (
                existing.kind !== "repositoryCode" ||
                existing.projectRepositoryLinkId !== projectRepositoryLinkId ||
                existing.grantId !== grantId ||
                existing.policyRevisionId !== snapshot.grant.policyRevisionId ||
                existing.embeddingProfileId !== storageProfile.id ||
                existing.inputManifestFingerprint !== inputManifest ||
                existing.processingBoundaryFingerprint !== processingBoundary ||
                existing.expectedInputCount !== inputEntries.length
              ) {
                return fail("REPOSITORY_CODE_INDEX_CONFLICT");
              }
              if (["failed", "cancelled", "ineligible", "superseded"].includes(existing.status)) {
                return fail("REPOSITORY_CODE_INDEX_BUILD_TERMINAL");
              }
              if (existing.status === "unknown") {
                return fail("REPOSITORY_CODE_INDEX_RECONCILIATION_REQUIRED");
              }
              return toIndexView(existing);
            }

            const indexGenerationId = safeUuid(idFactory());
            await tx.indexGeneration.create({
              data: {
                id: indexGenerationId,
                projectId,
                kind: "repositoryCode",
                originScope: "repository_link",
                projectRepositoryLinkId,
                grantId,
                policyRevisionId: snapshot.grant.policyRevisionId,
                embeddingProfileId: storageProfile.id,
                status: "staging",
                generationKey,
                inputManifestFingerprint: inputManifest,
                processingBoundaryFingerprint: processingBoundary,
                expectedInputCount: inputEntries.length,
              },
            });
            await tx.repositoryCodeIndexGeneration.create({
              data: {
                projectId,
                projectRepositoryLinkId,
                indexGenerationId,
                repositoryCodeGenerationId:
                  snapshot.boundary.repositoryCodeGenerationId,
                expectedActiveIndexGenerationId:
                  snapshot.boundary.expectedActiveIndexGenerationId,
                linkConfigVersion: snapshot.boundary.linkConfigVersion,
                grantId,
                policyRevisionId: snapshot.grant.policyRevisionId,
                effectivePolicyVersion:
                  snapshot.boundary.linkEffectivePolicyVersion,
                chunkerVersion: REPOSITORY_CODE_CHUNKER_VERSION,
              },
            });
            await tx.indexGenerationInputEntry.createMany({
              data: inputEntries.map((entry) => ({
                id: entry.id,
                projectId,
                indexGenerationId,
                ordinal: entry.ordinal,
                entryKind: "repositoryCode",
                originScope: "repository_link",
                projectRepositoryLinkId,
                sourceChunkId: entry.sourceChunkId,
                contentHash: entry.contentHash,
                contentBytes: entry.contentBytes,
              })),
            });
            await tx.repositoryCodeIndexInput.createMany({
              data: inputEntries.map((entry) => ({
                projectId,
                projectRepositoryLinkId,
                indexGenerationId,
                inputEntryId: entry.id,
                repositoryCodeGenerationId:
                  snapshot.boundary.repositoryCodeGenerationId,
                codeGenerationEntryId: entry.codeGenerationEntryId,
                repositoryFileRevisionId: entry.repositoryFileRevisionId,
                sourceChunkId: entry.sourceChunkId,
                originScope: "repository_link",
              })),
            });
            await tx.indexWorkItem.createMany({
              data: inputEntries.map((entry) => ({
                id: uuidFromStableInput(canonicalRow([
                  REPOSITORY_CODE_INDEX_VERSION,
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
                  REPOSITORY_CODE_INDEX_VERSION,
                  ["work-item", projectId, entry.id, processingBoundary],
                ),
                processingBoundaryFingerprint: processingBoundary,
                status: "queued",
              })),
            });
            const startedAt = currentTime();
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
                grantId,
                policyRevisionId: snapshot.grant.policyRevisionId,
                attemptNumber: 1,
                operationKey: stableFingerprint(
                  REPOSITORY_CODE_INDEX_VERSION,
                  ["attempt", projectId, generationKey, 1],
                ),
                status: "queued",
                expectedInputCount: inputEntries.length,
              },
            });
            const created = await tx.indexGeneration.findUniqueOrThrow({
              where: { projectId_id: { projectId, id: indexGenerationId } },
              include: {
                repositoryCode: {
                  include: {
                    codeGeneration: {
                      select: { capturedFullName: true, frozenCommitSha: true },
                    },
                  },
                },
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
          if (error instanceof RepositoryCodeIndexError) throw error;
          const retryable = isPrismaCode(error, "P2002") ||
            isSerializationFailure(error);
          if (retryable && attempt + 1 < retryLimit) continue;
          if (retryable) return fail("REPOSITORY_CODE_INDEX_WRITE_CONFLICT");
          throw error;
        }
      }
      return fail("REPOSITORY_CODE_INDEX_WRITE_CONFLICT");
    },

    async executeRepositoryCodeIndex(input, credential, transportOptions = {}) {
      const projectId = safeUuid(input?.projectId);
      const projectRepositoryLinkId = safeUuid(input?.projectRepositoryLinkId);
      const indexGenerationId = safeUuid(input?.indexGenerationId);
      const claim = await claimIndexBuild(
        projectId,
        projectRepositoryLinkId,
        indexGenerationId,
      );
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
          const calledAt = currentTime();
          const plan = buildOpenAiEmbeddingsTransportPlan(
            getOpenAiEmbeddingProfile(),
            {
              runId: claim.attemptId,
              operationKey: stableFingerprint(
                REPOSITORY_CODE_INDEX_VERSION,
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
      if (sentAt === null) return fail("REPOSITORY_CODE_INDEX_CONFLICT");
      return publishCompletedIndex(claim, completedBatches, sentAt);
    },
  });
}
