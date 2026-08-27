import { createHash, randomUUID } from "node:crypto";
import {
  AiOperation,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import { resolveAiExecutionProfile } from "@/lib/ai-runtime";
import {
  getIssuedGroundedRagPlan,
  type GroundedRagPlan,
} from "./grounded-rag";
import {
  verifyGroundedAnalysisOutput,
  type GroundedAnalysisOperation,
  type GroundedAnalysisResult,
} from "./grounded-analysis";
import { EMBEDDING_STORAGE_PROFILE_FINGERPRINT } from "./corpus-index";

export const AI_DERIVED_ARTIFACT_VERSION = "ai-derived-artifact:v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRANSACTION_RETRY_LIMIT = 3;

export type AiDerivedArtifactErrorCode =
  | "AI_ARTIFACT_INVALID_INPUT"
  | "AI_ARTIFACT_PROJECT_NOT_FOUND"
  | "AI_ARTIFACT_PLAN_INELIGIBLE"
  | "AI_ARTIFACT_REFUSAL_NOT_PERSISTED"
  | "AI_ARTIFACT_NOT_FOUND"
  | "AI_ARTIFACT_WRITE_CONFLICT";

export class AiDerivedArtifactError extends Error {
  constructor(readonly code: AiDerivedArtifactErrorCode) {
    super(code);
    this.name = "AiDerivedArtifactError";
  }
}

export type AiDerivedArtifactAvailability = "active" | "stale" | "restricted";
export type AiDerivedArtifactRestrictionReason =
  | "GRANT_INELIGIBLE"
  | "POLICY_INELIGIBLE"
  | "SNAPSHOT_INELIGIBLE"
  | "DEPENDENCY_MISMATCH";

export type AiDerivedArtifactView = Readonly<{
  id: string;
  projectId: string;
  kind: "source_summary" | "project_brief";
  operation: GroundedAnalysisOperation;
  availability: AiDerivedArtifactAvailability;
  restrictionReasonCode: AiDerivedArtifactRestrictionReason | null;
  snapshotId: string;
  snapshotManifestFingerprint: string;
  artifactFingerprint: string;
  inputFingerprint: string;
  outputFingerprint: string;
  modelId: string;
  promptVersion: string;
  dependencyCount: number;
  payload: GroundedAnalysisResult | null;
  createdAt: string;
}>;

export type PublishGroundedAnalysisRequest = Readonly<{
  projectId: string;
  operation: GroundedAnalysisOperation;
  plan: GroundedRagPlan;
  output: unknown;
}>;

type TransactionRunner = <T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { isolationLevel: Prisma.TransactionIsolationLevel },
) => Promise<T>;

type SourceDependency = Readonly<{
  sourceId: string;
  originScope: "project" | "repository_link";
  sourceRevisionKey: string;
  sourceContentHash: string;
}>;

type SnapshotEligibility = Readonly<{ baseEligible: boolean; current: boolean }>;

