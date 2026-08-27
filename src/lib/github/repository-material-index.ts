import { createHash, randomUUID } from "node:crypto";
import {
  AiOperation,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import {
  SOURCE_CHUNKER_VERSION,
  chunkSourceText,
} from "@/lib/ai-memory/chunking";
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
  REPOSITORY_MATERIAL_MODEL_GRANT_VERSION,
  REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
} from "./repository-material-model-grant";

export const REPOSITORY_MATERIAL_INDEX_VERSION =
  "repository-material-index:v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DEFAULT_RETRY_LIMIT = 3;
const CREATE_BATCH_SIZE = 200;

export type RepositoryMaterialIndexErrorCode =
  | "REPOSITORY_MATERIAL_INDEX_INVALID_INPUT"
  | "REPOSITORY_MATERIAL_INDEX_PROJECT_NOT_FOUND"
  | "REPOSITORY_MATERIAL_INDEX_LINK_NOT_FOUND"
  | "REPOSITORY_MATERIAL_INDEX_LINK_INELIGIBLE"
  | "REPOSITORY_MATERIAL_INDEX_GRANT_INELIGIBLE"
  | "REPOSITORY_MATERIAL_INDEX_MATERIAL_NOT_READY"
  | "REPOSITORY_MATERIAL_INDEX_INDEX_NOT_FOUND"
  | "REPOSITORY_MATERIAL_INDEX_RECONCILIATION_REQUIRED"
  | "REPOSITORY_MATERIAL_INDEX_BUILD_TERMINAL"
  | "REPOSITORY_MATERIAL_INDEX_CONFLICT"
  | "REPOSITORY_MATERIAL_INDEX_WRITE_CONFLICT";

export class RepositoryMaterialIndexError extends Error {
  constructor(readonly code: RepositoryMaterialIndexErrorCode) {
    super(code);
    this.name = "RepositoryMaterialIndexError";
  }
}

export type RepositoryMaterialIndexView = Readonly<{
  id: string;
  projectId: string;
  projectRepositoryLinkId: string;
  repositoryMaterialGenerationId: string;
  grantId: string;
  policyRevisionId: string;
  embeddingProfileId: string;
  status: "building" | "ragReady";
  generationKey: string;
  inputManifestFingerprint: string;
  processingBoundaryFingerprint: string;
  expectedInputCount: number;
  indexedInputCount: number;
  attemptId: string;
  attemptStatus: "queued" | "running" | "succeeded" | "unknown";
  capturedFullName: string;
  observedHeadCommitSha: string;
}>;

export type RepositoryMaterialIndexExecutionResult =
  | Readonly<{
      kind: "published";
      index: RepositoryMaterialIndexView;
    }>
  | Readonly<{
      kind: "terminal";
      status: "failed" | "unknown" | "cancelled";
      safeCode: string;
      indexGenerationId: string;
      attemptId: string;
    }>;

type RepositoryMaterialSource = Readonly<{
  grantSourceId: string;
  materialGenerationEntryId: string;
  githubSourceVersionId: string;
  projectSourceId: string;
  sourceRevisionKey: string;
  sourceContentHash: string;
  sourceContentBytes: number;
  sourceOrdinal: number;
  materialKind: string;
  contentText: string;
}>;

type EligibleMaterialSnapshot = Readonly<{
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
    scannerFingerprint: string;
    scannerVersion: string;
  }>;
  boundary: Readonly<{
    projectRepositoryLinkId: string;
    repositoryMaterialGenerationId: string;
    linkConfigVersion: number;
    linkEffectivePolicyVersion: number;
    expectedActiveIndexGenerationId: string | null;
    materialPolicyFingerprint: string;
    manifestFingerprint: string;
    scannerVersion: string;
    scannerFingerprint: string;
    capturedFullName: string;
    observedHeadCommitSha: string;
    sourceCount: number;
    decodedTextBytes: number;
  }>;
  sources: readonly RepositoryMaterialSource[];
}>;

type MaterialChunkManifestEntry = Readonly<{
  sourceChunkId: string;
  grantSourceId: string;
  materialGenerationEntryId: string;
  githubSourceVersionId: string;
  projectSourceId: string;
  sourceRevisionKey: string;
  sourceContentHash: string;
  sourceOrdinal: number;
  materialKind: string;
  chunkOrdinal: number;
  rangeStart: number;
  rangeEnd: number;
  contentText: string;
  contentHash: string;
  contentBytes: number;
}>;

type MaterialIndexInput = Readonly<{
  id: string;
  sourceChunkId: string;
  grantSourceId: string;
  materialGenerationEntryId: string;
  projectSourceId: string;
  ordinal: number;
  contentHash: string;
  contentBytes: number;
}>;

type MaterialIndexPlan = Readonly<{
  chunks: readonly MaterialChunkManifestEntry[];
  inputs: readonly MaterialIndexInput[];
  inputManifestFingerprint: string;
  processingBoundaryFingerprint: string;
  generationKey: string;
}>;

type ClaimedIndexInput = Readonly<{
  id: string;
  sourceChunkId: string;
  contentText: string;
  contentHash: string;
  contentBytes: number;
}>;

