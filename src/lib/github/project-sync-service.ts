import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type AppUser,
  type PrismaClient,
  type ProjectGitHubSyncChangeType,
  type ProjectGitHubSyncEntryKind,
  type ProjectGitHubSyncEntryStatus,
  type ProjectGitHubSyncRunStatus,
  type ProjectGitHubSyncStage,
} from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  claimProjectJob,
  failProjectJob,
  finishProjectJob,
  getProjectJob,
  isLeaseExpired,
  isUncertainProviderDispatch,
  markProjectJobUnknown,
  markProviderAcknowledged,
  markProviderDispatched,
  startProjectJobHeartbeat,
  toPublicProjectJob,
  withProjectJobLock,
  type PublicProjectJob,
} from "@/lib/project-workflow";
import {
  createGitHubCodeScanService,
  type FrozenProjectCodeScanTarget,
  type GitHubCodeScanService,
  type ProjectCodeScanBatchView,
} from "./code-scan-service";
import {
  createGitHubMaterialSyncService,
  type FrozenRepositoryMaterialSyncTarget,
  type GitHubMaterialSyncService,
  type RepositoryMaterialSyncView,
} from "./material-sync-service";
import {
  loadGitHubClientForCredential,
  type WebGitHubCredentialClient,
} from "@/lib/web-github";
import { jsonValue } from "@/lib/web-github";
import {
  hasBlockingUnknownProjectCodeBatch,
  hasBlockingUnknownProjectMaterialRun,
  hasBlockingUnknownProjectSyncRun,
  lockGitHubProject,
} from "./project-sync-lock";

export const PROJECT_GITHUB_SYNC_SERVICE_VERSION =
  "project-github-sync-service:v1" as const;
export const PROJECT_GITHUB_SYNC_DEADLINE_MS = 240_000 as const;
export const PROJECT_GITHUB_SYNC_CHANGE_PAGE_SIZE = 100 as const;
export const PROJECT_GITHUB_SYNC_CHANGE_PAGE_MAX = 200 as const;

/** Server-only seams used by the disposable PostgreSQL runner. HTTP callers
 * cannot provide these callbacks; the default path always resolves the
 * encrypted credential and uses the real clock/client loader. */
export type ProjectGitHubSyncRuntime = Readonly<{
  now?: () => number;
  loadClientForCredential?: (input: Readonly<{
    credentialId: string;
    expectedSecretFingerprint: string;
    absoluteDeadlineAt: Date;
  }>) => Promise<WebGitHubCredentialClient>;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const clientKeySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const TRANSACTION_RETRY_LIMIT = 3;

export type ProjectGitHubSyncErrorCode =
  | "PROJECT_GITHUB_SYNC_INVALID_INPUT"
  | "PROJECT_GITHUB_SYNC_PROJECT_NOT_FOUND"
  | "PROJECT_GITHUB_SYNC_RUN_NOT_FOUND"
  | "PROJECT_GITHUB_SYNC_ALREADY_RUNNING"
  | "PROJECT_GITHUB_SYNC_DIRECT_OPERATION_ACTIVE"
  | "PROJECT_GITHUB_SYNC_NO_ENABLED_TARGETS"
  | "PROJECT_GITHUB_SYNC_SCOPE_CONFLICT"
  | "PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED"
  | "PROJECT_GITHUB_SYNC_RECONCILIATION_REQUIRED"
  | "PROJECT_GITHUB_SYNC_RECONCILIATION_NOT_DUE"
  | "PROJECT_GITHUB_SYNC_CANCEL_NOT_ALLOWED"
  | "PROJECT_GITHUB_SYNC_WRITE_CONFLICT"
  | "PROJECT_GITHUB_SYNC_INTEGRITY_ERROR";

export class ProjectGitHubSyncError extends Error {
  constructor(readonly code: ProjectGitHubSyncErrorCode) {
    super(code);
    this.name = "ProjectGitHubSyncError";
  }
}

export type ProjectGitHubSyncChangeView = Readonly<{
  id: string;
  targetKind: "code" | "material";
  targetKey: string;
  identity: string;
  changeType: "added" | "updated" | "deleted" | "unchanged" | "withheld";
  normalizedPath: string | null;
  materialKind: string | null;
  remoteIdentity: string | null;
  beforeContentHash: string | null;
  afterContentHash: string | null;
  beforeRevisionFingerprint: string | null;
  afterRevisionFingerprint: string | null;
  createdAt: string;
}>;

export type ProjectGitHubSyncEntryView = Readonly<{
  id: string;
  targetKind: "code" | "material";
  targetKey: string;
  status: "pending" | "running" | "succeeded" | "partial" | "failed" | "rateLimited" | "unknown" | "skipped";
  repositoryFullName: string;
  configVersion: number;
  effectivePolicyVersion: number;
  requiredForProjectSnapshot: boolean;
  trackedRef: string;
  beforeCodeGenerationId: string | null;
  beforeMaterialGenerationId: string | null;
  childCodeBatchId: string | null;
  childMaterialSyncRunId: string | null;
  warning: string | null;
  failureCode: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}>;

export type PublicProjectGitHubSyncRun = Readonly<{
  id: string;
  projectId: string;
  parentJobId: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "rateLimited" | "unknown" | "cancelled";
  stage: "queued" | "freezing" | "code" | "material" | "finalizing" | "terminal";
  scopeFingerprint: string;
  manifestFingerprint: string | null;
  deadlineAt: string;
  codeTargetCount: number;
  materialTargetCount: number;
  completedCodeTargetCount: number;
  completedMaterialTargetCount: number;
  counts: Readonly<{
    added: number;
    updated: number;
    deleted: number;
    unchanged: number;
    withheld: number;
  }>;
  warnings: readonly string[];
  failureCode: string | null;
  reconciliationRequired: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  entries: readonly ProjectGitHubSyncEntryView[];
  changes: readonly ProjectGitHubSyncChangeView[];
  changeOffset: number;
  changeLimit: number;
  changeTotal: number;
  hasMoreChanges: boolean;
}>;

type SyncDb = PrismaClient | Prisma.TransactionClient;

type FrozenScopeEntry = Readonly<{
  id: string;
  projectId: string;
  projectRepositoryLinkId: string;
  githubConnectionId: string;
  credentialId: string;
  credentialSecretFingerprint: string;
  ordinal: number;
  targetKind: "code" | "material";
  targetKey: string;
  githubRepositoryId: bigint;
  repositoryNodeId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryFullName: string;
  configVersion: number;
  effectivePolicyVersion: number;
  requiredForProjectSnapshot: boolean;
  trackedRef: string;
  scanScopeFingerprint: string;
  policyFingerprint: string;
  configSnapshot: Record<string, unknown>;
  beforeCodeGenerationId: string | null;
  beforeMaterialGenerationId: string | null;
}>;

type FrozenScope = Readonly<{
  projectId: string;
  entries: readonly FrozenScopeEntry[];
  codeTargets: readonly FrozenScopeEntry[];
  materialTargets: readonly FrozenScopeEntry[];
  scopeFingerprint: string;
}>;

type ChangeItem = Readonly<{
  targetKey?: string;
  identity: string;
  normalizedPath: string | null;
  materialKind: string | null;
  remoteIdentity: string | null;
  contentHash: string | null;
  revisionFingerprint: string | null;
}>;

type ChangeDiff = Readonly<{
  targetKind?: ProjectGitHubSyncEntryKind;
  targetKey?: string;
  identity: string;
  changeType: ProjectGitHubSyncChangeType;
  normalizedPath: string | null;
  materialKind: string | null;
  remoteIdentity: string | null;
  beforeContentHash: string | null;
  afterContentHash: string | null;
  beforeRevisionFingerprint: string | null;
  afterRevisionFingerprint: string | null;
}>;

function fail(code: ProjectGitHubSyncErrorCode): never {
  throw new ProjectGitHubSyncError(code);
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === code;
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("PROJECT_GITHUB_SYNC_INVALID_INPUT");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function codeRevisionFingerprint(value: Readonly<{
  blobOid: string;
  contentHash: string;
  mode: string;
  contentBytes: number;
  lineCount: number;
}>): string {
  return sha256(canonicalJson({
    blobOid: value.blobOid,
    contentHash: value.contentHash,
    mode: value.mode,
    contentBytes: value.contentBytes,
    lineCount: value.lineCount,
  }));
}

function materialQuarantineFingerprint(value: Readonly<{
  materialKind: string;
  remoteIdentity: string;
  remoteRevisionFingerprint: string;
}>): string {
  return sha256(canonicalJson({
    materialKind: value.materialKind,
    remoteIdentity: value.remoteIdentity,
    remoteRevisionFingerprint: value.remoteRevisionFingerprint,
  }));
}

function syncFingerprint(label: string, value: unknown): string {
  return sha256(canonicalJson({ version: PROJECT_GITHUB_SYNC_SERVICE_VERSION, label, value }));
}

function safeDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
  return new Date(value.getTime());
}

function safeHash(value: unknown): string | null {
  return typeof value === "string" && HASH_PATTERN.test(value) ? value : null;
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9_]{3,64}$/.test(value) ? value : null;
}

function safeWarnings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const result = value.filter((item): item is string => typeof item === "string" && /^[A-Z0-9_]{3,64}$/.test(item)).slice(0, 100);
  return Object.freeze(result);
}

function iso(value: Date | null): string | null {
  return value === null ? null : safeDate(value).toISOString();
}

function statusView(value: ProjectGitHubSyncRunStatus): PublicProjectGitHubSyncRun["status"] {
  return value === "rateLimited" ? "rateLimited" : value;
}

function entryStatusView(value: ProjectGitHubSyncEntryStatus): ProjectGitHubSyncEntryView["status"] {
  return value === "rateLimited" ? "rateLimited" : value;
}

function stageView(value: ProjectGitHubSyncStage): PublicProjectGitHubSyncRun["stage"] {
  return value;
}

function changeView(row: {
  id: string;
  targetKind: ProjectGitHubSyncEntryKind;
  targetKey: string;
  identity: string;
  changeType: ProjectGitHubSyncChangeType;
  normalizedPath: string | null;
  materialKind: string | null;
  remoteIdentity: string | null;
  beforeContentHash: string | null;
  afterContentHash: string | null;
  beforeRevisionFingerprint: string | null;
  afterRevisionFingerprint: string | null;
  createdAt: Date;
}): ProjectGitHubSyncChangeView {
  return Object.freeze({
    id: row.id,
    targetKind: row.targetKind,
    targetKey: row.targetKey,
    identity: row.identity,
    changeType: row.changeType,
    normalizedPath: row.normalizedPath,
    materialKind: row.materialKind,
    remoteIdentity: row.remoteIdentity,
    beforeContentHash: safeHash(row.beforeContentHash),
    afterContentHash: safeHash(row.afterContentHash),
    beforeRevisionFingerprint: safeHash(row.beforeRevisionFingerprint),
    afterRevisionFingerprint: safeHash(row.afterRevisionFingerprint),
    createdAt: safeDate(row.createdAt).toISOString(),
  });
}