async function inspectSnapshotEligibility(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  projectId: string,
  snapshotId: string,
): Promise<SnapshotEligibility> {
  const rows = await tx.$queryRaw<Array<{
    baseEligible: boolean;
    current: boolean;
  }>>(Prisma.sql`
    SELECT
      TRUE AS "baseEligible",
      (
        snapshot."status" = 'complete'
        AND snapshot."supersededAt" IS NULL
        AND EXISTS (
          SELECT 1 FROM "ProjectRagSnapshotPointer" AS rag_pointer
           WHERE rag_pointer."projectId" = snapshot."projectId"
             AND rag_pointer."ragSnapshotId" = snapshot."id"
        )
        AND EXISTS (
          SELECT 1 FROM "ProjectCorpusIndexPointer" AS manual_pointer
           WHERE manual_pointer."projectId" = snapshot."projectId"
             AND manual_pointer."indexGenerationId" = snapshot."manualIndexGenerationId"
             AND manual_pointer."corpusGenerationId" = snapshot."manualCorpusGenerationId"
        )
      ) AS "current"
    FROM "ProjectRagSnapshot" AS snapshot
    JOIN "ProjectCorpusIndexGeneration" AS project_index
      ON project_index."projectId" = snapshot."projectId"
     AND project_index."indexGenerationId" = snapshot."manualIndexGenerationId"
     AND project_index."corpusGenerationId" = snapshot."manualCorpusGenerationId"
     AND project_index."grantId" = snapshot."grantId"
     AND project_index."policyRevisionId" = snapshot."policyRevisionId"
    JOIN "IndexGeneration" AS index_generation
      ON index_generation."projectId" = project_index."projectId"
     AND index_generation."id" = project_index."indexGenerationId"
     AND index_generation."grantId" = project_index."grantId"
     AND index_generation."policyRevisionId" = project_index."policyRevisionId"
    JOIN "ProjectCorpusGeneration" AS corpus_generation
      ON corpus_generation."projectId" = project_index."projectId"
     AND corpus_generation."id" = project_index."corpusGenerationId"
     AND corpus_generation."grantId" = project_index."grantId"
     AND corpus_generation."policyRevisionId" = project_index."policyRevisionId"
    JOIN "ModelProcessingGrant" AS grant_row
      ON grant_row."projectId" = snapshot."projectId"
     AND grant_row."id" = snapshot."grantId"
     AND grant_row."policyRevisionId" = snapshot."policyRevisionId"
    JOIN "ModelProcessingGrantOperation" AS grant_operation
      ON grant_operation."projectId" = grant_row."projectId"
     AND grant_operation."grantId" = grant_row."id"
     AND grant_operation."operation" = 'embedding'
    JOIN "ProjectAiPolicy" AS policy
      ON policy."projectId" = snapshot."projectId"
     AND policy."currentRevisionId" = snapshot."policyRevisionId"
    JOIN "EmbeddingProfile" AS profile
      ON profile."id" = index_generation."embeddingProfileId"
    WHERE snapshot."projectId" = ${projectId}::uuid
      AND snapshot."id" = ${snapshotId}::uuid
      AND snapshot."status" IN ('complete', 'superseded')
      AND snapshot."completedAt" IS NOT NULL
      AND index_generation."kind" = 'project_corpus'
      AND index_generation."status" = 'rag_ready'
      AND index_generation."expectedInputCount" > 0
      AND index_generation."indexedInputCount" = index_generation."expectedInputCount"
      AND corpus_generation."status" = 'complete'
      AND grant_row."status" = 'issued'
      AND grant_row."issuedAt" IS NOT NULL
      AND grant_row."revokedAt" IS NULL
      AND grant_row."expiresAt" IS NOT NULL
      AND grant_row."expiresAt" > CURRENT_TIMESTAMP
      AND grant_row."effectivePolicyVersion" = snapshot."effectivePolicyVersion"
      AND profile."profileFingerprint" = ${EMBEDDING_STORAGE_PROFILE_FINGERPRINT}
    FOR SHARE OF snapshot, project_index, index_generation,
      corpus_generation, grant_row, grant_operation, policy, profile
  `);
  if (rows.length !== 1) {
    return Object.freeze({ baseEligible: false, current: false });
  }
  return Object.freeze(rows[0]!);
}

function fail(code: AiDerivedArtifactErrorCode): never {
  throw new AiDerivedArtifactError(code);
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("AI_ARTIFACT_INVALID_INPUT");
  }
  return value;
}

function hash(label: string, value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: AI_DERIVED_ARTIFACT_VERSION, label, value }), "utf8")
    .digest("hex");
}

function isPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return (error as { code?: unknown }).code === code;
  } catch {
    return false;
  }
}

function operationEnabled(
  operation: GroundedAnalysisOperation,
  revision: Readonly<{
    outboundEnabled: boolean;
    sourceSummaryEnabled: boolean;
    projectAnalysisEnabled: boolean;
  }>,
): boolean {
  return revision.outboundEnabled && (
    operation === "sourceSummary"
      ? revision.sourceSummaryEnabled
      : revision.projectAnalysisEnabled
  );
}

function artifactKind(
  result: GroundedAnalysisResult,
): "sourceSummary" | "projectBrief" {
  if (result.kind === "source_summary") return "sourceSummary";
  if (result.kind === "project_brief") return "projectBrief";
  return fail("AI_ARTIFACT_REFUSAL_NOT_PERSISTED");
}

function prismaOperation(operation: GroundedAnalysisOperation): AiOperation {
  return operation === "sourceSummary"
    ? AiOperation.sourceSummary
    : AiOperation.projectAnalysis;
}

function asJson(value: GroundedAnalysisResult): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toPayload(value: Prisma.JsonValue): GroundedAnalysisResult {
  return value as unknown as GroundedAnalysisResult;
}

export interface CreateAiDerivedArtifactServiceOptions {
  db: PrismaClient;
  idFactory?: () => string;
  now?: () => Date;
}

