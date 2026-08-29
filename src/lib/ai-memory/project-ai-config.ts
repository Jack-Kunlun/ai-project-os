import { createHash, randomUUID } from "node:crypto";
import {
  AiAuditEventType,
  AiOperation,
  ModelProcessingGrantRevocationReasonCode,
  ModelProcessingGrantStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import {
  LOCAL_SOURCE_SCANNER_FINGERPRINT,
  LOCAL_SOURCE_SCANNER_VERSION,
  OPENAI_AUTO_EXTRACT_PROCESSOR_FINGERPRINT,
  OPENAI_EMBEDDING_PROCESSOR_FINGERPRINT,
  OPENAI_GENERATE_WITH_CONTEXT_PROCESSOR_FINGERPRINT,
  OPENAI_PROJECT_ANALYSIS_PROCESSOR_FINGERPRINT,
  OPENAI_SOURCE_SUMMARY_PROCESSOR_FINGERPRINT,
  getOpenAiAutoExtractProfile,
  getOpenAiEmbeddingProfile,
  getOpenAiGenerateWithContextProfile,
  getOpenAiProjectAnalysisProfile,
  getOpenAiSourceSummaryProfile,
  loadAiRuntimeConfig,
  scanLocalSourcesForModelTransfer,
} from "@/lib/ai-runtime";
import { hashSourceContent } from "@/lib/source";
import {
  ProjectAiConfigError,
  throwProjectAiConfigError,
} from "./project-ai-config-errors";

export const MODEL_TRANSFER_CONSENT_VERSION =
  "selected-project-sources-to-openai:v1" as const;
export const PROJECT_AI_CONFIG_VERSION = "project-ai-config:v1" as const;
export const PROJECT_AI_GRANT_LIFETIME_DAYS = 30 as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIGURE_FIELDS = [
  "acknowledgeExternalModelTransfer",
  "consentVersion",
  "projectId",
  "sourceIds",
] as const;
const MAX_SOURCE_COUNT = 100;
const MAX_AUTO_EXTRACT_SOURCE_BYTES = 64_000;
const TRANSACTION_RETRY_LIMIT = 3;
const CONFIGURED_OPERATIONS = [
  AiOperation.autoExtract,
  AiOperation.embedding,
  AiOperation.sourceSummary,
  AiOperation.projectAnalysis,
  AiOperation.generateWithContext,
] as const;

type ConfiguredOperation = (typeof CONFIGURED_OPERATIONS)[number];
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type TransactionRunner = <T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { isolationLevel: Prisma.TransactionIsolationLevel },
) => Promise<T>;

type OperationBoundary = Readonly<{
  operation: ConfiguredOperation;
  profileFingerprint: string;
  providerFingerprint: string;
  modelFingerprint: string;
  modelId: string;
  processorFingerprint: string;
  regionFingerprint: string;
  retentionFingerprint: string;
  endpointFingerprint: string;
}>;

type SelectedSource = Readonly<{
  id: string;
  contentText: string;
  contentHash: string;
  contentBytes: number;
}>;

type GrantForMatching = Readonly<{
  id: string;
  policyRevisionId: string;
  status: ModelProcessingGrantStatus;
  expiresAt: Date | null;
  revokedAt: Date | null;
  grantFingerprint: string;
  profileFingerprint: string;
  providerFingerprint: string;
  modelFingerprint: string;
  modelId: string;
  processorFingerprint: string;
  regionFingerprint: string;
  retentionFingerprint: string;
  endpointFingerprint: string;
  operations: readonly Readonly<{ operation: AiOperation }>[];
  sources: readonly Readonly<{
    sourceId: string;
    contentFingerprint: string;
    contentBytes: number;
  }>[];
}>;

export type ProjectAiOperationStatus = Readonly<{
  operation: ConfiguredOperation;
  modelId: string;
  grantId: string;
  sourceCount: number;
  expiresAt: string;
}>;

export type ProjectAiMemoryStatus = Readonly<{
  configured: boolean;
  currentRevision: number | null;
  sourceIds: readonly string[];
  operations: readonly ProjectAiOperationStatus[];
  availableSourceCount: number;
  pendingCandidateCount: number;
  runtime: Readonly<{
    configured: boolean;
    errorCode: "AI_DISABLED" | "AI_PROVIDER_DISABLED" | null;
    responseModelId: string;
    embeddingModelId: string;
  }>;
  externalTransferExecution: Readonly<{
    enabled: false;
    reasonCode: "EXTERNAL_TRANSFER_NOT_ENABLED";
  }>;
}>;