function entryView(row: {
  id: string;
  targetKind: ProjectGitHubSyncEntryKind;
  targetKey: string;
  status: ProjectGitHubSyncEntryStatus;
  repositoryFullName: string;
  configVersion: number;
  effectivePolicyVersion: number;
  requiredForProjectSnapshot: boolean;
  trackedRef: string;
  beforeCodeGenerationId: string | null;
  beforeMaterialGenerationId: string | null;
  childCodeBatchId: string | null;
  childMaterialSyncRunId: string | null;
  warning: string | null;
  failureCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): ProjectGitHubSyncEntryView {
  return Object.freeze({
    id: row.id,
    targetKind: row.targetKind,
    targetKey: row.targetKey,
    status: entryStatusView(row.status),
    repositoryFullName: row.repositoryFullName,
    configVersion: row.configVersion,
    effectivePolicyVersion: row.effectivePolicyVersion,
    requiredForProjectSnapshot: row.requiredForProjectSnapshot,
    trackedRef: row.trackedRef,
    beforeCodeGenerationId: row.beforeCodeGenerationId,
    beforeMaterialGenerationId: row.beforeMaterialGenerationId,
    childCodeBatchId: row.childCodeBatchId,
    childMaterialSyncRunId: row.childMaterialSyncRunId,
    warning: safeCode(row.warning),
    failureCode: safeCode(row.failureCode),
    createdAt: safeDate(row.createdAt).toISOString(),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
  });
}

type PublicRunRow = {
  id: string;
  projectId: string;
  parentJobId: string;
  status: ProjectGitHubSyncRunStatus;
  stage: ProjectGitHubSyncStage;
  scopeFingerprint: string;
  manifestFingerprint: string | null;
  deadlineAt: Date;
  codeTargetCount: number;
  materialTargetCount: number;
  completedCodeTargetCount: number;
  completedMaterialTargetCount: number;
  addedCount: number;
  updatedCount: number;
  deletedCount: number;
  unchangedCount: number;
  withheldCount: number;
  warnings: unknown;
  failureCode: string | null;
  reconciliationRequired: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  entries: readonly Parameters<typeof entryView>[0][];
  changes: readonly Parameters<typeof changeView>[0][];
};

export function toPublicProjectGitHubSyncRun(
  row: PublicRunRow,
  page: Readonly<{ offset?: number; limit?: number; total?: number }> = {},
): PublicProjectGitHubSyncRun {
  const offset = Number.isSafeInteger(page.offset) && page.offset !== undefined && page.offset >= 0 ? page.offset : 0;
  const limit = Number.isSafeInteger(page.limit) && page.limit !== undefined && page.limit > 0
    ? Math.min(page.limit, PROJECT_GITHUB_SYNC_CHANGE_PAGE_MAX)
    : PROJECT_GITHUB_SYNC_CHANGE_PAGE_SIZE;
  const total = Number.isSafeInteger(page.total) && page.total !== undefined && page.total >= 0
    ? page.total
    : row.changes.length;
  const scopeFingerprint = safeHash(row.scopeFingerprint);
  if (scopeFingerprint === null) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    parentJobId: row.parentJobId,
    status: statusView(row.status),
    stage: stageView(row.stage),
    scopeFingerprint,
    manifestFingerprint: safeHash(row.manifestFingerprint),
    deadlineAt: safeDate(row.deadlineAt).toISOString(),
    codeTargetCount: row.codeTargetCount,
    materialTargetCount: row.materialTargetCount,
    completedCodeTargetCount: row.completedCodeTargetCount,
    completedMaterialTargetCount: row.completedMaterialTargetCount,
    counts: Object.freeze({
      added: row.addedCount,
      updated: row.updatedCount,
      deleted: row.deletedCount,
      unchanged: row.unchangedCount,
      withheld: row.withheldCount,
    }),
    warnings: safeWarnings(row.warnings),
    failureCode: safeCode(row.failureCode),
    reconciliationRequired: row.reconciliationRequired === true,
    createdAt: safeDate(row.createdAt).toISOString(),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    entries: Object.freeze(row.entries.map(entryView)),
    changes: Object.freeze(row.changes.map(changeView)),
    changeOffset: offset,
    changeLimit: limit,
    changeTotal: total,
    hasMoreChanges: offset + row.changes.length < total,
  });
}

const RUN_INCLUDE = Prisma.validator<Prisma.ProjectGitHubSyncRunInclude>()({
  entries: { orderBy: [{ ordinal: "asc" }] },
  changes: { orderBy: [{ targetKind: "asc" }, { identity: "asc" }, { id: "asc" }] },
});

function parseRunInput(value: unknown): Readonly<{ projectId: string; syncRunId: string }> {
  if (!isRecord(value) || !exactKeys(value, ["projectId", "syncRunId"])) return fail("PROJECT_GITHUB_SYNC_INVALID_INPUT");
  return Object.freeze({ projectId: canonicalUuid(value.projectId), syncRunId: canonicalUuid(value.syncRunId) });
}

function parseStartInput(value: unknown): Readonly<{ projectId: string; requestedById: string; clientKey: string }> {
  if (!isRecord(value) || !exactKeys(value, ["clientKey", "projectId", "requestedById"])) return fail("PROJECT_GITHUB_SYNC_INVALID_INPUT");
  const parsed = clientKeySchema.safeParse(value.clientKey);
  if (!parsed.success) return fail("PROJECT_GITHUB_SYNC_INVALID_INPUT");
  return Object.freeze({
    projectId: canonicalUuid(value.projectId),
    requestedById: canonicalUuid(value.requestedById),
    clientKey: parsed.data,
  });
}

function idempotencyHash(projectId: string, clientKey: string): string {
  return sha256(`githubProjectSync:${projectId}:${clientKey}`);
}

function materialEnabled(config: Record<string, unknown>): boolean {
  return config.metadataEnabled === true || config.readmeEnabled === true ||
    config.markdownEnabled === true || config.issuesEnabled === true ||
    config.pullRequestsEnabled === true || config.releasesEnabled === true;
}

function safeConfigSnapshot(config: Record<string, unknown>): Record<string, unknown> {
  const fields = [
    "role", "requiredForProjectSnapshot", "trackedRef", "codeEnabled", "metadataEnabled",
    "readmeEnabled", "markdownEnabled", "markdownPaths", "issuesEnabled", "pullRequestsEnabled",
    "releasesEnabled", "includeRoots", "softExcludePatterns", "scanScopeFingerprint",
    "policyFingerprint", "effectivePolicyVersion",
  ] as const;
  const snapshot: Record<string, unknown> = {};
  for (const field of fields) snapshot[field] = config[field];
  return JSON.parse(canonicalJson(snapshot)) as Record<string, unknown>;
}

function configRowSnapshot(row: {
  role: unknown;
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
}): Record<string, unknown> {
  return safeConfigSnapshot(row as unknown as Record<string, unknown>);
}

async function transactionRetry<T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < TRANSACTION_RETRY_LIMIT; attempt += 1) {
    try {
      return await db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if ((isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) && attempt + 1 < TRANSACTION_RETRY_LIMIT) continue;
      if (isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034")) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
      if (isPrismaCode(error, "P2003") || isPrismaCode(error, "P2010")) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
      throw error;
    }
  }
  return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
}

type SyncChangePage = Readonly<{ offset: number; limit: number }>;

function normalizeChangePage(value: Readonly<{ offset?: number; limit?: number }> = {}): SyncChangePage {
  const offset = value.offset ?? 0;
  const requestedLimit = value.limit ?? PROJECT_GITHUB_SYNC_CHANGE_PAGE_SIZE;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    return fail("PROJECT_GITHUB_SYNC_INVALID_INPUT");
  }
  return Object.freeze({ offset, limit: Math.min(requestedLimit, PROJECT_GITHUB_SYNC_CHANGE_PAGE_MAX) });
}

async function readSyncRun(
  db: SyncDb,
  projectId: string,
  syncRunId: string,
  pageInput: Readonly<{ offset?: number; limit?: number }> = {},
): Promise<PublicProjectGitHubSyncRun> {
  const page = normalizeChangePage(pageInput);
  const [row, total] = await Promise.all([
    db.projectGitHubSyncRun.findUnique({
      where: { projectId_id: { projectId, id: syncRunId } },
      include: {
        entries: { orderBy: [{ ordinal: "asc" }] },
        changes: {
          orderBy: [{ targetKind: "asc" }, { identity: "asc" }, { id: "asc" }],
          skip: page.offset,
          take: page.limit,
        },
      },
    }),
    db.projectGitHubSyncChange.count({ where: { projectId, syncRunId } }),
  ]);
  if (row === null) return fail("PROJECT_GITHUB_SYNC_RUN_NOT_FOUND");
  return toPublicProjectGitHubSyncRun(row as unknown as PublicRunRow, { ...page, total });
}

