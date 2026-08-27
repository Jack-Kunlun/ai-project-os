import { Prisma, type PrismaClient } from "@prisma/client";

export const PROJECT_REPOSITORY_STATUS_VERSION =
  "project-repository-status:v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ProjectRepositoryStatusErrorCode =
  | "PROJECT_REPOSITORY_STATUS_INVALID_INPUT"
  | "PROJECT_REPOSITORY_STATUS_PROJECT_NOT_FOUND"
  | "PROJECT_REPOSITORY_STATUS_CONFLICT";

export class ProjectRepositoryStatusError extends Error {
  constructor(readonly code: ProjectRepositoryStatusErrorCode) {
    super(code);
    this.name = "ProjectRepositoryStatusError";
  }
}

export type ProjectRepositoryMemoryStatus = Readonly<{
  statusVersion: typeof PROJECT_REPOSITORY_STATUS_VERSION;
  configuredRepositoryCount: number;
  activeRepositoryCount: number;
  requiredRepositoryCount: number;
  readyRepositoryCount: number;
  projectCodeSnapshotId: string | null;
  projectRagSnapshot: Readonly<{
    id: string;
    requiredRepositoryCount: number;
    manualRagSnapshotId: string | null;
    publishedAt: string;
    ready: boolean;
  }> | null;
  repositories: readonly Readonly<{
    id: string;
    fullName: string;
    status: "active" | "disabled" | "unlinked" | "accessUnknown";
    eligible: boolean;
    role: "primary" | "application" | "infrastructure" | "library" | "documentation" | "other";
    requiredForProjectSnapshot: boolean;
    trackedRef: string;
    code: Readonly<{
      enabled: boolean;
      scanned: boolean;
      indexed: boolean;
    }>;
    materials: Readonly<{
      enabled: boolean;
      synced: boolean;
      indexed: boolean;
    }>;
    ragSnapshotId: string | null;
    ragReady: boolean;
  }>[];
}>;

type RepositoryRow = {
  id: string;
  fullName: string;
  status: string;
  effectivePolicyVersion: number;
  configVersion: number | null;
  configEffectivePolicyVersion: number | null;
  role: string | null;
  requiredForProjectSnapshot: boolean | null;
  trackedRef: string | null;
  codeEnabled: boolean | null;
  metadataEnabled: boolean | null;
  readmeEnabled: boolean | null;
  markdownEnabled: boolean | null;
  issuesEnabled: boolean | null;
  pullRequestsEnabled: boolean | null;
  releasesEnabled: boolean | null;
  codeGenerationStatus: string | null;
  codeGenerationConfigVersion: number | null;
  codeGenerationPolicyVersion: number | null;
  codeIndexStatus: string | null;
  codeIndexConfigVersion: number | null;
  codeIndexPolicyVersion: number | null;
  materialGenerationStatus: string | null;
  materialGenerationConfigVersion: number | null;
  materialGenerationPolicyVersion: number | null;
  materialIndexStatus: string | null;
  materialIndexConfigVersion: number | null;
  materialIndexPolicyVersion: number | null;
  ragSnapshotId: string | null;
  ragReady: boolean;
};

type ProjectSnapshotRow = {
  projectCodeSnapshotId: string | null;
  projectRagSnapshotId: string | null;
  requiredRepositoryCount: number | null;
  manualRagSnapshotId: string | null;
  publishedAt: Date | null;
  ragReady: boolean;
};

const VALID_LINK_STATUSES = new Set([
  "active",
  "disabled",
  "unlinked",
  "access_unknown",
]);
const VALID_ROLES = new Set([
  "primary",
  "application",
  "infrastructure",
  "library",
  "documentation",
  "other",
]);

function fail(code: ProjectRepositoryStatusErrorCode): never {
  throw new ProjectRepositoryStatusError(code);
}

function canonicalUuid(value: unknown): string {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value
    : fail("PROJECT_REPOSITORY_STATUS_INVALID_INPUT");
}