export type ConfigureProjectAiMemoryRequest = Readonly<{
  projectId: string;
  sourceIds: readonly string[];
  consentVersion: typeof MODEL_TRANSFER_CONSENT_VERSION;
  acknowledgeExternalModelTransfer: true;
}>;

export interface CreateProjectAiConfigServiceOptions {
  db: PrismaClient;
  environment?: RuntimeEnvironment;
  idFactory?: () => string;
  now?: () => Date;
}

function fingerprint(label: string, value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: PROJECT_AI_CONFIG_VERSION,
        label,
        value,
      }),
      "utf8",
    )
    .digest("hex");
}

function operationBoundaries(): readonly OperationBoundary[] {
  const autoExtract = getOpenAiAutoExtractProfile();
  const embedding = getOpenAiEmbeddingProfile();
  const generateWithContext = getOpenAiGenerateWithContextProfile();
  const sourceSummary = getOpenAiSourceSummaryProfile();
  const projectAnalysis = getOpenAiProjectAnalysisProfile();
  return Object.freeze([
    Object.freeze({
      operation: AiOperation.autoExtract,
      profileFingerprint: autoExtract.profileFingerprint,
      providerFingerprint: autoExtract.providerFingerprint,
      modelFingerprint: autoExtract.modelFingerprint,
      modelId: autoExtract.modelId,
      processorFingerprint: OPENAI_AUTO_EXTRACT_PROCESSOR_FINGERPRINT,
      regionFingerprint: autoExtract.processorRegionFingerprint,
      retentionFingerprint: autoExtract.processorRetentionFingerprint,
      endpointFingerprint: autoExtract.processorEndpointFingerprint,
    }),
    Object.freeze({
      operation: AiOperation.embedding,
      profileFingerprint: embedding.profileFingerprint,
      providerFingerprint: embedding.providerFingerprint,
      modelFingerprint: embedding.modelFingerprint,
      modelId: embedding.modelId,
      processorFingerprint: OPENAI_EMBEDDING_PROCESSOR_FINGERPRINT,
      regionFingerprint: embedding.processorRegionFingerprint,
      retentionFingerprint: embedding.processorRetentionFingerprint,
      endpointFingerprint: embedding.processorEndpointFingerprint,
    }),
    Object.freeze({
      operation: AiOperation.generateWithContext,
      profileFingerprint: generateWithContext.profileFingerprint,
      providerFingerprint: generateWithContext.providerFingerprint,
      modelFingerprint: generateWithContext.modelFingerprint,
      modelId: generateWithContext.modelId,
      processorFingerprint: OPENAI_GENERATE_WITH_CONTEXT_PROCESSOR_FINGERPRINT,
      regionFingerprint: generateWithContext.processorRegionFingerprint,
      retentionFingerprint: generateWithContext.processorRetentionFingerprint,
      endpointFingerprint: generateWithContext.processorEndpointFingerprint,
    }),
    Object.freeze({
      operation: AiOperation.sourceSummary,
      profileFingerprint: sourceSummary.profileFingerprint,
      providerFingerprint: sourceSummary.providerFingerprint,
      modelFingerprint: sourceSummary.modelFingerprint,
      modelId: sourceSummary.modelId,
      processorFingerprint: OPENAI_SOURCE_SUMMARY_PROCESSOR_FINGERPRINT,
      regionFingerprint: sourceSummary.processorRegionFingerprint,
      retentionFingerprint: sourceSummary.processorRetentionFingerprint,
      endpointFingerprint: sourceSummary.processorEndpointFingerprint,
    }),
    Object.freeze({
      operation: AiOperation.projectAnalysis,
      profileFingerprint: projectAnalysis.profileFingerprint,
      providerFingerprint: projectAnalysis.providerFingerprint,
      modelFingerprint: projectAnalysis.modelFingerprint,
      modelId: projectAnalysis.modelId,
      processorFingerprint: OPENAI_PROJECT_ANALYSIS_PROCESSOR_FINGERPRINT,
      regionFingerprint: projectAnalysis.processorRegionFingerprint,
      retentionFingerprint: projectAnalysis.processorRetentionFingerprint,
      endpointFingerprint: projectAnalysis.processorEndpointFingerprint,
    }),
  ]);
}

