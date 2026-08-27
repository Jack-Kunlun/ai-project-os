import { createHash, randomUUID } from "node:crypto";
import {
  AiOperation,
  ModelProcessingGrantRevocationReasonCode,
  ModelProcessingGrantStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

export const REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION =
  "repository-material-to-openai:v1" as const;
export const REPOSITORY_MATERIAL_MODEL_GRANT_VERSION =
  "repository-material-model-grant:v1" as const;
export const REPOSITORY_MATERIAL_MODEL_GRANT_LIFETIME_DAYS = 30 as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const TRANSACTION_RETRY_LIMIT = 3;
const SUPPORTED_OPERATIONS = Object.freeze([
  AiOperation.embedding,
  AiOperation.autoExtract,
  AiOperation.sourceSummary,
  AiOperation.projectAnalysis,
  AiOperation.generateWithContext,
] as const);

type RepositoryMaterialModelOperation = (typeof SUPPORTED_OPERATIONS)[number];

export type RepositoryMaterialModelGrantErrorCode =
  | "REPOSITORY_MATERIAL_MODEL_GRANT_INVALID_INPUT"
  | "REPOSITORY_MATERIAL_MODEL_GRANT_PROJECT_NOT_FOUND"
  | "REPOSITORY_MATERIAL_MODEL_GRANT_LINK_NOT_FOUND"
  | "REPOSITORY_MATERIAL_MODEL_GRANT_LINK_INELIGIBLE"
  | "REPOSITORY_MATERIAL_MODEL_GRANT_MATERIAL_NOT_READY"
  | "REPOSITORY_MATERIAL_MODEL_GRANT_POLICY_INELIGIBLE"
  | "REPOSITORY_MATERIAL_MODEL_GRANT_WRITE_CONFLICT";

export class RepositoryMaterialModelGrantError extends Error {
  constructor(readonly code: RepositoryMaterialModelGrantErrorCode) {
    super(code);
    this.name = "RepositoryMaterialModelGrantError";
  }
}

export type RepositoryMaterialModelGrantView = Readonly<{
  id: string;
  operation: RepositoryMaterialModelOperation;
  modelId: string;
  grantFingerprint: string;
  issuedAt: Date;
  expiresAt: Date;
}>;

export type RepositoryMaterialModelGrantStatus = Readonly<{
  projectId: string;
  projectRepositoryLinkId: string;
  eligibleMaterialGeneration: Readonly<{
    id: string;
    observedHeadCommitSha: string;
    manifestFingerprint: string;
    materialPolicyFingerprint: string;
    linkConfigVersion: number;
    linkEffectivePolicyVersion: number;
    sourceCount: number;
    sourceBytes: number;
  }> | null;
  grants: readonly RepositoryMaterialModelGrantView[];
}>;

export type IssueRepositoryMaterialModelGrantsRequest = Readonly<{
  projectId: string;
  projectRepositoryLinkId: string;
  operations: readonly RepositoryMaterialModelOperation[];
  consentVersion: typeof REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION;
  acknowledgeExternalModelTransfer: true;
  acknowledgeProcessingRights: true;
}>;

type MaterialBoundaryEntry = Readonly<{
  id: string;
  githubSourceVersionId: string;
  projectSourceId: string;
  sourceRevisionKey: string;
  sourceContentHash: string;
  sourceContentBytes: number;
}>;

type MaterialBoundary = Readonly<{
  linkConfigVersion: number;
  linkEffectivePolicyVersion: number;
  materialGenerationId: string;
  observedHeadCommitSha: string;
  manifestFingerprint: string;
  materialPolicyFingerprint: string;
  scannerFingerprint: string;
  scannerVersion: string;
  sourceCount: number;
  sourceBytes: number;
  entries: readonly MaterialBoundaryEntry[];
}>;

type TransactionRunner = <T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { isolationLevel: Prisma.TransactionIsolationLevel },
) => Promise<T>;

function fail(code: RepositoryMaterialModelGrantErrorCode): never {
  throw new RepositoryMaterialModelGrantError(code);
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("REPOSITORY_MATERIAL_MODEL_GRANT_INVALID_INPUT");
  }
  return value;
}