function statusRow(row: RepositoryRow) {
  if (
    !UUID_PATTERN.test(row.id) ||
    row.fullName.length === 0 ||
    !VALID_LINK_STATUSES.has(row.status) ||
    !VALID_ROLES.has(row.role ?? "") ||
    row.configVersion === null ||
    row.configEffectivePolicyVersion === null ||
    row.requiredForProjectSnapshot === null ||
    row.trackedRef === null ||
    row.codeEnabled === null
  ) {
    return fail("PROJECT_REPOSITORY_STATUS_CONFLICT");
  }
  const eligible = row.status === "active" &&
    row.effectivePolicyVersion === row.configEffectivePolicyVersion;
  const materialsEnabled = row.metadataEnabled === true ||
    row.readmeEnabled === true ||
    row.markdownEnabled === true ||
    row.issuesEnabled === true ||
    row.pullRequestsEnabled === true ||
    row.releasesEnabled === true;
  const codeScanned = row.codeEnabled &&
    row.codeGenerationStatus === "code_ready" &&
    row.codeGenerationConfigVersion === row.configVersion &&
    row.codeGenerationPolicyVersion === row.configEffectivePolicyVersion;
  const codeIndexed = codeScanned &&
    row.codeIndexStatus === "rag_ready" &&
    row.codeIndexConfigVersion === row.configVersion &&
    row.codeIndexPolicyVersion === row.configEffectivePolicyVersion;
  const materialsSynced = materialsEnabled &&
    row.materialGenerationStatus === "complete" &&
    row.materialGenerationConfigVersion === row.configVersion &&
    row.materialGenerationPolicyVersion === row.configEffectivePolicyVersion;
  const materialsIndexed = materialsSynced &&
    row.materialIndexStatus === "rag_ready" &&
    row.materialIndexConfigVersion === row.configVersion &&
    row.materialIndexPolicyVersion === row.configEffectivePolicyVersion;
  return Object.freeze({
    id: row.id,
    fullName: row.fullName,
    status: (
      row.status === "access_unknown" ? "accessUnknown" : row.status
    ) as ProjectRepositoryMemoryStatus["repositories"][number]["status"],
    eligible,
    role: row.role as ProjectRepositoryMemoryStatus["repositories"][number]["role"],
    requiredForProjectSnapshot: row.requiredForProjectSnapshot,
    trackedRef: row.trackedRef,
    code: Object.freeze({
      enabled: row.codeEnabled,
      scanned: codeScanned,
      indexed: codeIndexed,
    }),
    materials: Object.freeze({
      enabled: materialsEnabled,
      synced: materialsSynced,
      indexed: materialsIndexed,
    }),
    ragSnapshotId: row.ragSnapshotId,
    ragReady: row.ragReady === true,
  });
}

