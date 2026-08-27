import { createHash, randomUUID } from "node:crypto";
import {
  GitHubConnectionStatus,
  Prisma,
  ProjectRepositoryLinkStatus,
  ProjectRepositoryRole,
  type PrismaClient,
} from "@prisma/client";
import type { VerifiedGitHubRepository } from "./read-only-client";

export const GITHUB_REPOSITORY_LEDGER_VERSION =
  "github-repository-ledger:v2" as const;
export const GITHUB_AUTH_REF = "github-token-file:v1" as const;
export const GITHUB_SOFT_EXCLUDE_CLASSES = Object.freeze([
  "vendor",
  "node_modules",
  "build",
  "dist",
  "coverage",
  "generated",
  "minified",
  "source_map",
  "lockfile",
] as const);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f]/u;
const TRANSACTION_RETRY_LIMIT = 3;
const LINK_CONFIG_FIELDS = Object.freeze([
  "codeEnabled",
  "includeRoots",
  "issuesEnabled",
  "markdownEnabled",
  "markdownPaths",
  "metadataEnabled",
  "pullRequestsEnabled",
  "readmeEnabled",
  "releasesEnabled",
  "requiredForProjectSnapshot",
  "role",
  "softExcludePatterns",
  "trackedRef",
] as const);
const REPOSITORY_FIELDS = Object.freeze([
  "archived",
  "defaultBranch",
  "disabled",
  "fullName",
  "name",
  "nodeId",
  "owner",
  "private",
  "repositoryId",
] as const);

type TransactionRunner = <T>(
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { isolationLevel: Prisma.TransactionIsolationLevel },
) => Promise<T>;

type GitHubSoftExcludeClass = (typeof GITHUB_SOFT_EXCLUDE_CLASSES)[number];

export type GitHubLedgerErrorCode =
  | "GITHUB_LEDGER_INVALID_INPUT"
  | "PROJECT_NOT_FOUND"
  | "GITHUB_REPOSITORY_IDENTITY_MISMATCH"
  | "GITHUB_LINK_NOT_FOUND"
  | "GITHUB_LINK_UNLINKED"
  | "GITHUB_LEDGER_WRITE_CONFLICT"
  | "GITHUB_LEDGER_INTEGRITY_ERROR";

export class GitHubLedgerError extends Error {
  constructor(readonly code: GitHubLedgerErrorCode) {
    super(code);
    this.name = "GitHubLedgerError";
  }
}

export type RepositoryLinkConfigInput = Readonly<{
  role: ProjectRepositoryRole;
  requiredForProjectSnapshot: boolean;
  trackedRef: string;
  codeEnabled: boolean;
  metadataEnabled: boolean;
  readmeEnabled: boolean;
  markdownEnabled: boolean;
  markdownPaths: readonly string[];
  issuesEnabled: boolean;
  pullRequestsEnabled: boolean;
  releasesEnabled: boolean;
  includeRoots: readonly string[];
  softExcludePatterns: readonly GitHubSoftExcludeClass[];
}>;

export type ConnectRepositoryInput = Readonly<{
  projectId: string;
  repository: VerifiedGitHubRepository;
  config: RepositoryLinkConfigInput;
}>;

export type RepositoryLinkStatus = Readonly<{
  id: string;
  projectId: string;
  status: ProjectRepositoryLinkStatus;
  eligible: boolean;
  effectivePolicyVersion: number;
  repository: Readonly<{
    repositoryId: string;
    nodeId: string;
    currentFullName: string;
    private: boolean;
    archived: boolean;
    disabled: boolean;
    defaultBranch: string;
    lastVerifiedAt: string;
  }>;
  config: Readonly<{
    version: number;
    role: ProjectRepositoryRole;
    requiredForProjectSnapshot: boolean;
    trackedRef: string;
    codeEnabled: boolean;
    metadataEnabled: boolean;
    readmeEnabled: boolean;
    markdownEnabled: boolean;
    markdownPaths: readonly string[];
    issuesEnabled: boolean;
    pullRequestsEnabled: boolean;
    releasesEnabled: boolean;
    includeRoots: readonly string[];
    softExcludePatterns: readonly GitHubSoftExcludeClass[];
    scanScopeFingerprint: string;
    policyFingerprint: string;
    effectivePolicyVersion: number;
  }>;
}>;

