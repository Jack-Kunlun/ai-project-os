import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type AppUser,
  type MemoryRecordScope,
  type PrismaClient,
} from "@prisma/client";
import { invokeEmbeddings } from "@/lib/ai-providers";
import { PROVIDER_REQUEST_TIMEOUT_MS } from "@/lib/ai-providers/transport";
import { chunkSourceText } from "@/lib/ai-memory/chunking";
import { getDb } from "@/lib/db";
import { chunkRepositoryCode } from "@/lib/github";
import {
  getProjectJob as getWorkflowProjectJob,
  isUncertainProviderDispatch,
  markProjectJobUnknown,
  ProjectWorkflowError,
  startProjectJobHeartbeat,
  withProjectJobLock,
  workflowSafeFailureCode,
} from "@/lib/project-workflow";
import {
  assertWebAiConsent,
  auditedProviderCall,
  claimWebAiJob,
  createGrantedWebAiJob,
  failWebAiJob,
  finishWebAiJob,
  manifestFingerprint,
  stableAiCallKey,
  updateWebAiJobProgress,
  type RuntimeRoute,
} from "@/lib/web-ai-governance";

type MemoryIndexDb = PrismaClient | Prisma.TransactionClient;

export const MAX_INDEX_RECORDS = 5_000;
export const MAX_INDEX_TEXT_BYTES = 24 * 1024 * 1024;
export const EMBEDDING_BATCH_SIZE = 16;
export const MEMORY_INDEX_MAX_DURATION_MS = 240_000;
const MEMORY_INDEX_DEADLINE_SAFETY_MS = 2_000;
/**
 * A plan must budget every embedding batch for the transport's full request
 * timeout plus bounded local credential/audit overhead.
 */
export const MEMORY_INDEX_ESTIMATED_CALL_MS = PROVIDER_REQUEST_TIMEOUT_MS + 2_000;
const MEMORY_INDEX_CHUNKER_VERSION = "memory-index-chunker:v1";
const MEMORY_INDEX_PLAN_VERSION = "memory-index-plan:v1";
const MEMORY_INDEX_LOCK_NAMESPACE = 29082026;

export function isMemoryIndexDeadlineEligible(estimatedProviderCalls: number): boolean {
  return Number.isSafeInteger(estimatedProviderCalls) && estimatedProviderCalls >= 0 &&
    estimatedProviderCalls * MEMORY_INDEX_ESTIMATED_CALL_MS + MEMORY_INDEX_DEADLINE_SAFETY_MS <
    MEMORY_INDEX_MAX_DURATION_MS;
}

export type WebMemoryIndexErrorCode =
  | "MEMORY_INDEX_EMPTY"
  | "MEMORY_INDEX_TOO_LARGE"
  | "MEMORY_INDEX_INPUT_INVALID"
  | "MEMORY_INDEX_ROUTE_MISSING"
  | "MEMORY_INDEX_PROVIDER_UNAVAILABLE"
  | "MEMORY_INDEX_INCREMENTAL_BASELINE_REQUIRED"
  | "MEMORY_INDEX_PLAN_STALE"
  | "MEMORY_INDEX_DEADLINE_EXCEEDED"
  | "MEMORY_INDEX_ALREADY_RUNNING"
  | "MEMORY_INDEX_RECONCILIATION_REQUIRED"
  | "MEMORY_INDEX_PUBLICATION_CONFLICT";

export class WebMemoryIndexError extends Error {
  constructor(readonly code: WebMemoryIndexErrorCode) {
    super(code);
    this.name = "WebMemoryIndexError";
  }
}

export type MemoryIndexReadinessState =
  | "routeMissing"
  | "providerUnavailable"
  | "indexMissing"
  | "legacyIndex"
  | "routeIncompatible"
  | "inputsChanged"
  | "ready";

export type MemoryIntelligenceReadinessState = MemoryIndexReadinessState | "generationProviderUnavailable";

export type MemoryIndexReadiness = Readonly<{
  state: MemoryIntelligenceReadinessState;
  indexCompatible: boolean;
  inputManifestCurrent: boolean;
  ready: boolean;
}>;

export function resolveMemoryIndexReadiness(input: Readonly<{
  embeddingRoute: Readonly<{
    providerConnectionId: string;
    modelId: string;
    embeddingDimensions: number | null;
    providerVerified: boolean;
  }> | null;
  activeIndex: Readonly<{
    providerConnectionId: string;
    modelId: string;
    dimensions: number;
    inputManifestFingerprint: string;
    legacy?: boolean;
    status?: "staging" | "building" | "complete" | "failed" | "unknown" | "superseded";
  }> | null;
  currentInputManifestFingerprint: string | null;
  generationProviderVerified?: boolean;
}>): MemoryIndexReadiness {
  const routeAvailable = input.embeddingRoute !== null;
  const providerAvailable = routeAvailable && input.embeddingRoute.providerVerified;
  const indexAvailable = input.activeIndex !== null &&
    (input.activeIndex.status === undefined || input.activeIndex.status === "complete");
  const legacyIndex = indexAvailable && input.activeIndex?.legacy === true;
  const routeCompatible = routeAvailable && indexAvailable && providerAvailable &&
    input.embeddingRoute.providerConnectionId === input.activeIndex?.providerConnectionId &&
    input.embeddingRoute.modelId === input.activeIndex?.modelId &&
    input.embeddingRoute.embeddingDimensions === input.activeIndex?.dimensions;
  const inputManifestCurrent = indexAvailable && input.currentInputManifestFingerprint !== null &&
    input.currentInputManifestFingerprint === input.activeIndex?.inputManifestFingerprint;
  const baseState: MemoryIndexReadinessState = !routeAvailable
    ? "routeMissing"
    : !providerAvailable
      ? "providerUnavailable"
      : !indexAvailable
        ? "indexMissing"
        : legacyIndex
          ? "legacyIndex"
        : !routeCompatible
          ? "routeIncompatible"
          : !inputManifestCurrent
            ? "inputsChanged"
            : "ready";
  const state: MemoryIntelligenceReadinessState = baseState === "ready" && input.generationProviderVerified === false
    ? "generationProviderUnavailable"
    : baseState;
  return Object.freeze({
    state,
    indexCompatible: baseState === "ready",
    inputManifestCurrent,
    ready: state === "ready",
  });
}

export type MemoryIndexPublicationSnapshot = Readonly<{
  expectedActiveIndexGenerationId: string | null;
  currentActiveIndexGenerationId: string | null;
  expectedRoute: Readonly<{
    providerConnectionId: string;
    modelId: string;
    embeddingDimensions: number | null;
    updatedAt?: Date | string | null;
  }>;
  currentRoute: Readonly<{
    providerConnectionId: string;
    modelId: string;
    embeddingDimensions: number | null;
    providerVerified: boolean;
    updatedAt?: Date | string | null;
  }> | null;
  expectedInputManifestFingerprint: string;
  currentInputManifestFingerprint: string | null;
}>;

