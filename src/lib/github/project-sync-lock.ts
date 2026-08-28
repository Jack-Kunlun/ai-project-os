import { Prisma, type PrismaClient } from "@prisma/client";

/** Shared namespace for repository operations and the project-wide sync. */
export const GITHUB_PROJECT_SYNC_LOCK_NAMESPACE = 23082303 as const;

export type GitHubProjectLockDb = PrismaClient | Prisma.TransactionClient;

export async function lockGitHubProject(
  db: GitHubProjectLockDb,
  projectId: string,
): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, ${GITHUB_PROJECT_SYNC_LOCK_NAMESPACE}))`;
}

/**
 * Unknown project-sync rows remain an admission blocker until an explicit
 * reconciliation row records the user's decision.  Once reconciled, a new
 * direct operation may be admitted without changing the old unknown row.
 */
export async function hasBlockingUnknownProjectSyncRun(
  db: GitHubProjectLockDb,
  projectId: string,
): Promise<boolean> {
  const rows = await db.projectGitHubSyncRun.findMany({
    where: { projectId, status: "unknown" },
    select: { id: true, reconciliation: { select: { id: true } } },
  });
  return rows.some((row) => row.reconciliation === null);
}

export async function hasBlockingUnknownProjectCodeBatch(
  db: GitHubProjectLockDb,
  projectId: string,
): Promise<boolean> {
  const batches = await db.projectScanBatch.findMany({
    where: { projectId, status: "unknown" },
    select: { id: true },
  });
  if (batches.length === 0) return false;
  const entries = await db.projectGitHubSyncEntry.findMany({
    where: { projectId, childCodeBatchId: { in: batches.map((batch) => batch.id) } },
    select: { childCodeBatchId: true, syncRun: { select: { reconciliation: { select: { id: true } } } } },
  });
  const reconciled = new Set(entries.flatMap((entry) => entry.syncRun.reconciliation === null ? [] : entry.childCodeBatchId === null ? [] : [entry.childCodeBatchId]));
  return batches.some((batch) => !reconciled.has(batch.id));
}

export async function hasBlockingUnknownProjectMaterialRun(
  db: GitHubProjectLockDb,
  projectId: string,
): Promise<boolean> {
  const runs = await db.gitHubMaterialSyncRun.findMany({
    where: { projectId, status: "unknown" },
    select: { id: true },
  });
  if (runs.length === 0) return false;
  const entries = await db.projectGitHubSyncEntry.findMany({
    where: { projectId, childMaterialSyncRunId: { in: runs.map((run) => run.id) } },
    select: { childMaterialSyncRunId: true, syncRun: { select: { reconciliation: { select: { id: true } } } } },
  });
  const reconciled = new Set(entries.flatMap((entry) => entry.syncRun.reconciliation === null ? [] : entry.childMaterialSyncRunId === null ? [] : [entry.childMaterialSyncRunId]));
  return runs.some((run) => !reconciled.has(run.id));
}