type ClaimedMaterialIndex = Readonly<{
  kind: "claimed";
  projectId: string;
  projectRepositoryLinkId: string;
  indexGenerationId: string;
  repositoryMaterialGenerationId: string;
  linkConfigVersion: number;
  linkEffectivePolicyVersion: number;
  grantId: string;
  policyRevisionId: string;
  aiEffectivePolicyVersion: number;
  processingBoundaryFingerprint: string;
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

function fail(code: RepositoryMaterialIndexErrorCode): never {
  throw new RepositoryMaterialIndexError(code);
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function safeUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("REPOSITORY_MATERIAL_INDEX_INVALID_INPUT");
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
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function canonicalRow(fields: readonly (string | number)[]): string {
  return fields.map(String).join("\x1f");
}

function fingerprintRows(rows: readonly string[]): string {
  if (rows.length === 0) {
    return fail("REPOSITORY_MATERIAL_INDEX_MATERIAL_NOT_READY");
  }
  return sha256(rows.join("\x1e"));
}

function stableFingerprint(
  label: string,
  fields: readonly (string | number)[],
): string {
  return sha256(canonicalRow([label, ...fields]));
}

function expectedGrantFingerprint(input: Readonly<{
  issuedAt: Date;
  expiresAt: Date;
  projectId: string;
  projectRepositoryLinkId: string;
  policyRevisionId: string;
  effectivePolicyVersion: number;
  linkConfigVersion: number;
  linkEffectivePolicyVersion: number;
  repositoryMaterialGenerationId: string;
  materialPolicyFingerprint: string;
  sourceManifestFingerprint: string;
  scannerFingerprint: string;
  profileFingerprint: string;
  providerFingerprint: string;
  modelFingerprint: string;
  processorFingerprint: string;
  endpointFingerprint: string;
}>): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: REPOSITORY_MATERIAL_MODEL_GRANT_VERSION,
      label: "repository-material-model-grant",
      value: {
        consentVersion: REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
        issuedAt: input.issuedAt.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        projectId: input.projectId,
        projectRepositoryLinkId: input.projectRepositoryLinkId,
        operation: AiOperation.embedding,
        policyRevisionId: input.policyRevisionId,
        effectivePolicyVersion: input.effectivePolicyVersion,
        linkConfigVersion: input.linkConfigVersion,
        linkEffectivePolicyVersion: input.linkEffectivePolicyVersion,
        repositoryMaterialGenerationId: input.repositoryMaterialGenerationId,
        materialPolicyFingerprint: input.materialPolicyFingerprint,
        sourceManifestFingerprint: input.sourceManifestFingerprint,
        scannerFingerprint: input.scannerFingerprint,
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
    return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
  }
  return "[" +
    vector.map((component) => Math.fround(component).toString()).join(",") +
    "]";
}

function isPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.value === code;
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
    return typeof value === "object" &&
      value !== null &&
      Object.values(value).some((entry) => entry === "40001");
  } catch {
    return false;
  }
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function materialChunks(
  snapshot: EligibleMaterialSnapshot,
): readonly MaterialChunkManifestEntry[] {
  const result: MaterialChunkManifestEntry[] = [];
  for (const source of snapshot.sources) {
    let chunks;
    try {
      chunks = chunkSourceText(source.contentText);
    } catch {
      return fail("REPOSITORY_MATERIAL_INDEX_MATERIAL_NOT_READY");
    }
    if (chunks.length === 0) {
      return fail("REPOSITORY_MATERIAL_INDEX_MATERIAL_NOT_READY");
    }
    for (const chunk of chunks) {
      result.push(frozen({
        sourceChunkId: uuidFromStableInput(canonicalRow([
          SOURCE_CHUNKER_VERSION,
          snapshot.boundary.projectRepositoryLinkId,
          snapshot.boundary.repositoryMaterialGenerationId,
          source.materialGenerationEntryId,
          source.projectSourceId,
          chunk.ordinal,
          chunk.rangeStart,
          chunk.rangeEnd,
          chunk.contentHash,
        ])),
        grantSourceId: source.grantSourceId,
        materialGenerationEntryId: source.materialGenerationEntryId,
        githubSourceVersionId: source.githubSourceVersionId,
        projectSourceId: source.projectSourceId,
        sourceRevisionKey: source.sourceRevisionKey,
        sourceContentHash: source.sourceContentHash,
        sourceOrdinal: source.sourceOrdinal,
        materialKind: source.materialKind,
        chunkOrdinal: chunk.ordinal,
        rangeStart: chunk.rangeStart,
        rangeEnd: chunk.rangeEnd,
        contentText: chunk.contentText,
        contentHash: chunk.contentHash,
        contentBytes: chunk.contentBytes,
      }));
    }
  }
  if (result.length < snapshot.boundary.sourceCount) {
    return fail("REPOSITORY_MATERIAL_INDEX_MATERIAL_NOT_READY");
  }
  return Object.freeze(result);
}

function chunkManifestFingerprint(
  entries: readonly MaterialChunkManifestEntry[],
): string {
  return fingerprintRows(entries.map((entry) => canonicalRow([
    entry.sourceOrdinal,
    entry.chunkOrdinal,
    entry.materialGenerationEntryId,
    entry.githubSourceVersionId,
    entry.projectSourceId,
    entry.materialKind,
    entry.rangeStart,
    entry.rangeEnd,
    entry.sourceChunkId,
    entry.contentHash,
    entry.contentBytes,
  ])));
}

function inputManifestFingerprint(
  entries: readonly MaterialIndexInput[],
): string {
  return fingerprintRows(entries.map((entry) => canonicalRow([
    entry.ordinal,
    entry.id,
    entry.sourceChunkId,
    entry.contentHash,
    entry.contentBytes,
  ])));
}

function buildIndexPlan(
  projectId: string,
  snapshot: EligibleMaterialSnapshot,
): MaterialIndexPlan {
  const chunks = materialChunks(snapshot);
  const chunkManifest = chunkManifestFingerprint(chunks);
  const processingBoundaryFingerprint = stableFingerprint(
    REPOSITORY_MATERIAL_INDEX_VERSION,
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
      snapshot.grant.scannerFingerprint,
      snapshot.grant.scannerVersion,
      snapshot.boundary.repositoryMaterialGenerationId,
      snapshot.boundary.linkConfigVersion,
      snapshot.boundary.linkEffectivePolicyVersion,
      snapshot.boundary.materialPolicyFingerprint,
      snapshot.boundary.manifestFingerprint,
      snapshot.boundary.scannerVersion,
      snapshot.boundary.scannerFingerprint,
      snapshot.boundary.observedHeadCommitSha,
      chunkManifest,
      EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
      OPENAI_EMBEDDINGS_CONTRACT_VERSION,
      OPENAI_HTTP_TRANSPORT_VERSION,
      SOURCE_CHUNKER_VERSION,
    ],
  );
  const inputs = Object.freeze(chunks.map((chunk, ordinal) => frozen({
    id: uuidFromStableInput(canonicalRow([
      REPOSITORY_MATERIAL_INDEX_VERSION,
      projectId,
      snapshot.boundary.projectRepositoryLinkId,
      snapshot.boundary.repositoryMaterialGenerationId,
      chunk.sourceChunkId,
      processingBoundaryFingerprint,
    ])),
    sourceChunkId: chunk.sourceChunkId,
    grantSourceId: chunk.grantSourceId,
    materialGenerationEntryId: chunk.materialGenerationEntryId,
    projectSourceId: chunk.projectSourceId,
    ordinal,
    contentHash: chunk.contentHash,
    contentBytes: chunk.contentBytes,
  })));
  const inputManifest = inputManifestFingerprint(inputs);
  const generationKey = stableFingerprint(
    REPOSITORY_MATERIAL_INDEX_VERSION,
    [
      projectId,
      snapshot.boundary.projectRepositoryLinkId,
      snapshot.boundary.repositoryMaterialGenerationId,
      snapshot.boundary.manifestFingerprint,
      inputManifest,
      processingBoundaryFingerprint,
      EMBEDDING_STORAGE_PROFILE_FINGERPRINT,
    ],
  );
  return frozen({
    chunks,
    inputs,
    inputManifestFingerprint: inputManifest,
    processingBoundaryFingerprint,
    generationKey,
  });
}