function datesEqual(left: Date | string | null | undefined, right: Date | string | null | undefined): boolean {
  if (left === undefined || left === null || right === undefined || right === null) return left === right;
  return new Date(left).getTime() === new Date(right).getTime();
}

export function isMemoryIndexPublicationCurrent(input: MemoryIndexPublicationSnapshot): boolean {
  const expectedUpdatedAt = input.expectedRoute.updatedAt;
  const currentUpdatedAt = input.currentRoute?.updatedAt;
  return input.currentActiveIndexGenerationId === input.expectedActiveIndexGenerationId &&
    input.currentRoute !== null &&
    input.currentRoute.providerVerified &&
    input.currentRoute.providerConnectionId === input.expectedRoute.providerConnectionId &&
    input.currentRoute.modelId === input.expectedRoute.modelId &&
    input.currentRoute.embeddingDimensions === input.expectedRoute.embeddingDimensions &&
    (expectedUpdatedAt === undefined || datesEqual(expectedUpdatedAt, currentUpdatedAt)) &&
    input.currentInputManifestFingerprint === input.expectedInputManifestFingerprint;
}

export type IndexInput = Readonly<{
  id: string;
  scope: MemoryRecordScope;
  projectSourceId: string | null;
  projectRepositoryLinkId: string | null;
  frozenCommitSha: string | null;
  path: string | null;
  externalRef: string | null;
  rangeStart: number;
  rangeEnd: number;
  contentText: string;
  contentHash: string;
}>;