export interface GitHubRepositoryLedgerService {
  connect(input: unknown): Promise<RepositoryLinkStatus>;
  list(projectId: unknown): Promise<readonly RepositoryLinkStatus[]>;
  disable(input: unknown): Promise<RepositoryLinkStatus>;
  unlink(input: unknown): Promise<RepositoryLinkStatus>;
}

function fail(code: GitHubLedgerErrorCode): never {
  throw new GitHubLedgerError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]) &&
      actual.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
      });
  } catch {
    return false;
  }
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return value;
}

function canonicalText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string") return fail("GITHUB_LEDGER_INVALID_INPUT");
  let normalized: string;
  try {
    normalized = value.normalize("NFC");
  } catch {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  if (
    value.length === 0 ||
    normalized !== value ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return value;
}

function canonicalIncludeRoot(value: unknown): string {
  const root = canonicalText(value, 1_024);
  const segments = root.split("/");
  if (
    root.startsWith("/") ||
    root.endsWith("/") ||
    root.includes("//") ||
    root.includes("\\") ||
    segments.length > 32 ||
    segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)
  ) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return root;
}

function canonicalTrackedRef(value: unknown): string {
  const ref = canonicalText(value, 255);
  if (
    !ref.startsWith("refs/heads/") ||
    ["\\", "~", "^", ":", "?", "*", "["].some((character) => ref.includes(character)) ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock")
  ) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  const segments = ref.slice("refs/heads/".length).split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return ref;
}

function canonicalStringArray(
  value: unknown,
  maximumCount: number,
  mapper: (entry: unknown) => string,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumCount) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  const mapped = value.map(mapper).sort();
  if (Object.keys(value).length !== value.length || new Set(mapped).size !== mapped.length) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return Object.freeze(mapped);
}

function canonicalSoftExcludes(value: unknown): readonly GitHubSoftExcludeClass[] {
  const values = canonicalStringArray(value, GITHUB_SOFT_EXCLUDE_CLASSES.length, (entry) => {
    if (
      typeof entry !== "string" ||
      !GITHUB_SOFT_EXCLUDE_CLASSES.includes(entry as GitHubSoftExcludeClass)
    ) {
      return fail("GITHUB_LEDGER_INVALID_INPUT");
    }
    return entry;
  });
  return values as readonly GitHubSoftExcludeClass[];
}

function canonicalMarkdownPaths(value: unknown, enabled: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 100 || Object.keys(value).length !== value.length) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  const paths = value.map((entry) => {
    const path = canonicalIncludeRoot(entry);
    if (
      Buffer.byteLength(path, "utf8") > 480 ||
      !/\.(?:md|markdown)$/iu.test(path) ||
      ["*", "?", "[", "]"].some((character) => path.includes(character))
    ) {
      return fail("GITHUB_LEDGER_INVALID_INPUT");
    }
    return path;
  }).sort();
  if (enabled !== (paths.length > 0) || new Set(paths).size !== paths.length) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return Object.freeze(paths);
}

function canonicalRole(value: unknown): ProjectRepositoryRole {
  if (!Object.values(ProjectRepositoryRole).includes(value as ProjectRepositoryRole)) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return value as ProjectRepositoryRole;
}