function canonicalOperations(value: unknown): readonly RepositoryMaterialModelOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SUPPORTED_OPERATIONS.length) {
    return fail("REPOSITORY_MATERIAL_MODEL_GRANT_INVALID_INPUT");
  }
  const operations = value.map((operation) => {
    if (!SUPPORTED_OPERATIONS.includes(operation as RepositoryMaterialModelOperation)) {
      return fail("REPOSITORY_MATERIAL_MODEL_GRANT_INVALID_INPUT");
    }
    return operation as RepositoryMaterialModelOperation;
  });
  if (new Set(operations).size !== operations.length) {
    return fail("REPOSITORY_MATERIAL_MODEL_GRANT_INVALID_INPUT");
  }
  return Object.freeze([...operations].sort());
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index]);
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

function fingerprint(label: string, value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: REPOSITORY_MATERIAL_MODEL_GRANT_VERSION,
      label,
      value,
    }), "utf8")
    .digest("hex");
}

function operationEnabled(
  revision: Readonly<{
    embeddingEnabled: boolean;
    autoExtractEnabled: boolean;
    sourceSummaryEnabled: boolean;
    projectAnalysisEnabled: boolean;
    generateWithContextEnabled: boolean;
  }>,
  operation: RepositoryMaterialModelOperation,
): boolean {
  switch (operation) {
    case AiOperation.embedding:
      return revision.embeddingEnabled;
    case AiOperation.autoExtract:
      return revision.autoExtractEnabled;
    case AiOperation.sourceSummary:
      return revision.sourceSummaryEnabled;
    case AiOperation.projectAnalysis:
      return revision.projectAnalysisEnabled;
    case AiOperation.generateWithContext:
      return revision.generateWithContextEnabled;
  }
}