function fail(code: WebMemoryIndexErrorCode): never {
  throw new WebMemoryIndexError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCanonical(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function canonicalInputValue(record: IndexInput): Record<string, unknown> {
  return {
    scope: record.scope,
    projectSourceId: record.projectSourceId,
    projectRepositoryLinkId: record.projectRepositoryLinkId,
    frozenCommitSha: record.frozenCommitSha,
    path: record.path,
    externalRef: record.externalRef,
    rangeStart: record.rangeStart,
    rangeEnd: record.rangeEnd,
    contentHash: record.contentHash,
    contentTextHash: sha256(record.contentText),
  };
}

export function memoryInputFingerprint(record: IndexInput): string {
  return manifestFingerprint({ version: "memory-input:v1", ...canonicalInputValue(record) });
}

export function memoryEmbeddingFingerprint(record: IndexInput): string {
  return manifestFingerprint({
    version: "memory-embedding-input:v1",
    chunkerVersion: MEMORY_INDEX_CHUNKER_VERSION,
    contentHash: record.contentHash,
    contentTextHash: sha256(record.contentText),
  });
}

/**
 * Keep the provider worklist independent from the order of reused records.
 * Plans and execution both use this helper so sparse reuse cannot create one
 * provider request per interleaved generated record.
 */
export function buildMemoryIndexEmbeddingWorklist(
  records: readonly IndexInput[],
  reuseByInputFingerprint: ReadonlyMap<string, unknown>,
): readonly IndexInput[] {
  return Object.freeze(records.filter((record) => !reuseByInputFingerprint.has(memoryInputFingerprint(record))));
}

export function estimateMemoryIndexProviderCalls(generateCount: number): number {
  if (!Number.isSafeInteger(generateCount) || generateCount < 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(generateCount / EMBEDDING_BATCH_SIZE);
}

function ensureBudget(records: readonly IndexInput[]): void {
  if (records.length === 0) return fail("MEMORY_INDEX_EMPTY");
  const bytes = records.reduce((total, record) => total + Buffer.byteLength(record.contentText, "utf8"), 0);
  if (records.length > MAX_INDEX_RECORDS || bytes > MAX_INDEX_TEXT_BYTES) {
    return fail("MEMORY_INDEX_TOO_LARGE");
  }
}

export function inputManifest(records: readonly IndexInput[]): string {
  const entries = records
    .map((record) => canonicalInputValue(record))
    .sort((left, right) => compareCanonical(JSON.stringify(left), JSON.stringify(right)));
  return manifestFingerprint({ version: "memory-input-manifest:v1", entries });
}

export function planFingerprint(input: Readonly<{
  mode: "full" | "incremental";
  route: Readonly<{ providerConnectionId: string; modelId: string; embeddingDimensions: number }>;
  routeUpdatedAt: Date | string;
  inputManifestFingerprint: string;
  expectedInputCount: number;
  generateCount: number;
  reuseCount: number;
  deleteCount: number;
  baselineGenerationId: string | null;
  baselineManifestFingerprint: string | null;
  reusedInputFingerprints: readonly string[];
}>): string {
  return manifestFingerprint({
    version: MEMORY_INDEX_PLAN_VERSION,
    mode: input.mode,
    route: {
      providerConnectionId: input.route.providerConnectionId,
      modelId: input.route.modelId,
      dimensions: input.route.embeddingDimensions,
      updatedAt: new Date(input.routeUpdatedAt).toISOString(),
    },
    inputManifestFingerprint: input.inputManifestFingerprint,
    expectedInputCount: input.expectedInputCount,
    generateCount: input.generateCount,
    reuseCount: input.reuseCount,
    deleteCount: input.deleteCount,
    baselineGenerationId: input.baselineGenerationId,
    baselineManifestFingerprint: input.baselineManifestFingerprint,
    reusedInputFingerprints: [...input.reusedInputFingerprints].sort(compareCanonical),
  });
}

export type MemoryIndexPlan = Readonly<{
  planFingerprint: string;
  mode: "full" | "incremental";
  providerConnectionId: string;
  providerName: string;
  providerKind: string;
  modelId: string;
  dimensions: number;
  routeUpdatedAt: string;
  currentInputManifestFingerprint: string;
  expectedInputCount: number;
  reuseCount: number;
  generateCount: number;
  deleteCount: number;
  baselineGenerationId: string | null;
  baselineManifestFingerprint: string | null;
  estimatedProviderCalls: number;
  deadlineAt: string;
  deadlineEligible: boolean;
  ineligibleCode: "MEMORY_INDEX_INCREMENTAL_BASELINE_REQUIRED" | "MEMORY_INDEX_DEADLINE_EXCEEDED" | null;
}>;

export type MemoryIndexReconciliationOutcome = "publishedLocally" | "explicitAbandon";

export function resolveMemoryIndexReconciliationOutcome(input: Readonly<{
  jobStatus: "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
  jobReconciliationRequired: boolean;
  generationStatus: "staging" | "building" | "complete" | "failed" | "unknown" | "superseded";
  generationReconciliationRequired: boolean;
  generationId: string;
  pointerGenerationId: string | null;
}>): MemoryIndexReconciliationOutcome | null {
  if (input.jobStatus !== "unknown" || !input.jobReconciliationRequired) return null;
  if (input.generationStatus === "complete" && input.pointerGenerationId === input.generationId) {
    return "publishedLocally";
  }
  // A complete candidate that is not the active pointer cannot be rewritten
  // safely. Record the local abandonment evidence and release only the job;
  // the terminal candidate itself remains immutable.
  if (input.generationStatus === "complete") return "explicitAbandon";
  if (input.generationStatus === "unknown" && input.generationReconciliationRequired) {
    return "explicitAbandon";
  }
  return null;
}

type BaselineRecord = Readonly<{
  id: string;
  inputFingerprint: string | null;
  embeddingFingerprint: string | null;
  embedding: number[];
}>;

type MemoryIndexPlanSnapshot = MemoryIndexPlan & Readonly<{
  route: RuntimeRoute;
  records: readonly IndexInput[];
  baselineRecords: readonly BaselineRecord[];
  reuseByInputFingerprint: ReadonlyMap<string, BaselineRecord>;
  deadlineAtDate: Date;
}>;

/**
 * Convert an internal plan snapshot into the only shape allowed across the
 * plan API boundary. The runtime snapshot deliberately contains source text,
 * vectors, the selected route, and a reuse Map; none of those belong in JSON.
 */
export function toPublicMemoryIndexPlan(snapshot: MemoryIndexPlanSnapshot): MemoryIndexPlan {
  return Object.freeze({
    planFingerprint: snapshot.planFingerprint,
    mode: snapshot.mode,
    providerConnectionId: snapshot.providerConnectionId,
    providerName: snapshot.providerName,
    providerKind: snapshot.providerKind,
    modelId: snapshot.modelId,
    dimensions: snapshot.dimensions,
    routeUpdatedAt: snapshot.routeUpdatedAt,
    currentInputManifestFingerprint: snapshot.currentInputManifestFingerprint,
    expectedInputCount: snapshot.expectedInputCount,
    reuseCount: snapshot.reuseCount,
    generateCount: snapshot.generateCount,
    deleteCount: snapshot.deleteCount,
    baselineGenerationId: snapshot.baselineGenerationId,
    baselineManifestFingerprint: snapshot.baselineManifestFingerprint,
    estimatedProviderCalls: snapshot.estimatedProviderCalls,
    deadlineAt: snapshot.deadlineAt,
    deadlineEligible: snapshot.deadlineEligible,
    ineligibleCode: snapshot.ineligibleCode,
  });
}

export async function collectProjectMemoryInputs(
  projectId: string,
  db: MemoryIndexDb = getDb(),
): Promise<readonly IndexInput[]> {
  const [manualSources, materialPointers, codePointer] = await Promise.all([
    db.projectSource.findMany({
      where: { projectId, originScope: "project", retiredAt: null },
      orderBy: { id: "asc" },
      select: {
        id: true,
        externalRef: true,
        contentText: true,
        assetSegment: { select: { locatorLabel: true } },
      },
    }),
    db.repositoryMaterialGenerationPointer.findMany({
      where: { projectId },
      orderBy: { projectRepositoryLinkId: "asc" },
      select: {
        projectRepositoryLinkId: true,
        generation: {
          select: {
            observedHeadCommitSha: true,
            entries: {
              orderBy: { ordinal: "asc" },
              select: {
                sourceVersion: {
                  select: {
                    normalizedPath: true,
                    projectSource: { select: { id: true, externalRef: true, contentText: true } },
                  },
                },
              },
            },
          },
        },
      },
    }),
    db.projectCodeSnapshotPointer.findUnique({
      where: { projectId },
      select: {
        snapshot: {
          select: {
            entries: {
              orderBy: { projectRepositoryLinkId: "asc" },
              select: {
                projectRepositoryLinkId: true,
                frozenCommitSha: true,
                generation: {
                  select: {
                    capturedFullName: true,
                    entries: {
                      orderBy: { ordinal: "asc" },
                      select: {
                        normalizedPath: true,
                        fileRevision: { select: { contentText: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const records: IndexInput[] = [];
  for (const source of manualSources) {
    for (const chunk of chunkSourceText(source.contentText)) {
      records.push(Object.freeze({
        id: randomUUID(),
        scope: "projectSource",
        projectSourceId: source.id,
        projectRepositoryLinkId: null,
        frozenCommitSha: null,
        path: source.assetSegment?.locatorLabel ?? null,
        externalRef: source.externalRef,
        rangeStart: chunk.rangeStart,
        rangeEnd: chunk.rangeEnd,
        contentText: chunk.contentText,
        contentHash: chunk.contentHash,
      }));
    }
  }

  for (const pointer of materialPointers) {
    for (const entry of pointer.generation.entries) {
      const source = entry.sourceVersion.projectSource;
      for (const chunk of chunkSourceText(source.contentText)) {
        records.push(Object.freeze({
          id: randomUUID(),
          scope: "repositoryMaterial",
          projectSourceId: source.id,
          projectRepositoryLinkId: pointer.projectRepositoryLinkId,
          frozenCommitSha: pointer.generation.observedHeadCommitSha,
          path: entry.sourceVersion.normalizedPath,
          externalRef: source.externalRef,
          rangeStart: chunk.rangeStart,
          rangeEnd: chunk.rangeEnd,
          contentText: chunk.contentText,
          contentHash: chunk.contentHash,
        }));
      }
    }
  }

  for (const snapshotEntry of codePointer?.snapshot.entries ?? []) {
    for (const entry of snapshotEntry.generation.entries) {
      for (const chunk of chunkRepositoryCode(entry.fileRevision.contentText)) {
        records.push(Object.freeze({
          id: randomUUID(),
          scope: "repositoryCode",
          projectSourceId: null,
          projectRepositoryLinkId: snapshotEntry.projectRepositoryLinkId,
          frozenCommitSha: snapshotEntry.frozenCommitSha,
          path: entry.normalizedPath,
          externalRef: `github://${snapshotEntry.generation.capturedFullName}/${entry.normalizedPath}@${snapshotEntry.frozenCommitSha}`,
          rangeStart: chunk.rangeStart,
          rangeEnd: chunk.rangeEnd,
          contentText: chunk.contentText,
          contentHash: chunk.contentHash,
        }));
      }
    }
  }

  records.sort((left, right) =>
    compareCanonical(left.scope, right.scope) ||
    compareCanonical(left.projectRepositoryLinkId ?? "", right.projectRepositoryLinkId ?? "") ||
    compareCanonical(left.projectSourceId ?? "", right.projectSourceId ?? "") ||
    compareCanonical(left.externalRef ?? "", right.externalRef ?? "") ||
    compareCanonical(left.path ?? "", right.path ?? "") ||
    left.rangeStart - right.rangeStart ||
    left.rangeEnd - right.rangeEnd,
  );
  ensureBudget(records);
  return Object.freeze(records);
}

export async function getProjectMemoryInputManifest(
  projectId: string,
  db: MemoryIndexDb = getDb(),
): Promise<string | null> {
  try {
    return inputManifest(await collectProjectMemoryInputs(projectId, db));
  } catch (error) {
    if (
      error instanceof WebMemoryIndexError &&
      (error.code === "MEMORY_INDEX_EMPTY" || error.code === "MEMORY_INDEX_TOO_LARGE")
    ) return null;
    throw error;
  }
}

async function readEmbeddingRoute(projectId: string, db: MemoryIndexDb): Promise<RuntimeRoute> {
  const route = await db.projectAiRoute.findUnique({
    where: { projectId_operation: { projectId, operation: "embedding" } },
    include: { providerConnection: true },
  });
  if (route === null) return fail("MEMORY_INDEX_ROUTE_MISSING");
  if (route.providerConnection.status !== "verified") return fail("MEMORY_INDEX_PROVIDER_UNAVAILABLE");
  if (route.embeddingDimensions === null) return fail("MEMORY_INDEX_INPUT_INVALID");
  return route;
}

async function buildMemoryIndexPlan(
  projectId: string,
  mode: "full" | "incremental",
  db: MemoryIndexDb,
): Promise<MemoryIndexPlanSnapshot> {
  const route = await readEmbeddingRoute(projectId, db);
  const dimensions = route.embeddingDimensions;
  if (dimensions === null) return fail("MEMORY_INDEX_INPUT_INVALID");
  const records = await collectProjectMemoryInputs(projectId, db);
  const currentManifest = inputManifest(records);
  const currentInputFingerprints = records.map(memoryInputFingerprint);
  const currentFingerprints = new Set(currentInputFingerprints);
  if (currentFingerprints.size !== records.length) return fail("MEMORY_INDEX_INPUT_INVALID");
  const pointer = await db.memoryIndexPointer.findUnique({
    where: { projectId },
    select: {
      indexGenerationId: true,
      generation: {
        select: {
          id: true,
          status: true,
          providerConnectionId: true,
          modelId: true,
          dimensions: true,
          inputManifestFingerprint: true,
          expectedEmbeddingRouteUpdatedAt: true,
          records: {
            select: { id: true, inputFingerprint: true, embeddingFingerprint: true, embedding: true },
          },
        },
      },
    },
  });
  const baseline = pointer?.generation.status === "complete" ? pointer.generation : null;
  const baselineRecords = baseline?.records ?? [];
  const baselineCompatible = baseline !== null &&
    baseline.expectedEmbeddingRouteUpdatedAt !== null &&
    baseline.expectedEmbeddingRouteUpdatedAt.getTime() === route.updatedAt.getTime() &&
    baseline.providerConnectionId === route.providerConnectionId &&
    baseline.modelId === route.modelId &&
    baseline.dimensions === dimensions &&
    baselineRecords.every((record) => record.embedding.length === dimensions && record.embedding.every((value) => Number.isFinite(value))) &&
    baselineRecords.length === baselineRecords.filter((record) =>
      record.inputFingerprint !== null && record.embeddingFingerprint !== null,
    ).length &&
    new Set(baselineRecords.map((record) => record.inputFingerprint)).size === baselineRecords.length;
  const reuseByInputFingerprint = new Map<string, BaselineRecord>();
  if (mode === "incremental" && baselineCompatible) {
    // Provenance is intentionally part of inputFingerprint, so a moved file,
    // refreshed commit, or changed external reference must not force a new
    // embedding when the actual embedding input is unchanged. If a legacy
    // baseline contains duplicate embedding fingerprints, choose the stable
    // lowest record id rather than depending on query order.
    const byEmbeddingFingerprint = new Map<string, BaselineRecord>();
    for (const record of baselineRecords) {
      const embeddingFingerprint = record.embeddingFingerprint;
      if (embeddingFingerprint === null) continue;
      const existing = byEmbeddingFingerprint.get(embeddingFingerprint);
      if (existing === undefined || compareCanonical(record.id, existing.id) < 0) {
        byEmbeddingFingerprint.set(embeddingFingerprint, record);
      }
    }
    for (const record of records) {
      const currentInputFingerprint = memoryInputFingerprint(record);
      const currentEmbeddingFingerprint = memoryEmbeddingFingerprint(record);
      const candidate = byEmbeddingFingerprint.get(currentEmbeddingFingerprint);
      if (candidate !== undefined) {
        reuseByInputFingerprint.set(currentInputFingerprint, candidate);
      }
    }
  }
  const baselineFingerprints = new Set(baselineRecords.flatMap((record) => record.inputFingerprint ?? []));
  const reuseCount = mode === "full" ? 0 : reuseByInputFingerprint.size;
  const generatedWorklist = buildMemoryIndexEmbeddingWorklist(records, reuseByInputFingerprint);
  const generateCount = generatedWorklist.length;
  const deleteCount = baseline === null
    ? 0
    : [...baselineFingerprints].filter((fingerprint) => !currentFingerprints.has(fingerprint)).length;
  const estimatedProviderCalls = estimateMemoryIndexProviderCalls(generateCount);
  const deadlineAtDate = new Date(Date.now() + MEMORY_INDEX_MAX_DURATION_MS);
  const deadlineEligible = isMemoryIndexDeadlineEligible(estimatedProviderCalls);
  const ineligibleCode = mode === "incremental" && !baselineCompatible
    ? "MEMORY_INDEX_INCREMENTAL_BASELINE_REQUIRED"
    : !deadlineEligible
      ? "MEMORY_INDEX_DEADLINE_EXCEEDED"
      : null;
  const fingerprint = planFingerprint({
    mode,
    route: {
      providerConnectionId: route.providerConnectionId,
      modelId: route.modelId,
      embeddingDimensions: dimensions,
    },
    routeUpdatedAt: route.updatedAt,
    inputManifestFingerprint: currentManifest,
    expectedInputCount: records.length,
    generateCount,
    reuseCount,
    deleteCount,
    baselineGenerationId: baseline?.id ?? null,
    baselineManifestFingerprint: baseline?.inputManifestFingerprint ?? null,
    reusedInputFingerprints: [...reuseByInputFingerprint.keys()],
  });
  return Object.freeze({
    planFingerprint: fingerprint,
    mode,
    providerConnectionId: route.providerConnectionId,
    providerName: route.providerConnection.name,
    providerKind: route.providerConnection.kind,
    modelId: route.modelId,
    dimensions,
    routeUpdatedAt: route.updatedAt.toISOString(),
    currentInputManifestFingerprint: currentManifest,
    expectedInputCount: records.length,
    reuseCount,
    generateCount,
    deleteCount,
    baselineGenerationId: baseline?.id ?? null,
    baselineManifestFingerprint: baseline?.inputManifestFingerprint ?? null,
    estimatedProviderCalls,
    deadlineAt: deadlineAtDate.toISOString(),
    deadlineEligible,
    ineligibleCode,
    route,
    records,
    baselineRecords,
    reuseByInputFingerprint,
    deadlineAtDate,
  });
}

export async function getProjectMemoryIndexPlan(
  projectId: string,
  mode: "full" | "incremental",
  db: PrismaClient = getDb(),
): Promise<MemoryIndexPlan> {
  return toPublicMemoryIndexPlan(await buildMemoryIndexPlan(projectId, mode, db));
}

export async function getProjectMemoryIndexStatus(projectId: string, db: PrismaClient = getDb()) {
  const [pointer, sourceCount, codePointer, materialPointerCount, route, currentManifest, latestJob] = await Promise.all([
    db.memoryIndexPointer.findUnique({
      where: { projectId },
      select: {
        publishedAt: true,
        generation: {
          select: {
            id: true,
            jobId: true,
            status: true,
            buildMode: true,
            providerConnectionId: true,
            modelId: true,
            dimensions: true,
            recordCount: true,
            generatedRecordCount: true,
            reusedRecordCount: true,
            inputManifestFingerprint: true,
            expectedEmbeddingRouteUpdatedAt: true,
            completedAt: true,
            providerConnection: { select: { id: true, name: true, kind: true, status: true } },
          },
        },
      },
    }),
    db.projectSource.count({ where: { projectId, originScope: "project", retiredAt: null } }),
    db.projectCodeSnapshotPointer.findUnique({ where: { projectId }, select: { projectCodeSnapshotId: true } }),
    db.repositoryMaterialGenerationPointer.count({ where: { projectId } }),
    db.projectAiRoute.findUnique({
      where: { projectId_operation: { projectId, operation: "embedding" } },
      select: {
        providerConnectionId: true,
        modelId: true,
        embeddingDimensions: true,
        updatedAt: true,
        providerConnection: { select: { id: true, name: true, kind: true, status: true } },
      },
    }),
    getProjectMemoryInputManifest(projectId, db),
    db.backgroundJob.findFirst({
      where: { projectId, kind: "memoryIndex" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, stage: true, failureCode: true, reconciliationRequired: true, createdAt: true, completedAt: true },
    }),
  ]);
  const readiness = resolveMemoryIndexReadiness({
    embeddingRoute: route === null ? null : {
      providerConnectionId: route.providerConnectionId,
      modelId: route.modelId,
      embeddingDimensions: route.embeddingDimensions,
      providerVerified: route.providerConnection.status === "verified",
    },
    activeIndex: pointer === null ? null : {
      providerConnectionId: pointer.generation.providerConnectionId,
      modelId: pointer.generation.modelId,
      dimensions: pointer.generation.dimensions,
      inputManifestFingerprint: pointer.generation.inputManifestFingerprint,
      legacy: pointer.generation.jobId === null,
      status: pointer.generation.status,
    },
    currentInputManifestFingerprint: currentManifest,
  });
  return Object.freeze({
    activeIndex: pointer === null ? null : {
      ...pointer,
      generation: {
        ...pointer.generation,
        legacy: pointer.generation.jobId === null,
      },
    },
    compatible: readiness.indexCompatible,
    readiness: readiness.state,
    latestJob,
    inputs: {
      projectSourceCount: sourceCount,
      hasCodeSnapshot: codePointer !== null,
      repositoryMaterialGenerationCount: materialPointerCount,
      manifestFingerprint: currentManifest,
    },
    route,
  });
}

function safePlanPayload(plan: MemoryIndexPlanSnapshot): Record<string, unknown> {
  return {
    mode: plan.mode,
    planFingerprint: plan.planFingerprint,
    providerConnectionId: plan.providerConnectionId,
    providerName: plan.providerName,
    providerKind: plan.providerKind,
    modelId: plan.modelId,
    dimensions: plan.dimensions,
    inputManifestFingerprint: plan.currentInputManifestFingerprint,
    expectedInputCount: plan.expectedInputCount,
    reuseCount: plan.reuseCount,
    generateCount: plan.generateCount,
    deleteCount: plan.deleteCount,
    baselineGenerationId: plan.baselineGenerationId,
    baselineManifestFingerprint: plan.baselineManifestFingerprint,
  };
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function stopHeartbeat(
  heartbeat: ReturnType<typeof startProjectJobHeartbeat> | null,
): Promise<void> {
  if (heartbeat === null) return;
  await heartbeat.stop();
  if (heartbeat.failure !== null) throw heartbeat.failure;
}

export async function runProjectMemoryIndexJob(input: Readonly<{
  projectId: string;
  requestedBy: Pick<AppUser, "id">;
  clientKey: unknown;
  consent: unknown;
  mode?: "full" | "incremental";
  planFingerprint?: string;
}>, db: PrismaClient = getDb()) {
  assertWebAiConsent(input.consent);
  const mode = input.mode ?? "full";
  const initialPlan = await buildMemoryIndexPlan(input.projectId, mode, db);
  if (initialPlan.ineligibleCode !== null) return fail(initialPlan.ineligibleCode);
  const expectedPlanFingerprint = input.planFingerprint ?? initialPlan.planFingerprint;
  let generationId: string | null = null;
  let plannedGeneration: MemoryIndexPlanSnapshot | null = null;
  let granted: Readonly<{ jobId: string; created: boolean }>;
  try {
    granted = await createGrantedWebAiJob({
      projectId: input.projectId,
      kind: "memoryIndex",
      route: initialPlan.route,
      requestedBy: input.requestedBy,
      clientKey: input.clientKey,
      scopeKind: "projectMemory",
      scopeIds: safePlanPayload(initialPlan),
      manifestFingerprint: initialPlan.currentInputManifestFingerprint,
      payload: safePlanPayload(initialPlan),
      afterCreate: async (tx, jobId) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, ${MEMORY_INDEX_LOCK_NAMESPACE}))`;
        const lockedPlan = await buildMemoryIndexPlan(input.projectId, mode, tx);
        if (lockedPlan.planFingerprint !== expectedPlanFingerprint) return fail("MEMORY_INDEX_PLAN_STALE");
        if (lockedPlan.ineligibleCode !== null) return fail(lockedPlan.ineligibleCode);
        plannedGeneration = lockedPlan;
        const generation = await tx.memoryIndexGeneration.create({
          data: {
            projectId: input.projectId,
            jobId,
            providerConnectionId: lockedPlan.providerConnectionId,
            modelId: lockedPlan.modelId,
            dimensions: lockedPlan.dimensions,
            status: "staging",
            buildMode: lockedPlan.mode,
            inputManifestFingerprint: lockedPlan.currentInputManifestFingerprint,
            expectedActiveIndexGenerationId: lockedPlan.baselineGenerationId,
            expectedEmbeddingRouteUpdatedAt: new Date(lockedPlan.routeUpdatedAt),
            expectedInputCount: lockedPlan.expectedInputCount,
            generatedRecordCount: 0,
            reusedRecordCount: 0,
            deadlineAt: lockedPlan.deadlineAtDate,
            recordCount: 0,
          },
          select: { id: true },
        });
        generationId = generation.id;
      },
    }, db);
  } catch (error) {
    if (isKnown(error, "P2002")) return fail("MEMORY_INDEX_ALREADY_RUNNING");
    throw error;
  }
  if (!granted.created) return getWorkflowProjectJob(input.projectId, granted.jobId, db);
  const plan = plannedGeneration ?? initialPlan;
  const claim = await claimWebAiJob(granted.jobId, db);
  if (!claim) return getWorkflowProjectJob(input.projectId, granted.jobId, db);

  let heartbeat: ReturnType<typeof startProjectJobHeartbeat> | null = null;
  let heartbeatStopped = false;
  try {
    heartbeat = startProjectJobHeartbeat({ jobId: granted.jobId, ...claim }, db);
    const building = await db.memoryIndexGeneration.updateMany({
      where: { projectId: input.projectId, id: generationId!, status: "staging" },
      data: { status: "building" },
    });
    if (building.count !== 1) return fail("MEMORY_INDEX_INPUT_INVALID");

    let generatedRecordCount = 0;
    let reusedRecordCount = 0;
    const generatedWorklist = buildMemoryIndexEmbeddingWorklist(plan.records, plan.reuseByInputFingerprint);
    const embeddingByInputFingerprint = new Map<string, readonly number[]>();
    const persistedInputFingerprints = new Set<string>();

    const persistAvailableRecords = async (): Promise<void> => {
      const data: Prisma.MemoryRecordCreateManyInput[] = [];
      const dataFingerprints: string[] = [];
      for (const record of plan.records) {
        const currentInputFingerprint = memoryInputFingerprint(record);
        if (persistedInputFingerprints.has(currentInputFingerprint)) continue;
        const currentEmbeddingFingerprint = memoryEmbeddingFingerprint(record);
        const reused = plan.reuseByInputFingerprint.get(currentInputFingerprint);
        const embedding = reused?.embedding ?? embeddingByInputFingerprint.get(currentInputFingerprint);
        if (embedding === undefined) continue;
        if (embedding.length !== plan.dimensions || embedding.some((value) => !Number.isFinite(value))) return fail("MEMORY_INDEX_INPUT_INVALID");
        if (reused === undefined) generatedRecordCount += 1;
        else reusedRecordCount += 1;
        data.push({
          id: record.id,
          projectId: input.projectId,
          indexGenerationId: generationId!,
          scope: record.scope,
          projectSourceId: record.projectSourceId,
          projectRepositoryLinkId: record.projectRepositoryLinkId,
          frozenCommitSha: record.frozenCommitSha,
          path: record.path,
          externalRef: record.externalRef,
          rangeStart: record.rangeStart,
          rangeEnd: record.rangeEnd,
          contentText: record.contentText,
          contentHash: record.contentHash,
          embedding: [...embedding],
          inputFingerprint: currentInputFingerprint,
          embeddingFingerprint: currentEmbeddingFingerprint,
          reusedFromMemoryRecordId: reused?.id ?? null,
        });
        dataFingerprints.push(currentInputFingerprint);
      }
      if (data.length === 0) return;
      await db.memoryRecord.createMany({ data });
      for (const fingerprint of dataFingerprints) persistedInputFingerprints.add(fingerprint);
      const progress = await db.memoryIndexGeneration.updateMany({
        where: { projectId: input.projectId, id: generationId!, status: "building" },
        data: { recordCount: persistedInputFingerprints.size, generatedRecordCount, reusedRecordCount },
      });
      if (progress.count !== 1) return fail("MEMORY_INDEX_INPUT_INVALID");
    };

    for (let offset = 0; offset < generatedWorklist.length; offset += EMBEDDING_BATCH_SIZE) {
      const generatedBatch = generatedWorklist.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      if (Date.now() >= plan.deadlineAtDate.getTime() - MEMORY_INDEX_DEADLINE_SAFETY_MS) return fail("MEMORY_INDEX_DEADLINE_EXCEEDED");
      await updateWebAiJobProgress(granted.jobId, claim, "embedding", persistedInputFingerprints.size, plan.records.length, db);
      const embeddingResult = await auditedProviderCall({
        jobId: granted.jobId,
        attempt: claim,
        route: plan.route,
        callKey: stableAiCallKey(granted.jobId, "embedding", String(offset)),
        requestPayload: { texts: generatedBatch.map((record) => record.contentText) },
        maxOutputTokens: 128,
        call: () => invokeEmbeddings({
          connection: plan.route.providerConnection,
          modelId: plan.route.modelId,
          texts: generatedBatch.map((record) => record.contentText),
          expectedDimensions: plan.dimensions,
          absoluteDeadlineAt: plan.deadlineAtDate,
        }),
      }, db);
      if (embeddingResult.vectors.length !== generatedBatch.length) return fail("MEMORY_INDEX_INPUT_INVALID");
      for (const [index, record] of generatedBatch.entries()) {
        embeddingByInputFingerprint.set(memoryInputFingerprint(record), embeddingResult.vectors[index]!);
      }
      await persistAvailableRecords();
    }
    // A plan with only reusable records has no provider batch, but still needs
    // its complete candidate snapshot materialized before publication.
    await persistAvailableRecords();
    if (persistedInputFingerprints.size !== plan.records.length || generatedRecordCount + reusedRecordCount !== plan.records.length) {
      return fail("MEMORY_INDEX_INPUT_INVALID");
    }

    await updateWebAiJobProgress(granted.jobId, claim, "publishing", plan.records.length, plan.records.length, db);
    await stopHeartbeat(heartbeat);
    heartbeatStopped = true;

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, ${MEMORY_INDEX_LOCK_NAMESPACE}))`;
      const previous = await tx.memoryIndexPointer.findUnique({ where: { projectId: input.projectId }, select: { indexGenerationId: true } });
      const currentRoute = await tx.projectAiRoute.findUnique({
        where: { projectId_operation: { projectId: input.projectId, operation: "embedding" } },
        select: {
          providerConnectionId: true,
          modelId: true,
          embeddingDimensions: true,
          updatedAt: true,
          providerConnection: { select: { status: true } },
        },
      });
      let currentManifest: string | null;
      try {
        currentManifest = inputManifest(await collectProjectMemoryInputs(input.projectId, tx));
      } catch (error) {
        if (error instanceof WebMemoryIndexError && (error.code === "MEMORY_INDEX_EMPTY" || error.code === "MEMORY_INDEX_TOO_LARGE")) currentManifest = null;
        else throw error;
      }
      if (!isMemoryIndexPublicationCurrent({
        expectedActiveIndexGenerationId: plan.baselineGenerationId,
        currentActiveIndexGenerationId: previous?.indexGenerationId ?? null,
        expectedRoute: {
          providerConnectionId: plan.providerConnectionId,
          modelId: plan.modelId,
          embeddingDimensions: plan.dimensions,
          updatedAt: plan.routeUpdatedAt,
        },
        currentRoute: currentRoute === null ? null : {
          providerConnectionId: currentRoute.providerConnectionId,
          modelId: currentRoute.modelId,
          embeddingDimensions: currentRoute.embeddingDimensions,
          providerVerified: currentRoute.providerConnection.status === "verified",
          updatedAt: currentRoute.updatedAt,
        },
        expectedInputManifestFingerprint: plan.currentInputManifestFingerprint,
        currentInputManifestFingerprint: currentManifest,
      })) return fail("MEMORY_INDEX_PUBLICATION_CONFLICT");
      const candidate = await tx.memoryIndexGeneration.findUnique({
        where: { projectId_id: { projectId: input.projectId, id: generationId! } },
        select: { status: true, recordCount: true, expectedInputCount: true, generatedRecordCount: true, reusedRecordCount: true },
      });
      if (candidate === null || candidate.status !== "building" || candidate.recordCount !== plan.expectedInputCount || candidate.expectedInputCount !== plan.expectedInputCount || candidate.generatedRecordCount + candidate.reusedRecordCount !== plan.expectedInputCount) return fail("MEMORY_INDEX_PUBLICATION_CONFLICT");
      const completedAt = new Date();
      const completed = await tx.memoryIndexGeneration.updateMany({
        where: { projectId: input.projectId, id: generationId!, status: "building" },
        data: { status: "complete", completedAt, failureCode: null, reconciliationRequired: false },
      });
      if (completed.count !== 1) return fail("MEMORY_INDEX_PUBLICATION_CONFLICT");
      await tx.memoryIndexPointer.upsert({
        where: { projectId: input.projectId },
        create: { projectId: input.projectId, indexGenerationId: generationId!, publishedAt: completedAt },
        update: { indexGenerationId: generationId!, publishedAt: completedAt },
      });
      if (previous !== null && previous.indexGenerationId !== generationId) {
        const superseded = await tx.memoryIndexGeneration.updateMany({
          where: { projectId: input.projectId, id: previous.indexGenerationId, status: "complete" },
          data: { status: "superseded", supersededAt: completedAt },
        });
        if (superseded.count !== 1) return fail("MEMORY_INDEX_PUBLICATION_CONFLICT");
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return finishWebAiJob(granted.jobId, claim, {
      indexGenerationId: generationId,
      mode: plan.mode,
      expectedInputCount: plan.expectedInputCount,
      generatedRecordCount,
      reusedRecordCount,
      recordCount: plan.records.length,
      dimensions: plan.dimensions,
      manifest: plan.currentInputManifestFingerprint,
      planFingerprint: plan.planFingerprint,
    }, db);
  } catch (error) {
    if (heartbeat !== null && !heartbeatStopped) {
      await heartbeat.stop().catch(() => undefined);
      heartbeatStopped = true;
    }
    // A heartbeat failure means the executor can no longer prove its lease
    // while publishing/finishing. Keep the candidate recoverable rather than
    // claiming a deterministic failure under an unverified lease.
    const leaseUncertain = error instanceof ProjectWorkflowError && [
      "PROJECT_WORKFLOW_ATTEMPT_NOT_FOUND",
      "PROJECT_WORKFLOW_STALE_ATTEMPT",
      "PROJECT_WORKFLOW_LEASE_EXPIRED",
    ].includes(error.code);
    const jobState = await db.backgroundJob.findUnique({
      where: { id: granted.jobId },
      select: { status: true, reconciliationRequired: true },
    }).catch(() => null);
    const uncertain = isUncertainProviderDispatch(error) ||
      leaseUncertain ||
      jobState?.status === "unknown" ||
      jobState?.reconciliationRequired === true ||
      (heartbeat !== null && heartbeat.failure !== null);
    if (generationId !== null) {
      const generation = await db.memoryIndexGeneration.findUnique({
        where: { projectId_id: { projectId: input.projectId, id: generationId } },
        select: { status: true },
      }).catch(() => null);
      if (generation?.status === "staging" || generation?.status === "building") {
        if (uncertain) {
          await db.memoryIndexGeneration.updateMany({
            where: { projectId: input.projectId, id: generationId, status: { in: ["staging", "building"] } },
            data: { status: "unknown", failureCode: workflowSafeFailureCode(error), reconciliationRequired: true, completedAt: new Date() },
          }).catch(() => undefined);
          await markProjectJobUnknown({ jobId: granted.jobId, ...claim, error }, db).catch(() => undefined);
        } else {
          await db.memoryIndexGeneration.updateMany({
            where: { projectId: input.projectId, id: generationId, status: { in: ["staging", "building"] } },
            data: { status: "failed", failureCode: workflowSafeFailureCode(error), reconciliationRequired: false, completedAt: new Date() },
          }).catch(() => undefined);
          await failWebAiJob(granted.jobId, claim, error, db).catch(() => undefined);
        }
      }
    }
    throw error;
  }
}

export async function reconcileMemoryIndexJob(input: Readonly<{
  projectId: string;
  jobId: string;
  requestedById: string;
}>, db: PrismaClient = getDb()) {
  return withProjectJobLock(db, input.jobId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, ${MEMORY_INDEX_LOCK_NAMESPACE}))`;
    const job = await tx.backgroundJob.findUnique({
      where: { id: input.jobId },
      select: { id: true, projectId: true, kind: true, status: true, reconciliationRequired: true },
    });
    if (job === null || job.projectId !== input.projectId || job.kind !== "memoryIndex") return fail("MEMORY_INDEX_INPUT_INVALID");
    const generation = await tx.memoryIndexGeneration.findUnique({
      where: { projectId_jobId: { projectId: input.projectId, jobId: input.jobId } },
      select: { id: true, status: true, reconciliationRequired: true, inputManifestFingerprint: true, buildMode: true, recordCount: true },
    });
    if (generation === null) return fail("MEMORY_INDEX_INPUT_INVALID");
    const existingReconciliation = await tx.memoryIndexReconciliation.findUnique({
      where: { projectId_indexGenerationId: { projectId: input.projectId, indexGenerationId: generation.id } },
      select: { id: true },
    });
    if (existingReconciliation !== null) return getWorkflowProjectJob(input.projectId, input.jobId, tx);

    let currentJobStatus = job.status;
    let jobNeedsReconciliation = job.reconciliationRequired;
    let currentGenerationStatus = generation.status;
    let generationNeedsReconciliation = generation.reconciliationRequired;
    const latestAttempt = await tx.backgroundJobAttempt.findFirst({
      where: { jobId: input.jobId },
      orderBy: { attemptNumber: "desc" },
      select: { id: true, status: true, leaseExpiresAt: true },
    });
    if (currentJobStatus === "running") {
      if (latestAttempt === null) throw new ProjectWorkflowError("PROJECT_WORKFLOW_ATTEMPT_NOT_FOUND");
      if (latestAttempt.status !== "running") throw new ProjectWorkflowError("PROJECT_WORKFLOW_STALE_ATTEMPT");
      if (latestAttempt.leaseExpiresAt.getTime() > Date.now()) throw new ProjectWorkflowError("PROJECT_WORKFLOW_RECONCILIATION_NOT_DUE");
      const completedAt = new Date();
      const attemptUpdated = await tx.backgroundJobAttempt.updateMany({
        where: { id: latestAttempt.id, jobId: input.jobId, status: "running" },
        data: { status: "unknown", safeFailureCode: "RECONCILIATION_REQUIRED", completedAt, heartbeatAt: completedAt },
      });
      if (attemptUpdated.count !== 1) return fail("MEMORY_INDEX_PUBLICATION_CONFLICT");
      await tx.providerCallAudit.updateMany({
        where: { jobId: input.jobId, status: "running" },
        data: { status: "unknown", safeErrorCode: "RECONCILIATION_REQUIRED", completedAt },
      });
      const updatedJob = await tx.backgroundJob.updateMany({
        where: { id: input.jobId, projectId: input.projectId, status: "running" },
        data: { status: "unknown", stage: "reconciliation_required", failureCode: "RECONCILIATION_REQUIRED", completedAt, reconciliationRequired: true },
      });
      if (updatedJob.count !== 1) return fail("MEMORY_INDEX_PUBLICATION_CONFLICT");
      currentJobStatus = "unknown";
      jobNeedsReconciliation = true;
      if (currentGenerationStatus === "staging" || currentGenerationStatus === "building") {
        const updatedGeneration = await tx.memoryIndexGeneration.updateMany({
          where: { projectId: input.projectId, id: generation.id, status: currentGenerationStatus },
          data: { status: "unknown", failureCode: "RECONCILIATION_REQUIRED", reconciliationRequired: true, completedAt },
        });
        if (updatedGeneration.count !== 1) return fail("MEMORY_INDEX_PUBLICATION_CONFLICT");
        currentGenerationStatus = "unknown";
        generationNeedsReconciliation = true;
      }
    }

    // An expired request and an already-unknown request are both closed in
    // this single locked transaction. Reconciliation never calls a provider;
    // it only records the local evidence and releases admission.
    if (currentJobStatus === "unknown" && jobNeedsReconciliation &&
      (currentGenerationStatus === "staging" || currentGenerationStatus === "building")) {
      const completedAt = new Date();
      const updatedGeneration = await tx.memoryIndexGeneration.updateMany({
        where: { projectId: input.projectId, id: generation.id, status: currentGenerationStatus },
        data: { status: "unknown", failureCode: "RECONCILIATION_REQUIRED", reconciliationRequired: true, completedAt },
      });
      if (updatedGeneration.count !== 1) return fail("MEMORY_INDEX_PUBLICATION_CONFLICT");
      currentGenerationStatus = "unknown";
      generationNeedsReconciliation = true;
    }

    if (currentJobStatus === "unknown" && jobNeedsReconciliation) {
      const completedAt = new Date();
      await tx.providerCallAudit.updateMany({
        where: { jobId: input.jobId, status: "running" },
        data: { status: "unknown", safeErrorCode: "RECONCILIATION_REQUIRED", completedAt },
      });
    }

    if (currentJobStatus !== "unknown" || !jobNeedsReconciliation) {
      return getWorkflowProjectJob(input.projectId, input.jobId, tx);
    }
    const pointer = await tx.memoryIndexPointer.findUnique({ where: { projectId: input.projectId }, select: { indexGenerationId: true } });
    const evidenceFingerprint = manifestFingerprint({
      version: "memory-index-reconciliation:v1",
      projectId: input.projectId,
      jobId: input.jobId,
      generationId: generation.id,
      generationStatus: currentGenerationStatus,
      pointerGenerationId: pointer?.indexGenerationId ?? null,
    });
    const reconciliationOutcome = resolveMemoryIndexReconciliationOutcome({
      jobStatus: currentJobStatus,
      jobReconciliationRequired: jobNeedsReconciliation,
      generationStatus: currentGenerationStatus,
      generationReconciliationRequired: generationNeedsReconciliation,
      generationId: generation.id,
      pointerGenerationId: pointer?.indexGenerationId ?? null,
    });
    if (reconciliationOutcome === "publishedLocally") {
      const completedAt = new Date();
      await tx.memoryIndexReconciliation.create({
        data: {
          projectId: input.projectId,
          indexGenerationId: generation.id,
          requestedById: input.requestedById,
          resolution: "publishedLocally",
          evidenceFingerprint,
        },
      });
      await tx.backgroundJobAttempt.updateMany({
        where: { jobId: input.jobId, status: "unknown" },
        data: { status: "succeeded", safeFailureCode: null, completedAt, heartbeatAt: completedAt },
      });
      await tx.backgroundJob.update({
        where: { id: input.jobId },
        data: {
          status: "succeeded",
          stage: "complete",
          failureCode: null,
          completedAt,
          reconciliationRequired: false,
          result: {
            indexGenerationId: generation.id,
            mode: generation.buildMode,
            recordCount: generation.recordCount,
            reconciliation: "publishedLocally",
          },
        },
      });
      return getWorkflowProjectJob(input.projectId, input.jobId, tx);
    }

    if (reconciliationOutcome !== "explicitAbandon") {
      return fail("MEMORY_INDEX_RECONCILIATION_REQUIRED");
    }
    await tx.memoryIndexReconciliation.create({
      data: {
        projectId: input.projectId,
        indexGenerationId: generation.id,
        requestedById: input.requestedById,
        resolution: "explicitAbandon",
        evidenceFingerprint,
      },
    });
    if (currentGenerationStatus === "unknown") {
      const releasedGeneration = await tx.memoryIndexGeneration.updateMany({
        where: { projectId: input.projectId, id: generation.id, status: "unknown", reconciliationRequired: true },
        data: { reconciliationRequired: false },
      });
      if (releasedGeneration.count !== 1) return fail("MEMORY_INDEX_PUBLICATION_CONFLICT");
    }
    const releasedJob = await tx.backgroundJob.updateMany({
      where: { id: input.jobId, projectId: input.projectId, status: "unknown", reconciliationRequired: true },
      data: {
        reconciliationRequired: false,
        stage: "reconciled_unknown",
        result: {
          indexGenerationId: generation.id,
          mode: generation.buildMode,
          recordCount: generation.recordCount,
          reconciliation: "explicitAbandon",
        },
      },
    });
    if (releasedJob.count !== 1) return fail("MEMORY_INDEX_PUBLICATION_CONFLICT");
    return getWorkflowProjectJob(input.projectId, input.jobId, tx);
  });
}

export async function cancelMemoryIndexJob(projectId: string, jobId: string, db: PrismaClient = getDb()) {
  return withProjectJobLock(db, jobId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, ${MEMORY_INDEX_LOCK_NAMESPACE}))`;
    const job = await tx.backgroundJob.findUnique({ where: { id: jobId }, select: { id: true, projectId: true, kind: true, status: true } });
    if (job === null || job.projectId !== projectId || job.kind !== "memoryIndex") return fail("MEMORY_INDEX_INPUT_INVALID");
    if (job.status !== "queued" && job.status !== "waitingConsent") return fail("MEMORY_INDEX_ALREADY_RUNNING");
    const completedAt = new Date();
    const generation = await tx.memoryIndexGeneration.findUnique({ where: { projectId_jobId: { projectId, jobId } }, select: { id: true, status: true } });
    if (generation !== null && (generation.status === "staging" || generation.status === "building")) {
      await tx.memoryIndexGeneration.updateMany({ where: { projectId, id: generation.id, status: generation.status }, data: { status: "failed", failureCode: "MEMORY_INDEX_CANCELLED", completedAt } });
    }
    await tx.backgroundJob.update({ where: { id: jobId }, data: { status: "cancelled", stage: "cancelled", completedAt } });
    return getWorkflowProjectJob(projectId, jobId, tx);
  });
}