async function freezeScope(tx: Prisma.TransactionClient, projectId: string, now: Date): Promise<FrozenScope> {
  const rows = await tx.projectRepositoryLink.findMany({
    where: { projectId, status: "active" },
    orderBy: [{ id: "asc" }],
    select: {
      id: true,
      projectId: true,
      status: true,
      effectivePolicyVersion: true,
      githubConnection: {
        select: {
          id: true,
          status: true,
          credentialId: true,
          credential: { select: { id: true, secretFingerprint: true, kind: true } },
        },
      },
      githubRepository: {
        select: {
          githubRepositoryId: true,
          nodeId: true,
          currentOwner: true,
          currentName: true,
          currentFullName: true,
          isDisabled: true,
        },
      },
      configPointer: {
        select: {
          configVersion: true,
          effectivePolicyVersion: true,
          config: {
            select: {
              version: true,
              role: true,
              requiredForProjectSnapshot: true,
              trackedRef: true,
              codeEnabled: true,
              metadataEnabled: true,
              readmeEnabled: true,
              markdownEnabled: true,
              markdownPaths: true,
              issuesEnabled: true,
              pullRequestsEnabled: true,
              releasesEnabled: true,
              includeRoots: true,
              softExcludePatterns: true,
              scanScopeFingerprint: true,
              policyFingerprint: true,
              effectivePolicyVersion: true,
            },
          },
        },
      },
      codeGenerationPointer: { select: { repositoryCodeGenerationId: true } },
      materialGenerationPointer: { select: { repositoryMaterialGenerationId: true } },
    },
  });
  const entries: FrozenScopeEntry[] = [];
  for (const row of rows) {
    const pointer = row.configPointer;
    const connection = row.githubConnection;
    const config = pointer?.config;
    if (
      connection.status !== "verified" || connection.credentialId === null ||
      connection.credential === null || connection.credential.kind !== "github" ||
      !HASH_PATTERN.test(connection.credential.secretFingerprint) || row.githubRepository.isDisabled ||
      pointer === null || pointer === undefined || config === null || config === undefined || row.effectivePolicyVersion !== pointer.effectivePolicyVersion ||
      pointer.effectivePolicyVersion !== config.effectivePolicyVersion || pointer.configVersion !== config.version ||
      !HASH_PATTERN.test(config.scanScopeFingerprint) || !HASH_PATTERN.test(config.policyFingerprint)
    ) continue;
    const snapshot = configRowSnapshot(config);
    const common = {
      projectId,
      projectRepositoryLinkId: row.id,
      githubConnectionId: connection.id,
      credentialId: connection.credentialId,
      credentialSecretFingerprint: connection.credential.secretFingerprint,
      githubRepositoryId: row.githubRepository.githubRepositoryId,
      repositoryNodeId: row.githubRepository.nodeId,
      repositoryOwner: row.githubRepository.currentOwner,
      repositoryName: row.githubRepository.currentName,
      repositoryFullName: row.githubRepository.currentFullName,
      configVersion: pointer.configVersion,
      effectivePolicyVersion: row.effectivePolicyVersion,
      requiredForProjectSnapshot: config.requiredForProjectSnapshot,
      trackedRef: config.trackedRef,
      scanScopeFingerprint: config.scanScopeFingerprint,
      policyFingerprint: config.policyFingerprint,
      configSnapshot: snapshot,
      beforeCodeGenerationId: row.codeGenerationPointer?.repositoryCodeGenerationId ?? null,
      beforeMaterialGenerationId: row.materialGenerationPointer?.repositoryMaterialGenerationId ?? null,
    } as const;
    if (config.codeEnabled) {
      entries.push(Object.freeze({
        ...common,
        id: randomUUID(),
        ordinal: 0,
        targetKind: "code",
        targetKey: `code:${row.id}`,
        beforeMaterialGenerationId: null,
      }));
    }
    if (materialEnabled(config as unknown as Record<string, unknown>)) {
      entries.push(Object.freeze({
        ...common,
        id: randomUUID(),
        ordinal: 0,
        targetKind: "material",
        targetKey: `material:${row.id}`,
        beforeCodeGenerationId: null,
      }));
    }
  }
  entries.sort((left, right) => left.projectRepositoryLinkId.localeCompare(right.projectRepositoryLinkId) || (left.targetKind === "code" ? -1 : 1));
  const normalizedEntries = entries.map((entry, ordinal) => Object.freeze({ ...entry, ordinal }));
  if (normalizedEntries.length === 0) return fail("PROJECT_GITHUB_SYNC_NO_ENABLED_TARGETS");
  const manifestInput = normalizedEntries.map((entry) => ({
    projectRepositoryLinkId: entry.projectRepositoryLinkId,
    targetKind: entry.targetKind,
    targetKey: entry.targetKey,
    githubRepositoryId: entry.githubRepositoryId.toString(),
    repositoryNodeId: entry.repositoryNodeId,
    repositoryFullName: entry.repositoryFullName,
    configVersion: entry.configVersion,
    effectivePolicyVersion: entry.effectivePolicyVersion,
    requiredForProjectSnapshot: entry.requiredForProjectSnapshot,
    trackedRef: entry.trackedRef,
    scanScopeFingerprint: entry.scanScopeFingerprint,
    policyFingerprint: entry.policyFingerprint,
    credentialId: entry.credentialId,
    credentialSecretFingerprint: entry.credentialSecretFingerprint,
    beforeCodeGenerationId: entry.beforeCodeGenerationId,
    beforeMaterialGenerationId: entry.beforeMaterialGenerationId,
    configSnapshot: entry.configSnapshot,
  }));
  void now;
  return Object.freeze({
    projectId,
    entries: Object.freeze(normalizedEntries),
    codeTargets: Object.freeze(normalizedEntries.filter((entry) => entry.targetKind === "code")),
    materialTargets: Object.freeze(normalizedEntries.filter((entry) => entry.targetKind === "material")),
    scopeFingerprint: syncFingerprint("frozen-scope", manifestInput),
  });
}

function toCodeTarget(entry: FrozenScopeEntry): FrozenProjectCodeScanTarget {
  return Object.freeze({
    projectRepositoryLinkId: entry.projectRepositoryLinkId,
    githubConnectionId: entry.githubConnectionId,
    credentialId: entry.credentialId,
    credentialSecretFingerprint: entry.credentialSecretFingerprint,
    githubRepositoryId: entry.githubRepositoryId.toString(),
    repositoryNodeId: entry.repositoryNodeId,
    repositoryOwner: entry.repositoryOwner,
    repositoryName: entry.repositoryName,
    repositoryFullName: entry.repositoryFullName,
    linkConfigVersion: entry.configVersion,
    effectivePolicyVersion: entry.effectivePolicyVersion,
    expectedActiveGenerationId: entry.beforeCodeGenerationId,
    requiredForProjectSnapshot: entry.requiredForProjectSnapshot,
    trackedRef: entry.trackedRef,
    scanScopeFingerprint: entry.scanScopeFingerprint,
  });
}

function toMaterialTarget(entry: FrozenScopeEntry): FrozenRepositoryMaterialSyncTarget {
  return Object.freeze({
    projectRepositoryLinkId: entry.projectRepositoryLinkId,
    githubConnectionId: entry.githubConnectionId,
    credentialId: entry.credentialId,
    credentialSecretFingerprint: entry.credentialSecretFingerprint,
    githubRepositoryId: entry.githubRepositoryId.toString(),
    repositoryNodeId: entry.repositoryNodeId,
    repositoryOwner: entry.repositoryOwner,
    repositoryName: entry.repositoryName,
    repositoryFullName: entry.repositoryFullName,
    linkConfigVersion: entry.configVersion,
    effectivePolicyVersion: entry.effectivePolicyVersion,
    expectedActiveGenerationId: entry.beforeMaterialGenerationId,
    trackedRef: entry.trackedRef,
    policyFingerprint: entry.policyFingerprint,
  });
}

function diffItems(
  before: readonly ChangeItem[],
  after: readonly ChangeItem[],
  withheldIdentities: ReadonlySet<string>,
  targetKind?: ProjectGitHubSyncEntryKind,
): readonly ChangeDiff[] {
  const beforeById = new Map(before.map((item) => [item.identity, item]));
  const afterById = new Map(after.map((item) => [item.identity, item]));
  const identities = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
  return Object.freeze(identities.map((identity) => {
    const oldItem = beforeById.get(identity) ?? null;
    const newItem = afterById.get(identity) ?? null;
    const same = oldItem !== null && newItem !== null && oldItem.contentHash === newItem.contentHash && oldItem.revisionFingerprint === newItem.revisionFingerprint;
    const changeType: ProjectGitHubSyncChangeType = newItem === null
      ? oldItem !== null && withheldIdentities.has(identity) ? "withheld" : "deleted"
      : oldItem === null ? "added" : same ? "unchanged" : "updated";
    const item = newItem ?? oldItem!;
    return Object.freeze({
      ...(targetKind === undefined ? {} : { targetKind }),
      ...(item.targetKey === undefined ? {} : { targetKey: item.targetKey }),
      identity,
      changeType,
      normalizedPath: item.normalizedPath,
      materialKind: item.materialKind,
      remoteIdentity: item.remoteIdentity,
      beforeContentHash: oldItem?.contentHash ?? null,
      afterContentHash: newItem?.contentHash ?? null,
      beforeRevisionFingerprint: oldItem?.revisionFingerprint ?? null,
      afterRevisionFingerprint: newItem?.revisionFingerprint ?? null,
    });
  }));
}

export function diffProjectGitHubSyncItems(
  before: readonly ChangeItem[],
  after: readonly ChangeItem[],
  withheldIdentities: readonly string[] = [],
): readonly ChangeDiff[] {
  return diffItems(before, after, new Set(withheldIdentities));
}

export function canonicalProjectGitHubSyncManifest(changes: readonly ChangeDiff[]): string {
  return sha256(canonicalJson({
    version: PROJECT_GITHUB_SYNC_SERVICE_VERSION,
    changes: [...changes].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  }));
}