function embeddingBatches(
  inputs: readonly ClaimedIndexInput[],
): readonly (readonly ClaimedIndexInput[])[] {
  const batches: ClaimedIndexInput[][] = [];
  let current: ClaimedIndexInput[] = [];
  let currentBytes = 0;
  for (const input of inputs) {
    if (input.contentBytes <= 0 || input.contentBytes > 8_192) {
      return fail("REPOSITORY_MATERIAL_INDEX_MATERIAL_NOT_READY");
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
  if (batches.length === 0) {
    return fail("REPOSITORY_MATERIAL_INDEX_MATERIAL_NOT_READY");
  }
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

function terminalResult(
  indexGenerationId: string,
  attemptId: string,
  status: "failed" | "unknown" | "cancelled",
  safeCode: string,
): RepositoryMaterialIndexExecutionResult {
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
  projectRepositoryLinkId: string;
  repositoryMaterialGenerationId: string;
  grantId: string;
  policyRevisionId: string;
  embeddingProfileId: string;
  status: string;
  generationKey: string;
  inputManifestFingerprint: string;
  processingBoundaryFingerprint: string;
  expectedInputCount: number;
  indexedInputCount: number;
  materialGeneration: {
    capturedFullName: string;
    observedHeadCommitSha: string;
  };
  attempts: readonly { id: string; status: string }[];
}): RepositoryMaterialIndexView {
  const attempt = row.attempts[0];
  if (
    attempt === undefined ||
    !["building", "ragReady"].includes(row.status) ||
    !["queued", "running", "succeeded", "unknown"].includes(attempt.status)
  ) {
    return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
  }
  return frozen({
    id: row.id,
    projectId: row.projectId,
    projectRepositoryLinkId: row.projectRepositoryLinkId,
    repositoryMaterialGenerationId: row.repositoryMaterialGenerationId,
    grantId: row.grantId,
    policyRevisionId: row.policyRevisionId,
    embeddingProfileId: row.embeddingProfileId,
    status: row.status as RepositoryMaterialIndexView["status"],
    generationKey: row.generationKey,
    inputManifestFingerprint: row.inputManifestFingerprint,
    processingBoundaryFingerprint: row.processingBoundaryFingerprint,
    expectedInputCount: row.expectedInputCount,
    indexedInputCount: row.indexedInputCount,
    attemptId: attempt.id,
    attemptStatus: attempt.status as RepositoryMaterialIndexView["attemptStatus"],
    capturedFullName: row.materialGeneration.capturedFullName,
    observedHeadCommitSha: row.materialGeneration.observedHeadCommitSha,
  });
}

async function readEligibleMaterialEmbeddingGrant(
  tx: Prisma.TransactionClient,
  projectId: string,
  projectRepositoryLinkId: string,
  grantId: string,
  at: Date,
): Promise<EligibleMaterialSnapshot> {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (project === null) {
    return fail("REPOSITORY_MATERIAL_INDEX_PROJECT_NOT_FOUND");
  }

  const link = await tx.projectRepositoryLink.findUnique({
    where: { projectId_id: { projectId, id: projectRepositoryLinkId } },
    include: {
      configPointer: { include: { config: true } },
      materialGenerationPointer: {
        include: {
          generation: {
            include: {
              entries: {
                orderBy: { ordinal: "asc" },
                include: {
                  sourceVersion: { include: { projectSource: true } },
                },
              },
            },
          },
        },
      },
      materialIndexPointer: { select: { indexGenerationId: true } },
    },
  });
  if (link === null) {
    return fail("REPOSITORY_MATERIAL_INDEX_LINK_NOT_FOUND");
  }
  const configPointer = link.configPointer;
  const materialPointer = link.materialGenerationPointer;
  const materialEnabled = configPointer !== null && (
    configPointer.config.metadataEnabled ||
    configPointer.config.readmeEnabled ||
    configPointer.config.markdownEnabled ||
    configPointer.config.issuesEnabled ||
    configPointer.config.pullRequestsEnabled ||
    configPointer.config.releasesEnabled
  );
  if (
    link.status !== "active" ||
    configPointer === null ||
    materialPointer === null ||
    !materialEnabled ||
    link.effectivePolicyVersion !== configPointer.effectivePolicyVersion ||
    configPointer.configVersion !== configPointer.config.version ||
    configPointer.effectivePolicyVersion !==
      configPointer.config.effectivePolicyVersion ||
    materialPointer.linkConfigVersion !== configPointer.configVersion ||
    materialPointer.effectivePolicyVersion !==
      configPointer.effectivePolicyVersion
  ) {
    return fail("REPOSITORY_MATERIAL_INDEX_LINK_INELIGIBLE");
  }
  const generation = materialPointer.generation;
  if (
    generation.id !== materialPointer.repositoryMaterialGenerationId ||
    generation.status !== "complete" ||
    generation.linkConfigVersion !== configPointer.configVersion ||
    generation.effectivePolicyVersion !== configPointer.effectivePolicyVersion ||
    generation.entries.length !== generation.sourceCount ||
    generation.sourceCount < 1 ||
    generation.decodedTextBytes < 1 ||
    !FINGERPRINT_PATTERN.test(generation.manifestFingerprint) ||
    !FINGERPRINT_PATTERN.test(generation.scannerFingerprint) ||
    !FINGERPRINT_PATTERN.test(configPointer.config.policyFingerprint) ||
    !COMMIT_SHA_PATTERN.test(generation.observedHeadCommitSha) ||
    generation.capturedFullName.length === 0
  ) {
    return fail("REPOSITORY_MATERIAL_INDEX_MATERIAL_NOT_READY");
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
    return fail("REPOSITORY_MATERIAL_INDEX_GRANT_INELIGIBLE");
  }

  const grant = await tx.repositoryMaterialModelGrant.findUnique({
    where: { id: grantId },
    include: { sources: true },
  });
  if (
    grant === null ||
    grant.projectId !== projectId ||
    grant.projectRepositoryLinkId !== projectRepositoryLinkId ||
    grant.repositoryMaterialGenerationId !== generation.id ||
    grant.linkConfigVersion !== configPointer.configVersion ||
    grant.linkEffectivePolicyVersion !== configPointer.effectivePolicyVersion ||
    grant.policyRevisionId !== revision.id ||
    grant.effectivePolicyVersion !== revision.revision ||
    grant.operation !== AiOperation.embedding ||
    grant.status !== "issued" ||
    grant.issuedAt === null ||
    grant.expiresAt === null ||
    grant.revokedAt !== null ||
    grant.issuedAt.getTime() > at.getTime() ||
    grant.expiresAt.getTime() <= at.getTime() ||
    grant.expiresAt.getTime() <= grant.issuedAt.getTime() ||
    grant.materialPolicyFingerprint !== configPointer.config.policyFingerprint ||
    grant.sourceManifestFingerprint !== generation.manifestFingerprint ||
    grant.scannerFingerprint !== generation.scannerFingerprint ||
    grant.scannerVersion !== generation.scannerVersion ||
    grant.consentVersion !== REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION ||
    grant.sourceCount !== generation.sourceCount ||
    grant.sourceBytes !== generation.decodedTextBytes ||
    grant.issuedBy !== "local:user" ||
    grant.purposeCode !== "repository-material-memory-v1" ||
    !FINGERPRINT_PATTERN.test(grant.grantFingerprint) ||
    grant.sources.length !== generation.sourceCount
  ) {
    return fail("REPOSITORY_MATERIAL_INDEX_GRANT_INELIGIBLE");
  }
  if (grant.grantFingerprint !== expectedGrantFingerprint({
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    projectId,
    projectRepositoryLinkId,
    policyRevisionId: revision.id,
    effectivePolicyVersion: revision.revision,
    linkConfigVersion: configPointer.configVersion,
    linkEffectivePolicyVersion: configPointer.effectivePolicyVersion,
    repositoryMaterialGenerationId: generation.id,
    materialPolicyFingerprint: configPointer.config.policyFingerprint,
    sourceManifestFingerprint: generation.manifestFingerprint,
    scannerFingerprint: generation.scannerFingerprint,
    profileFingerprint: grant.profileFingerprint,
    providerFingerprint: grant.providerFingerprint,
    modelFingerprint: grant.modelFingerprint,
    processorFingerprint: grant.processorFingerprint,
    endpointFingerprint: grant.endpointFingerprint,
  })) {
    return fail("REPOSITORY_MATERIAL_INDEX_GRANT_INELIGIBLE");
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
    return fail("REPOSITORY_MATERIAL_INDEX_GRANT_INELIGIBLE");
  }

  const grantSourceByEntry = new Map(
    grant.sources.map((source) => [source.materialGenerationEntryId, source]),
  );
  if (grantSourceByEntry.size !== generation.entries.length) {
    return fail("REPOSITORY_MATERIAL_INDEX_GRANT_INELIGIBLE");
  }
  let decodedTextBytes = 0;
  const sources = generation.entries.map((entry, sourceOrdinal) => {
    const sourceVersion = entry.sourceVersion;
    const source = sourceVersion.projectSource;
    const grantSource = grantSourceByEntry.get(entry.id);
    const contentBytes = Buffer.byteLength(source.contentText, "utf8");
    if (
      entry.ordinal !== sourceOrdinal ||
      grantSource === undefined ||
      grantSource.projectId !== projectId ||
      grantSource.projectRepositoryLinkId !== projectRepositoryLinkId ||
      grantSource.repositoryMaterialGenerationId !== generation.id ||
      grantSource.githubSourceVersionId !== entry.githubSourceVersionId ||
      grantSource.projectSourceId !== entry.projectSourceId ||
      grantSource.originScope !== "repository_link" ||
      grantSource.sourceRevisionKey !== source.revisionKey ||
      grantSource.sourceContentHash !== entry.sourceContentHash ||
      grantSource.contentBytes !== entry.sourceContentBytes ||
      sourceVersion.projectId !== projectId ||
      sourceVersion.projectRepositoryLinkId !== projectRepositoryLinkId ||
      sourceVersion.projectSourceId !== entry.projectSourceId ||
      sourceVersion.sourceRevisionKey !== source.revisionKey ||
      sourceVersion.sourceContentHash !== entry.sourceContentHash ||
      sourceVersion.sourceContentBytes !== entry.sourceContentBytes ||
      sourceVersion.capturedFullName !== generation.capturedFullName ||
      sourceVersion.observedHeadCommitSha !== generation.observedHeadCommitSha ||
      source.originScope !== "repository_link" ||
      source.projectRepositoryLinkId !== projectRepositoryLinkId ||
      source.contentHash !== entry.sourceContentHash ||
      hashSourceContent(source.contentText) !== entry.sourceContentHash ||
      contentBytes !== entry.sourceContentBytes ||
      entry.sourceContentBytes < 1
    ) {
      return fail("REPOSITORY_MATERIAL_INDEX_MATERIAL_NOT_READY");
    }
    decodedTextBytes += contentBytes;
    return frozen({
      grantSourceId: grantSource.id,
      materialGenerationEntryId: entry.id,
      githubSourceVersionId: entry.githubSourceVersionId,
      projectSourceId: entry.projectSourceId,
      sourceRevisionKey: source.revisionKey,
      sourceContentHash: entry.sourceContentHash,
      sourceContentBytes: contentBytes,
      sourceOrdinal,
      materialKind: entry.materialKind,
      contentText: source.contentText,
    });
  });
  if (decodedTextBytes !== generation.decodedTextBytes) {
    return fail("REPOSITORY_MATERIAL_INDEX_MATERIAL_NOT_READY");
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
      scannerFingerprint: grant.scannerFingerprint,
      scannerVersion: grant.scannerVersion,
    }),
    boundary: frozen({
      projectRepositoryLinkId,
      repositoryMaterialGenerationId: generation.id,
      linkConfigVersion: configPointer.configVersion,
      linkEffectivePolicyVersion: configPointer.effectivePolicyVersion,
      expectedActiveIndexGenerationId:
        link.materialIndexPointer?.indexGenerationId ?? null,
      materialPolicyFingerprint: configPointer.config.policyFingerprint,
      manifestFingerprint: generation.manifestFingerprint,
      scannerVersion: generation.scannerVersion,
      scannerFingerprint: generation.scannerFingerprint,
      capturedFullName: generation.capturedFullName,
      observedHeadCommitSha: generation.observedHeadCommitSha,
      sourceCount: generation.sourceCount,
      decodedTextBytes: generation.decodedTextBytes,
    }),
    sources: Object.freeze(sources),
  });
}

