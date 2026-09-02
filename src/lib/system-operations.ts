import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { AppUserRole, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AuthError, DEFAULT_WORKSPACE_ID } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { BackupOperationsSnapshot, PublicBackupRun } from "@/lib/system-operations-types";

const DEFAULT_STATUS_ROOT = "/var/lib/ai-project-os-operations/backups";
const MAX_STATUS_FILE_BYTES = 32 * 1024;
const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 90;
const HISTORY_FILE_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9]+\.json$/u;
const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9]+$/u;
const BACKUP_NAME_PATTERN = /^[0-9]{8}T[0-9]{6}Z-(?:daily|manual|pre-deploy-to-v[0-9]+\.[0-9]+\.[0-9]+)\.[A-Za-z0-9]{6}$/u;
const ARCHIVE_OBJECT_PATTERN = /^cos:\/\/ai-project-os-backup-[0-9]+\/[A-Za-z0-9][A-Za-z0-9._/-]{1,2000}$/u;

const publicBackupRunSchema = z.object({
  formatVersion: z.literal(1),
  runId: z.string().regex(RUN_ID_PATTERN),
  state: z.enum(["running", "succeeded", "failed", "skipped"]),
  trigger: z.enum(["daily", "manual", "pre-deploy"]),
  targetTag: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+$/u).nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
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

type OperationsUser = Readonly<{ id: string; role: AppUserRole }>;

export async function isInitialSuperAdmin(
  user: OperationsUser,
  db: PrismaClient = getDb(),
): Promise<boolean> {
  if (user.role !== "admin") return false;
  const workspace = await db.workspace.findUnique({
    where: { id: DEFAULT_WORKSPACE_ID },
    select: { createdById: true },
  });
  return workspace?.createdById === user.id;
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
    schedule: { localTime: "03:20", randomizedDelayMinutes: 20, persistent: true },
    readAt,
  };
}