async function readBoundary(
  tx: Prisma.TransactionClient,
  projectId: string,
  projectRepositoryLinkId: string,
): Promise<MaterialBoundary> {
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
                include: { sourceVersion: { include: { projectSource: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (link === null) {
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
    return fail(project === null
      ? "REPOSITORY_MATERIAL_MODEL_GRANT_PROJECT_NOT_FOUND"
      : "REPOSITORY_MATERIAL_MODEL_GRANT_LINK_NOT_FOUND");
  }
  const configPointer = link.configPointer;
  const materialPointer = link.materialGenerationPointer;
  if (
    link.status !== "active" || configPointer === null || materialPointer === null ||
    link.effectivePolicyVersion !== configPointer.effectivePolicyVersion ||
    configPointer.configVersion !== configPointer.config.version ||
    configPointer.effectivePolicyVersion !== configPointer.config.effectivePolicyVersion ||
    materialPointer.linkConfigVersion !== configPointer.configVersion ||
    materialPointer.effectivePolicyVersion !== configPointer.effectivePolicyVersion
  ) {
    return fail("REPOSITORY_MATERIAL_MODEL_GRANT_LINK_INELIGIBLE");
  }
  const generation = materialPointer.generation;
  const materialEnabled = configPointer.config.metadataEnabled ||
    configPointer.config.readmeEnabled || configPointer.config.markdownEnabled ||
    configPointer.config.issuesEnabled || configPointer.config.pullRequestsEnabled ||
    configPointer.config.releasesEnabled;
  if (
    !materialEnabled || generation.status !== "complete" ||
    generation.id !== materialPointer.repositoryMaterialGenerationId ||
    generation.linkConfigVersion !== configPointer.configVersion ||
    generation.effectivePolicyVersion !== configPointer.effectivePolicyVersion ||
    generation.sourceCount < 1 || generation.decodedTextBytes < 1 ||
    generation.entries.length !== generation.sourceCount ||
    !FINGERPRINT_PATTERN.test(generation.manifestFingerprint) ||
    !FINGERPRINT_PATTERN.test(generation.scannerFingerprint) ||
    !FINGERPRINT_PATTERN.test(configPointer.config.policyFingerprint)
  ) {
    return fail("REPOSITORY_MATERIAL_MODEL_GRANT_MATERIAL_NOT_READY");
  }

  let sourceBytes = 0;
  const entries = generation.entries.map((entry) => {
    const sourceVersion = entry.sourceVersion;
    const source = sourceVersion.projectSource;
    if (
      source.originScope !== "repository_link" ||
      source.projectRepositoryLinkId !== projectRepositoryLinkId ||
      source.contentHash !== entry.sourceContentHash ||
      sourceVersion.sourceContentHash !== entry.sourceContentHash ||
      sourceVersion.sourceContentBytes !== entry.sourceContentBytes ||
      Buffer.byteLength(source.contentText, "utf8") !== entry.sourceContentBytes ||
      entry.sourceContentBytes < 1 || !FINGERPRINT_PATTERN.test(entry.sourceContentHash)
    ) {
      return fail("REPOSITORY_MATERIAL_MODEL_GRANT_MATERIAL_NOT_READY");
    }
    sourceBytes += entry.sourceContentBytes;
    return Object.freeze({
      id: entry.id,
      githubSourceVersionId: entry.githubSourceVersionId,
      projectSourceId: entry.projectSourceId,
      sourceRevisionKey: source.revisionKey,
      sourceContentHash: entry.sourceContentHash,
      sourceContentBytes: entry.sourceContentBytes,
    });
  });
  if (sourceBytes !== generation.decodedTextBytes) {
    return fail("REPOSITORY_MATERIAL_MODEL_GRANT_MATERIAL_NOT_READY");
  }
  return Object.freeze({
    linkConfigVersion: generation.linkConfigVersion,
    linkEffectivePolicyVersion: generation.effectivePolicyVersion,
    materialGenerationId: generation.id,
    observedHeadCommitSha: generation.observedHeadCommitSha,
    manifestFingerprint: generation.manifestFingerprint,
    materialPolicyFingerprint: configPointer.config.policyFingerprint,
    scannerFingerprint: generation.scannerFingerprint,
    scannerVersion: generation.scannerVersion,
    sourceCount: generation.sourceCount,
    sourceBytes,
    entries: Object.freeze(entries),
  });
}

function grantView(grant: Readonly<{
  id: string;
  operation: AiOperation;
  modelId: string;
  grantFingerprint: string;
  issuedAt: Date | null;
  expiresAt: Date | null;
}>): RepositoryMaterialModelGrantView {
  if (
    !SUPPORTED_OPERATIONS.includes(grant.operation as RepositoryMaterialModelOperation) ||
    grant.issuedAt === null || grant.expiresAt === null ||
    !FINGERPRINT_PATTERN.test(grant.grantFingerprint)
  ) {
    return fail("REPOSITORY_MATERIAL_MODEL_GRANT_POLICY_INELIGIBLE");
  }
  return Object.freeze({
    id: grant.id,
    operation: grant.operation as RepositoryMaterialModelOperation,
    modelId: grant.modelId,
    grantFingerprint: grant.grantFingerprint,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  });
}

export function createRepositoryMaterialModelGrantService(options: {
  db: PrismaClient;
  idFactory?: () => string;
  now?: () => Date;
}): {
  getStatus(input: Readonly<{
    projectId: string;
    projectRepositoryLinkId: string;
  }>): Promise<RepositoryMaterialModelGrantStatus>;
  issue(input: IssueRepositoryMaterialModelGrantsRequest): Promise<RepositoryMaterialModelGrantStatus>;
  revoke(input: Readonly<{
    projectId: string;
    projectRepositoryLinkId: string;
  }>): Promise<RepositoryMaterialModelGrantStatus>;
} {
  if (typeof options !== "object" || options === null || typeof options.db?.$transaction !== "function") {
    return fail("REPOSITORY_MATERIAL_MODEL_GRANT_INVALID_INPUT");
  }
  const idFactory = options.idFactory ?? randomUUID;
  const nowFactory = options.now ?? (() => new Date());
  const runTransaction = options.db.$transaction.bind(options.db) as TransactionRunner;

  async function serializable<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < TRANSACTION_RETRY_LIMIT; attempt += 1) {
      try {
        return await runTransaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (error instanceof RepositoryMaterialModelGrantError) throw error;
        if (isPrismaCode(error, "P2034") && attempt + 1 < TRANSACTION_RETRY_LIMIT) continue;
        if (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) {
          return fail("REPOSITORY_MATERIAL_MODEL_GRANT_WRITE_CONFLICT");
        }
        throw error;
      }
    }
    return fail("REPOSITORY_MATERIAL_MODEL_GRANT_WRITE_CONFLICT");
  }

  async function status(
    projectId: string,
    projectRepositoryLinkId: string,
    at: Date,
  ): Promise<RepositoryMaterialModelGrantStatus> {
    return options.db.$transaction(async (tx) => {
      let boundary: MaterialBoundary | null = null;
      try {
        boundary = await readBoundary(tx, projectId, projectRepositoryLinkId);
      } catch (error) {
        if (error instanceof RepositoryMaterialModelGrantError && [
          "REPOSITORY_MATERIAL_MODEL_GRANT_LINK_INELIGIBLE",
          "REPOSITORY_MATERIAL_MODEL_GRANT_MATERIAL_NOT_READY",
        ].includes(error.code)) {
          boundary = null;
        } else {
          throw error;
        }
      }
      const policy = await tx.projectAiPolicy.findUnique({
        where: { projectId },
        select: {
          currentRevisionId: true,
          currentRevision: { select: { outboundEnabled: true, revision: true } },
        },
      });
      const grants = await tx.repositoryMaterialModelGrant.findMany({
        where: {
          projectId,
          projectRepositoryLinkId,
          status: ModelProcessingGrantStatus.issued,
          revokedAt: null,
          expiresAt: { gt: at },
        },
        orderBy: { createdAt: "asc" },
      });
      if (policy?.currentRevision.outboundEnabled !== true) boundary = null;
      const eligible = boundary === null || policy === null
        ? []
        : grants.filter((grant) =>
            grant.policyRevisionId === policy.currentRevisionId &&
            grant.effectivePolicyVersion === policy.currentRevision.revision &&
            grant.repositoryMaterialGenerationId === boundary.materialGenerationId &&
            grant.linkConfigVersion === boundary.linkConfigVersion &&
            grant.linkEffectivePolicyVersion === boundary.linkEffectivePolicyVersion &&
            grant.materialPolicyFingerprint === boundary.materialPolicyFingerprint &&
            grant.sourceManifestFingerprint === boundary.manifestFingerprint &&
            grant.scannerFingerprint === boundary.scannerFingerprint);
      return Object.freeze({
        projectId,
        projectRepositoryLinkId,
        eligibleMaterialGeneration: boundary === null
          ? null
          : Object.freeze({
              id: boundary.materialGenerationId,
              observedHeadCommitSha: boundary.observedHeadCommitSha,
              manifestFingerprint: boundary.manifestFingerprint,
              materialPolicyFingerprint: boundary.materialPolicyFingerprint,
              linkConfigVersion: boundary.linkConfigVersion,
              linkEffectivePolicyVersion: boundary.linkEffectivePolicyVersion,
              sourceCount: boundary.sourceCount,
              sourceBytes: boundary.sourceBytes,
            }),
        grants: Object.freeze(eligible.map(grantView)),
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  return Object.freeze({
    async getStatus(input) {
      if (typeof input !== "object" || input === null ||
        !exactObjectKeys(input, ["projectId", "projectRepositoryLinkId"])) {
        return fail("REPOSITORY_MATERIAL_MODEL_GRANT_INVALID_INPUT");
      }
      const projectId = canonicalUuid(input.projectId);
      const projectRepositoryLinkId = canonicalUuid(input.projectRepositoryLinkId);
      return status(projectId, projectRepositoryLinkId, nowFactory());
    },

    async issue(input) {
      if (typeof input !== "object" || input === null || !exactObjectKeys(input, [
        "acknowledgeExternalModelTransfer",
        "acknowledgeProcessingRights",
        "consentVersion",
        "operations",
        "projectId",
        "projectRepositoryLinkId",
      ]) || input.acknowledgeExternalModelTransfer !== true ||
        input.acknowledgeProcessingRights !== true ||
        input.consentVersion !== REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION) {
        return fail("REPOSITORY_MATERIAL_MODEL_GRANT_INVALID_INPUT");
      }
      const projectId = canonicalUuid(input.projectId);
      const projectRepositoryLinkId = canonicalUuid(input.projectRepositoryLinkId);
      const operations = canonicalOperations(input.operations);
      const now = nowFactory();
      const expiresAt = new Date(
        now.getTime() + REPOSITORY_MATERIAL_MODEL_GRANT_LIFETIME_DAYS * 24 * 60 * 60 * 1_000,
      );

      await serializable(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"::text AS id
          FROM "ProjectRepositoryLink"
          WHERE "projectId" = ${projectId}::uuid
            AND "id" = ${projectRepositoryLinkId}::uuid
          FOR UPDATE
        `);
        if (locked.length !== 1) {
          const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
          return fail(project === null
            ? "REPOSITORY_MATERIAL_MODEL_GRANT_PROJECT_NOT_FOUND"
            : "REPOSITORY_MATERIAL_MODEL_GRANT_LINK_NOT_FOUND");
        }
        const boundary = await readBoundary(tx, projectId, projectRepositoryLinkId);
        const policy = await tx.projectAiPolicy.findUnique({
          where: { projectId },
          include: { currentRevision: { include: { operationProfiles: true } } },
        });
        const revision = policy?.currentRevision;
        if (revision === undefined || !revision.outboundEnabled) {
          return fail("REPOSITORY_MATERIAL_MODEL_GRANT_POLICY_INELIGIBLE");
        }
        const profiles = operations.map((operation) => {
          const profile = revision.operationProfiles.find((entry) => entry.operation === operation);
          if (profile === undefined || !operationEnabled(revision, operation)) {
            return fail("REPOSITORY_MATERIAL_MODEL_GRANT_POLICY_INELIGIBLE");
          }
          return Object.freeze({ operation, profile });
        });
        const expectedFingerprints = new Map(profiles.map(({ operation, profile }) => [
          operation,
          fingerprint("repository-material-model-grant", {
            consentVersion: REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
            issuedAt: now.toISOString(),
            expiresAt: expiresAt.toISOString(),
            projectId,
            projectRepositoryLinkId,
            operation,
            policyRevisionId: revision.id,
            effectivePolicyVersion: revision.revision,
            linkConfigVersion: boundary.linkConfigVersion,
            linkEffectivePolicyVersion: boundary.linkEffectivePolicyVersion,
            repositoryMaterialGenerationId: boundary.materialGenerationId,
            materialPolicyFingerprint: boundary.materialPolicyFingerprint,
            sourceManifestFingerprint: boundary.manifestFingerprint,
            scannerFingerprint: boundary.scannerFingerprint,
            profileFingerprint: profile.profileFingerprint,
            providerFingerprint: profile.providerFingerprint,
            modelFingerprint: profile.modelFingerprint,
            processorFingerprint: profile.processorFingerprint,
            endpointFingerprint: profile.endpointFingerprint,
          }),
        ]));
        const existing = await tx.repositoryMaterialModelGrant.findMany({
          where: {
            projectId,
            projectRepositoryLinkId,
            status: ModelProcessingGrantStatus.issued,
          },
        });
        const reusable = new Map(existing.filter((grant) =>
          operations.includes(grant.operation as RepositoryMaterialModelOperation) &&
          grant.expiresAt !== null && grant.expiresAt.getTime() > now.getTime() &&
          grant.policyRevisionId === revision.id &&
          grant.repositoryMaterialGenerationId === boundary.materialGenerationId &&
          grant.linkConfigVersion === boundary.linkConfigVersion &&
          grant.linkEffectivePolicyVersion === boundary.linkEffectivePolicyVersion &&
          grant.materialPolicyFingerprint === boundary.materialPolicyFingerprint &&
          grant.sourceManifestFingerprint === boundary.manifestFingerprint &&
          grant.scannerFingerprint === boundary.scannerFingerprint
        ).map((grant) => [grant.operation as RepositoryMaterialModelOperation, grant]));

        for (const grant of existing) {
          if (reusable.get(grant.operation as RepositoryMaterialModelOperation)?.id === grant.id) continue;
          const revoked = await tx.repositoryMaterialModelGrant.updateMany({
            where: { projectId, id: grant.id, status: ModelProcessingGrantStatus.issued },
            data: {
              status: ModelProcessingGrantStatus.revoked,
              revokedAt: now,
              revocationReasonCode: grant.expiresAt !== null && grant.expiresAt <= now
                ? ModelProcessingGrantRevocationReasonCode.expired
                : ModelProcessingGrantRevocationReasonCode.policyChanged,
              updatedAt: now,
            },
          });
          if (revoked.count !== 1) {
            return fail("REPOSITORY_MATERIAL_MODEL_GRANT_WRITE_CONFLICT");
          }
        }

        for (const { operation, profile } of profiles) {
          if (reusable.has(operation)) continue;
          const grantId = canonicalUuid(idFactory());
          await tx.repositoryMaterialModelGrant.create({
            data: {
              id: grantId,
              projectId,
              projectRepositoryLinkId,
              repositoryMaterialGenerationId: boundary.materialGenerationId,
              linkConfigVersion: boundary.linkConfigVersion,
              linkEffectivePolicyVersion: boundary.linkEffectivePolicyVersion,
              policyRevisionId: revision.id,
              effectivePolicyVersion: revision.revision,
              operation,
              status: ModelProcessingGrantStatus.draft,
              profileFingerprint: profile.profileFingerprint,
              providerFingerprint: profile.providerFingerprint,
              modelFingerprint: profile.modelFingerprint,
              modelId: profile.modelId,
              processorFingerprint: profile.processorFingerprint,
              regionFingerprint: profile.regionFingerprint,
              retentionFingerprint: profile.retentionFingerprint,
              endpointFingerprint: profile.endpointFingerprint,
              grantFingerprint: expectedFingerprints.get(operation)!,
              materialPolicyFingerprint: boundary.materialPolicyFingerprint,
              sourceManifestFingerprint: boundary.manifestFingerprint,
              scannerFingerprint: boundary.scannerFingerprint,
              scannerVersion: boundary.scannerVersion,
              consentVersion: REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
              sourceCount: boundary.sourceCount,
              sourceBytes: boundary.sourceBytes,
              issuedBy: "local:user",
              purposeCode: "repository-material-memory-v1",
              issuedAt: null,
              expiresAt: null,
              revokedAt: null,
              revocationReasonCode: null,
              updatedAt: now,
            },
          });
          await tx.repositoryMaterialModelGrantSource.createMany({
            data: boundary.entries.map((entry) => ({
              id: canonicalUuid(idFactory()),
              projectId,
              projectRepositoryLinkId,
              grantId,
              repositoryMaterialGenerationId: boundary.materialGenerationId,
              materialGenerationEntryId: entry.id,
              githubSourceVersionId: entry.githubSourceVersionId,
              projectSourceId: entry.projectSourceId,
              originScope: "repository_link",
              sourceRevisionKey: entry.sourceRevisionKey,
              sourceContentHash: entry.sourceContentHash,
              contentBytes: entry.sourceContentBytes,
            })),
          });
          const issued = await tx.repositoryMaterialModelGrant.updateMany({
            where: { projectId, id: grantId, status: ModelProcessingGrantStatus.draft },
            data: {
              status: ModelProcessingGrantStatus.issued,
              issuedAt: now,
              expiresAt,
              updatedAt: now,
            },
          });
          if (issued.count !== 1) {
            return fail("REPOSITORY_MATERIAL_MODEL_GRANT_WRITE_CONFLICT");
          }
        }
      });
      return status(projectId, projectRepositoryLinkId, now);
    },

    async revoke(input) {
      if (typeof input !== "object" || input === null ||
        !exactObjectKeys(input, ["projectId", "projectRepositoryLinkId"])) {
        return fail("REPOSITORY_MATERIAL_MODEL_GRANT_INVALID_INPUT");
      }
      const projectId = canonicalUuid(input.projectId);
      const projectRepositoryLinkId = canonicalUuid(input.projectRepositoryLinkId);
      const now = nowFactory();
      await serializable(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"::text AS id FROM "ProjectRepositoryLink"
          WHERE "projectId" = ${projectId}::uuid
            AND "id" = ${projectRepositoryLinkId}::uuid
          FOR UPDATE
        `);
        if (locked.length !== 1) {
          const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
          return fail(project === null
            ? "REPOSITORY_MATERIAL_MODEL_GRANT_PROJECT_NOT_FOUND"
            : "REPOSITORY_MATERIAL_MODEL_GRANT_LINK_NOT_FOUND");
        }
        const grants = await tx.repositoryMaterialModelGrant.findMany({
          where: { projectId, projectRepositoryLinkId, status: ModelProcessingGrantStatus.issued },
        });
        for (const grant of grants) {
          const revoked = await tx.repositoryMaterialModelGrant.updateMany({
            where: { projectId, id: grant.id, status: ModelProcessingGrantStatus.issued },
            data: {
              status: ModelProcessingGrantStatus.revoked,
              revokedAt: now,
              revocationReasonCode: ModelProcessingGrantRevocationReasonCode.userRequested,
              updatedAt: now,
            },
          });
          if (revoked.count !== 1) {
            return fail("REPOSITORY_MATERIAL_MODEL_GRANT_WRITE_CONFLICT");
          }
        }
      });
      return status(projectId, projectRepositoryLinkId, now);
    },
  });
}
