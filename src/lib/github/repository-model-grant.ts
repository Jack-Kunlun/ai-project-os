import { createHash, randomUUID } from "node:crypto";
import {
  AiAuditEventType,
  AiOperation,
  ModelProcessingGrantRevocationReasonCode,
  ModelProcessingGrantStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

export const REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION =
  "repository-code-to-openai:v1" as const;
export const REPOSITORY_MODEL_GRANT_VERSION =
  "repository-model-grant:v1" as const;
export const REPOSITORY_MODEL_GRANT_LIFETIME_DAYS = 30 as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const TRANSACTION_RETRY_LIMIT = 3;
const SUPPORTED_OPERATIONS = Object.freeze([
  AiOperation.embedding,
  AiOperation.sourceSummary,
  AiOperation.projectAnalysis,
  AiOperation.generateWithContext,
] as const);

type RepositoryModelOperation = (typeof SUPPORTED_OPERATIONS)[number];

export type RepositoryModelGrantErrorCode =
  | "REPOSITORY_MODEL_GRANT_INVALID_INPUT"
  | "REPOSITORY_MODEL_GRANT_PROJECT_NOT_FOUND"
  | "REPOSITORY_MODEL_GRANT_LINK_NOT_FOUND"
  | "REPOSITORY_MODEL_GRANT_LINK_INELIGIBLE"
  | "REPOSITORY_MODEL_GRANT_CODE_NOT_READY"
  | "REPOSITORY_MODEL_GRANT_SCAN_BLOCKED"
  | "REPOSITORY_MODEL_GRANT_POLICY_INELIGIBLE"
  | "REPOSITORY_MODEL_GRANT_WRITE_CONFLICT";

export class RepositoryModelGrantError extends Error {
  constructor(readonly code: RepositoryModelGrantErrorCode) {
    super(code);
    this.name = "RepositoryModelGrantError";
  }
}

export type RepositoryModelGrantView = Readonly<{
  id: string;
  operation: RepositoryModelOperation;
  modelId: string;
  grantFingerprint: string;
  issuedAt: Date;
  expiresAt: Date;
}>;

export type RepositoryModelGrantStatus = Readonly<{
  projectId: string;
  projectRepositoryLinkId: string;
  eligibleCodeGeneration: Readonly<{
    id: string;
    frozenCommitSha: string;
    manifestFingerprint: string;
    scanScopeFingerprint: string;
    linkConfigVersion: number;
    linkEffectivePolicyVersion: number;
  }> | null;
  grants: readonly RepositoryModelGrantView[];
}>;

export type IssueRepositoryModelGrantsRequest = Readonly<{
  projectId: string;
  projectRepositoryLinkId: string;
  operations: readonly RepositoryModelOperation[];
  consentVersion: typeof REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION;
  acknowledgeExternalModelTransfer: true;
  acknowledgeProcessingRights: true;
}>;

type TransactionRunner = <T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { isolationLevel: Prisma.TransactionIsolationLevel },
) => Promise<T>;

type RepositoryBoundary = Readonly<{
  linkConfigVersion: number;
  linkEffectivePolicyVersion: number;
  codeGenerationId: string;
  frozenCommitSha: string;
  manifestFingerprint: string;
  scanScopeFingerprint: string;
  scannerVersion: string;
  fileCount: number;
  decodedTextBytes: number;
}>;

function fail(code: RepositoryModelGrantErrorCode): never {
  throw new RepositoryModelGrantError(code);
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("REPOSITORY_MODEL_GRANT_INVALID_INPUT");
  }
  return value;
}

function canonicalOperations(value: unknown): readonly RepositoryModelOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > SUPPORTED_OPERATIONS.length) {
    return fail("REPOSITORY_MODEL_GRANT_INVALID_INPUT");
  }
  const operations = value.map((operation) => {
    if (!SUPPORTED_OPERATIONS.includes(operation as RepositoryModelOperation)) {
      return fail("REPOSITORY_MODEL_GRANT_INVALID_INPUT");
    }
    return operation as RepositoryModelOperation;
  });
  if (new Set(operations).size !== operations.length) {
    return fail("REPOSITORY_MODEL_GRANT_INVALID_INPUT");
  }
  return Object.freeze([...operations].sort());
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
    .update(JSON.stringify({ version: REPOSITORY_MODEL_GRANT_VERSION, label, value }), "utf8")
    .digest("hex");
}