export function createRepositoryMaterialIndexService(options: {
  db: PrismaClient;
  idFactory?: () => string;
  now?: () => Date;
  transactionRetryLimit?: number;
}): {
  prepareRepositoryMaterialIndex(input: Readonly<{
    projectId: string;
    projectRepositoryLinkId: string;
    grantId: string;
  }>): Promise<RepositoryMaterialIndexView>;
  executeRepositoryMaterialIndex(
    input: Readonly<{
      projectId: string;
      projectRepositoryLinkId: string;
      indexGenerationId: string;
    }>,
    credential: OpenAiCredentialHandle,
    transportOptions?: ExecuteOpenAiEmbeddingsOptions,
  ): Promise<RepositoryMaterialIndexExecutionResult>;
} {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function"
  ) {
    return fail("REPOSITORY_MATERIAL_INDEX_INVALID_INPUT");
  }
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const retryLimit = options.transactionRetryLimit ?? DEFAULT_RETRY_LIMIT;
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 1 || retryLimit > 5) {
    return fail("REPOSITORY_MATERIAL_INDEX_INVALID_INPUT");
  }

  function currentTime(): Date {
    const value = now();
    if (!validDate(value)) {
      return fail("REPOSITORY_MATERIAL_INDEX_INVALID_INPUT");
    }
    return value;
  }

  async function eligibleSnapshot(
    projectId: string,
    projectRepositoryLinkId: string,
    grantId: string,
  ): Promise<EligibleMaterialSnapshot> {
    return options.db.$transaction(
      (tx) => readEligibleMaterialEmbeddingGrant(
        tx,
        projectId,
        projectRepositoryLinkId,
        grantId,
        currentTime(),
      ),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async function claimIndexBuild(
    projectId: string,
    projectRepositoryLinkId: string,
    indexGenerationId: string,
  ): Promise<
    | ClaimedMaterialIndex
    | Readonly<{ kind: "ready"; index: RepositoryMaterialIndexView }>
  > {
    return options.db.$transaction(async (tx) => {
      const initial = await tx.repositoryMaterialIndexGeneration.findUnique({
        where: { projectId_id: { projectId, id: indexGenerationId } },
        include: {
          materialGeneration: {
            select: { capturedFullName: true, observedHeadCommitSha: true },
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
        if (project === null) {
          return fail("REPOSITORY_MATERIAL_INDEX_PROJECT_NOT_FOUND");
        }
        const link = await tx.projectRepositoryLink.findUnique({
          where: { projectId_id: { projectId, id: projectRepositoryLinkId } },
          select: { id: true },
        });
        return fail(link === null
          ? "REPOSITORY_MATERIAL_INDEX_LINK_NOT_FOUND"
          : "REPOSITORY_MATERIAL_INDEX_INDEX_NOT_FOUND");
      }
      if (initial.projectRepositoryLinkId !== projectRepositoryLinkId) {
        return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
      }
      if (initial.status === "ragReady") {
        return frozen({ kind: "ready" as const, index: toIndexView(initial) });
      }
      if (initial.status === "unknown") {
        return fail("REPOSITORY_MATERIAL_INDEX_RECONCILIATION_REQUIRED");
      }
      if (["failed", "cancelled", "ineligible", "superseded"].includes(initial.status)) {
        return fail("REPOSITORY_MATERIAL_INDEX_BUILD_TERMINAL");
      }
      if (
        initial.status !== "building" ||
        initial.expectedInputCount <= 0 ||
        initial.indexedInputCount !== 0
      ) {
        return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
      }

      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "RepositoryMaterialIndexGeneration"
        WHERE "projectId" = ${projectId}::uuid
          AND "projectRepositoryLinkId" = ${projectRepositoryLinkId}::uuid
          AND "id" = ${indexGenerationId}::uuid
        FOR UPDATE
      `);
      const snapshot = await readEligibleMaterialEmbeddingGrant(
        tx,
        projectId,
        projectRepositoryLinkId,
        initial.grantId,
        currentTime(),
      );
      const plan = buildIndexPlan(projectId, snapshot);
      if (
        snapshot.grant.policyRevisionId !== initial.policyRevisionId ||
        initial.embeddingProfileId !== EMBEDDING_STORAGE_PROFILE_ID ||
        initial.repositoryMaterialGenerationId !==
          snapshot.boundary.repositoryMaterialGenerationId ||
        initial.linkConfigVersion !== snapshot.boundary.linkConfigVersion ||
        initial.effectivePolicyVersion !==
          snapshot.boundary.linkEffectivePolicyVersion ||
        initial.chunkerVersion !== SOURCE_CHUNKER_VERSION ||
        initial.generationKey !== plan.generationKey ||
        initial.inputManifestFingerprint !== plan.inputManifestFingerprint ||
        initial.processingBoundaryFingerprint !==
          plan.processingBoundaryFingerprint ||
        initial.expectedInputCount !== plan.inputs.length
      ) {
        return fail("REPOSITORY_MATERIAL_INDEX_GRANT_INELIGIBLE");
      }
      const attempt = initial.attempts[0];
      if (attempt === undefined) {
        return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
      }
      if (attempt.status === "running" || attempt.status === "unknown") {
        return fail("REPOSITORY_MATERIAL_INDEX_RECONCILIATION_REQUIRED");
      }
      if (attempt.status !== "queued") {
        return fail("REPOSITORY_MATERIAL_INDEX_BUILD_TERMINAL");
      }
      if (attempt.expectedInputCount !== initial.expectedInputCount) {
        return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
      }

      const inputs = await tx.repositoryMaterialIndexInput.findMany({
        where: { projectId, projectRepositoryLinkId, indexGenerationId },
        orderBy: { ordinal: "asc" },
        include: { sourceChunk: true },
      });
      if (
        inputs.length !== plan.inputs.length ||
        inputs.some((input, ordinal) => {
          const expectedInput = plan.inputs[ordinal];
          const expectedChunk = plan.chunks[ordinal];
          return expectedInput === undefined ||
            expectedChunk === undefined ||
            input.id !== expectedInput.id ||
            input.ordinal !== ordinal ||
            input.grantId !== initial.grantId ||
            input.grantSourceId !== expectedInput.grantSourceId ||
            input.repositoryMaterialGenerationId !==
              initial.repositoryMaterialGenerationId ||
            input.materialGenerationEntryId !==
              expectedInput.materialGenerationEntryId ||
            input.projectSourceId !== expectedInput.projectSourceId ||
            input.sourceChunkId !== expectedInput.sourceChunkId ||
            input.contentHash !== expectedInput.contentHash ||
            input.contentBytes !== expectedInput.contentBytes ||
            input.sourceChunk.projectRepositoryLinkId !== projectRepositoryLinkId ||
            input.sourceChunk.repositoryMaterialGenerationId !==
              initial.repositoryMaterialGenerationId ||
            input.sourceChunk.materialGenerationEntryId !==
              expectedChunk.materialGenerationEntryId ||
            input.sourceChunk.projectSourceId !== expectedChunk.projectSourceId ||
            input.sourceChunk.ordinal !== expectedChunk.chunkOrdinal ||
            input.sourceChunk.rangeStart !== expectedChunk.rangeStart ||
            input.sourceChunk.rangeEnd !== expectedChunk.rangeEnd ||
            input.sourceChunk.chunkerVersion !== SOURCE_CHUNKER_VERSION ||
            input.sourceChunk.contentText !== expectedChunk.contentText ||
            input.sourceChunk.contentHash !== expectedChunk.contentHash ||
            input.sourceChunk.contentBytes !== expectedChunk.contentBytes ||
            hashSourceContent(input.sourceChunk.contentText) !== input.contentHash;
        })
      ) {
        return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
      }

      const claimedAt = currentTime();
      const claimedAttempt =
        await tx.repositoryMaterialIndexAttempt.updateMany({
          where: {
            projectId,
            projectRepositoryLinkId,
            indexGenerationId,
            id: attempt.id,
            status: "queued",
          },
          data: { status: "running", startedAt: claimedAt },
        });
      if (claimedAttempt.count !== 1) {
        return fail("REPOSITORY_MATERIAL_INDEX_RECONCILIATION_REQUIRED");
      }
      return frozen({
        kind: "claimed" as const,
        projectId,
        projectRepositoryLinkId,
        indexGenerationId,
        repositoryMaterialGenerationId: initial.repositoryMaterialGenerationId,
        linkConfigVersion: initial.linkConfigVersion,
        linkEffectivePolicyVersion: initial.effectivePolicyVersion,
        grantId: initial.grantId,
        policyRevisionId: initial.policyRevisionId,
        aiEffectivePolicyVersion: snapshot.grant.aiEffectivePolicyVersion,
        processingBoundaryFingerprint: plan.processingBoundaryFingerprint,
        attemptId: attempt.id,
        attemptOperationKey: attempt.operationKey,
        expectedInputCount: initial.expectedInputCount,
        inputs: Object.freeze(inputs.map((input) => frozen({
          id: input.id,
          sourceChunkId: input.sourceChunkId,
          contentText: input.sourceChunk.contentText,
          contentHash: input.contentHash,
          contentBytes: input.contentBytes,
        }))),
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async function closeIndexBuild(
    claim: ClaimedMaterialIndex,
    status: "failed" | "unknown" | "cancelled",
    safeCode: string,
    values: {
      requestCount: number;
      inputTokens: number;
      providerRequestId: string | null;
      sentAt: Date | null;
    },
  ): Promise<RepositoryMaterialIndexExecutionResult> {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(safeCode)) {
      safeCode = "AI_PROVIDER_UNKNOWN";
      status = "unknown";
    }
    const completedAt = currentTime();
    return options.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
        SELECT "status"::text AS "status"
        FROM "RepositoryMaterialIndexGeneration"
        WHERE "projectId" = ${claim.projectId}::uuid
          AND "projectRepositoryLinkId" = ${claim.projectRepositoryLinkId}::uuid
          AND "id" = ${claim.indexGenerationId}::uuid
        FOR UPDATE
      `);
      if (locked.length !== 1) {
        return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
      }
      const attempt = await tx.repositoryMaterialIndexAttempt.findUnique({
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
        return fail("REPOSITORY_MATERIAL_INDEX_RECONCILIATION_REQUIRED");
      }
      await tx.repositoryMaterialIndexAttempt.update({
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
      await tx.repositoryMaterialIndexGeneration.update({
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
    claim: ClaimedMaterialIndex,
    batches: readonly CompletedEmbeddingBatch[],
    sentAt: Date,
  ): Promise<RepositoryMaterialIndexExecutionResult> {
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
          FROM "RepositoryMaterialIndexGeneration"
          WHERE "projectId" = ${claim.projectId}::uuid
            AND "projectRepositoryLinkId" = ${claim.projectRepositoryLinkId}::uuid
            AND "id" = ${claim.indexGenerationId}::uuid
          FOR UPDATE
        `);
        if (locked[0]?.status !== "building") {
          return fail("REPOSITORY_MATERIAL_INDEX_RECONCILIATION_REQUIRED");
        }
        const eligible = await readEligibleMaterialEmbeddingGrant(
          tx,
          claim.projectId,
          claim.projectRepositoryLinkId,
          claim.grantId,
          completedAt,
        );
        const plan = buildIndexPlan(claim.projectId, eligible);
        if (
          eligible.boundary.repositoryMaterialGenerationId !==
            claim.repositoryMaterialGenerationId ||
          eligible.boundary.linkConfigVersion !== claim.linkConfigVersion ||
          eligible.boundary.linkEffectivePolicyVersion !==
            claim.linkEffectivePolicyVersion ||
          eligible.grant.policyRevisionId !== claim.policyRevisionId ||
          eligible.grant.aiEffectivePolicyVersion !==
            claim.aiEffectivePolicyVersion ||
          plan.processingBoundaryFingerprint !==
            claim.processingBoundaryFingerprint ||
          plan.inputs.length !== claim.expectedInputCount
        ) {
          return fail("REPOSITORY_MATERIAL_INDEX_GRANT_INELIGIBLE");
        }
        const attempt = await tx.repositoryMaterialIndexAttempt.findUnique({
          where: { id: claim.attemptId },
          select: { status: true },
        });
        if (attempt?.status !== "running") {
          return fail("REPOSITORY_MATERIAL_INDEX_RECONCILIATION_REQUIRED");
        }
        const inputCount = await tx.repositoryMaterialIndexInput.count({
          where: {
            projectId: claim.projectId,
            projectRepositoryLinkId: claim.projectRepositoryLinkId,
            indexGenerationId: claim.indexGenerationId,
          },
        });
        if (inputCount !== claim.expectedInputCount) {
          return fail("REPOSITORY_MATERIAL_INDEX_RECONCILIATION_REQUIRED");
        }

        for (const input of claim.inputs) {
          const vector = vectorsByInput.get(input.id)!;
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "RepositoryMaterialEmbedding" (
              "id", "projectId", "projectRepositoryLinkId",
              "indexGenerationId", "inputEntryId", "sourceChunkId",
              "embeddingProfileId", "attemptId", "vector",
              "vectorFingerprint"
            ) VALUES (
              ${safeUuid(idFactory())}::uuid,
              ${claim.projectId}::uuid,
              ${claim.projectRepositoryLinkId}::uuid,
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
        await tx.repositoryMaterialIndexAttempt.update({
          where: { id: claim.attemptId },
          data: {
            status: "succeeded",
            requestCount: batches.length,
            inputTokens: batches.reduce(
              (sum, batch) => sum + batch.inputTokens,
              0,
            ),
            providerRequestId: batches.length === 1
              ? batches[0]!.providerRequestId
              : null,
            sentAt,
            completedAt,
          },
        });
        await tx.repositoryMaterialIndexGeneration.update({
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
        await tx.repositoryMaterialIndexPointer.upsert({
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
            repositoryMaterialGenerationId:
              claim.repositoryMaterialGenerationId,
            linkConfigVersion: claim.linkConfigVersion,
            effectivePolicyVersion: claim.linkEffectivePolicyVersion,
            publishedAt: completedAt,
          },
          update: {
            indexGenerationId: claim.indexGenerationId,
            repositoryMaterialGenerationId:
              claim.repositoryMaterialGenerationId,
            linkConfigVersion: claim.linkConfigVersion,
            effectivePolicyVersion: claim.linkEffectivePolicyVersion,
            publishedAt: completedAt,
          },
        });
        const published =
          await tx.repositoryMaterialIndexGeneration.findUniqueOrThrow({
            where: {
              projectId_id: {
                projectId: claim.projectId,
                id: claim.indexGenerationId,
              },
            },
            include: {
              materialGeneration: {
                select: {
                  capturedFullName: true,
                  observedHeadCommitSha: true,
                },
              },
              attempts: {
                orderBy: { attemptNumber: "desc" },
                take: 1,
                select: { id: true, status: true },
              },
            },
          });
        return frozen({
          kind: "published" as const,
          index: toIndexView(published),
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      try {
        return await closeIndexBuild(
          claim,
          "unknown",
          "AI_PROVIDER_UNKNOWN",
          {
            requestCount: batches.length,
            inputTokens: batches.reduce(
              (sum, batch) => sum + batch.inputTokens,
              0,
            ),
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
    async prepareRepositoryMaterialIndex(input) {
      const projectId = safeUuid(input?.projectId);
      const projectRepositoryLinkId = safeUuid(input?.projectRepositoryLinkId);
      const grantId = safeUuid(input?.grantId);
      const initial = await eligibleSnapshot(
        projectId,
        projectRepositoryLinkId,
        grantId,
      );
      const initialPlan = buildIndexPlan(projectId, initial);
      for (
        let offset = 0;
        offset < initialPlan.chunks.length;
        offset += CREATE_BATCH_SIZE
      ) {
        const batch = initialPlan.chunks.slice(
          offset,
          offset + CREATE_BATCH_SIZE,
        );
        await options.db.repositoryMaterialChunk.createMany({
          data: batch.map((chunk) => ({
            id: chunk.sourceChunkId,
            projectId,
            projectRepositoryLinkId,
            repositoryMaterialGenerationId:
              initial.boundary.repositoryMaterialGenerationId,
            materialGenerationEntryId: chunk.materialGenerationEntryId,
            githubSourceVersionId: chunk.githubSourceVersionId,
            projectSourceId: chunk.projectSourceId,
            originScope: "repository_link",
            sourceRevisionKey: chunk.sourceRevisionKey,
            sourceContentHash: chunk.sourceContentHash,
            ordinal: chunk.chunkOrdinal,
            rangeStart: chunk.rangeStart,
            rangeEnd: chunk.rangeEnd,
            chunkerVersion: SOURCE_CHUNKER_VERSION,
            contentText: chunk.contentText,
            contentHash: chunk.contentHash,
            contentBytes: chunk.contentBytes,
          })),
          skipDuplicates: true,
        });
      }

      for (let attempt = 0; attempt < retryLimit; attempt += 1) {
        try {
          return await options.db.$transaction(async (tx) => {
            const snapshot = await readEligibleMaterialEmbeddingGrant(
              tx,
              projectId,
              projectRepositoryLinkId,
              grantId,
              currentTime(),
            );
            if (
              snapshot.boundary.repositoryMaterialGenerationId !==
                initial.boundary.repositoryMaterialGenerationId
            ) {
              return fail("REPOSITORY_MATERIAL_INDEX_LINK_INELIGIBLE");
            }
            const plan = buildIndexPlan(projectId, snapshot);
            const chunkRows = await tx.repositoryMaterialChunk.findMany({
              where: {
                projectId,
                projectRepositoryLinkId,
                id: { in: plan.chunks.map((chunk) => chunk.sourceChunkId) },
              },
            });
            const chunkById = new Map(
              chunkRows.map((chunk) => [chunk.id, chunk]),
            );
            if (
              chunkRows.length !== plan.chunks.length ||
              plan.chunks.some((chunk) => {
                const row = chunkById.get(chunk.sourceChunkId);
                return row === undefined ||
                  row.repositoryMaterialGenerationId !==
                    snapshot.boundary.repositoryMaterialGenerationId ||
                  row.materialGenerationEntryId !==
                    chunk.materialGenerationEntryId ||
                  row.githubSourceVersionId !== chunk.githubSourceVersionId ||
                  row.projectSourceId !== chunk.projectSourceId ||
                  row.originScope !== "repository_link" ||
                  row.sourceRevisionKey !== chunk.sourceRevisionKey ||
                  row.sourceContentHash !== chunk.sourceContentHash ||
                  row.ordinal !== chunk.chunkOrdinal ||
                  row.rangeStart !== chunk.rangeStart ||
                  row.rangeEnd !== chunk.rangeEnd ||
                  row.chunkerVersion !== SOURCE_CHUNKER_VERSION ||
                  row.contentText !== chunk.contentText ||
                  row.contentHash !== chunk.contentHash ||
                  row.contentBytes !== chunk.contentBytes;
              })
            ) {
              return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
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
              return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
            }

            const existing =
              await tx.repositoryMaterialIndexGeneration.findUnique({
                where: {
                  projectId_generationKey: {
                    projectId,
                    generationKey: plan.generationKey,
                  },
                },
                include: {
                  materialGeneration: {
                    select: {
                      capturedFullName: true,
                      observedHeadCommitSha: true,
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
                existing.projectRepositoryLinkId !== projectRepositoryLinkId ||
                existing.repositoryMaterialGenerationId !==
                  snapshot.boundary.repositoryMaterialGenerationId ||
                existing.grantId !== grantId ||
                existing.policyRevisionId !== snapshot.grant.policyRevisionId ||
                existing.embeddingProfileId !== storageProfile.id ||
                existing.inputManifestFingerprint !==
                  plan.inputManifestFingerprint ||
                existing.processingBoundaryFingerprint !==
                  plan.processingBoundaryFingerprint ||
                existing.expectedInputCount !== plan.inputs.length
              ) {
                return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
              }
              if (
                ["failed", "cancelled", "ineligible", "superseded"].includes(
                  existing.status,
                )
              ) {
                return fail("REPOSITORY_MATERIAL_INDEX_BUILD_TERMINAL");
              }
              if (existing.status === "unknown") {
                return fail(
                  "REPOSITORY_MATERIAL_INDEX_RECONCILIATION_REQUIRED",
                );
              }
              return toIndexView(existing);
            }

            const indexGenerationId = safeUuid(idFactory());
            await tx.repositoryMaterialIndexGeneration.create({
              data: {
                id: indexGenerationId,
                projectId,
                projectRepositoryLinkId,
                repositoryMaterialGenerationId:
                  snapshot.boundary.repositoryMaterialGenerationId,
                expectedActiveIndexGenerationId:
                  snapshot.boundary.expectedActiveIndexGenerationId,
                linkConfigVersion: snapshot.boundary.linkConfigVersion,
                grantId,
                policyRevisionId: snapshot.grant.policyRevisionId,
                effectivePolicyVersion:
                  snapshot.boundary.linkEffectivePolicyVersion,
                embeddingProfileId: storageProfile.id,
                status: "staging",
                generationKey: plan.generationKey,
                inputManifestFingerprint: plan.inputManifestFingerprint,
                processingBoundaryFingerprint:
                  plan.processingBoundaryFingerprint,
                chunkerVersion: SOURCE_CHUNKER_VERSION,
                expectedInputCount: plan.inputs.length,
              },
            });
            await tx.repositoryMaterialIndexInput.createMany({
              data: plan.inputs.map((entry) => ({
                id: entry.id,
                projectId,
                projectRepositoryLinkId,
                indexGenerationId,
                grantId,
                grantSourceId: entry.grantSourceId,
                repositoryMaterialGenerationId:
                  snapshot.boundary.repositoryMaterialGenerationId,
                materialGenerationEntryId:
                  entry.materialGenerationEntryId,
                projectSourceId: entry.projectSourceId,
                sourceChunkId: entry.sourceChunkId,
                ordinal: entry.ordinal,
                contentHash: entry.contentHash,
                contentBytes: entry.contentBytes,
              })),
            });
            const startedAt = currentTime();
            await tx.repositoryMaterialIndexGeneration.update({
              where: {
                projectId_id: { projectId, id: indexGenerationId },
              },
              data: { status: "building", buildStartedAt: startedAt },
            });
            const attemptId = safeUuid(idFactory());
            await tx.repositoryMaterialIndexAttempt.create({
              data: {
                id: attemptId,
                projectId,
                projectRepositoryLinkId,
                indexGenerationId,
                grantId,
                attemptNumber: 1,
                operationKey: stableFingerprint(
                  REPOSITORY_MATERIAL_INDEX_VERSION,
                  ["attempt", projectId, plan.generationKey, 1],
                ),
                status: "queued",
                expectedInputCount: plan.inputs.length,
              },
            });
            const created =
              await tx.repositoryMaterialIndexGeneration.findUniqueOrThrow({
                where: {
                  projectId_id: { projectId, id: indexGenerationId },
                },
                include: {
                  materialGeneration: {
                    select: {
                      capturedFullName: true,
                      observedHeadCommitSha: true,
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
          if (error instanceof RepositoryMaterialIndexError) throw error;
          const retryable = isPrismaCode(error, "P2002") ||
            isSerializationFailure(error);
          if (retryable && attempt + 1 < retryLimit) continue;
          if (retryable) {
            return fail("REPOSITORY_MATERIAL_INDEX_WRITE_CONFLICT");
          }
          throw error;
        }
      }
      return fail("REPOSITORY_MATERIAL_INDEX_WRITE_CONFLICT");
    },

    async executeRepositoryMaterialIndex(
      input,
      credential,
      transportOptions = {},
    ) {
      const projectId = safeUuid(input?.projectId);
      const projectRepositoryLinkId = safeUuid(
        input?.projectRepositoryLinkId,
      );
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
        for (
          let batchIndex = 0;
          batchIndex < batches.length;
          batchIndex += 1
        ) {
          const batch = batches[batchIndex]!;
          const calledAt = currentTime();
          const plan = buildOpenAiEmbeddingsTransportPlan(
            getOpenAiEmbeddingProfile(),
            {
              runId: claim.attemptId,
              operationKey: stableFingerprint(
                REPOSITORY_MATERIAL_INDEX_VERSION,
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
          const classification: ProviderClassification =
            classifyProviderResult(result.providerResult);
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
      if (sentAt === null) {
        return fail("REPOSITORY_MATERIAL_INDEX_CONFLICT");
      }
      return publishCompletedIndex(claim, completedBatches, sentAt);
    },
  });
}