export function createProjectRepositoryStatusService(options: {
  db: PrismaClient;
}): Readonly<{
  getStatus(projectId: unknown): Promise<ProjectRepositoryMemoryStatus>;
}> {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function"
  ) {
    return fail("PROJECT_REPOSITORY_STATUS_INVALID_INPUT");
  }
  return Object.freeze({
    async getStatus(projectIdValue) {
      const projectId = canonicalUuid(projectIdValue);
      return options.db.$transaction(async (tx) => {
        const project = await tx.project.findUnique({
          where: { id: projectId },
          select: { id: true },
        });
        if (project === null) {
          return fail("PROJECT_REPOSITORY_STATUS_PROJECT_NOT_FOUND");
        }
        const [rows, projectRows] = await Promise.all([
          tx.$queryRaw<RepositoryRow[]>(Prisma.sql`
            SELECT
              link."id"::text AS "id",
              repository."currentFullName" AS "fullName",
              link."status"::text AS "status",
              link."effectivePolicyVersion",
              config_pointer."configVersion",
              config_pointer."effectivePolicyVersion"
                AS "configEffectivePolicyVersion",
              config."role"::text AS "role",
              config."requiredForProjectSnapshot",
              config."trackedRef",
              config."codeEnabled",
              config."metadataEnabled",
              config."readmeEnabled",
              config."markdownEnabled",
              config."issuesEnabled",
              config."pullRequestsEnabled",
              config."releasesEnabled",
              code_generation."status"::text AS "codeGenerationStatus",
              code_pointer."linkConfigVersion" AS "codeGenerationConfigVersion",
              code_pointer."effectivePolicyVersion" AS "codeGenerationPolicyVersion",
              code_index."status"::text AS "codeIndexStatus",
              code_index_pointer."linkConfigVersion" AS "codeIndexConfigVersion",
              code_index_pointer."effectivePolicyVersion" AS "codeIndexPolicyVersion",
              material_generation."status"::text AS "materialGenerationStatus",
              material_pointer."linkConfigVersion"
                AS "materialGenerationConfigVersion",
              material_pointer."effectivePolicyVersion"
                AS "materialGenerationPolicyVersion",
              material_index."status"::text AS "materialIndexStatus",
              material_index_pointer."linkConfigVersion"
                AS "materialIndexConfigVersion",
              material_index_pointer."effectivePolicyVersion"
                AS "materialIndexPolicyVersion",
              rag_pointer."repositoryRagSnapshotId"::text AS "ragSnapshotId",
              CASE
                WHEN rag_pointer."repositoryRagSnapshotId" IS NULL THEN false
                ELSE "repository_rag_snapshot_is_current"(
                  link."projectId",
                  link."id",
                  rag_pointer."repositoryRagSnapshotId"
                )
              END AS "ragReady"
            FROM "ProjectRepositoryLink" AS link
            JOIN "GitHubRepository" AS repository
              ON repository."id" = link."githubRepositoryId"
            LEFT JOIN "ProjectRepositoryLinkConfigPointer" AS config_pointer
              ON config_pointer."projectId" = link."projectId"
             AND config_pointer."projectRepositoryLinkId" = link."id"
            LEFT JOIN "ProjectRepositoryLinkConfigVersion" AS config
              ON config."projectId" = config_pointer."projectId"
             AND config."projectRepositoryLinkId" =
                 config_pointer."projectRepositoryLinkId"
             AND config."version" = config_pointer."configVersion"
             AND config."effectivePolicyVersion" =
                 config_pointer."effectivePolicyVersion"
            LEFT JOIN "RepositoryCodeGenerationPointer" AS code_pointer
              ON code_pointer."projectId" = link."projectId"
             AND code_pointer."projectRepositoryLinkId" = link."id"
            LEFT JOIN "RepositoryCodeGeneration" AS code_generation
              ON code_generation."projectId" = code_pointer."projectId"
             AND code_generation."projectRepositoryLinkId" =
                 code_pointer."projectRepositoryLinkId"
             AND code_generation."id" =
                 code_pointer."repositoryCodeGenerationId"
            LEFT JOIN "RepositoryCodeIndexPointer" AS code_index_pointer
              ON code_index_pointer."projectId" = link."projectId"
             AND code_index_pointer."projectRepositoryLinkId" = link."id"
            LEFT JOIN "IndexGeneration" AS code_index
              ON code_index."projectId" = code_index_pointer."projectId"
             AND code_index."id" = code_index_pointer."indexGenerationId"
            LEFT JOIN "RepositoryMaterialGenerationPointer" AS material_pointer
              ON material_pointer."projectId" = link."projectId"
             AND material_pointer."projectRepositoryLinkId" = link."id"
            LEFT JOIN "RepositoryMaterialGeneration" AS material_generation
              ON material_generation."projectId" = material_pointer."projectId"
             AND material_generation."projectRepositoryLinkId" =
                 material_pointer."projectRepositoryLinkId"
             AND material_generation."id" =
                 material_pointer."repositoryMaterialGenerationId"
            LEFT JOIN "RepositoryMaterialIndexPointer" AS material_index_pointer
              ON material_index_pointer."projectId" = link."projectId"
             AND material_index_pointer."projectRepositoryLinkId" = link."id"
            LEFT JOIN "RepositoryMaterialIndexGeneration" AS material_index
              ON material_index."projectId" = material_index_pointer."projectId"
             AND material_index."projectRepositoryLinkId" =
                 material_index_pointer."projectRepositoryLinkId"
             AND material_index."id" =
                 material_index_pointer."indexGenerationId"
            LEFT JOIN "RepositoryRagSnapshotPointer" AS rag_pointer
              ON rag_pointer."projectId" = link."projectId"
             AND rag_pointer."projectRepositoryLinkId" = link."id"
            WHERE link."projectId" = ${projectId}::uuid
            ORDER BY link."createdAt", link."id"
          `),
          tx.$queryRaw<ProjectSnapshotRow[]>(Prisma.sql`
            SELECT
              code_pointer."projectCodeSnapshotId"::text
                AS "projectCodeSnapshotId",
              rag_pointer."projectRepositoryRagSnapshotId"::text
                AS "projectRagSnapshotId",
              rag_snapshot."requiredRepositoryCount",
              rag_snapshot."manualRagSnapshotId"::text AS "manualRagSnapshotId",
              rag_pointer."publishedAt",
              CASE
                WHEN rag_pointer."projectRepositoryRagSnapshotId" IS NULL
                  THEN false
                ELSE "project_repository_rag_snapshot_is_current"(
                  project."id",
                  rag_pointer."projectRepositoryRagSnapshotId"
                )
              END AS "ragReady"
            FROM "Project" AS project
            LEFT JOIN "ProjectCodeSnapshotPointer" AS code_pointer
              ON code_pointer."projectId" = project."id"
            LEFT JOIN "ProjectRepositoryRagSnapshotPointer" AS rag_pointer
              ON rag_pointer."projectId" = project."id"
            LEFT JOIN "ProjectRepositoryRagSnapshot" AS rag_snapshot
              ON rag_snapshot."projectId" = rag_pointer."projectId"
             AND rag_snapshot."id" =
                 rag_pointer."projectRepositoryRagSnapshotId"
            WHERE project."id" = ${projectId}::uuid
          `),
        ]);
        if (projectRows.length !== 1) {
          return fail("PROJECT_REPOSITORY_STATUS_CONFLICT");
        }
        const repositories = Object.freeze(rows.map(statusRow));
        const projectRow = projectRows[0]!;
        const projectRagSnapshot = projectRow.projectRagSnapshotId === null
          ? null
          : projectRow.requiredRepositoryCount !== null &&
              projectRow.publishedAt instanceof Date
            ? Object.freeze({
                id: projectRow.projectRagSnapshotId,
                requiredRepositoryCount: projectRow.requiredRepositoryCount,
                manualRagSnapshotId: projectRow.manualRagSnapshotId,
                publishedAt: projectRow.publishedAt.toISOString(),
                ready: projectRow.ragReady === true,
              })
            : fail("PROJECT_REPOSITORY_STATUS_CONFLICT");
        return Object.freeze({
          statusVersion: PROJECT_REPOSITORY_STATUS_VERSION,
          configuredRepositoryCount: repositories.length,
          activeRepositoryCount: repositories.filter(
            (row) => row.status === "active",
          ).length,
          requiredRepositoryCount: repositories.filter(
            (row) => row.eligible && row.requiredForProjectSnapshot,
          ).length,
          readyRepositoryCount: repositories.filter((row) => row.ragReady).length,
          projectCodeSnapshotId: projectRow.projectCodeSnapshotId,
          projectRagSnapshot,
          repositories,
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },
  });
}