function parseConfig(value: unknown): RepositoryLinkConfigInput {
  if (!isPlainRecord(value) || !exactKeys(value, LINK_CONFIG_FIELDS)) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  for (const field of [
    "requiredForProjectSnapshot",
    "codeEnabled",
    "metadataEnabled",
    "readmeEnabled",
    "markdownEnabled",
    "issuesEnabled",
    "pullRequestsEnabled",
    "releasesEnabled",
  ] as const) {
    if (typeof value[field] !== "boolean") return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  if (
    value.codeEnabled !== true &&
    value.metadataEnabled !== true &&
    value.readmeEnabled !== true &&
    value.markdownEnabled !== true &&
    value.issuesEnabled !== true &&
    value.pullRequestsEnabled !== true &&
    value.releasesEnabled !== true
  ) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return Object.freeze({
    role: canonicalRole(value.role),
    requiredForProjectSnapshot: value.requiredForProjectSnapshot as boolean,
    trackedRef: canonicalTrackedRef(value.trackedRef),
    codeEnabled: value.codeEnabled as boolean,
    metadataEnabled: value.metadataEnabled as boolean,
    readmeEnabled: value.readmeEnabled as boolean,
    markdownEnabled: value.markdownEnabled as boolean,
    markdownPaths: canonicalMarkdownPaths(
      value.markdownPaths,
      value.markdownEnabled as boolean,
    ),
    issuesEnabled: value.issuesEnabled as boolean,
    pullRequestsEnabled: value.pullRequestsEnabled as boolean,
    releasesEnabled: value.releasesEnabled as boolean,
    includeRoots: canonicalStringArray(value.includeRoots, 32, canonicalIncludeRoot),
    softExcludePatterns: canonicalSoftExcludes(value.softExcludePatterns),
  });
}

function parseRepository(value: unknown): VerifiedGitHubRepository {
  if (!isPlainRecord(value) || !exactKeys(value, REPOSITORY_FIELDS)) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  if (
    !Number.isSafeInteger(value.repositoryId) ||
    (value.repositoryId as number) < 1 ||
    typeof value.private !== "boolean" ||
    typeof value.archived !== "boolean" ||
    typeof value.disabled !== "boolean"
  ) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  const owner = canonicalText(value.owner, 256);
  const name = canonicalText(value.name, 256);
  const fullName = canonicalText(value.fullName, 512);
  if (fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return Object.freeze({
    repositoryId: value.repositoryId as number,
    nodeId: canonicalText(value.nodeId, 512),
    owner,
    name,
    fullName,
    private: value.private as boolean,
    archived: value.archived as boolean,
    disabled: value.disabled as boolean,
    defaultBranch: canonicalText(value.defaultBranch, 1_024),
  });
}

function parseConnectInput(value: unknown): ConnectRepositoryInput {
  if (!isPlainRecord(value) || !exactKeys(value, ["config", "projectId", "repository"])) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return Object.freeze({
    projectId: canonicalUuid(value.projectId),
    repository: parseRepository(value.repository),
    config: parseConfig(value.config),
  });
}

function parseLinkMutation(value: unknown): Readonly<{ projectId: string; linkId: string }> {
  if (!isPlainRecord(value) || !exactKeys(value, ["linkId", "projectId"])) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  return Object.freeze({
    projectId: canonicalUuid(value.projectId),
    linkId: canonicalUuid(value.linkId),
  });
}

function fingerprint(label: string, value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: GITHUB_REPOSITORY_LEDGER_VERSION, label, value }), "utf8")
    .digest("hex");
}