const OPERATION_BOUNDARIES = operationBoundaries();
const POLICY_PROFILE_FINGERPRINT = fingerprint(
  "operation-profiles",
  OPERATION_BOUNDARIES,
);
const POLICY_PROCESSOR_FINGERPRINT = fingerprint(
  "operation-processors",
  OPERATION_BOUNDARIES.map((profile) => profile.processorFingerprint),
);
const POLICY_REGION_FINGERPRINT = fingerprint(
  "operation-regions",
  OPERATION_BOUNDARIES.map((profile) => profile.regionFingerprint),
);
const POLICY_RETENTION_FINGERPRINT = fingerprint(
  "operation-retention",
  OPERATION_BOUNDARIES.map((profile) => profile.retentionFingerprint),
);
const POLICY_ENDPOINT_FINGERPRINT = fingerprint(
  "operation-endpoints",
  OPERATION_BOUNDARIES.map((profile) => profile.endpointFingerprint),
);
const POLICY_BUDGET_FINGERPRINT = fingerprint("budget", {
  autoExtractMaxInputTokens: 64_000,
  autoExtractMaxOutputTokens: 2_048,
  autoExtractMaxBudgetMicros: 60_000,
  embeddingMaximumAttempts: 1,
  generateWithContextMaxInputTokens: 64_000,
  generateWithContextMaxOutputTokens: 2_048,
  generateWithContextMaxBudgetMicros: 60_000,
  sourceSummaryMaxInputTokens: 64_000,
  sourceSummaryMaxOutputTokens: 2_048,
  sourceSummaryMaxBudgetMicros: 60_000,
  projectAnalysisMaxInputTokens: 64_000,
  projectAnalysisMaxOutputTokens: 4_096,
  projectAnalysisMaxBudgetMicros: 90_000,
});
const POLICY_FINGERPRINT = fingerprint("enabled-policy", {
  consentVersion: MODEL_TRANSFER_CONSENT_VERSION,
  outboundEnabled: true,
  operations: CONFIGURED_OPERATIONS,
  profileFingerprint: POLICY_PROFILE_FINGERPRINT,
  processorFingerprint: POLICY_PROCESSOR_FINGERPRINT,
  regionFingerprint: POLICY_REGION_FINGERPRINT,
  retentionFingerprint: POLICY_RETENTION_FINGERPRINT,
  endpointFingerprint: POLICY_ENDPOINT_FINGERPRINT,
  budgetFingerprint: POLICY_BUDGET_FINGERPRINT,
  scannerFingerprint: LOCAL_SOURCE_SCANNER_FINGERPRINT,
});
const DISABLED_POLICY_FINGERPRINT = fingerprint("disabled-policy", {
  outboundEnabled: false,
  operations: [],
  scannerFingerprint: LOCAL_SOURCE_SCANNER_FINGERPRINT,
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactDataFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  try {
    const keys = Object.keys(value).sort();
    const canonical = [...expected].sort();
    return keys.length === canonical.length &&
      keys.every((key, index) => key === canonical[index]) &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
      });
  } catch {
    return false;
  }
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return throwProjectAiConfigError("PROJECT_AI_CONFIG_INVALID_INPUT");
  }
  return value;
}

function canonicalSourceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SOURCE_COUNT) {
    return throwProjectAiConfigError("PROJECT_AI_CONFIG_INVALID_INPUT");
  }
  const ids = value.map(canonicalUuid).sort();
  if (new Set(ids).size !== ids.length) {
    return throwProjectAiConfigError("PROJECT_AI_CONFIG_INVALID_INPUT");
  }
  return Object.freeze(ids);
}

function parseConfigureRequest(value: unknown): ConfigureProjectAiMemoryRequest {
  if (
    !isPlainRecord(value) ||
    !exactDataFields(value, CONFIGURE_FIELDS) ||
    value.consentVersion !== MODEL_TRANSFER_CONSENT_VERSION ||
    value.acknowledgeExternalModelTransfer !== true
  ) {
    return throwProjectAiConfigError("PROJECT_AI_CONFIG_INVALID_INPUT");
  }
  return Object.freeze({
    projectId: canonicalUuid(value.projectId),
    sourceIds: canonicalSourceIds(value.sourceIds),
    consentVersion: MODEL_TRANSFER_CONSENT_VERSION,
    acknowledgeExternalModelTransfer: true,
  });
}

function isPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return (error as { code?: unknown }).code === code;
  } catch {
    return false;
  }
}

