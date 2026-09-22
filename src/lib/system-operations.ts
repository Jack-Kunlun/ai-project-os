import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { AppUserRole, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AuthError } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { BackupOperationsSnapshot, PublicBackupRun, PublicRecoveryDrill } from "@/lib/system-operations-types";

const DEFAULT_STATUS_ROOT = "/var/lib/ai-project-os-operations/backups";
const MAX_STATUS_FILE_BYTES = 32 * 1024;
const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 90;
const HISTORY_FILE_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9]+\.json$/u;
const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9]+$/u;
// Backup producers use SemVer core tags and numeric `-dev.N` prereleases.
// Keep this grammar narrow so untrusted status files cannot carry arbitrary tag text.
const RELEASE_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-dev\.[1-9][0-9]*)?$/u;
const BACKUP_NAME_PATTERN = /^[0-9]{8}T[0-9]{6}Z-(?:daily|manual|pre-deploy-to-v[0-9]+\.[0-9]+\.[0-9]+(?:-dev\.[1-9][0-9]*)?)\.[A-Za-z0-9]{6}$/u;
const ARCHIVE_OBJECT_PATTERN = /^cos:\/\/ai-project-os-backup-[0-9]+\/[A-Za-z0-9][A-Za-z0-9._/-]{1,2000}$/u;
const DRILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;

const publicBackupRunSchema = z.object({
  formatVersion: z.literal(1),
  runId: z.string().regex(RUN_ID_PATTERN),
  state: z.enum(["running", "succeeded", "failed", "skipped"]),
  trigger: z.enum(["daily", "manual", "pre-deploy"]),
  /** Target release tag emitted for pre-deploy runs; recurring runs use null. */
  targetTag: z.string().regex(RELEASE_TAG_PATTERN).nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  /** Producer-generated backup directory name, including its six-character suffix. */
  backupName: z.string().regex(BACKUP_NAME_PATTERN).nullable(),
  archiveObject: z.string().regex(ARCHIVE_OBJECT_PATTERN).nullable(),
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  archiveBytes: z.number().int().nonnegative().nullable(),
  retentionRemoved: z.number().int().nonnegative(),
  verificationAttempts: z.number().int().nonnegative(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/u).nullable(),
  nextRunAt: z.iso.datetime({ offset: true }).nullable(),
}).strict().superRefine((run, context) => {
  if (run.trigger === "pre-deploy" && run.targetTag === null) {
    context.addIssue({ code: "custom", path: ["targetTag"], message: "pre-deploy status requires a target tag" });
  }
  if (run.trigger !== "pre-deploy" && run.targetTag !== null) {
    context.addIssue({ code: "custom", path: ["targetTag"], message: "only pre-deploy status may include a target tag" });
  }
  if (run.state === "running" && (run.completedAt !== null || run.durationSeconds !== null || run.errorCode !== null)) {
    context.addIssue({ code: "custom", path: ["state"], message: "running status cannot contain completion fields" });
  }
  if (run.state !== "running" && (run.completedAt === null || run.durationSeconds === null)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "final status requires completion fields" });
  }
  if (run.state === "failed" && run.errorCode === null) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "failed status requires an error code" });
  }
  if (run.state !== "failed" && run.errorCode !== null) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "only failed status may include an error code" });
  }
});

const recoveryDrillCheckResultsSchema = z.object({
  pgRestore: z.enum(["passed", "failed"]),
  migrationLedger: z.enum(["passed", "failed"]),
  securityCounts: z.enum(["passed", "failed"]),
  masterKeyVolume: z.enum(["passed", "failed"]),
  uploadsManifest: z.enum(["passed", "failed"]),
  serviceHealth: z.enum(["passed", "failed"]),
}).strict();

const recoveryDrillSecurityCountsSchema = z.object({
  users: z.number().int().nonnegative(),
  workspaces: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
  credentials: z.number().int().nonnegative(),
  projectAssets: z.number().int().nonnegative(),
}).strict();

const publicRecoveryDrillSchema = z.object({
  formatVersion: z.literal(1),
  drillId: z.string().regex(DRILL_ID_PATTERN),
  environment: z.enum(["local", "production"]),
  scope: z.enum(["isolated-local", "isolated-host"]),
  status: z.enum(["verified", "failed"]),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }),
  durationSeconds: z.number().int().nonnegative(),
  sourceArtifact: z.object({
    name: z.string().regex(BACKUP_NAME_PATTERN),
    sha256: z.string().regex(SHA256_PATTERN),
    kind: z.enum(["local-consistent-snapshot", "production-backup"]),
  }).strict().nullable(),
  checks: recoveryDrillCheckResultsSchema,
  validationSha256: z.string().regex(SHA256_PATTERN).nullable(),
  migrationCount: z.number().int().nonnegative(),
  securityCounts: recoveryDrillSecurityCountsSchema,
  errorCode: z.string().regex(SAFE_ERROR_CODE_PATTERN).nullable(),
  cleanupErrorCode: z.string().regex(SAFE_ERROR_CODE_PATTERN).nullable().optional(),
}).strict().superRefine((drill, context) => {
  const startedAt = Date.parse(drill.startedAt);
  const completedAt = Date.parse(drill.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "recovery drill times are invalid" });
  }
  if (drill.environment === "local" && drill.scope !== "isolated-local") {
    context.addIssue({ code: "custom", path: ["scope"], message: "local drill must use isolated-local scope" });
  }
  if (drill.environment === "production" && drill.scope !== "isolated-host") {
    context.addIssue({ code: "custom", path: ["scope"], message: "production drill must use isolated-host scope" });
  }
  const checkValues = Object.values(drill.checks);
  if (drill.status === "verified") {
    if (drill.sourceArtifact === null) context.addIssue({ code: "custom", path: ["sourceArtifact"], message: "verified drill requires a source artifact" });
    if (drill.validationSha256 === null) context.addIssue({ code: "custom", path: ["validationSha256"], message: "verified drill requires a validation digest" });
    if (drill.errorCode !== null) context.addIssue({ code: "custom", path: ["errorCode"], message: "verified drill cannot contain an error code" });
    if (drill.cleanupErrorCode !== undefined && drill.cleanupErrorCode !== null) context.addIssue({ code: "custom", path: ["cleanupErrorCode"], message: "verified drill cannot contain a cleanup error code" });
    if (checkValues.some((value) => value !== "passed")) context.addIssue({ code: "custom", path: ["checks"], message: "verified drill requires all checks to pass" });
  }
  if (drill.status === "failed" && drill.errorCode === null) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "failed drill requires an error code" });
  }
});