function configFingerprints(config: RepositoryLinkConfigInput): Readonly<{
  scanScopeFingerprint: string;
  policyFingerprint: string;
}> {
  return Object.freeze({
    scanScopeFingerprint: fingerprint("scan-scope", {
      trackedRef: config.trackedRef,
      includeRoots: config.includeRoots,
      softExcludePatterns: config.softExcludePatterns,
      codeEnabled: config.codeEnabled,
    }),
    policyFingerprint: fingerprint("link-policy", {
      role: config.role,
      requiredForProjectSnapshot: config.requiredForProjectSnapshot,
      metadataEnabled: config.metadataEnabled,
      readmeEnabled: config.readmeEnabled,
      markdownEnabled: config.markdownEnabled,
      markdownPaths: config.markdownPaths,
      issuesEnabled: config.issuesEnabled,
      pullRequestsEnabled: config.pullRequestsEnabled,
      releasesEnabled: config.releasesEnabled,
    }),
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

type LinkQueryRow = Readonly<{
  id: string;
  projectId: string;
  status: ProjectRepositoryLinkStatus;
  effectivePolicyVersion: number;
  githubRepository: Readonly<{
    githubRepositoryId: bigint;
    nodeId: string;
    currentFullName: string;
    isPrivate: boolean;
    isArchived: boolean;
    isDisabled: boolean;
    defaultBranch: string;
    lastVerifiedAt: Date;
  }>;
  configPointer: Readonly<{
    configVersion: number;
    effectivePolicyVersion: number;
    config: Readonly<{
      version: number;
      role: ProjectRepositoryRole;
      requiredForProjectSnapshot: boolean;
      trackedRef: string;
      codeEnabled: boolean;
      metadataEnabled: boolean;
      readmeEnabled: boolean;
      markdownEnabled: boolean;
      markdownPaths: unknown;
      issuesEnabled: boolean;
      pullRequestsEnabled: boolean;
      releasesEnabled: boolean;
      includeRoots: unknown;
      softExcludePatterns: unknown;
      scanScopeFingerprint: string;
      policyFingerprint: string;
      effectivePolicyVersion: number;
    }>;
  }> | null;
}>;

function projectStatus(row: LinkQueryRow): RepositoryLinkStatus {
  const pointer = row.configPointer;
  if (pointer === null) return fail("GITHUB_LEDGER_INTEGRITY_ERROR");
  const includeRoots = canonicalStringArray(pointer.config.includeRoots, 32, canonicalIncludeRoot);
  const softExcludePatterns = canonicalSoftExcludes(pointer.config.softExcludePatterns);
  const markdownPaths = canonicalMarkdownPaths(
    pointer.config.markdownPaths,
    pointer.config.markdownEnabled,
  );
  const eligible =
    row.status === ProjectRepositoryLinkStatus.active &&
    row.effectivePolicyVersion === pointer.effectivePolicyVersion &&
    pointer.config.effectivePolicyVersion === pointer.effectivePolicyVersion;
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    eligible,
    effectivePolicyVersion: row.effectivePolicyVersion,
    repository: Object.freeze({
      repositoryId: row.githubRepository.githubRepositoryId.toString(),
      nodeId: row.githubRepository.nodeId,
      currentFullName: row.githubRepository.currentFullName,
      private: row.githubRepository.isPrivate,
      archived: row.githubRepository.isArchived,
      disabled: row.githubRepository.isDisabled,
      defaultBranch: row.githubRepository.defaultBranch,
      lastVerifiedAt: row.githubRepository.lastVerifiedAt.toISOString(),
    }),
    config: Object.freeze({
      version: pointer.config.version,
      role: pointer.config.role,
      requiredForProjectSnapshot: pointer.config.requiredForProjectSnapshot,
      trackedRef: pointer.config.trackedRef,
      codeEnabled: pointer.config.codeEnabled,
      metadataEnabled: pointer.config.metadataEnabled,
      readmeEnabled: pointer.config.readmeEnabled,
      markdownEnabled: pointer.config.markdownEnabled,
      markdownPaths,
      issuesEnabled: pointer.config.issuesEnabled,
      pullRequestsEnabled: pointer.config.pullRequestsEnabled,
      releasesEnabled: pointer.config.releasesEnabled,
      includeRoots,
      softExcludePatterns,
      scanScopeFingerprint: pointer.config.scanScopeFingerprint,
      policyFingerprint: pointer.config.policyFingerprint,
      effectivePolicyVersion: pointer.config.effectivePolicyVersion,
    }),
  });
}

const LINK_INCLUDE = Prisma.validator<Prisma.ProjectRepositoryLinkInclude>()({
  githubRepository: true,
  configPointer: { include: { config: true } },
});

export function createGitHubRepositoryLedgerService(options: Readonly<{
  db: PrismaClient;
  idFactory?: () => string;
  now?: () => Date;
}>): GitHubRepositoryLedgerService {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function" ||
    (options.idFactory !== undefined && typeof options.idFactory !== "function") ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    return fail("GITHUB_LEDGER_INVALID_INPUT");
  }
  const transaction = options.db.$transaction.bind(options.db) as TransactionRunner;
  const idFactory = options.idFactory ?? randomUUID;
  const nowFactory = options.now ?? (() => new Date());
  const generatedId = (): string => canonicalUuid(idFactory());
  const currentTime = (): Date => {
    const value = nowFactory();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      return fail("GITHUB_LEDGER_INVALID_INPUT");
    }
    return new Date(value.getTime());
  };
  const serializable = async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
    for (let attempt = 0; attempt < TRANSACTION_RETRY_LIMIT; attempt += 1) {
      try {
        return await transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) &&
          attempt + 1 < TRANSACTION_RETRY_LIMIT
        ) {
          continue;
        }
        if (error instanceof GitHubLedgerError) throw error;
        if (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) {
          return fail("GITHUB_LEDGER_WRITE_CONFLICT");
        }
        if (isPrismaCode(error, "P2003") || isPrismaCode(error, "P2010")) {
          return fail("GITHUB_LEDGER_INTEGRITY_ERROR");
        }
        throw error;
      }
    }
    return fail("GITHUB_LEDGER_WRITE_CONFLICT");
  };

  const readLink = async (
    db: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    linkId: string,
  ): Promise<RepositoryLinkStatus> => {
    const row = await db.projectRepositoryLink.findUnique({
      where: { projectId_id: { projectId, id: linkId } },
      include: LINK_INCLUDE,
    });
    if (row === null) return fail("GITHUB_LINK_NOT_FOUND");
    return projectStatus(row as LinkQueryRow);
  };

  const service: GitHubRepositoryLedgerService = {
    async connect(value): Promise<RepositoryLinkStatus> {
      const input = parseConnectInput(value);
      const now = currentTime();
      const fingerprints = configFingerprints(input.config);
      const connectionFingerprint = fingerprint("connection", {
        projectId: input.projectId,
        authRef: GITHUB_AUTH_REF,
      });
      const linkId = generatedId();
      const connectionId = generatedId();
      const repositoryRecordId = generatedId();
      const configId = generatedId();
      return serializable(async (tx) => {
        const project = await tx.project.findUnique({
          where: { id: input.projectId },
          select: { id: true },
        });
        if (project === null) return fail("PROJECT_NOT_FOUND");

        const remoteId = BigInt(input.repository.repositoryId);
        const existingRepository = await tx.gitHubRepository.findUnique({
          where: { githubRepositoryId: remoteId },
        });
        if (
          existingRepository !== null &&
          existingRepository.nodeId !== input.repository.nodeId
        ) {
          return fail("GITHUB_REPOSITORY_IDENTITY_MISMATCH");
        }
        const repository = existingRepository === null
          ? await tx.gitHubRepository.create({
              data: {
                id: repositoryRecordId,
                githubRepositoryId: remoteId,
                nodeId: input.repository.nodeId,
                currentOwner: input.repository.owner,
                currentName: input.repository.name,
                currentFullName: input.repository.fullName,
                isPrivate: input.repository.private,
                isArchived: input.repository.archived,
                isDisabled: input.repository.disabled,
                defaultBranch: input.repository.defaultBranch,
                lastVerifiedAt: now,
                updatedAt: now,
              },
            })
          : await tx.gitHubRepository.update({
              where: { id: existingRepository.id },
              data: {
                currentOwner: input.repository.owner,
                currentName: input.repository.name,
                currentFullName: input.repository.fullName,
                isPrivate: input.repository.private,
                isArchived: input.repository.archived,
                isDisabled: input.repository.disabled,
                defaultBranch: input.repository.defaultBranch,
                lastVerifiedAt: now,
                updatedAt: now,
              },
            });

        const existingConnection = await tx.gitHubConnection.findUnique({
          where: {
            projectId_connectionFingerprint: {
              projectId: input.projectId,
              connectionFingerprint,
            },
          },
        });
        const connection = existingConnection === null
          ? await tx.gitHubConnection.create({
              data: {
                id: connectionId,
                projectId: input.projectId,
                authRef: GITHUB_AUTH_REF,
                status: GitHubConnectionStatus.verified,
                connectionFingerprint,
                verifiedAt: now,
                updatedAt: now,
              },
            })
          : await tx.gitHubConnection.update({
              where: { id: existingConnection.id },
              data: {
                status: GitHubConnectionStatus.verified,
                verifiedAt: now,
                disabledAt: null,
                updatedAt: now,
              },
            });

        const existingLink = await tx.projectRepositoryLink.findUnique({
          where: {
            projectId_githubRepositoryId: {
              projectId: input.projectId,
              githubRepositoryId: repository.id,
            },
          },
          include: LINK_INCLUDE,
        });
        if (existingLink?.status === ProjectRepositoryLinkStatus.unlinked) {
          return fail("GITHUB_LINK_UNLINKED");
        }

        if (existingLink === null) {
          await tx.projectRepositoryLink.create({
            data: {
              id: linkId,
              projectId: input.projectId,
              githubConnectionId: connection.id,
              githubRepositoryId: repository.id,
              status: ProjectRepositoryLinkStatus.active,
              effectivePolicyVersion: 1,
              updatedAt: now,
            },
          });
          await tx.projectRepositoryLinkConfigVersion.create({
            data: {
              id: configId,
              projectId: input.projectId,
              projectRepositoryLinkId: linkId,
              version: 1,
              ...input.config,
              includeRoots: [...input.config.includeRoots],
              softExcludePatterns: [...input.config.softExcludePatterns],
              ...fingerprints,
              effectivePolicyVersion: 1,
            },
          });
          await tx.projectRepositoryLinkConfigPointer.create({
            data: {
              projectId: input.projectId,
              projectRepositoryLinkId: linkId,
              configVersion: 1,
              effectivePolicyVersion: 1,
              updatedAt: now,
            },
          });
          return readLink(tx, input.projectId, linkId);
        }

        const pointer = existingLink.configPointer;
        if (pointer === null) return fail("GITHUB_LEDGER_INTEGRITY_ERROR");
        const current = pointer.config;
        const unchanged =
          existingLink.status === ProjectRepositoryLinkStatus.active &&
          existingLink.githubConnectionId === connection.id &&
          current.scanScopeFingerprint === fingerprints.scanScopeFingerprint &&
          current.policyFingerprint === fingerprints.policyFingerprint &&
          current.role === input.config.role &&
          current.requiredForProjectSnapshot === input.config.requiredForProjectSnapshot &&
          current.trackedRef === input.config.trackedRef;
        if (unchanged) return projectStatus(existingLink as LinkQueryRow);

        const nextConfigVersion = pointer.configVersion + 1;
        const nextPolicyVersion = existingLink.effectivePolicyVersion + 1;
        await tx.projectRepositoryLink.update({
          where: { projectId_id: { projectId: input.projectId, id: existingLink.id } },
          data: {
            githubConnectionId: connection.id,
            status: ProjectRepositoryLinkStatus.active,
            effectivePolicyVersion: nextPolicyVersion,
            disabledAt: null,
            updatedAt: now,
          },
        });
        await tx.projectRepositoryLinkConfigVersion.create({
          data: {
            id: configId,
            projectId: input.projectId,
            projectRepositoryLinkId: existingLink.id,
            version: nextConfigVersion,
            ...input.config,
            includeRoots: [...input.config.includeRoots],
            softExcludePatterns: [...input.config.softExcludePatterns],
            ...fingerprints,
            effectivePolicyVersion: nextPolicyVersion,
          },
        });
        await tx.projectRepositoryLinkConfigPointer.update({
          where: {
            projectId_projectRepositoryLinkId: {
              projectId: input.projectId,
              projectRepositoryLinkId: existingLink.id,
            },
          },
          data: {
            configVersion: nextConfigVersion,
            effectivePolicyVersion: nextPolicyVersion,
            updatedAt: now,
          },
        });
        return readLink(tx, input.projectId, existingLink.id);
      });
    },

    async list(projectIdValue): Promise<readonly RepositoryLinkStatus[]> {
      const projectId = canonicalUuid(projectIdValue);
      const project = await options.db.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      });
      if (project === null) return fail("PROJECT_NOT_FOUND");
      const rows = await options.db.projectRepositoryLink.findMany({
        where: { projectId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: LINK_INCLUDE,
      });
      return Object.freeze(rows.map((row) => projectStatus(row as LinkQueryRow)));
    },

    async disable(value): Promise<RepositoryLinkStatus> {
      const input = parseLinkMutation(value);
      const now = currentTime();
      return serializable(async (tx) => {
        const existing = await tx.projectRepositoryLink.findUnique({
          where: { projectId_id: { projectId: input.projectId, id: input.linkId } },
        });
        if (existing === null) return fail("GITHUB_LINK_NOT_FOUND");
        if (existing.status === ProjectRepositoryLinkStatus.unlinked) {
          return fail("GITHUB_LINK_UNLINKED");
        }
        if (existing.status !== ProjectRepositoryLinkStatus.disabled) {
          await tx.projectRepositoryLink.update({
            where: { projectId_id: { projectId: input.projectId, id: input.linkId } },
            data: {
              status: ProjectRepositoryLinkStatus.disabled,
              effectivePolicyVersion: existing.effectivePolicyVersion + 1,
              disabledAt: now,
              updatedAt: now,
            },
          });
        }
        return readLink(tx, input.projectId, input.linkId);
      });
    },

    async unlink(value): Promise<RepositoryLinkStatus> {
      const input = parseLinkMutation(value);
      const now = currentTime();
      return serializable(async (tx) => {
        const existing = await tx.projectRepositoryLink.findUnique({
          where: { projectId_id: { projectId: input.projectId, id: input.linkId } },
        });
        if (existing === null) return fail("GITHUB_LINK_NOT_FOUND");
        if (existing.status !== ProjectRepositoryLinkStatus.unlinked) {
          await tx.projectRepositoryLink.update({
            where: { projectId_id: { projectId: input.projectId, id: input.linkId } },
            data: {
              status: ProjectRepositoryLinkStatus.unlinked,
              effectivePolicyVersion: existing.effectivePolicyVersion + 1,
              disabledAt: null,
              unlinkedAt: now,
              updatedAt: now,
            },
          });
        }
        return readLink(tx, input.projectId, input.linkId);
      });
    },
  };
  return Object.freeze(service);
}