async function updateEntry(
  db: PrismaClient,
  input: Readonly<{ projectId: string; entryId: string; status: ProjectGitHubSyncEntryStatus; failureCode?: string | null; warning?: string | null; childCodeBatchId?: string | null; childMaterialSyncRunId?: string | null }>,
): Promise<void> {
  const now = new Date();
  const data: Prisma.ProjectGitHubSyncEntryUncheckedUpdateManyInput = { status: input.status };
  if (input.status === "running") data.startedAt = now;
  if (["succeeded", "partial", "failed", "rateLimited", "unknown", "skipped"].includes(input.status)) data.completedAt = now;
  if (input.failureCode !== undefined) data.failureCode = input.failureCode;
  if (input.warning !== undefined) data.warning = input.warning;
  if (input.childCodeBatchId !== undefined) data.childCodeBatchId = input.childCodeBatchId;
  if (input.childMaterialSyncRunId !== undefined) data.childMaterialSyncRunId = input.childMaterialSyncRunId;
  const updated = await db.projectGitHubSyncEntry.updateMany({ where: { projectId: input.projectId, id: input.entryId }, data });
  if (updated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
}

async function persistChanges(
  db: PrismaClient,
  entry: FrozenScopeEntry,
  syncRunId: string,
  after: readonly ChangeItem[],
  success: boolean,
  quarantineOrExclusions: readonly string[],
  afterReliable = true,
): Promise<readonly ChangeDiff[]> {
  if (!success || !afterReliable) return Object.freeze([]);
  const beforeRows = entry.targetKind === "code"
    ? entry.beforeCodeGenerationId === null ? [] : await db.repositoryCodeGenerationEntry.findMany({
      where: { projectId: entry.projectId, projectRepositoryLinkId: entry.projectRepositoryLinkId, repositoryCodeGenerationId: entry.beforeCodeGenerationId },
      select: { normalizedPath: true, blobOid: true, contentHash: true, mode: true, contentBytes: true, lineCount: true },
    })
    : entry.beforeMaterialGenerationId === null ? [] : await db.repositoryMaterialGenerationEntry.findMany({
      where: { projectId: entry.projectId, projectRepositoryLinkId: entry.projectRepositoryLinkId, repositoryMaterialGenerationId: entry.beforeMaterialGenerationId },
      select: { sourceContentHash: true, materialKind: true, sourceVersion: { select: { remoteIdentity: true, remoteRevisionFingerprint: true } } },
    });
  const before: ChangeItem[] = entry.targetKind === "code"
    ? beforeRows.map((row) => {
      const code = row as { normalizedPath: string; blobOid: string; contentHash: string; mode: string; contentBytes: number; lineCount: number };
      return {
        targetKey: entry.targetKey,
        identity: code.normalizedPath,
        normalizedPath: code.normalizedPath,
        materialKind: null,
        remoteIdentity: null,
        contentHash: code.contentHash,
        revisionFingerprint: codeRevisionFingerprint(code),
      };
    })
    : beforeRows.map((row) => {
      const value = row as { sourceContentHash: string; materialKind: string; sourceVersion: { remoteIdentity: string; remoteRevisionFingerprint: string } };
      const identity = `${value.materialKind}:${value.sourceVersion.remoteIdentity}`;
      return { targetKey: entry.targetKey, identity, normalizedPath: null, materialKind: value.materialKind, remoteIdentity: value.sourceVersion.remoteIdentity, contentHash: value.sourceContentHash, revisionFingerprint: value.sourceVersion.remoteRevisionFingerprint };
    });
  const withheld = quarantineOrExclusions;
  const changes = diffItems(before, after, new Set(withheld), entry.targetKind);
  if (changes.length > 0) {
    await db.projectGitHubSyncChange.createMany({
      data: changes.map((change) => ({
        id: randomUUID(),
        projectId: entry.projectId,
        syncRunId,
        entryId: entry.id,
        targetKind: entry.targetKind,
        targetKey: entry.targetKey,
        identity: change.identity,
        changeType: change.changeType,
        normalizedPath: change.normalizedPath,
        materialKind: change.materialKind as never,
        remoteIdentity: change.remoteIdentity,
        beforeContentHash: change.beforeContentHash,
        afterContentHash: change.afterContentHash,
        beforeRevisionFingerprint: change.beforeRevisionFingerprint,
        afterRevisionFingerprint: change.afterRevisionFingerprint,
      })),
    });
  }
  return changes;
}

async function afterItemsForEntry(
  db: PrismaClient,
  entry: FrozenScopeEntry,
): Promise<Readonly<{ items: readonly ChangeItem[]; withheld: readonly string[]; reliable: boolean }>> {
  if (entry.targetKind === "code") {
    const pointer = await db.repositoryCodeGenerationPointer.findUnique({
      where: {
        projectId_projectRepositoryLinkId: {
          projectId: entry.projectId,
          projectRepositoryLinkId: entry.projectRepositoryLinkId,
        },
      },
      select: { repositoryCodeGenerationId: true },
    });
    if (pointer === null) return { items: [], withheld: [], reliable: false };
    const generation = await db.repositoryCodeGeneration.findUnique({
      where: { projectId_id: { projectId: entry.projectId, id: pointer.repositoryCodeGenerationId } },
      select: {
        exclusionManifest: true,
        entries: { select: { normalizedPath: true, blobOid: true, contentHash: true, mode: true, contentBytes: true, lineCount: true } },
      },
    });
    if (generation === null) return { items: [], withheld: [], reliable: false };
    const items = generation.entries.map((row) => ({
      targetKey: entry.targetKey,
      identity: row.normalizedPath,
      normalizedPath: row.normalizedPath,
      materialKind: null,
      remoteIdentity: null,
      contentHash: row.contentHash,
      revisionFingerprint: codeRevisionFingerprint(row),
    }));
    const excluded = isRecord(generation.exclusionManifest)
      ? []
      : Array.isArray(generation.exclusionManifest)
        ? generation.exclusionManifest.flatMap((row) => isRecord(row) && typeof row.normalizedPath === "string" ? [row.normalizedPath] : [])
        : [];
    return { items, withheld: excluded, reliable: true };
  }
  const pointer = await db.repositoryMaterialGenerationPointer.findUnique({
    where: {
      projectId_projectRepositoryLinkId: {
        projectId: entry.projectId,
        projectRepositoryLinkId: entry.projectRepositoryLinkId,
      },
    },
    select: { repositoryMaterialGenerationId: true },
  });
  if (pointer === null) return { items: [], withheld: [], reliable: false };
  const generation = await db.repositoryMaterialGeneration.findUnique({
    where: { projectId_id: { projectId: entry.projectId, id: pointer.repositoryMaterialGenerationId } },
    select: {
      entries: {
        select: {
          sourceContentHash: true,
          materialKind: true,
          sourceVersion: { select: { remoteIdentity: true, remoteRevisionFingerprint: true } },
        },
      },
    },
  });
  if (generation === null) return { items: [], withheld: [], reliable: false };
  return {
    items: generation.entries.map((row) => ({
      targetKey: entry.targetKey,
      identity: `${row.materialKind}:${row.sourceVersion.remoteIdentity}`,
      normalizedPath: null,
      materialKind: row.materialKind,
      remoteIdentity: row.sourceVersion.remoteIdentity,
      contentHash: row.sourceContentHash,
      revisionFingerprint: row.sourceVersion.remoteRevisionFingerprint,
    })),
    withheld: [],
    reliable: true,
  };
}

async function mapMaterialQuarantineIdentities(
  db: PrismaClient,
  entry: FrozenScopeEntry,
  childRunId: string,
): Promise<Readonly<{ identities: readonly string[]; unmapped: boolean }>> {
  const rows = await db.gitHubMaterialQuarantine.findMany({
    where: { projectId: entry.projectId, githubMaterialSyncRunId: childRunId },
    select: { materialKind: true, remoteIdentityFingerprint: true },
  });
  if (rows.length === 0) return Object.freeze({ identities: Object.freeze([]), unmapped: false });
  const beforeRows = entry.beforeMaterialGenerationId === null
    ? []
    : await db.repositoryMaterialGenerationEntry.findMany({
      where: {
        projectId: entry.projectId,
        projectRepositoryLinkId: entry.projectRepositoryLinkId,
        repositoryMaterialGenerationId: entry.beforeMaterialGenerationId,
      },
      select: {
        materialKind: true,
        sourceVersion: { select: { remoteIdentity: true, remoteRevisionFingerprint: true } },
      },
    });
  const fingerprints = new Set(rows.map((row) => row.remoteIdentityFingerprint));
  const identities = beforeRows.flatMap((row) => {
    const fingerprint = materialQuarantineFingerprint({
      materialKind: row.materialKind,
      remoteIdentity: row.sourceVersion.remoteIdentity,
      remoteRevisionFingerprint: row.sourceVersion.remoteRevisionFingerprint,
    });
    return fingerprints.has(fingerprint)
      ? [`${row.materialKind}:${row.sourceVersion.remoteIdentity}`]
      : [];
  });
  return Object.freeze({
    identities: Object.freeze([...new Set(identities)].sort()),
    unmapped: identities.length !== rows.length,
  });
}

function resultRunStatus(batch: ProjectCodeScanBatchView, linkId: string): ProjectCodeScanBatchView["runs"][number]["status"] {
  return batch.runs.find((run) => run.projectRepositoryLinkId === linkId)?.status ?? "failed";
}

function codeOutcome(status: ProjectCodeScanBatchView["runs"][number]["status"]): "succeeded" | "partial" | "rateLimited" | "unknown" | "failed" {
  if (status === "succeeded") return "succeeded";
  if (status === "rateLimited") return "rateLimited";
  if (status === "unknown") return "unknown";
  if (status === "failed") return "failed";
  return "failed";
}

function materialOutcome(status: RepositoryMaterialSyncView["status"]): "succeeded" | "partial" | "rateLimited" | "unknown" | "failed" {
  if (status === "succeeded") return "succeeded";
  if (status === "rateLimited") return "rateLimited";
  if (status === "unknown") return "unknown";
  if (status === "partial") return "partial";
  return "failed";
}

type RootExecutionSummary = {
  knownFailure: boolean;
  rateLimited: boolean;
  unknown: boolean;
  stopped: boolean;
  successfulCount: number;
  warnings: string[];
  changes: ChangeDiff[];
};

export function resolveProjectGitHubSyncTerminalStatus(input: Readonly<{
  unknown: boolean;
  rateLimited: boolean;
  knownFailure: boolean;
  successfulCount: number;
}>): ProjectGitHubSyncRunStatus {
  if (input.unknown) return "unknown";
  if (input.rateLimited) return "rateLimited";
  if (!input.knownFailure) return "succeeded";
  return input.successfulCount > 0 ? "partial" : "failed";
}

function addRootWarning(summary: RootExecutionSummary, warning: string): void {
  if (!summary.warnings.includes(warning)) summary.warnings.push(warning);
}

async function markUnstartedCodeRuns(db: PrismaClient, projectId: string, batchId: string): Promise<void> {
  const queued = await db.repoCodeScanRun.findMany({
    where: { projectId, projectScanBatchId: batchId, status: "queued" },
    select: { id: true },
  });
  if (queued.length === 0) return;
  const updated = await db.repoCodeScanRun.updateMany({
    where: { projectId, projectScanBatchId: batchId, status: "queued" },
    data: { status: "failed", stage: "terminal", failureCode: "GITHUB_PROJECT_SYNC_NOT_RUN", completedAt: new Date() },
  });
  if (updated.count !== queued.length) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
}

async function markPendingSyncEntriesSkipped(
  db: PrismaClient,
  projectId: string,
  syncRunId: string,
  targetKind: ProjectGitHubSyncEntryKind,
): Promise<readonly string[]> {
  const pending = await db.projectGitHubSyncEntry.findMany({
    where: { projectId, syncRunId, targetKind, status: "pending" },
    select: { id: true },
  });
  if (pending.length === 0) return Object.freeze([]);
  const updated = await db.projectGitHubSyncEntry.updateMany({
    where: { projectId, syncRunId, targetKind, status: "pending" },
    data: { status: "skipped", failureCode: "GITHUB_PROJECT_SYNC_NOT_RUN", completedAt: new Date() },
  });
  if (updated.count !== pending.length) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
  return Object.freeze(pending.map((entry) => entry.id));
}

const TERMINAL_SYNC_ENTRY_STATUSES = Object.freeze([
  "succeeded",
  "partial",
  "failed",
  "rateLimited",
  "unknown",
  "skipped",
] as const);

function isTerminalSyncEntryStatus(value: ProjectGitHubSyncEntryStatus): value is (typeof TERMINAL_SYNC_ENTRY_STATUSES)[number] {
  return (TERMINAL_SYNC_ENTRY_STATUSES as readonly string[]).includes(value);
}

type SyncRootClosure = Readonly<{
  status: "failed" | "unknown";
  failureCode: string;
}>;

async function closeProjectGitHubSyncRoot(
  db: PrismaClient,
  input: Readonly<{ projectId: string; syncRunId: string; closure: SyncRootClosure }>,
): Promise<boolean> {
  return transactionRetry(db, async (tx) => {
    await lockGitHubProject(tx, input.projectId);
    const root = await tx.projectGitHubSyncRun.findUnique({
      where: { projectId_id: { projectId: input.projectId, id: input.syncRunId } },
      select: {
        id: true,
        status: true,
        codeTargetCount: true,
        materialTargetCount: true,
        warnings: true,
      },
    });
    if (root === null) return false;
    if (["succeeded", "partial", "failed", "rateLimited", "unknown", "cancelled"].includes(root.status)) return false;
    const entries = await tx.projectGitHubSyncEntry.findMany({
      where: { projectId: input.projectId, syncRunId: input.syncRunId },
      select: { id: true, targetKind: true, status: true, childCodeBatchId: true, childMaterialSyncRunId: true },
    });
    const completedAt = new Date();
    for (const entry of entries) {
      if (isTerminalSyncEntryStatus(entry.status)) continue;
      // A material target which never left the queue was never dispatched.
      // Close it as skipped; the child run (when one exists) is cancelled
      // below, preserving the material-run lifecycle contract.
      const status: ProjectGitHubSyncEntryStatus = entry.status === "pending"
        ? "skipped"
        : input.closure.status === "unknown" ? "unknown" : "failed";
      const updated = await tx.projectGitHubSyncEntry.updateMany({
        where: { projectId: input.projectId, syncRunId: input.syncRunId, id: entry.id, status: entry.status },
        data: {
          status,
          failureCode: status === "skipped" ? "GITHUB_PROJECT_SYNC_NOT_RUN" : input.closure.failureCode,
          completedAt,
        },
      });
      if (updated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
    }
    const codeBatchIds = entries.flatMap((entry) => entry.childCodeBatchId === null ? [] : [entry.childCodeBatchId]);
    if (codeBatchIds.length > 0) {
      const codeRuns = await tx.repoCodeScanRun.findMany({
        where: { projectId: input.projectId, projectScanBatchId: { in: codeBatchIds }, status: { in: ["queued", "running"] } },
        select: { id: true, status: true },
      });
      for (const run of codeRuns) {
        const data = run.status === "queued"
          ? { status: "failed" as const, stage: "terminal" as const, failureCode: "GITHUB_PROJECT_SYNC_NOT_RUN", completedAt }
          : input.closure.status === "unknown"
            ? { status: "unknown" as const, stage: "terminal" as const, failureCode: input.closure.failureCode }
            : { status: "failed" as const, stage: "terminal" as const, failureCode: input.closure.failureCode, completedAt };
        const updated = await tx.repoCodeScanRun.updateMany({
          where: { projectId: input.projectId, id: run.id, status: run.status },
          data,
        });
        if (updated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
      }
      const codeBatches = await tx.projectScanBatch.findMany({
        where: { projectId: input.projectId, id: { in: codeBatchIds }, status: { in: ["queued", "running"] } },
        select: { id: true, status: true },
      });
      for (const batch of codeBatches) {
        const data = batch.status === "queued"
          ? { status: "failed" as const, failureCode: "GITHUB_PROJECT_SYNC_NOT_RUN", completedAt }
          : input.closure.status === "unknown"
            ? { status: "unknown" as const, failureCode: input.closure.failureCode }
            : { status: "failed" as const, failureCode: input.closure.failureCode, completedAt };
        const updated = await tx.projectScanBatch.updateMany({
          where: { projectId: input.projectId, id: batch.id, status: batch.status },
          data,
        });
        if (updated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
      }
    }
    const materialRunIds = entries.flatMap((entry) => entry.childMaterialSyncRunId === null ? [] : [entry.childMaterialSyncRunId]);
    if (materialRunIds.length > 0) {
      const materialRuns = await tx.gitHubMaterialSyncRun.findMany({
        where: { projectId: input.projectId, id: { in: materialRunIds }, status: { in: ["queued", "running"] } },
        select: { id: true, status: true },
      });
      for (const run of materialRuns) {
        const updated = await tx.gitHubMaterialSyncRun.updateMany({
          where: { projectId: input.projectId, id: run.id, status: run.status },
          data: run.status === "queued"
            ? { status: "cancelled", stage: "terminal", failureCode: null, retryAt: null, completedAt }
            : input.closure.status === "unknown"
              ? { status: "unknown", stage: "terminal", failureCode: input.closure.failureCode, retryAt: null, completedAt }
              : { status: "failed", stage: "terminal", failureCode: input.closure.failureCode, retryAt: null, completedAt },
        });
        if (updated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
      }
    }
    const updatedRoot = await tx.projectGitHubSyncRun.updateMany({
      where: { projectId: input.projectId, id: input.syncRunId, status: { in: ["queued", "running"] } },
      data: {
        status: input.closure.status,
        stage: "terminal",
        manifestFingerprint: null,
        completedCodeTargetCount: root.codeTargetCount,
        completedMaterialTargetCount: root.materialTargetCount,
        failureCode: input.closure.failureCode,
        reconciliationRequired: input.closure.status === "unknown",
        completedAt,
      },
    });
    if (updatedRoot.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
    return true;
  });
}

/**
 * Reconcile a project-wide sync without contacting GitHub or an AI provider.
 * This is an explicit user action: it records that the in-flight external
 * work is being abandoned/observed, keeps the root and children unknown, and
 * only then releases admission through the immutable reconciliation row.
 */
export async function reconcileGitHubProjectSync(
  input: Readonly<{ projectId: unknown; jobId: unknown; requestedById: unknown }>,
  db: PrismaClient = getDb(),
): Promise<PublicProjectJob> {
  const projectId = canonicalUuid(input.projectId);
  const jobId = canonicalUuid(input.jobId);
  const requestedById = canonicalUuid(input.requestedById);
  return withProjectJobLock(db, jobId, async (tx) => {
    await lockGitHubProject(tx, projectId);
    const job = await tx.backgroundJob.findUnique({
      where: { id: jobId },
      select: { id: true, projectId: true, kind: true, status: true, requestedById: true },
    });
    if (job === null) return fail("PROJECT_GITHUB_SYNC_RUN_NOT_FOUND");
    if (job.projectId !== projectId) return fail("PROJECT_GITHUB_SYNC_RUN_NOT_FOUND");
    if (job.kind !== "githubProjectSync") return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
    const root = await tx.projectGitHubSyncRun.findUnique({
      where: { parentJobId: jobId },
      include: {
        entries: {
          orderBy: [{ ordinal: "asc" }],
          select: {
            id: true,
            ordinal: true,
            targetKind: true,
            targetKey: true,
            status: true,
            childCodeBatchId: true,
            childMaterialSyncRunId: true,
            warning: true,
            failureCode: true,
          },
        },
        reconciliation: { select: { id: true } },
      },
    });
    if (root === null || root.projectId !== projectId) return fail("PROJECT_GITHUB_SYNC_RUN_NOT_FOUND");
    if (root.reconciliation !== null) return getProjectJob(projectId, jobId, tx);
    if (!["running", "unknown"].includes(job.status)) return fail("PROJECT_GITHUB_SYNC_RECONCILIATION_NOT_DUE");
    if (!["running", "unknown"].includes(root.status)) return fail("PROJECT_GITHUB_SYNC_RECONCILIATION_NOT_DUE");

    const latestAttempt = await tx.backgroundJobAttempt.findFirst({
      where: { jobId },
      orderBy: { attemptNumber: "desc" },
      select: { id: true, status: true, leaseExpiresAt: true },
    });
    if (job.status === "running") {
      if (latestAttempt === null || latestAttempt.status !== "running") return fail("PROJECT_GITHUB_SYNC_RECONCILIATION_REQUIRED");
      if (!isLeaseExpired(latestAttempt.leaseExpiresAt)) return fail("PROJECT_GITHUB_SYNC_RECONCILIATION_NOT_DUE");
    }

    const completedAt = new Date();
    if (latestAttempt?.status === "running") {
      const attemptUpdated = await tx.backgroundJobAttempt.updateMany({
        where: { id: latestAttempt.id, jobId, status: "running" },
        data: { status: "unknown", safeFailureCode: "RECONCILIATION_REQUIRED", completedAt, heartbeatAt: completedAt },
      });
      if (attemptUpdated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
    }
    await tx.providerCallAudit.updateMany({
      where: { jobId, status: "running" },
      data: { status: "unknown", safeErrorCode: "RECONCILIATION_REQUIRED", completedAt },
    });

      if (root.status !== "unknown") {
        for (const entry of root.entries) {
          if (isTerminalSyncEntryStatus(entry.status)) continue;
          const entryStatus: ProjectGitHubSyncEntryStatus = entry.status === "pending" ? "skipped" : "unknown";
          const updatedEntry = await tx.projectGitHubSyncEntry.updateMany({
            where: { projectId, syncRunId: root.id, id: entry.id, status: entry.status },
            data: {
              status: entryStatus,
              failureCode: entryStatus === "skipped" ? "GITHUB_PROJECT_SYNC_NOT_RUN" : "RECONCILIATION_REQUIRED",
              completedAt,
            },
          });
        if (updatedEntry.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
      }
      const codeBatchIds = [...new Set(root.entries.flatMap((entry) => entry.childCodeBatchId === null ? [] : [entry.childCodeBatchId]))];
      if (codeBatchIds.length > 0) {
        const codeRuns = await tx.repoCodeScanRun.findMany({
          where: { projectId, projectScanBatchId: { in: codeBatchIds }, status: { in: ["queued", "running"] } },
          select: { id: true, status: true },
        });
        for (const run of codeRuns) {
          const data = run.status === "queued"
            ? { status: "failed" as const, stage: "terminal" as const, failureCode: "GITHUB_PROJECT_SYNC_NOT_RUN", completedAt }
            : { status: "unknown" as const, stage: "terminal" as const, failureCode: "RECONCILIATION_REQUIRED" };
          const updated = await tx.repoCodeScanRun.updateMany({
            where: { projectId, id: run.id, status: run.status },
            data,
          });
          if (updated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
        }
        const codeBatches = await tx.projectScanBatch.findMany({
          where: { projectId, id: { in: codeBatchIds }, status: { in: ["queued", "running"] } },
          select: { id: true, status: true },
        });
        for (const batch of codeBatches) {
          const data = batch.status === "queued"
            ? { status: "failed" as const, failureCode: "GITHUB_PROJECT_SYNC_NOT_RUN", completedAt }
            : { status: "unknown" as const, failureCode: "RECONCILIATION_REQUIRED" };
          const updated = await tx.projectScanBatch.updateMany({
            where: { projectId, id: batch.id, status: batch.status },
            data,
          });
          if (updated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
        }
      }
      const materialRunIds = [...new Set(root.entries.flatMap((entry) => entry.childMaterialSyncRunId === null ? [] : [entry.childMaterialSyncRunId]))];
      if (materialRunIds.length > 0) {
        const materialRuns = await tx.gitHubMaterialSyncRun.findMany({
          where: { projectId, id: { in: materialRunIds }, status: { in: ["queued", "running"] } },
          select: { id: true, status: true },
        });
        for (const run of materialRuns) {
          const updated = await tx.gitHubMaterialSyncRun.updateMany({
            where: { projectId, id: run.id, status: run.status },
            data: run.status === "queued"
              ? { status: "cancelled", stage: "terminal", failureCode: null, retryAt: null, completedAt }
              : { status: "unknown", stage: "terminal", failureCode: "RECONCILIATION_REQUIRED", retryAt: null, completedAt },
          });
          if (updated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
        }
      }
      const updatedRoot = await tx.projectGitHubSyncRun.updateMany({
        where: { projectId, id: root.id, status: { in: ["queued", "running"] } },
        data: {
          status: "unknown",
          stage: "terminal",
          manifestFingerprint: null,
          completedCodeTargetCount: root.codeTargetCount,
          completedMaterialTargetCount: root.materialTargetCount,
          failureCode: "RECONCILIATION_REQUIRED",
          reconciliationRequired: true,
          completedAt,
        },
      });
      if (updatedRoot.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
    }

    const classifications = root.entries.map((entry) => ({
      entryId: entry.id,
      ordinal: entry.ordinal,
      targetKind: entry.targetKind,
      targetKey: entry.targetKey,
      status: "unknown",
      childCodeBatchId: entry.childCodeBatchId,
      childMaterialSyncRunId: entry.childMaterialSyncRunId,
      warning: safeCode(entry.warning),
      failureCode: "RECONCILIATION_REQUIRED",
    }));
    const evidenceFingerprint = syncFingerprint("reconciliation", {
      projectId,
      jobId,
      syncRunId: root.id,
      resolution: "explicit_abandon",
      classifications,
    });
    await tx.projectGitHubSyncReconciliation.create({
      data: {
        id: randomUUID(),
        projectId,
        syncRunId: root.id,
        requestedById,
        resolution: "explicitAbandon",
        childClassifications: jsonValue(classifications),
        evidenceFingerprint,
      },
    });
    const updatedJob = await tx.backgroundJob.updateMany({
      where: { id: jobId, projectId, status: { in: ["running", "unknown"] } },
      data: {
        status: "unknown",
        stage: "reconciliation_required",
        failureCode: "RECONCILIATION_REQUIRED",
        completedAt: job.status === "running" ? completedAt : undefined,
        reconciliationRequired: false,
      },
    });
    if (updatedJob.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
    return getProjectJob(projectId, jobId, tx);
  });
}

/** Cancel a project sync before any child target is dispatched. */
export async function cancelGitHubProjectSync(
  input: Readonly<{ projectId: unknown; jobId: unknown; requestedById?: unknown }>,
  db: PrismaClient = getDb(),
): Promise<PublicProjectJob> {
  const projectId = canonicalUuid(input.projectId);
  const jobId = canonicalUuid(input.jobId);
  const requestedById = input.requestedById === undefined ? null : canonicalUuid(input.requestedById);
  return withProjectJobLock(db, jobId, async (tx) => {
    await lockGitHubProject(tx, projectId);
    const job = await tx.backgroundJob.findUnique({
      where: { id: jobId },
      select: { id: true, projectId: true, kind: true, status: true, requestedById: true },
    });
    if (job === null || job.projectId !== projectId || job.kind !== "githubProjectSync") {
      return fail("PROJECT_GITHUB_SYNC_RUN_NOT_FOUND");
    }
    if (requestedById !== null && job.requestedById !== requestedById) {
      return fail("PROJECT_GITHUB_SYNC_RUN_NOT_FOUND");
    }
    if (job.status !== "queued" && job.status !== "waitingConsent") {
      return fail("PROJECT_GITHUB_SYNC_CANCEL_NOT_ALLOWED");
    }
    const root = await tx.projectGitHubSyncRun.findUnique({
      where: { parentJobId: jobId },
      select: { id: true, projectId: true, status: true, codeTargetCount: true, materialTargetCount: true },
    });
    if (root === null || root.projectId !== projectId || root.status !== "queued") {
      return fail("PROJECT_GITHUB_SYNC_CANCEL_NOT_ALLOWED");
    }
    const entries = await tx.projectGitHubSyncEntry.findMany({
      where: { projectId, syncRunId: root.id },
      select: { id: true, status: true },
    });
    for (const entry of entries) {
      if (entry.status !== "pending") return fail("PROJECT_GITHUB_SYNC_CANCEL_NOT_ALLOWED");
      const updated = await tx.projectGitHubSyncEntry.updateMany({
        where: { projectId, syncRunId: root.id, id: entry.id, status: "pending" },
        data: { status: "skipped", failureCode: "PROJECT_GITHUB_SYNC_CANCELLED", completedAt: new Date() },
      });
      if (updated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
    }
    const completedAt = new Date();
    const updatedRoot = await tx.projectGitHubSyncRun.updateMany({
      where: { projectId, id: root.id, status: "queued" },
      data: {
        status: "cancelled",
        stage: "terminal",
        manifestFingerprint: null,
        completedCodeTargetCount: root.codeTargetCount,
        completedMaterialTargetCount: root.materialTargetCount,
        failureCode: "PROJECT_GITHUB_SYNC_CANCELLED",
        reconciliationRequired: false,
        completedAt,
      },
    });
    if (updatedRoot.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
    const updatedJob = await tx.backgroundJob.updateMany({
      where: { id: jobId, projectId, status: { in: ["queued", "waitingConsent"] } },
      data: { status: "cancelled", stage: "cancelled", completedAt, reconciliationRequired: false },
    });
    if (updatedJob.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
    return getProjectJob(projectId, jobId, tx);
  });
}

export async function getProjectGitHubSync(
  input: unknown,
  db: PrismaClient = getDb(),
  page: Readonly<{ offset?: number; limit?: number }> = {},
): Promise<PublicProjectGitHubSyncRun> {
  const parsed = parseRunInput(input);
  return readSyncRun(db, parsed.projectId, parsed.syncRunId, page);
}

export async function prepareGitHubProjectSync(
  input: Readonly<{ projectId: unknown; requestedById: unknown; clientKey: unknown }>,
  db: PrismaClient = getDb(),
): Promise<Readonly<{ job: PublicProjectJob; syncRun: PublicProjectGitHubSyncRun }>> {
  const parsed = parseStartInput(input);
  const hash = idempotencyHash(parsed.projectId, parsed.clientKey);
  const prepared = await transactionRetry(db, async (tx) => {
    await lockGitHubProject(tx, parsed.projectId);
    const project = await tx.project.findUnique({ where: { id: parsed.projectId }, select: { id: true } });
    if (project === null) return fail("PROJECT_GITHUB_SYNC_PROJECT_NOT_FOUND");
    const existing = await tx.backgroundJob.findUnique({
      where: { requestedById_idempotencyKey: { requestedById: parsed.requestedById, idempotencyKey: hash } },
    });
    if (existing !== null) {
      const root = await tx.projectGitHubSyncRun.findUnique({ where: { parentJobId: existing.id }, include: RUN_INCLUDE });
      if (root === null) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
      return { job: toPublicProjectJob(existing), syncRun: toPublicProjectGitHubSyncRun(root as unknown as PublicRunRow) };
    }
    const activeRoot = await tx.projectGitHubSyncRun.findFirst({ where: { projectId: parsed.projectId, status: { in: ["queued", "running"] } }, select: { status: true } });
    if (activeRoot !== null) return fail("PROJECT_GITHUB_SYNC_ALREADY_RUNNING");
    const directCode = await tx.projectScanBatch.findFirst({ where: { projectId: parsed.projectId, status: { in: ["queued", "running"] } }, select: { status: true } });
    const directMaterial = await tx.gitHubMaterialSyncRun.findFirst({ where: { projectId: parsed.projectId, status: { in: ["queued", "running"] } }, select: { status: true } });
    if (directCode !== null || directMaterial !== null) return fail("PROJECT_GITHUB_SYNC_DIRECT_OPERATION_ACTIVE");
    const [blockedCode, blockedMaterial, blockedRoot] = await Promise.all([
      hasBlockingUnknownProjectCodeBatch(tx, parsed.projectId),
      hasBlockingUnknownProjectMaterialRun(tx, parsed.projectId),
      hasBlockingUnknownProjectSyncRun(tx, parsed.projectId),
    ]);
    if (blockedCode || blockedMaterial || blockedRoot) return fail("PROJECT_GITHUB_SYNC_RECONCILIATION_REQUIRED");
    const now = new Date();
    const scope = await freezeScope(tx, parsed.projectId, now);
    const jobId = randomUUID();
    const syncRunId = randomUUID();
    const job = await tx.backgroundJob.create({
      data: {
        id: jobId,
        projectId: parsed.projectId,
        kind: "githubProjectSync",
        requestedById: parsed.requestedById,
        idempotencyKey: hash,
        payload: jsonValue({ syncRunId }),
      },
    });
    await tx.projectGitHubSyncRun.create({
      data: {
        id: syncRunId,
        projectId: parsed.projectId,
        parentJobId: jobId,
        status: "queued",
        stage: "queued",
        scopeFingerprint: scope.scopeFingerprint,
        deadlineAt: new Date(now.getTime() + PROJECT_GITHUB_SYNC_DEADLINE_MS),
        codeTargetCount: scope.codeTargets.length,
        materialTargetCount: scope.materialTargets.length,
        warnings: jsonValue([]),
      },
    });
    await tx.projectGitHubSyncEntry.createMany({
      data: scope.entries.map((entry) => ({
        id: entry.id,
        projectId: parsed.projectId,
        syncRunId,
        projectRepositoryLinkId: entry.projectRepositoryLinkId,
        githubConnectionId: entry.githubConnectionId,
        credentialId: entry.credentialId,
        credentialSecretFingerprint: entry.credentialSecretFingerprint,
        ordinal: entry.ordinal,
        targetKind: entry.targetKind,
        targetKey: entry.targetKey,
        status: "pending",
        githubRepositoryId: entry.githubRepositoryId,
        repositoryNodeId: entry.repositoryNodeId,
        repositoryOwner: entry.repositoryOwner,
        repositoryName: entry.repositoryName,
        repositoryFullName: entry.repositoryFullName,
        configVersion: entry.configVersion,
        effectivePolicyVersion: entry.effectivePolicyVersion,
        requiredForProjectSnapshot: entry.requiredForProjectSnapshot,
        trackedRef: entry.trackedRef,
        scanScopeFingerprint: entry.scanScopeFingerprint,
        policyFingerprint: entry.policyFingerprint,
        configSnapshot: jsonValue(entry.configSnapshot),
        beforeCodeGenerationId: entry.beforeCodeGenerationId,
        beforeMaterialGenerationId: entry.beforeMaterialGenerationId,
      })),
    });
    const frozenRoot = await tx.projectGitHubSyncRun.findUnique({ where: { projectId_id: { projectId: parsed.projectId, id: syncRunId } }, include: RUN_INCLUDE });
    if (frozenRoot === null) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
    return {
      job: toPublicProjectJob(job),
      syncRun: toPublicProjectGitHubSyncRun(frozenRoot as unknown as PublicRunRow),
    };
  });
  return prepared;
}

export async function runGitHubProjectSyncJob(
  input: Readonly<{ projectId: string; requestedBy: Pick<AppUser, "id">; clientKey: unknown }>,
  db: PrismaClient = getDb(),
  runtime: ProjectGitHubSyncRuntime = {},
): Promise<PublicProjectJob> {
  const prepared = await prepareGitHubProjectSync({ projectId: input.projectId, requestedById: input.requestedBy.id, clientKey: input.clientKey }, db);
  if (prepared.job.status !== "queued") return prepared.job;
  const claim = await claimProjectJob(prepared.job.id, db, "githubProjectSync");
  if (claim === false) return getProjectJob(input.projectId, prepared.job.id, db);
  const heartbeat = startProjectJobHeartbeat({ jobId: prepared.job.id, ...claim }, db);
  const summary: RootExecutionSummary = { knownFailure: false, rateLimited: false, unknown: false, stopped: false, successfulCount: 0, warnings: [], changes: [] };
  let codeBatch: ProjectCodeScanBatchView | null = null;
  const codeServices = new Map<string, GitHubCodeScanService>();
  const materialServices = new Map<string, GitHubMaterialSyncService>();
  let entryRows: readonly FrozenScopeEntry[] = [];
  let frozenById = new Map<string, FrozenScopeEntry>();
  const deadline = new Date(prepared.syncRun.deadlineAt).getTime();
  const nowExpired = () => (runtime.now?.() ?? Date.now()) >= deadline;
  const publicSummary = async () => getProjectGitHubSync({ projectId: input.projectId, syncRunId: prepared.syncRun.id }, db);
  const setRoot = async (data: Prisma.ProjectGitHubSyncRunUpdateManyMutationInput) => {
    const updated = await db.projectGitHubSyncRun.updateMany({ where: { projectId: input.projectId, id: prepared.syncRun.id, status: "running" }, data });
    if (updated.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
  };
  const getClient = async (credentialId: string, expectedSecretFingerprint: string): Promise<WebGitHubCredentialClient> => runtime.loadClientForCredential
    ? runtime.loadClientForCredential({ credentialId, expectedSecretFingerprint, absoluteDeadlineAt: new Date(prepared.syncRun.deadlineAt) })
    : loadGitHubClientForCredential(
      credentialId,
      db,
      { absoluteDeadlineAt: new Date(prepared.syncRun.deadlineAt), expectedSecretFingerprint },
    );
  const serviceForCode = async (credentialId: string, expectedSecretFingerprint: string): Promise<GitHubCodeScanService> => {
    const cacheKey = `${credentialId}:${expectedSecretFingerprint}`;
    const existing = codeServices.get(cacheKey);
    if (existing) return existing;
    const service = createGitHubCodeScanService({ db, client: await getClient(credentialId, expectedSecretFingerprint) });
    codeServices.set(cacheKey, service);
    return service;
  };
  const serviceForMaterial = async (credentialId: string, expectedSecretFingerprint: string): Promise<GitHubMaterialSyncService> => {
    const cacheKey = `${credentialId}:${expectedSecretFingerprint}`;
    const existing = materialServices.get(cacheKey);
    if (existing) return existing;
    const service = createGitHubMaterialSyncService({ db, client: await getClient(credentialId, expectedSecretFingerprint) });
    materialServices.set(cacheKey, service);
    return service;
  };
  let parentWasDispatched = false;
  let providerDispatchPending = false;
  let rootTerminalized = false;
  let jobTerminalized = false;
  let completedRootStatus: ProjectGitHubSyncRunStatus | null = null;
  let caughtError: unknown = null;
  try {
    const loadedEntries = await db.projectGitHubSyncEntry.findMany({
      where: { projectId: input.projectId, syncRunId: prepared.syncRun.id },
      orderBy: [{ ordinal: "asc" }],
    });
    entryRows = loadedEntries as unknown as FrozenScopeEntry[];
    frozenById = new Map(entryRows.map((entry) => [entry.id, entry]));
    const started = await db.projectGitHubSyncRun.updateMany({
      where: { projectId: input.projectId, id: prepared.syncRun.id, status: "queued" },
      data: { status: "running", stage: "freezing", startedAt: new Date() },
    });
    if (started.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
    const codeEntries = entryRows.filter((entry) => entry.targetKind === "code");
    const materialEntries = entryRows.filter((entry) => entry.targetKind === "material");
    if (codeEntries.length > 0) {
      const first = frozenById.get(codeEntries[0]!.id);
      if (!first) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
      const codeService = await serviceForCode(first.credentialId, first.credentialSecretFingerprint);
      codeBatch = await codeService.prepareProjectScanFrozen({ projectId: input.projectId, targets: codeEntries.map((entry) => {
        const frozen = frozenById.get(entry.id);
        if (!frozen) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
        return toCodeTarget(frozen);
      }) });
      for (const entry of codeEntries) await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "pending", childCodeBatchId: codeBatch.id });
      await setRoot({ stage: "code" });
      for (const entry of codeEntries) {
        const frozen = frozenById.get(entry.id);
        if (!frozen) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
        const deadlineExceeded = !summary.stopped && nowExpired();
        if (summary.stopped || deadlineExceeded) {
          summary.stopped = true;
          if (frozen.requiredForProjectSnapshot) summary.knownFailure = true;
          if (deadlineExceeded) addRootWarning(summary, "PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED");
          await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "skipped", failureCode: deadlineExceeded ? "PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED" : "GITHUB_PROJECT_SYNC_NOT_RUN" });
          const after = await afterItemsForEntry(db, frozen);
          summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
          continue;
        }
        await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "running" });
        let child: ProjectCodeScanBatchView;
        try {
          const childService = await serviceForCode(frozen.credentialId, frozen.credentialSecretFingerprint);
          const childRun = codeBatch.runs.find((run) => run.projectRepositoryLinkId === entry.projectRepositoryLinkId);
          if (childRun === undefined) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
          if (nowExpired()) {
            summary.stopped = true;
            if (frozen.requiredForProjectSnapshot) summary.knownFailure = true;
            addRootWarning(summary, "PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED");
            await updateEntry(db, {
              projectId: input.projectId,
              entryId: entry.id,
              status: "skipped",
              failureCode: "PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED",
            });
            continue;
          }
          // Only claim an uncertain provider dispatch after the read-only
          // client and the frozen child identity have been prepared.  Client
          // setup/validation failures are deterministic and must close the
          // root as known failure rather than pretending a request happened.
          await markProviderDispatched({ jobId: prepared.job.id, ...claim }, db);
          parentWasDispatched = true;
          providerDispatchPending = true;
          child = await childService.executeProjectScanRun({
            projectId: input.projectId,
            batchId: codeBatch.id,
            runId: childRun.id,
            frozenTarget: toCodeTarget(frozen),
          });
        } catch (error) {
          if (isUncertainProviderDispatch(error)) {
            summary.unknown = true;
            summary.stopped = true;
            await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "unknown", failureCode: "GITHUB_REQUEST_FAILED" });
            break;
          }
          if (parentWasDispatched && providerDispatchPending) {
            await markProviderAcknowledged({ jobId: prepared.job.id, ...claim }, db);
            providerDispatchPending = false;
          }
          summary.knownFailure = true;
          await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "failed", failureCode: "GITHUB_CODE_SCAN_FAILED" });
          const after = await afterItemsForEntry(db, frozen);
          summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
          continue;
        }
        const outcome = codeOutcome(resultRunStatus(child, entry.projectRepositoryLinkId));
        if (outcome === "unknown") {
          summary.unknown = true;
          summary.stopped = true;
          await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "unknown", failureCode: "GITHUB_REQUEST_FAILED" });
          break;
        }
        if (parentWasDispatched && providerDispatchPending) {
          await markProviderAcknowledged({ jobId: prepared.job.id, ...claim }, db);
          providerDispatchPending = false;
        }
        if (outcome === "rateLimited") {
          summary.rateLimited = true;
          summary.knownFailure = true;
          summary.stopped = true;
          await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "rateLimited", failureCode: "GITHUB_RATE_LIMITED" });
          const after = await afterItemsForEntry(db, frozen);
          summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
          break;
        }
        if (outcome !== "succeeded") {
          const optionalFailure = outcome === "failed" && !frozen.requiredForProjectSnapshot;
          if (!optionalFailure) summary.knownFailure = true;
          await updateEntry(db, {
            projectId: input.projectId,
            entryId: entry.id,
            status: optionalFailure ? "partial" : "failed",
            warning: optionalFailure ? "OPTIONAL_REPOSITORY_INCOMPLETE" : null,
            failureCode: optionalFailure ? null : "GITHUB_CODE_SCAN_FAILED",
          });
          if (optionalFailure) addRootWarning(summary, "OPTIONAL_REPOSITORY_INCOMPLETE");
          const after = await afterItemsForEntry(db, frozen);
          summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
          continue;
        }
        summary.successfulCount += 1;
        await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "succeeded" });
        const after = await afterItemsForEntry(db, frozen);
        summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, true, after.withheld, after.reliable));
      }
      if (summary.stopped) {
        await markUnstartedCodeRuns(db, input.projectId, codeBatch.id);
        const skippedIds = await markPendingSyncEntriesSkipped(db, input.projectId, prepared.syncRun.id, "code");
        for (const entryId of skippedIds) {
          const frozen = frozenById.get(entryId);
          if (!frozen) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
          if (frozen.requiredForProjectSnapshot) summary.knownFailure = true;
          const after = await afterItemsForEntry(db, frozen);
          summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
        }
      }
      const finalizerEntry = frozenById.get(codeEntries[0]!.id);
      if (!finalizerEntry) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
      const finalizer = await serviceForCode(finalizerEntry.credentialId, finalizerEntry.credentialSecretFingerprint);
      codeBatch = await finalizer.finalizeProjectScan({ projectId: input.projectId, batchId: codeBatch.id, allowQueued: true } as never);
      if (codeBatch.status === "unknown") { summary.unknown = true; summary.stopped = true; }
    }
    if (!summary.stopped && materialEntries.length > 0) await setRoot({ stage: "material" });
    for (const entry of materialEntries) {
      const frozen = frozenById.get(entry.id);
      if (!frozen) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
      const deadlineExceeded = !summary.stopped && nowExpired();
      if (summary.stopped || deadlineExceeded) {
        summary.stopped = true;
        if (frozen.requiredForProjectSnapshot) summary.knownFailure = true;
        if (deadlineExceeded) {
          addRootWarning(summary, "PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED");
        }
        await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "skipped", failureCode: deadlineExceeded ? "PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED" : "GITHUB_PROJECT_SYNC_NOT_RUN" });
        const after = await afterItemsForEntry(db, frozen);
        summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
        continue;
      }
      await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "running" });
      let child: RepositoryMaterialSyncView;
      try {
        const childService = await serviceForMaterial(frozen.credentialId, frozen.credentialSecretFingerprint);
        const preparedChild = await childService.prepareRepositorySyncFrozen({ projectId: input.projectId, target: toMaterialTarget(frozen) });
        await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "running", childMaterialSyncRunId: preparedChild.id });
        if (nowExpired()) {
          summary.stopped = true;
          if (frozen.requiredForProjectSnapshot) summary.knownFailure = true;
          addRootWarning(summary, "PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED");
          await childService.skipRepositorySync({ projectId: input.projectId, runId: preparedChild.id });
          await updateEntry(db, {
            projectId: input.projectId,
            entryId: entry.id,
            status: "skipped",
            childMaterialSyncRunId: preparedChild.id,
            failureCode: "PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED",
          });
          continue;
        }
        // The child preparation validates the frozen repository/config CAS.
        // Mark the parent dispatch only once the request can actually be
        // issued, so setup errors remain deterministic known failures.
        await markProviderDispatched({ jobId: prepared.job.id, ...claim }, db);
        parentWasDispatched = true;
        providerDispatchPending = true;
        child = await childService.executeRepositorySync({
          projectId: input.projectId,
          runId: preparedChild.id,
          frozenTarget: toMaterialTarget(frozen),
        });
        await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "running", childMaterialSyncRunId: child.id });
      } catch (error) {
        if (isUncertainProviderDispatch(error)) {
          summary.unknown = true;
          summary.stopped = true;
          await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "unknown", failureCode: "GITHUB_REQUEST_FAILED" });
          break;
        }
        if (parentWasDispatched && providerDispatchPending) {
          await markProviderAcknowledged({ jobId: prepared.job.id, ...claim }, db);
          providerDispatchPending = false;
        }
        if (frozen.requiredForProjectSnapshot) summary.knownFailure = true;
        await updateEntry(db, {
          projectId: input.projectId,
          entryId: entry.id,
          status: "failed",
          warning: frozen.requiredForProjectSnapshot ? null : "OPTIONAL_REPOSITORY_INCOMPLETE",
          failureCode: frozen.requiredForProjectSnapshot ? "GITHUB_MATERIAL_SYNC_FAILED" : null,
        });
        if (!frozen.requiredForProjectSnapshot) addRootWarning(summary, "OPTIONAL_REPOSITORY_INCOMPLETE");
        const after = await afterItemsForEntry(db, frozen);
        summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
        continue;
      }
      const outcome = materialOutcome(child.status);
      if (outcome === "unknown") { summary.unknown = true; summary.stopped = true; await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "unknown", childMaterialSyncRunId: child.id, failureCode: "GITHUB_REQUEST_FAILED" }); break; }
      await markProviderAcknowledged({ jobId: prepared.job.id, ...claim }, db);
      providerDispatchPending = false;
      if (child.status === "cancelled") {
        // A cancelled child from this path means the read-only client failed
        // before dispatch.  It is a known incomplete target, not an unknown
        // provider result, so preserve the child lifecycle and skip the root
        // entry without requesting reconciliation.
        summary.stopped = true;
        if (frozen.requiredForProjectSnapshot) summary.knownFailure = true;
        addRootWarning(summary, "PROJECT_GITHUB_SYNC_NOT_RUN");
        await updateEntry(db, {
          projectId: input.projectId,
          entryId: entry.id,
          status: "skipped",
          childMaterialSyncRunId: child.id,
          failureCode: "GITHUB_PROJECT_SYNC_NOT_RUN",
        });
        const after = await afterItemsForEntry(db, frozen);
        summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
        break;
      }
      if (outcome === "rateLimited") {
        summary.rateLimited = true;
        summary.knownFailure = true;
        summary.stopped = true;
        await updateEntry(db, { projectId: input.projectId, entryId: entry.id, status: "rateLimited", childMaterialSyncRunId: child.id, failureCode: "GITHUB_RATE_LIMITED" });
        const after = await afterItemsForEntry(db, frozen);
        summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
        break;
      }
      if (outcome !== "succeeded") {
        const optionalFailure = !frozen.requiredForProjectSnapshot;
        if (!optionalFailure) summary.knownFailure = true;
        await updateEntry(db, {
          projectId: input.projectId,
          entryId: entry.id,
          status: outcome,
          childMaterialSyncRunId: child.id,
          warning: optionalFailure ? "OPTIONAL_REPOSITORY_INCOMPLETE" : null,
          failureCode: optionalFailure ? null : "GITHUB_MATERIAL_SYNC_FAILED",
        });
        if (optionalFailure) addRootWarning(summary, "OPTIONAL_REPOSITORY_INCOMPLETE");
        const after = await afterItemsForEntry(db, frozen);
        summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
        continue;
      }
      const after = await afterItemsForEntry(db, frozen);
      const quarantine = await mapMaterialQuarantineIdentities(db, frozen, child.id);
      if (quarantine.unmapped) {
        addRootWarning(summary, "GITHUB_MATERIAL_QUARANTINE_UNMAPPED");
        await updateEntry(db, {
          projectId: input.projectId,
          entryId: entry.id,
          status: "succeeded",
          childMaterialSyncRunId: child.id,
          warning: "QUARANTINE_IDENTITY_UNMAPPED",
        });
      } else {
        await updateEntry(db, {
          projectId: input.projectId,
          entryId: entry.id,
          status: "succeeded",
          childMaterialSyncRunId: child.id,
          warning: null,
        });
      }
      summary.successfulCount += 1;
      const afterWithheld = [...after.withheld, ...quarantine.identities];
      summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, true, afterWithheld, after.reliable));
    }
    if (summary.stopped) {
      const skippedIds = await markPendingSyncEntriesSkipped(db, input.projectId, prepared.syncRun.id, "material");
      for (const entryId of skippedIds) {
        const frozen = frozenById.get(entryId);
        if (!frozen) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
        if (frozen.requiredForProjectSnapshot) summary.knownFailure = true;
        const after = await afterItemsForEntry(db, frozen);
        summary.changes.push(...await persistChanges(db, frozen, prepared.syncRun.id, after.items, false, after.withheld));
      }
    }
    await setRoot({ stage: "finalizing" });
    const finalEntries = await db.projectGitHubSyncEntry.findMany({
      where: { projectId: input.projectId, syncRunId: prepared.syncRun.id },
      select: { id: true, targetKind: true, status: true },
    });
    const expectedCode = entryRows.filter((entry) => entry.targetKind === "code").length;
    const expectedMaterial = entryRows.filter((entry) => entry.targetKind === "material").length;
    if (
      finalEntries.length !== entryRows.length ||
      finalEntries.some((entry) => !isTerminalSyncEntryStatus(entry.status))
    ) return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
    const completedCode = finalEntries.filter((entry) => entry.targetKind === "code").length;
    const completedMaterial = finalEntries.filter((entry) => entry.targetKind === "material").length;
    if (completedCode !== expectedCode || completedMaterial !== expectedMaterial) {
      return fail("PROJECT_GITHUB_SYNC_INTEGRITY_ERROR");
    }
    const changes = await db.projectGitHubSyncChange.findMany({ where: { projectId: input.projectId, syncRunId: prepared.syncRun.id }, orderBy: [{ identity: "asc" }, { id: "asc" }] });
    const manifestFingerprint = summary.unknown ? null : canonicalProjectGitHubSyncManifest(changes.map((change) => ({ targetKind: change.targetKind, targetKey: change.targetKey, identity: change.identity, changeType: change.changeType, normalizedPath: change.normalizedPath, materialKind: change.materialKind, remoteIdentity: change.remoteIdentity, beforeContentHash: change.beforeContentHash, afterContentHash: change.afterContentHash, beforeRevisionFingerprint: change.beforeRevisionFingerprint, afterRevisionFingerprint: change.afterRevisionFingerprint })) as never);
    const counts = { added: changes.filter((change) => change.changeType === "added").length, updated: changes.filter((change) => change.changeType === "updated").length, deleted: changes.filter((change) => change.changeType === "deleted").length, unchanged: changes.filter((change) => change.changeType === "unchanged").length, withheld: changes.filter((change) => change.changeType === "withheld").length };
    const terminalStatus = resolveProjectGitHubSyncTerminalStatus(summary);
    const failureCode = summary.unknown ? "RECONCILIATION_REQUIRED" : summary.rateLimited ? "GITHUB_RATE_LIMITED" : summary.knownFailure ? (summary.warnings.includes("PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED") ? "PROJECT_GITHUB_SYNC_DEADLINE_EXCEEDED" : "PROJECT_GITHUB_SYNC_INCOMPLETE") : null;
    // Stop the request-bound heartbeat before publishing terminal state.  A
    // heartbeat that failed concurrently means this executor can no longer
    // prove ownership of the lease, so fail closed as unknown.
    await heartbeat.stop();
    if (heartbeat.failure !== null) {
      summary.unknown = true;
      throw heartbeat.failure;
    }
    const completedAt = new Date();
    const updatedRoot = await db.projectGitHubSyncRun.updateMany({
      where: { projectId: input.projectId, id: prepared.syncRun.id, status: "running" },
      data: {
        status: terminalStatus,
        stage: "terminal",
        manifestFingerprint,
        completedCodeTargetCount: completedCode,
        completedMaterialTargetCount: completedMaterial,
        addedCount: counts.added,
        updatedCount: counts.updated,
        deletedCount: counts.deleted,
        unchangedCount: counts.unchanged,
        withheldCount: counts.withheld,
        warnings: jsonValue(summary.warnings),
        failureCode,
        reconciliationRequired: summary.unknown,
        completedAt,
      },
    });
    if (updatedRoot.count !== 1) return fail("PROJECT_GITHUB_SYNC_WRITE_CONFLICT");
    rootTerminalized = true;
    completedRootStatus = terminalStatus;
    if (summary.unknown) {
      await markProjectJobUnknown({ jobId: prepared.job.id, ...claim, error: { code: "RECONCILIATION_REQUIRED" }, result: await publicSummary() }, db);
      jobTerminalized = true;
    } else if (terminalStatus === "succeeded") {
      if (parentWasDispatched && providerDispatchPending) {
        await markProviderAcknowledged({ jobId: prepared.job.id, ...claim, allowExpired: true }, db);
        providerDispatchPending = false;
      }
      await finishProjectJob({ jobId: prepared.job.id, ...claim, result: await publicSummary(), allowExpired: true }, db);
      jobTerminalized = true;
    } else {
      if (parentWasDispatched && providerDispatchPending) {
        await markProviderAcknowledged({ jobId: prepared.job.id, ...claim, allowExpired: true }, db);
        providerDispatchPending = false;
      }
      await failProjectJob({ jobId: prepared.job.id, ...claim, error: { code: failureCode ?? "PROJECT_GITHUB_SYNC_INCOMPLETE" }, result: await publicSummary(), allowExpired: true }, db);
      jobTerminalized = true;
    }
    return getProjectJob(input.projectId, prepared.job.id, db);
  } catch (error) {
    caughtError = error;
    throw error;
  } finally {
    // `stop` is idempotent and must complete before any recovery transition.
    // This prevents an in-flight heartbeat from racing a terminal update.
    await heartbeat.stop();
    const heartbeatFailure = heartbeat.failure;
    if (!rootTerminalized) {
      const uncertain = summary.unknown || providerDispatchPending || heartbeatFailure !== null ||
        (caughtError !== null && isUncertainProviderDispatch(caughtError));
      const closureStatus: SyncRootClosure["status"] = uncertain ? "unknown" : "failed";
      const closureCode = uncertain
        ? "RECONCILIATION_REQUIRED"
        : (caughtError instanceof ProjectGitHubSyncError ? caughtError.code : "PROJECT_GITHUB_SYNC_INCOMPLETE");
      await closeProjectGitHubSyncRoot(db, {
        projectId: input.projectId,
        syncRunId: prepared.syncRun.id,
        closure: { status: closureStatus, failureCode: closureCode },
      });
      rootTerminalized = true;
      completedRootStatus = closureStatus;
    }
    if (!jobTerminalized) {
      const result = await publicSummary().catch(() => null);
      if (completedRootStatus === "unknown") {
        await markProjectJobUnknown({
          jobId: prepared.job.id,
          ...claim,
          error: { code: "RECONCILIATION_REQUIRED" },
          result,
        }, db);
      } else if (completedRootStatus === "succeeded") {
        if (parentWasDispatched && providerDispatchPending) {
          await markProviderAcknowledged({ jobId: prepared.job.id, ...claim, allowExpired: true }, db);
          providerDispatchPending = false;
        }
        await finishProjectJob({ jobId: prepared.job.id, ...claim, result, allowExpired: true }, db);
      } else {
        if (parentWasDispatched && providerDispatchPending) {
          await markProviderAcknowledged({ jobId: prepared.job.id, ...claim, allowExpired: true }, db);
          providerDispatchPending = false;
        }
        await failProjectJob({
          jobId: prepared.job.id,
          ...claim,
          error: { code: completedRootStatus === "failed" ? "PROJECT_GITHUB_SYNC_INCOMPLETE" : "PROJECT_GITHUB_SYNC_INTEGRITY_ERROR" },
          result,
          allowExpired: true,
        }, db);
      }
      jobTerminalized = true;
    }
  }
}