type OperationsUser = Readonly<{ id: string; role: AppUserRole }>;

export async function isInitialSuperAdmin(
  user: OperationsUser,
  db: PrismaClient = getDb(),
): Promise<boolean> {
  if (user.role !== "admin") return false;
  const bootstrap = await db.platformBootstrap.findUnique({
    where: { id: "platform" },
    select: { initialAdminUserId: true },
  });
  return bootstrap?.initialAdminUserId === user.id;
}

export async function requireInitialSuperAdmin(
  user: OperationsUser,
  db: PrismaClient = getDb(),
): Promise<void> {
  if (!(await isInitialSuperAdmin(user, db))) throw new AuthError("AUTH_FORBIDDEN");
}

async function readStatusFile(filePath: string): Promise<PublicBackupRun> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_STATUS_FILE_BYTES) {
      throw new Error("BACKUP_STATUS_FILE_INVALID");
    }
    const input = await handle.readFile("utf8");
    return publicBackupRunSchema.parse(JSON.parse(input));
  } finally {
    await handle.close();
  }
}

async function readRecoveryDrillFile(filePath: string, now: Date): Promise<PublicRecoveryDrill> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_STATUS_FILE_BYTES) {
      throw new Error("RECOVERY_DRILL_FILE_INVALID");
    }
    const drill = publicRecoveryDrillSchema.parse(JSON.parse(await handle.readFile("utf8")));
    const startedAt = Date.parse(drill.startedAt);
    const completedAt = Date.parse(drill.completedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt > now.getTime() || completedAt > now.getTime()) {
      throw new Error("RECOVERY_DRILL_TIME_INVALID");
    }
    return drill;
  } finally {
    await handle.close();
  }
}

function canonicalStatusRoot(root: string): string | null {
  if (!path.isAbsolute(root) || root.includes("\0")) return null;
  const normalized = path.normalize(root);
  return normalized === root && normalized !== path.parse(normalized).root ? normalized : null;
}

function safeHistoryLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(value, MAX_HISTORY_LIMIT);
}

async function directoryIsSafe(directoryPath: string): Promise<boolean> {
  try {
    const metadata = await lstat(directoryPath);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function readBackupOperationsSnapshot(options: Readonly<{
  root?: string;
  historyLimit?: number;
  now?: Date;
}> = {}): Promise<BackupOperationsSnapshot> {
  const readAt = (options.now ?? new Date()).toISOString();
  const configuredRoot = options.root ?? process.env.AI_PROJECT_OS_OPERATIONS_STATUS_ROOT ?? DEFAULT_STATUS_ROOT;
  const root = canonicalStatusRoot(configuredRoot);
  const empty = (sourceStatus: BackupOperationsSnapshot["sourceStatus"]): BackupOperationsSnapshot => ({
    sourceStatus,
    current: null,
    history: [],
    recoveryDrillSourceStatus: sourceStatus === "ready" ? "not_configured" : sourceStatus,
    recoveryDrill: null,
    schedule: { localTime: "03:20", randomizedDelayMinutes: 20, persistent: true },
    readAt,
  });

  if (root === null) return empty("invalid");
  try {
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return empty("invalid");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? empty("not_configured") : empty("invalid");
  }

  let current: PublicBackupRun | null = null;
  let sourceStatus: BackupOperationsSnapshot["sourceStatus"] = "ready";
  try {
    current = await readStatusFile(path.join(root, "current.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") sourceStatus = "invalid";
  }

  let recoveryDrill: PublicRecoveryDrill | null = null;
  let recoveryDrillSourceStatus: BackupOperationsSnapshot["recoveryDrillSourceStatus"] = "not_configured";
  try {
    recoveryDrill = await readRecoveryDrillFile(path.join(root, "recovery-drill.json"), options.now ?? new Date());
    recoveryDrillSourceStatus = "ready";
  } catch (error) {
    recoveryDrillSourceStatus = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_configured" : "invalid";
  }

  const historyRoot = path.join(root, "history");
  const history: PublicBackupRun[] = [];
  if (await directoryIsSafe(historyRoot)) {
    const entries = await readdir(historyRoot, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && HISTORY_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of names) {
      try {
        history.push(await readStatusFile(path.join(historyRoot, name)));
      } catch {
        // A malformed historical record is ignored instead of exposing raw host data.
      }
      if (history.length >= safeHistoryLimit(options.historyLimit ?? DEFAULT_HISTORY_LIMIT)) break;
    }
  }

  history.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return {
    sourceStatus,
    current,
    history,
    recoveryDrillSourceStatus,
    recoveryDrill,
    schedule: { localTime: "03:20", randomizedDelayMinutes: 20, persistent: true },
    readAt,
  };
}