function sourceManifest(sources: readonly SelectedSource[]) {
  return sources.map((source) => ({
    sourceId: source.id,
    contentFingerprint: source.contentHash,
    contentBytes: source.contentBytes,
  }));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameOperationBoundary(
  value: Readonly<{
    operation: AiOperation;
    profileFingerprint: string;
    providerFingerprint: string;
    modelFingerprint: string;
    modelId: string;
    processorFingerprint: string;
    regionFingerprint: string;
    retentionFingerprint: string;
    endpointFingerprint: string;
  }>,
  expected: OperationBoundary,
): boolean {
  return value.operation === expected.operation &&
    value.profileFingerprint === expected.profileFingerprint &&
    value.providerFingerprint === expected.providerFingerprint &&
    value.modelFingerprint === expected.modelFingerprint &&
    value.modelId === expected.modelId &&
    value.processorFingerprint === expected.processorFingerprint &&
    value.regionFingerprint === expected.regionFingerprint &&
    value.retentionFingerprint === expected.retentionFingerprint &&
    value.endpointFingerprint === expected.endpointFingerprint;
}

function grantMatches(
  grant: GrantForMatching,
  revisionId: string,
  operation: OperationBoundary,
  sources: readonly SelectedSource[],
  now: Date,
): boolean {
  if (
    grant.policyRevisionId !== revisionId ||
    grant.status !== ModelProcessingGrantStatus.issued ||
    grant.revokedAt !== null ||
    grant.expiresAt === null ||
    grant.expiresAt.getTime() <= now.getTime() ||
    grant.operations.length !== 1 ||
    grant.operations[0]?.operation !== operation.operation ||
    !sameOperationBoundary(
      { operation: operation.operation, ...grant },
      operation,
    )
  ) {
    return false;
  }
  const actualSources = [...grant.sources]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const expectedSources = sourceManifest(sources);
  return actualSources.length === expectedSources.length &&
    actualSources.every((source, index) => {
      const expected = expectedSources[index];
      return expected !== undefined &&
        source.sourceId === expected.sourceId &&
        source.contentFingerprint === expected.contentFingerprint &&
        source.contentBytes === expected.contentBytes;
    });
}

function exactConfiguredRevision(value: Readonly<{
  policyFingerprint: string;
  outboundEnabled: boolean;
  embeddingEnabled: boolean;
  autoExtractEnabled: boolean;
  sourceSummaryEnabled: boolean;
  projectAnalysisEnabled: boolean;
  generateWithContextEnabled: boolean;
  profileFingerprint: string;
  processorFingerprint: string;
  regionFingerprint: string;
  retentionFingerprint: string;
  endpointFingerprint: string;
  budgetFingerprint: string;
  scannerFingerprint: string;
  operationProfiles: readonly Readonly<{
    operation: AiOperation;
    profileFingerprint: string;
    providerFingerprint: string;
    modelFingerprint: string;
    modelId: string;
    processorFingerprint: string;
    regionFingerprint: string;
    retentionFingerprint: string;
    endpointFingerprint: string;
  }>[];
}>): boolean {
  if (
    value.policyFingerprint !== POLICY_FINGERPRINT ||
    value.outboundEnabled !== true ||
    value.embeddingEnabled !== true ||
    value.autoExtractEnabled !== true ||
    value.sourceSummaryEnabled !== true ||
    value.projectAnalysisEnabled !== true ||
    value.generateWithContextEnabled !== true ||
    value.profileFingerprint !== POLICY_PROFILE_FINGERPRINT ||
    value.processorFingerprint !== POLICY_PROCESSOR_FINGERPRINT ||
    value.regionFingerprint !== POLICY_REGION_FINGERPRINT ||
    value.retentionFingerprint !== POLICY_RETENTION_FINGERPRINT ||
    value.endpointFingerprint !== POLICY_ENDPOINT_FINGERPRINT ||
    value.budgetFingerprint !== POLICY_BUDGET_FINGERPRINT ||
    value.scannerFingerprint !== LOCAL_SOURCE_SCANNER_FINGERPRINT ||
    value.operationProfiles.length !== OPERATION_BOUNDARIES.length
  ) {
    return false;
  }
  return OPERATION_BOUNDARIES.every((expected) =>
    value.operationProfiles.some((profile) => sameOperationBoundary(profile, expected)),
  );
}

class ProjectAiConfigServiceImpl {
  private readonly db: PrismaClient;
  private readonly transaction: TransactionRunner;
  private readonly environment: RuntimeEnvironment;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: CreateProjectAiConfigServiceOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.db?.$transaction !== "function" ||
      (options.idFactory !== undefined && typeof options.idFactory !== "function") ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throwProjectAiConfigError("PROJECT_AI_CONFIG_INVALID_INPUT");
    }
    this.db = options.db;
    this.transaction = this.db.$transaction.bind(this.db) as TransactionRunner;
    this.environment = options.environment ?? process.env;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  private generatedId(): string {
    return canonicalUuid(this.idFactory());
  }

  private currentTime(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      return throwProjectAiConfigError("PROJECT_AI_CONFIG_INVALID_INPUT");
    }
    return new Date(value.getTime());
  }

  private async serializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < TRANSACTION_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (isPrismaCode(error, "P2034")) {
          if (attempt + 1 < TRANSACTION_RETRY_LIMIT) continue;
          return throwProjectAiConfigError("PROJECT_AI_CONFIG_WRITE_CONFLICT");
        }
        if (error instanceof ProjectAiConfigError) throw error;
        throw error;
      }
    }
    return throwProjectAiConfigError("PROJECT_AI_CONFIG_WRITE_CONFLICT");
  }

  async getStatus(projectIdValue: unknown): Promise<ProjectAiMemoryStatus> {
    const projectId = canonicalUuid(projectIdValue);
    const now = this.currentTime();
    const project = await this.db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        _count: { select: { sources: { where: { retiredAt: null } } } },
        aiPolicy: {
          select: {
            currentRevision: {
              select: {
                id: true,
                revision: true,
                policyFingerprint: true,
                outboundEnabled: true,
                embeddingEnabled: true,
                autoExtractEnabled: true,
                sourceSummaryEnabled: true,
                projectAnalysisEnabled: true,
                generateWithContextEnabled: true,
                profileFingerprint: true,
                processorFingerprint: true,
                regionFingerprint: true,
                retentionFingerprint: true,
                endpointFingerprint: true,
                budgetFingerprint: true,
                scannerFingerprint: true,
                operationProfiles: true,
                grants: {
                  where: {
                    status: ModelProcessingGrantStatus.issued,
                    sourceKind: "manual_text",
                  },
                  include: { operations: true, sources: true },
                },
              },
            },
          },
        },
      },
    });
    if (project === null) {
      return throwProjectAiConfigError("PROJECT_NOT_FOUND");
    }
    const pendingCandidateCount = await this.db.aiCandidateClaim.count({
      where: { projectId, reviewStatus: "candidate" },
    });
    const revision = project.aiPolicy?.currentRevision ?? null;
    const matchedOperations: ProjectAiOperationStatus[] = [];
    let configuredSourceIds: readonly string[] = Object.freeze([]);
    if (
      revision !== null &&
      exactConfiguredRevision(revision) &&
      revision.grants.length === OPERATION_BOUNDARIES.length
    ) {
      for (const boundary of OPERATION_BOUNDARIES) {
        const grant = revision.grants.find((candidate) =>
          candidate.revokedAt === null &&
          candidate.expiresAt !== null &&
          candidate.expiresAt.getTime() > now.getTime() &&
          candidate.operations.length === 1 &&
          candidate.operations[0]?.operation === boundary.operation &&
          sameOperationBoundary(
            { operation: boundary.operation, ...candidate },
            boundary,
          ),
        );
        if (grant === undefined || grant.expiresAt === null) continue;
        const sourceIds = grant.sources
          .map((source) => source.sourceId)
          .sort();
        if (configuredSourceIds.length === 0) {
          configuredSourceIds = Object.freeze(sourceIds);
        } else if (!sameStringArray(configuredSourceIds, sourceIds)) {
          configuredSourceIds = Object.freeze([]);
          matchedOperations.length = 0;
          break;
        }
        matchedOperations.push(Object.freeze({
          operation: boundary.operation,
          modelId: boundary.modelId,
          grantId: grant.id,
          sourceCount: sourceIds.length,
          expiresAt: grant.expiresAt.toISOString(),
        }));
      }
    }
    matchedOperations.sort((left, right) =>
      CONFIGURED_OPERATIONS.indexOf(left.operation) -
      CONFIGURED_OPERATIONS.indexOf(right.operation));
    const configured = matchedOperations.length === OPERATION_BOUNDARIES.length &&
      configuredSourceIds.length > 0;
    const runtime = loadAiRuntimeConfig(this.environment);
    return Object.freeze({
      configured,
      currentRevision: revision?.revision ?? null,
      sourceIds: configured ? configuredSourceIds : Object.freeze([]),
      operations: configured
        ? Object.freeze(matchedOperations)
        : Object.freeze([]),
      availableSourceCount: project._count.sources,
      pendingCandidateCount,
      runtime: Object.freeze({
        configured: runtime.status === "ready",
        errorCode: runtime.status === "ready" ? null : runtime.errorCode,
        responseModelId: getOpenAiAutoExtractProfile().modelId,
        embeddingModelId: getOpenAiEmbeddingProfile().modelId,
      }),
      externalTransferExecution: Object.freeze({
        enabled: false,
        reasonCode: "EXTERNAL_TRANSFER_NOT_ENABLED",
      }),
    });
  }

  async configure(value: unknown): Promise<ProjectAiMemoryStatus> {
    const request = parseConfigureRequest(value);
    const now = this.currentTime();
    await this.serializable(async (tx) => {
      const lockedProjects = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"::text AS id
          FROM "Project"
         WHERE "id" = ${request.projectId}::uuid
         FOR UPDATE
      `);
      if (lockedProjects.length !== 1) {
        return throwProjectAiConfigError("PROJECT_NOT_FOUND");
      }
      const rows = await tx.projectSource.findMany({
        where: { projectId: request.projectId, id: { in: [...request.sourceIds] }, retiredAt: null },
        select: { id: true, contentText: true, contentHash: true },
      });
      if (rows.length !== request.sourceIds.length) {
        return throwProjectAiConfigError("SOURCE_NOT_FOUND");
      }
      const selectedSources: SelectedSource[] = rows
        .map((source) => ({
          id: source.id,
          contentText: source.contentText,
          contentHash: source.contentHash,
          contentBytes: Buffer.byteLength(source.contentText, "utf8"),
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const source of selectedSources) {
        if (hashSourceContent(source.contentText) !== source.contentHash) {
          return throwProjectAiConfigError("SOURCE_CHANGED");
        }
        if (source.contentBytes > MAX_AUTO_EXTRACT_SOURCE_BYTES) {
          return throwProjectAiConfigError("SOURCE_TOO_LARGE");
        }
      }
      const scan = scanLocalSourcesForModelTransfer(
        selectedSources.map((source) => ({
          sourceId: source.id,
          content: source.contentText,
        })),
      );
      if (scan.result !== "passed") {
        return throwProjectAiConfigError("SOURCE_SCAN_BLOCKED");
      }

      const policy = await tx.projectAiPolicy.findUnique({
        where: { projectId: request.projectId },
        select: {
          currentRevision: {
            include: { operationProfiles: true },
          },
        },
      });
      let revision = policy?.currentRevision ?? null;
      if (revision === null || !exactConfiguredRevision(revision)) {
        const maximum = await tx.projectAiPolicyRevision.aggregate({
          where: { projectId: request.projectId },
          _max: { revision: true },
        });
        const nextRevision = (maximum._max.revision ?? 0) + 1;
        const revisionId = this.generatedId();
        revision = await tx.projectAiPolicyRevision.create({
          data: {
            id: revisionId,
            projectId: request.projectId,
            revision: nextRevision,
            policyFingerprint: POLICY_FINGERPRINT,
            outboundEnabled: true,
            embeddingEnabled: true,
            autoExtractEnabled: true,
            sourceSummaryEnabled: true,
            projectAnalysisEnabled: true,
            generateWithContextEnabled: true,
            profileFingerprint: POLICY_PROFILE_FINGERPRINT,
            processorFingerprint: POLICY_PROCESSOR_FINGERPRINT,
            regionFingerprint: POLICY_REGION_FINGERPRINT,
            retentionFingerprint: POLICY_RETENTION_FINGERPRINT,
            endpointFingerprint: POLICY_ENDPOINT_FINGERPRINT,
            budgetFingerprint: POLICY_BUDGET_FINGERPRINT,
            scannerFingerprint: LOCAL_SOURCE_SCANNER_FINGERPRINT,
            operationProfiles: {
              create: OPERATION_BOUNDARIES.map((boundary) => ({
                id: this.generatedId(),
                ...boundary,
              })),
            },
          },
          include: { operationProfiles: true },
        });
        if (policy === null) {
          await tx.projectAiPolicy.create({
            data: {
              projectId: request.projectId,
              currentRevisionId: revision.id,
              updatedAt: now,
            },
          });
        } else {
          await tx.projectAiPolicy.update({
            where: { projectId: request.projectId },
            data: { currentRevisionId: revision.id, updatedAt: now },
          });
        }
        await tx.aiAuditEvent.create({
          data: {
            id: this.generatedId(),
            projectId: request.projectId,
            policyRevisionId: revision.id,
            eventType: policy === null
              ? AiAuditEventType.policyCreated
              : AiAuditEventType.policyAdvanced,
            eventFingerprint: POLICY_FINGERPRINT,
            fingerprintCount: OPERATION_BOUNDARIES.length,
            byteCount: 0,
            tokenCount: 0,
            requestCount: 0,
            httpStatus: null,
            grantId: null,
            aiRunId: null,
            attemptId: null,
            createdAt: now,
          },
        });
      }

      const issuedGrants = await tx.modelProcessingGrant.findMany({
        where: {
          projectId: request.projectId,
          status: ModelProcessingGrantStatus.issued,
        },
        include: { operations: true, sources: true },
      });
      const manualGrants = issuedGrants.filter(
        (grant) => grant.sourceKind === "manual_text",
      );
      const staleRepositoryGrants = issuedGrants.filter(
        (grant) =>
          grant.sourceKind === "repository_code" &&
          grant.policyRevisionId !== revision.id,
      );
      const matchingGrants = OPERATION_BOUNDARIES.map((boundary) =>
        manualGrants.find((grant) =>
          grantMatches(grant, revision.id, boundary, selectedSources, now)),
      );
      if (
        manualGrants.length === OPERATION_BOUNDARIES.length &&
        staleRepositoryGrants.length === 0 &&
        matchingGrants.every((grant) => grant !== undefined)
      ) {
        return;
      }

      for (const grant of [...manualGrants, ...staleRepositoryGrants]) {
        const updated = await tx.modelProcessingGrant.updateMany({
          where: {
            projectId: request.projectId,
            id: grant.id,
            status: ModelProcessingGrantStatus.issued,
          },
          data: {
            status: ModelProcessingGrantStatus.revoked,
            revokedAt: now,
            revocationReasonCode:
              ModelProcessingGrantRevocationReasonCode.policyChanged,
            updatedAt: now,
          },
        });
        if (updated.count !== 1) {
          return throwProjectAiConfigError("PROJECT_AI_CONFIG_WRITE_CONFLICT");
        }
        await tx.aiAuditEvent.create({
          data: {
            id: this.generatedId(),
            projectId: request.projectId,
            policyRevisionId: grant.policyRevisionId,
            eventType: AiAuditEventType.grantRevoked,
            eventFingerprint: grant.grantFingerprint,
            fingerprintCount: grant.sources.length,
            byteCount: grant.sources.reduce(
              (total, source) => total + source.contentBytes,
              0,
            ),
            tokenCount: 0,
            requestCount: 0,
            httpStatus: null,
            grantId: grant.id,
            aiRunId: null,
            attemptId: null,
            createdAt: now,
          },
        });
      }

      const expiresAt = new Date(
        now.getTime() + PROJECT_AI_GRANT_LIFETIME_DAYS * 24 * 60 * 60 * 1_000,
      );
      const manifest = sourceManifest(selectedSources);
      const totalBytes = manifest.reduce(
        (total, source) => total + source.contentBytes,
        0,
      );
      for (const boundary of OPERATION_BOUNDARIES) {
        const grantId = this.generatedId();
        const grantFingerprint = fingerprint("model-transfer-grant", {
          consentVersion: request.consentVersion,
          projectId: request.projectId,
          policyRevisionId: revision.id,
          operation: boundary.operation,
          boundary,
          sources: manifest,
          issuedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        });
        await tx.modelProcessingGrant.create({
          data: {
            id: grantId,
            projectId: request.projectId,
            sourceKind: "manual_text",
            status: ModelProcessingGrantStatus.draft,
            policyRevisionId: revision.id,
            profileFingerprint: boundary.profileFingerprint,
            providerFingerprint: boundary.providerFingerprint,
            modelFingerprint: boundary.modelFingerprint,
            modelId: boundary.modelId,
            processorFingerprint: boundary.processorFingerprint,
            regionFingerprint: boundary.regionFingerprint,
            retentionFingerprint: boundary.retentionFingerprint,
            endpointFingerprint: boundary.endpointFingerprint,
            grantFingerprint,
            effectivePolicyVersion: revision.revision,
            budgetFingerprint: POLICY_BUDGET_FINGERPRINT,
            scannerFingerprint: LOCAL_SOURCE_SCANNER_FINGERPRINT,
            scannerVersion: LOCAL_SOURCE_SCANNER_VERSION,
            budgetProfile: "standard",
            issuedBy: "local:user",
            purposeCode: "project-memory-v1",
            issuedAt: null,
            expiresAt: null,
            revokedAt: null,
            revocationReasonCode: null,
            updatedAt: now,
            sources: {
              create: manifest.map((source) => ({
                id: this.generatedId(),
                ...source,
              })),
            },
            operations: {
              create: {
                id: this.generatedId(),
                operation: boundary.operation,
              },
            },
          },
        });
        const issued = await tx.modelProcessingGrant.updateMany({
          where: {
            projectId: request.projectId,
            id: grantId,
            status: ModelProcessingGrantStatus.draft,
          },
          data: {
            status: ModelProcessingGrantStatus.issued,
            issuedAt: now,
            expiresAt,
            updatedAt: now,
          },
        });
        if (issued.count !== 1) {
          return throwProjectAiConfigError("PROJECT_AI_CONFIG_WRITE_CONFLICT");
        }
        await tx.aiAuditEvent.create({
          data: {
            id: this.generatedId(),
            projectId: request.projectId,
            policyRevisionId: revision.id,
            eventType: AiAuditEventType.grantIssued,
            eventFingerprint: grantFingerprint,
            fingerprintCount: manifest.length,
            byteCount: totalBytes,
            tokenCount: 0,
            requestCount: 0,
            httpStatus: null,
            grantId,
            aiRunId: null,
            attemptId: null,
            createdAt: now,
          },
        });
      }
    });
    return this.getStatus(request.projectId);
  }

  async revoke(projectIdValue: unknown): Promise<ProjectAiMemoryStatus> {
    const projectId = canonicalUuid(projectIdValue);
    const now = this.currentTime();
    await this.serializable(async (tx) => {
      const lockedProjects = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"::text AS id
          FROM "Project"
         WHERE "id" = ${projectId}::uuid
         FOR UPDATE
      `);
      if (lockedProjects.length !== 1) {
        return throwProjectAiConfigError("PROJECT_NOT_FOUND");
      }
      const policy = await tx.projectAiPolicy.findUnique({
        where: { projectId },
        select: { currentRevision: true },
      });
      const issuedGrants = await tx.modelProcessingGrant.findMany({
        where: { projectId, status: ModelProcessingGrantStatus.issued },
        include: { sources: true },
      });
      if (policy === null && issuedGrants.length === 0) return;

      if (policy !== null && policy.currentRevision.outboundEnabled) {
        const maximum = await tx.projectAiPolicyRevision.aggregate({
          where: { projectId },
          _max: { revision: true },
        });
        const revision = await tx.projectAiPolicyRevision.create({
          data: {
            id: this.generatedId(),
            projectId,
            revision: (maximum._max.revision ?? 0) + 1,
            policyFingerprint: DISABLED_POLICY_FINGERPRINT,
            outboundEnabled: false,
            embeddingEnabled: false,
            autoExtractEnabled: false,
            sourceSummaryEnabled: false,
            projectAnalysisEnabled: false,
            generateWithContextEnabled: false,
            profileFingerprint: POLICY_PROFILE_FINGERPRINT,
            processorFingerprint: POLICY_PROCESSOR_FINGERPRINT,
            regionFingerprint: POLICY_REGION_FINGERPRINT,
            retentionFingerprint: POLICY_RETENTION_FINGERPRINT,
            endpointFingerprint: POLICY_ENDPOINT_FINGERPRINT,
            budgetFingerprint: POLICY_BUDGET_FINGERPRINT,
            scannerFingerprint: LOCAL_SOURCE_SCANNER_FINGERPRINT,
          },
        });
        await tx.projectAiPolicy.update({
          where: { projectId },
          data: { currentRevisionId: revision.id, updatedAt: now },
        });
        await tx.aiAuditEvent.create({
          data: {
            id: this.generatedId(),
            projectId,
            policyRevisionId: revision.id,
            eventType: AiAuditEventType.policyAdvanced,
            eventFingerprint: DISABLED_POLICY_FINGERPRINT,
            fingerprintCount: 0,
            byteCount: 0,
            tokenCount: 0,
            requestCount: 0,
            httpStatus: null,
            grantId: null,
            aiRunId: null,
            attemptId: null,
            createdAt: now,
          },
        });
      }

      for (const grant of issuedGrants) {
        const updated = await tx.modelProcessingGrant.updateMany({
          where: {
            projectId,
            id: grant.id,
            status: ModelProcessingGrantStatus.issued,
          },
          data: {
            status: ModelProcessingGrantStatus.revoked,
            revokedAt: now,
            revocationReasonCode:
              ModelProcessingGrantRevocationReasonCode.userRequested,
            updatedAt: now,
          },
        });
        if (updated.count !== 1) {
          return throwProjectAiConfigError("PROJECT_AI_CONFIG_WRITE_CONFLICT");
        }
        await tx.aiAuditEvent.create({
          data: {
            id: this.generatedId(),
            projectId,
            policyRevisionId: grant.policyRevisionId,
            eventType: AiAuditEventType.grantRevoked,
            eventFingerprint: grant.grantFingerprint,
            fingerprintCount: grant.sources.length,
            byteCount: grant.sources.reduce(
              (total, source) => total + source.contentBytes,
              0,
            ),
            tokenCount: 0,
            requestCount: 0,
            httpStatus: null,
            grantId: grant.id,
            aiRunId: null,
            attemptId: null,
            createdAt: now,
          },
        });
      }
    });
    return this.getStatus(projectId);
  }
}

export function createProjectAiConfigService(
  options: CreateProjectAiConfigServiceOptions,
): Pick<ProjectAiConfigServiceImpl, "getStatus" | "configure" | "revoke"> {
  return new ProjectAiConfigServiceImpl(options);
}