class AiDerivedArtifactServiceImpl {
  private readonly db: PrismaClient;
  private readonly transaction: TransactionRunner;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: CreateAiDerivedArtifactServiceOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.db?.$transaction !== "function" ||
      (options.idFactory !== undefined && typeof options.idFactory !== "function") ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      fail("AI_ARTIFACT_INVALID_INPUT");
    }
    this.db = options.db;
    this.transaction = this.db.$transaction.bind(this.db) as TransactionRunner;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  private generatedId(): string {
    return canonicalUuid(this.idFactory());
  }

  private currentTime(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      return fail("AI_ARTIFACT_INVALID_INPUT");
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
        if (isPrismaCode(error, "P2034") || isPrismaCode(error, "P2002")) {
          if (attempt + 1 < TRANSACTION_RETRY_LIMIT) continue;
          return fail("AI_ARTIFACT_WRITE_CONFLICT");
        }
        if (error instanceof AiDerivedArtifactError) throw error;
        throw error;
      }
    }
    return fail("AI_ARTIFACT_WRITE_CONFLICT");
  }

  async publishAnalysis(
    rawRequest: PublishGroundedAnalysisRequest,
  ): Promise<AiDerivedArtifactView> {
    if (typeof rawRequest !== "object" || rawRequest === null) {
      return fail("AI_ARTIFACT_INVALID_INPUT");
    }
    const projectId = canonicalUuid(rawRequest.projectId);
    const operation = rawRequest.operation;
    if (operation !== "sourceSummary" && operation !== "projectAnalysis") {
      return fail("AI_ARTIFACT_INVALID_INPUT");
    }
    const plan = getIssuedGroundedRagPlan(rawRequest.plan);
    if (plan === null || plan.projectId !== projectId) {
      return fail("AI_ARTIFACT_INVALID_INPUT");
    }
    const result = verifyGroundedAnalysisOutput(operation, plan, rawRequest.output);
    const kind = artifactKind(result);
    const dbOperation = prismaOperation(operation);
    const now = this.currentTime();

    const artifactId = await this.serializable(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"::text AS id FROM "Project"
         WHERE "id" = ${projectId}::uuid FOR UPDATE
      `);
      if (locked.length !== 1) return fail("AI_ARTIFACT_PROJECT_NOT_FOUND");

      const snapshot = await tx.projectRagSnapshot.findFirst({
        where: { projectId, id: plan.snapshotId },
        select: {
          id: true,
          status: true,
          manifestFingerprint: true,
          manualCorpusGenerationId: true,
          policyRevisionId: true,
          effectivePolicyVersion: true,
          publishedPointer: { select: { projectId: true } },
        },
      });
      if (
        snapshot === null ||
        snapshot.status !== "complete" ||
        snapshot.publishedPointer === null ||
        snapshot.manifestFingerprint !== plan.snapshotManifestFingerprint
      ) {
        return fail("AI_ARTIFACT_PLAN_INELIGIBLE");
      }
      const snapshotEligibility = await inspectSnapshotEligibility(
        tx,
        projectId,
        snapshot.id,
      );
      if (!snapshotEligibility.baseEligible || !snapshotEligibility.current) {
        return fail("AI_ARTIFACT_PLAN_INELIGIBLE");
      }

      const policy = await tx.projectAiPolicy.findUnique({
        where: { projectId },
        select: {
          currentRevision: {
            include: {
              operationProfiles: true,
              grants: {
                where: { status: "issued" },
                include: { operations: true, sources: true },
              },
            },
          },
        },
      });
      const revision = policy?.currentRevision;
      if (
        revision === undefined ||
        revision.id !== snapshot.policyRevisionId ||
        revision.revision !== snapshot.effectivePolicyVersion ||
        !operationEnabled(operation, revision)
      ) {
        return fail("AI_ARTIFACT_PLAN_INELIGIBLE");
      }
      const operationProfile = revision.operationProfiles.find(
        (profile) => profile.operation === dbOperation,
      );
      const grant = revision.grants.find((candidate) =>
        candidate.revokedAt === null &&
        candidate.expiresAt !== null &&
        candidate.expiresAt.getTime() > now.getTime() &&
        candidate.operations.length === 1 &&
        candidate.operations[0]?.operation === dbOperation &&
        operationProfile !== undefined &&
        candidate.profileFingerprint === operationProfile.profileFingerprint &&
        candidate.providerFingerprint === operationProfile.providerFingerprint &&
        candidate.modelFingerprint === operationProfile.modelFingerprint &&
        candidate.modelId === operationProfile.modelId &&
        candidate.processorFingerprint === operationProfile.processorFingerprint &&
        candidate.regionFingerprint === operationProfile.regionFingerprint &&
        candidate.retentionFingerprint === operationProfile.retentionFingerprint &&
        candidate.endpointFingerprint === operationProfile.endpointFingerprint,
      );
      if (grant === undefined) return fail("AI_ARTIFACT_PLAN_INELIGIBLE");
      const executionProfile = resolveAiExecutionProfile(dbOperation, {
        profileFingerprint: grant.profileFingerprint,
        providerFingerprint: grant.providerFingerprint,
        modelFingerprint: grant.modelFingerprint,
        modelId: grant.modelId,
        regionFingerprint: grant.regionFingerprint,
        retentionFingerprint: grant.retentionFingerprint,
        endpointFingerprint: grant.endpointFingerprint,
      });
      if (executionProfile === null || executionProfile.kind === "synthetic") {
        return fail("AI_ARTIFACT_PLAN_INELIGIBLE");
      }

      const chunkIds = plan.contexts.map((context) => canonicalUuid(context.chunkId));
      const entries = await tx.projectCorpusGenerationEntry.findMany({
        where: {
          projectId,
          corpusGenerationId: snapshot.manualCorpusGenerationId,
          sourceChunkId: { in: chunkIds },
        },
        select: {
          projectSourceId: true,
          originScope: true,
          sourceRevisionKey: true,
          sourceContentHash: true,
          sourceChunkId: true,
          chunkContentHash: true,
          sourceChunk: {
            select: {
              contentText: true,
              contentHash: true,
              rangeUnit: true,
              rangeStart: true,
              rangeEnd: true,
              state: true,
            },
          },
          projectSource: {
            select: { kind: true, externalRef: true },
          },
        },
      });
      if (entries.length !== plan.contexts.length) {
        return fail("AI_ARTIFACT_PLAN_INELIGIBLE");
      }
      const entriesByChunk = new Map(entries.map((entry) => [entry.sourceChunkId, entry]));
      for (const context of plan.contexts) {
        const entry = entriesByChunk.get(context.chunkId);
        if (
          entry === undefined ||
          entry.projectSourceId !== context.sourceId ||
          entry.chunkContentHash !== context.contentHash ||
          entry.sourceChunk.state !== "active" ||
          entry.sourceChunk.contentHash !== context.contentHash ||
          entry.sourceChunk.contentText !== context.contentText ||
          entry.sourceChunk.rangeUnit !== context.rangeUnit ||
          entry.sourceChunk.rangeStart !== context.rangeStart ||
          entry.sourceChunk.rangeEnd !== context.rangeEnd ||
          entry.projectSource.kind !== context.sourceKind ||
          entry.projectSource.externalRef !== context.externalRef
        ) {
          return fail("AI_ARTIFACT_PLAN_INELIGIBLE");
        }
      }

      const sourceDependenciesById = new Map<string, SourceDependency>();
      for (const entry of entries) {
        const dependency = Object.freeze({
          sourceId: entry.projectSourceId,
          originScope: entry.originScope,
          sourceRevisionKey: entry.sourceRevisionKey,
          sourceContentHash: entry.sourceContentHash,
        });
        const current = sourceDependenciesById.get(dependency.sourceId);
        if (current !== undefined && JSON.stringify(current) !== JSON.stringify(dependency)) {
          return fail("AI_ARTIFACT_PLAN_INELIGIBLE");
        }
        sourceDependenciesById.set(dependency.sourceId, dependency);
      }
      const sourceDependencies = [...sourceDependenciesById.values()]
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
      const grantSources = new Map(
        grant.sources.map((source) => [source.sourceId, source.contentFingerprint]),
      );
      if (
        sourceDependencies.some((dependency) =>
          grantSources.get(dependency.sourceId) !== dependency.sourceContentHash)
      ) {
        return fail("AI_ARTIFACT_PLAN_INELIGIBLE");
      }

      const inputFingerprint = hash("input", {
        operation,
        projectId,
        snapshotId: snapshot.id,
        snapshotManifestFingerprint: snapshot.manifestFingerprint,
        contextFingerprint: plan.contextFingerprint,
        sources: sourceDependencies,
      });
      const payload = asJson(result);
      const outputFingerprint = hash("output", payload);
      const artifactFingerprint = hash("artifact", {
        kind,
        operation,
        inputFingerprint,
        outputFingerprint,
        grantId: grant.id,
        policyRevisionId: revision.id,
        effectivePolicyVersion: revision.revision,
        profileFingerprint: grant.profileFingerprint,
        providerFingerprint: grant.providerFingerprint,
        modelFingerprint: grant.modelFingerprint,
        modelId: grant.modelId,
        promptFingerprint: executionProfile.promptFingerprint,
        promptVersion: executionProfile.promptVersion,
      });
      const existing = await tx.aiDerivedArtifact.findUnique({
        where: {
          projectId_artifactFingerprint: { projectId, artifactFingerprint },
        },
        select: { id: true },
      });
      if (existing !== null) return existing.id;

      const id = this.generatedId();
      await tx.aiDerivedArtifact.create({
        data: {
          id,
          projectId,
          kind,
          operation: dbOperation,
          artifactFingerprint,
          inputFingerprint,
          outputFingerprint,
          payload,
          projectRagSnapshotId: snapshot.id,
          snapshotManifestFingerprint: snapshot.manifestFingerprint,
          grantId: grant.id,
          policyRevisionId: revision.id,
          effectivePolicyVersion: revision.revision,
          profileFingerprint: grant.profileFingerprint,
          providerFingerprint: grant.providerFingerprint,
          modelFingerprint: grant.modelFingerprint,
          modelId: grant.modelId,
          promptFingerprint: executionProfile.promptFingerprint,
          promptVersion: executionProfile.promptVersion,
          createdAt: now,
          dependencies: {
            create: [
              {
                id: this.generatedId(),
                dependencyKind: "projectRagSnapshot",
                projectRagSnapshotId: snapshot.id,
                snapshotManifestFingerprint: snapshot.manifestFingerprint,
                grantId: grant.id,
                policyRevisionId: revision.id,
                effectivePolicyVersion: revision.revision,
                dependencyFingerprint: hash("snapshot-dependency", {
                  snapshotId: snapshot.id,
                  manifestFingerprint: snapshot.manifestFingerprint,
                }),
                createdAt: now,
              },
              ...sourceDependencies.map((dependency) => ({
                id: this.generatedId(),
                dependencyKind: "projectSource" as const,
                originScope: dependency.originScope,
                projectSourceId: dependency.sourceId,
                sourceRevisionKey: dependency.sourceRevisionKey,
                sourceContentHash: dependency.sourceContentHash,
                grantId: grant.id,
                policyRevisionId: revision.id,
                effectivePolicyVersion: revision.revision,
                dependencyFingerprint: hash("source-dependency", dependency),
                createdAt: now,
              })),
            ],
          },
        },
      });
      return id;
    });
    return this.getArtifact({ projectId, artifactId });
  }

  async getArtifact(rawInput: Readonly<{
    projectId: string;
    artifactId: string;
  }>): Promise<AiDerivedArtifactView> {
    if (typeof rawInput !== "object" || rawInput === null) {
      return fail("AI_ARTIFACT_INVALID_INPUT");
    }
    const projectId = canonicalUuid(rawInput.projectId);
    const artifactId = canonicalUuid(rawInput.artifactId);
    const now = this.currentTime();
    const artifact = await this.db.aiDerivedArtifact.findFirst({
      where: { projectId, id: artifactId },
      include: {
        project: { select: { aiPolicy: { select: { currentRevisionId: true } } } },
        policyRevision: true,
        grant: { include: { operations: true, sources: true } },
        projectRagSnapshot: { include: { publishedPointer: true } },
        dependencies: {
          include: { projectSource: true, projectRagSnapshot: true },
        },
      },
    });
    if (artifact === null) return fail("AI_ARTIFACT_NOT_FOUND");
    const snapshotEligibility = await inspectSnapshotEligibility(
      this.db,
      projectId,
      artifact.projectRagSnapshotId,
    );

    let availability: AiDerivedArtifactAvailability = artifact.state;
    let restrictionReasonCode: AiDerivedArtifactRestrictionReason | null =
      artifact.restrictionReasonCode === null
        ? null
        : artifact.restrictionReasonCode === "grantIneligible"
          ? "GRANT_INELIGIBLE"
          : artifact.restrictionReasonCode === "policyIneligible"
            ? "POLICY_INELIGIBLE"
            : artifact.restrictionReasonCode === "snapshotIneligible"
              ? "SNAPSHOT_INELIGIBLE"
              : "DEPENDENCY_MISMATCH";
    const operation = artifact.operation === AiOperation.sourceSummary
      ? "sourceSummary"
      : artifact.operation === AiOperation.projectAnalysis
        ? "projectAnalysis"
        : null;
    if (operation === null) {
      availability = "restricted";
      restrictionReasonCode = "DEPENDENCY_MISMATCH";
    } else if (
      artifact.project.aiPolicy?.currentRevisionId !== artifact.policyRevisionId ||
      !operationEnabled(operation, artifact.policyRevision)
    ) {
      availability = "restricted";
      restrictionReasonCode = "POLICY_INELIGIBLE";
    } else if (
      artifact.grant.status !== "issued" ||
      artifact.grant.revokedAt !== null ||
      artifact.grant.expiresAt === null ||
      artifact.grant.expiresAt.getTime() <= now.getTime() ||
      artifact.grant.effectivePolicyVersion !== artifact.effectivePolicyVersion ||
      artifact.grant.profileFingerprint !== artifact.profileFingerprint ||
      artifact.grant.providerFingerprint !== artifact.providerFingerprint ||
      artifact.grant.modelFingerprint !== artifact.modelFingerprint ||
      artifact.grant.modelId !== artifact.modelId ||
      artifact.grant.operations.length !== 1 ||
      artifact.grant.operations[0]?.operation !== artifact.operation
    ) {
      availability = "restricted";
      restrictionReasonCode = "GRANT_INELIGIBLE";
    } else if (
      !snapshotEligibility.baseEligible ||
      artifact.projectRagSnapshot.manifestFingerprint !==
        artifact.snapshotManifestFingerprint
    ) {
      availability = "restricted";
      restrictionReasonCode = "SNAPSHOT_INELIGIBLE";
    } else {
      const snapshotDependencies = artifact.dependencies.filter(
        (dependency) => dependency.dependencyKind === "projectRagSnapshot",
      );
      const sourceDependencies = artifact.dependencies.filter(
        (dependency) => dependency.dependencyKind === "projectSource",
      );
      const manifestInvalid =
        snapshotDependencies.length !== 1 ||
        sourceDependencies.length < 1 ||
        snapshotDependencies[0]?.projectRagSnapshotId !== artifact.projectRagSnapshotId ||
        snapshotDependencies[0]?.snapshotManifestFingerprint !==
          artifact.snapshotManifestFingerprint ||
        artifact.dependencies.some((dependency) =>
          dependency.grantId !== artifact.grantId ||
          dependency.policyRevisionId !== artifact.policyRevisionId ||
          dependency.effectivePolicyVersion !== artifact.effectivePolicyVersion);
      if (manifestInvalid) {
        availability = "restricted";
        restrictionReasonCode = "DEPENDENCY_MISMATCH";
      } else {
        const grantSources = new Map(
          artifact.grant.sources.map((source) => [source.sourceId, source.contentFingerprint]),
        );
        const sourceChanged = sourceDependencies.some((dependency) =>
          dependency.projectSource === null ||
          dependency.projectSource.originScope !== dependency.originScope ||
          dependency.projectSource.revisionKey !== dependency.sourceRevisionKey ||
          dependency.projectSource.contentHash !== dependency.sourceContentHash ||
          grantSources.get(dependency.projectSourceId ?? "") !==
            dependency.sourceContentHash);
        if (
          sourceChanged ||
          !snapshotEligibility.current ||
          availability === "stale"
        ) {
          availability = "stale";
          restrictionReasonCode = null;
        } else {
          availability = "active";
          restrictionReasonCode = null;
        }
      }
    }

    return Object.freeze({
      id: artifact.id,
      projectId: artifact.projectId,
      kind: artifact.kind === "sourceSummary" ? "source_summary" : "project_brief",
      operation: operation ?? "projectAnalysis",
      availability,
      restrictionReasonCode,
      snapshotId: artifact.projectRagSnapshotId,
      snapshotManifestFingerprint: artifact.snapshotManifestFingerprint,
      artifactFingerprint: artifact.artifactFingerprint,
      inputFingerprint: artifact.inputFingerprint,
      outputFingerprint: artifact.outputFingerprint,
      modelId: artifact.modelId,
      promptVersion: artifact.promptVersion,
      dependencyCount: artifact.dependencies.length,
      payload: availability === "restricted" ? null : toPayload(artifact.payload),
      createdAt: artifact.createdAt.toISOString(),
    });
  }
}

export function createAiDerivedArtifactService(
  options: CreateAiDerivedArtifactServiceOptions,
): Pick<AiDerivedArtifactServiceImpl, "publishAnalysis" | "getArtifact"> {
  return new AiDerivedArtifactServiceImpl(options);
}