function operationEnabled(
  revision: Readonly<{
    embeddingEnabled: boolean;
    sourceSummaryEnabled: boolean;
    projectAnalysisEnabled: boolean;
    generateWithContextEnabled: boolean;
  }>,
  operation: RepositoryModelOperation,
): boolean {
  switch (operation) {
    case AiOperation.embedding:
      return revision.embeddingEnabled;
    case AiOperation.sourceSummary:
      return revision.sourceSummaryEnabled;
    case AiOperation.projectAnalysis:
      return revision.projectAnalysisEnabled;
    case AiOperation.generateWithContext:
      return revision.generateWithContextEnabled;
  }
}

function exactObjectKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index]);
}

async function readBoundary(
  tx: Prisma.TransactionClient,
  projectId: string,
  projectRepositoryLinkId: string,
): Promise<RepositoryBoundary> {
  const link = await tx.projectRepositoryLink.findUnique({
    where: { projectId_id: { projectId, id: projectRepositoryLinkId } },
    include: {
      configPointer: { include: { config: true } },
      codeGenerationPointer: { include: { generation: true } },
    },
  });
  if (link === null) {
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
    return fail(project === null
      ? "REPOSITORY_MODEL_GRANT_PROJECT_NOT_FOUND"
      : "REPOSITORY_MODEL_GRANT_LINK_NOT_FOUND");
  }
  if (
    link.status !== "active" ||
    link.configPointer === null ||
    link.codeGenerationPointer === null ||
    link.effectivePolicyVersion !== link.configPointer.effectivePolicyVersion ||
    link.configPointer.configVersion !== link.configPointer.config.version ||
    link.configPointer.effectivePolicyVersion !==
      link.configPointer.config.effectivePolicyVersion ||
    link.codeGenerationPointer.linkConfigVersion !== link.configPointer.configVersion ||
    link.codeGenerationPointer.effectivePolicyVersion !==
      link.configPointer.effectivePolicyVersion ||
    !link.configPointer.config.codeEnabled
  ) {
    return fail("REPOSITORY_MODEL_GRANT_LINK_INELIGIBLE");
  }
  const generation = link.codeGenerationPointer.generation;
  if (
    generation.status !== "codeReady" ||
    generation.id !== link.codeGenerationPointer.repositoryCodeGenerationId ||
    generation.linkConfigVersion !== link.configPointer.configVersion ||
    generation.effectivePolicyVersion !== link.configPointer.effectivePolicyVersion ||
    generation.scanScopeFingerprint !== link.configPointer.config.scanScopeFingerprint
  ) {
    return fail("REPOSITORY_MODEL_GRANT_CODE_NOT_READY");
  }
  if (generation.modelTransferScanResult !== "passed") {
    return fail("REPOSITORY_MODEL_GRANT_SCAN_BLOCKED");
  }
  if (
    !FINGERPRINT_PATTERN.test(generation.manifestFingerprint) ||
    !FINGERPRINT_PATTERN.test(generation.scanScopeFingerprint) ||
    generation.fileCount < 1 ||
    generation.decodedTextBytes < 1 ||
    generation.scannerVersion.length > 64
  ) {
    return fail("REPOSITORY_MODEL_GRANT_CODE_NOT_READY");
  }
  return Object.freeze({
    linkConfigVersion: generation.linkConfigVersion,
    linkEffectivePolicyVersion: generation.effectivePolicyVersion,
    codeGenerationId: generation.id,
    frozenCommitSha: generation.frozenCommitSha,
    manifestFingerprint: generation.manifestFingerprint,
    scanScopeFingerprint: generation.scanScopeFingerprint,
    scannerVersion: generation.scannerVersion,
    fileCount: generation.fileCount,
    decodedTextBytes: generation.decodedTextBytes,
  });
}

function grantView(grant: Readonly<{
  id: string;
  modelId: string;
  grantFingerprint: string;
  issuedAt: Date | null;
  expiresAt: Date | null;
  operations: readonly Readonly<{ operation: AiOperation }>[];
}>): RepositoryModelGrantView {
  const operation = grant.operations[0]?.operation;
  if (
    grant.operations.length !== 1 ||
    !SUPPORTED_OPERATIONS.includes(operation as RepositoryModelOperation) ||
    grant.issuedAt === null ||
    grant.expiresAt === null ||
    !FINGERPRINT_PATTERN.test(grant.grantFingerprint)
  ) {
    return fail("REPOSITORY_MODEL_GRANT_POLICY_INELIGIBLE");
  }
  return Object.freeze({
    id: grant.id,
    operation: operation as RepositoryModelOperation,
    modelId: grant.modelId,
    grantFingerprint: grant.grantFingerprint,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  });
}

export function createRepositoryModelGrantService(options: {
  db: PrismaClient;
  idFactory?: () => string;
  now?: () => Date;
}): {
  getStatus(input: Readonly<{
    projectId: string;
    projectRepositoryLinkId: string;
  }>): Promise<RepositoryModelGrantStatus>;
  issue(input: IssueRepositoryModelGrantsRequest): Promise<RepositoryModelGrantStatus>;
  revoke(input: Readonly<{
    projectId: string;
    projectRepositoryLinkId: string;
  }>): Promise<RepositoryModelGrantStatus>;
} {
  if (typeof options !== "object" || options === null || typeof options.db?.$transaction !== "function") {
    return fail("REPOSITORY_MODEL_GRANT_INVALID_INPUT");
  }
  const idFactory = options.idFactory ?? randomUUID;
  const nowFactory = options.now ?? (() => new Date());
  const runTransaction = options.db.$transaction.bind(options.db) as TransactionRunner;

  async function serializable<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < TRANSACTION_RETRY_LIMIT; attempt += 1) {
      try {
        return await runTransaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (error instanceof RepositoryModelGrantError) throw error;
        if (isPrismaCode(error, "P2034") && attempt + 1 < TRANSACTION_RETRY_LIMIT) continue;
        if (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) {
          return fail("REPOSITORY_MODEL_GRANT_WRITE_CONFLICT");
        }
        throw error;
      }
    }
    return fail("REPOSITORY_MODEL_GRANT_WRITE_CONFLICT");
  }

  async function status(
    projectId: string,
    projectRepositoryLinkId: string,
    at: Date,
  ): Promise<RepositoryModelGrantStatus> {
    const result = await options.db.$transaction(async (tx) => {
      let boundary: RepositoryBoundary | null = null;
      try {
        boundary = await readBoundary(tx, projectId, projectRepositoryLinkId);
      } catch (error) {
        if (
          error instanceof RepositoryModelGrantError &&
          [
            "REPOSITORY_MODEL_GRANT_LINK_INELIGIBLE",
            "REPOSITORY_MODEL_GRANT_CODE_NOT_READY",
            "REPOSITORY_MODEL_GRANT_SCAN_BLOCKED",
          ].includes(error.code)
        ) {
          boundary = null;
        } else {
          throw error;
        }
      }
      const grants = await tx.modelProcessingGrant.findMany({
        where: {
          projectId,
          projectRepositoryLinkId,
          sourceKind: "repository_code",
          status: ModelProcessingGrantStatus.issued,
          revokedAt: null,
          expiresAt: { gt: at },
        },
        include: { operations: true },
        orderBy: { createdAt: "asc" },
      });
      const policy = await tx.projectAiPolicy.findUnique({
        where: { projectId },
        select: {
          currentRevisionId: true,
          currentRevision: { select: { outboundEnabled: true, revision: true } },
        },
      });
      if (policy?.currentRevision.outboundEnabled !== true) boundary = null;
      const eligible = boundary === null || policy === null
        ? []
        : grants.filter((grant) =>
            grant.policyRevisionId === policy.currentRevisionId &&
            grant.effectivePolicyVersion === policy.currentRevision.revision &&
            grant.repositoryCodeGenerationId === boundary.codeGenerationId &&
            grant.linkConfigVersion === boundary.linkConfigVersion &&
            grant.linkEffectivePolicyVersion === boundary.linkEffectivePolicyVersion &&
            grant.scanScopeFingerprint === boundary.scanScopeFingerprint &&
            grant.sourceManifestFingerprint === boundary.manifestFingerprint);
      return Object.freeze({
        projectId,
        projectRepositoryLinkId,
        eligibleCodeGeneration: boundary === null
          ? null
          : Object.freeze({
              id: boundary.codeGenerationId,
              frozenCommitSha: boundary.frozenCommitSha,
              manifestFingerprint: boundary.manifestFingerprint,
              scanScopeFingerprint: boundary.scanScopeFingerprint,
              linkConfigVersion: boundary.linkConfigVersion,
              linkEffectivePolicyVersion: boundary.linkEffectivePolicyVersion,
            }),
        grants: Object.freeze(eligible.map(grantView)),
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return result;
  }

  return Object.freeze({
    async getStatus(input) {
      if (
        typeof input !== "object" || input === null ||
        !exactObjectKeys(input, ["projectId", "projectRepositoryLinkId"])
      ) {
        return fail("REPOSITORY_MODEL_GRANT_INVALID_INPUT");
      }
      const projectId = canonicalUuid(input.projectId);
      const projectRepositoryLinkId = canonicalUuid(input.projectRepositoryLinkId);
      return status(projectId, projectRepositoryLinkId, nowFactory());
    },

    async issue(input) {
      if (
        typeof input !== "object" || input === null ||
        !exactObjectKeys(input, [
          "acknowledgeExternalModelTransfer",
          "acknowledgeProcessingRights",
          "consentVersion",
          "operations",
          "projectId",
          "projectRepositoryLinkId",
        ]) ||
        input.acknowledgeExternalModelTransfer !== true ||
        input.acknowledgeProcessingRights !== true ||
        input.consentVersion !== REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION
      ) {
        return fail("REPOSITORY_MODEL_GRANT_INVALID_INPUT");
      }
      const projectId = canonicalUuid(input.projectId);
      const projectRepositoryLinkId = canonicalUuid(input.projectRepositoryLinkId);
      const operations = canonicalOperations(input.operations);
      const now = nowFactory();

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
            ? "REPOSITORY_MODEL_GRANT_PROJECT_NOT_FOUND"
            : "REPOSITORY_MODEL_GRANT_LINK_NOT_FOUND");
        }
        const boundary = await readBoundary(tx, projectId, projectRepositoryLinkId);
        const policy = await tx.projectAiPolicy.findUnique({
          where: { projectId },
          include: { currentRevision: { include: { operationProfiles: true } } },
        });
        const revision = policy?.currentRevision;
        if (revision === undefined || !revision.outboundEnabled) {
          return fail("REPOSITORY_MODEL_GRANT_POLICY_INELIGIBLE");
        }
        const profiles = operations.map((operation) => {
          const profile = revision.operationProfiles.find((entry) => entry.operation === operation);
          if (profile === undefined || !operationEnabled(revision, operation)) {
            return fail("REPOSITORY_MODEL_GRANT_POLICY_INELIGIBLE");
          }
          return Object.freeze({ operation, profile });
        });

        const expectedFingerprints = new Map(profiles.map(({ operation, profile }) => [
          operation,
          fingerprint("repository-model-grant", {
            consentVersion: REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
            projectId,
            projectRepositoryLinkId,
            operation,
            policyRevisionId: revision.id,
            effectivePolicyVersion: revision.revision,
            linkConfigVersion: boundary.linkConfigVersion,
            linkEffectivePolicyVersion: boundary.linkEffectivePolicyVersion,
            repositoryCodeGenerationId: boundary.codeGenerationId,
            scanScopeFingerprint: boundary.scanScopeFingerprint,
            sourceManifestFingerprint: boundary.manifestFingerprint,
            profileFingerprint: profile.profileFingerprint,
            providerFingerprint: profile.providerFingerprint,
            modelFingerprint: profile.modelFingerprint,
            processorFingerprint: profile.processorFingerprint,
            endpointFingerprint: profile.endpointFingerprint,
          }),
        ]));

        const existing = await tx.modelProcessingGrant.findMany({
          where: {
            projectId,
            projectRepositoryLinkId,
            sourceKind: "repository_code",
            status: ModelProcessingGrantStatus.issued,
          },
          include: { operations: true },
        });
        const reusable = existing.filter((grant) => {
          const operation = grant.operations[0]?.operation as RepositoryModelOperation | undefined;
          return grant.operations.length === 1 &&
            operation !== undefined &&
            expectedFingerprints.get(operation) === grant.grantFingerprint &&
            grant.expiresAt !== null && grant.expiresAt.getTime() > now.getTime() &&
            grant.policyRevisionId === revision.id &&
            grant.repositoryCodeGenerationId === boundary.codeGenerationId &&
            grant.linkConfigVersion === boundary.linkConfigVersion &&
            grant.linkEffectivePolicyVersion === boundary.linkEffectivePolicyVersion;
        });
        if (reusable.length === operations.length && existing.length === reusable.length) return;

        for (const grant of existing) {
          const revoked = await tx.modelProcessingGrant.updateMany({
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
          if (revoked.count !== 1) return fail("REPOSITORY_MODEL_GRANT_WRITE_CONFLICT");
          await tx.aiAuditEvent.create({
            data: {
              id: canonicalUuid(idFactory()),
              projectId,
              policyRevisionId: grant.policyRevisionId,
              eventType: AiAuditEventType.grantRevoked,
              eventFingerprint: grant.grantFingerprint,
              fingerprintCount: boundary.fileCount,
              byteCount: boundary.decodedTextBytes,
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
          now.getTime() + REPOSITORY_MODEL_GRANT_LIFETIME_DAYS * 24 * 60 * 60 * 1_000,
        );
        for (const { operation, profile } of profiles) {
          const grantId = canonicalUuid(idFactory());
          const grantFingerprint = expectedFingerprints.get(operation)!;
          await tx.modelProcessingGrant.create({
            data: {
              id: grantId,
              projectId,
              sourceKind: "repository_code",
              projectRepositoryLinkId,
              repositoryCodeGenerationId: boundary.codeGenerationId,
              linkConfigVersion: boundary.linkConfigVersion,
              linkEffectivePolicyVersion: boundary.linkEffectivePolicyVersion,
              scanScopeFingerprint: boundary.scanScopeFingerprint,
              sourceManifestFingerprint: boundary.manifestFingerprint,
              status: ModelProcessingGrantStatus.draft,
              policyRevisionId: revision.id,
              profileFingerprint: profile.profileFingerprint,
              providerFingerprint: profile.providerFingerprint,
              modelFingerprint: profile.modelFingerprint,
              modelId: profile.modelId,
              processorFingerprint: profile.processorFingerprint,
              regionFingerprint: profile.regionFingerprint,
              retentionFingerprint: profile.retentionFingerprint,
              endpointFingerprint: profile.endpointFingerprint,
              grantFingerprint,
              effectivePolicyVersion: revision.revision,
              budgetFingerprint: revision.budgetFingerprint,
              scannerFingerprint: revision.scannerFingerprint,
              scannerVersion: boundary.scannerVersion,
              budgetProfile: "standard",
              issuedBy: "local:user",
              purposeCode: "repository-memory-v1",
              issuedAt: null,
              expiresAt: null,
              revokedAt: null,
              revocationReasonCode: null,
              updatedAt: now,
              operations: {
                create: { id: canonicalUuid(idFactory()), operation },
              },
            },
          });
          const issued = await tx.modelProcessingGrant.updateMany({
            where: { projectId, id: grantId, status: ModelProcessingGrantStatus.draft },
            data: {
              status: ModelProcessingGrantStatus.issued,
              issuedAt: now,
              expiresAt,
              updatedAt: now,
            },
          });
          if (issued.count !== 1) return fail("REPOSITORY_MODEL_GRANT_WRITE_CONFLICT");
          await tx.aiAuditEvent.create({
            data: {
              id: canonicalUuid(idFactory()),
              projectId,
              policyRevisionId: revision.id,
              eventType: AiAuditEventType.grantIssued,
              eventFingerprint: grantFingerprint,
              fingerprintCount: boundary.fileCount,
              byteCount: boundary.decodedTextBytes,
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
      return status(projectId, projectRepositoryLinkId, now);
    },

    async revoke(input) {
      if (
        typeof input !== "object" || input === null ||
        !exactObjectKeys(input, ["projectId", "projectRepositoryLinkId"])
      ) {
        return fail("REPOSITORY_MODEL_GRANT_INVALID_INPUT");
      }
      const projectId = canonicalUuid(input.projectId);
      const projectRepositoryLinkId = canonicalUuid(input.projectRepositoryLinkId);
      const now = nowFactory();
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
            ? "REPOSITORY_MODEL_GRANT_PROJECT_NOT_FOUND"
            : "REPOSITORY_MODEL_GRANT_LINK_NOT_FOUND");
        }
        const grants = await tx.modelProcessingGrant.findMany({
          where: {
            projectId,
            projectRepositoryLinkId,
            sourceKind: "repository_code",
            status: ModelProcessingGrantStatus.issued,
          },
        });
        for (const grant of grants) {
          const revoked = await tx.modelProcessingGrant.updateMany({
            where: { projectId, id: grant.id, status: ModelProcessingGrantStatus.issued },
            data: {
              status: ModelProcessingGrantStatus.revoked,
              revokedAt: now,
              revocationReasonCode: ModelProcessingGrantRevocationReasonCode.userRequested,
              updatedAt: now,
            },
          });
          if (revoked.count !== 1) return fail("REPOSITORY_MODEL_GRANT_WRITE_CONFLICT");
          await tx.aiAuditEvent.create({
            data: {
              id: canonicalUuid(idFactory()),
              projectId,
              policyRevisionId: grant.policyRevisionId,
              eventType: AiAuditEventType.grantRevoked,
              eventFingerprint: grant.grantFingerprint,
              fingerprintCount: 0,
              byteCount: 0,
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
      return status(projectId, projectRepositoryLinkId, now);
    },
  });
}
