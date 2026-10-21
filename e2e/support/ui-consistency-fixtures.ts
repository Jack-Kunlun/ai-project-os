import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export type UiConsistencyDetailFixtures = Readonly<{
  sourceId: string;
  sourceText: string;
  jobId: string;
  syncRunId: string;
}>;

/**
 * Seed real project-source, completed-job, and Git-sync detail records for the
 * all-route browser matrix. Dynamic detail URLs must not use missing IDs as a
 * substitute for rendering a real detail page.
 */
export async function seedUiConsistencyDetailFixtures(projectId: string, actorId: string): Promise<UiConsistencyDetailFixtures> {
  const db = getDb();
  try {
    const owner = await db.appUser.findUniqueOrThrow({ where: { id: actorId }, select: { id: true } });
    const sourceText = "UI consistency matrix source fixture";
    const contentHash = createHash("sha256").update(sourceText).digest("hex");
    const source = await db.projectSource.create({
      data: { projectId, kind: "manual", contentText: sourceText, contentHash, manualContentDedupeKey: contentHash },
      select: { id: true },
    });
    const completedAt = new Date();
    const job = await db.backgroundJob.create({
      data: {
        projectId,
        kind: "projectBrief",
        status: "succeeded",
        stage: "terminal",
        payload: { source: "ui-consistency-matrix" },
        result: { summary: "UI consistency matrix completed job fixture" },
        progressCurrent: 1,
        progressTotal: 1,
        idempotencyKey: createHash("sha256").update(`ui-consistency-job:${projectId}:${randomUUID()}`).digest("hex"),
        requestedById: owner.id,
        startedAt: completedAt,
        completedAt,
      },
      select: { id: true },
    });
    const syncJob = await db.backgroundJob.create({
      data: {
        projectId,
        kind: "githubProjectSync",
        status: "succeeded",
        stage: "terminal",
        payload: { source: "ui-consistency-matrix" },
        progressCurrent: 0,
        progressTotal: 0,
        idempotencyKey: createHash("sha256").update(`ui-consistency-sync-job:${projectId}:${randomUUID()}`).digest("hex"),
        requestedById: owner.id,
        startedAt: completedAt,
        completedAt,
      },
      select: { id: true },
    });
    const syncRun = await db.projectGitHubSyncRun.create({
      data: {
        projectId,
        parentJobId: syncJob.id,
        status: "succeeded",
        stage: "terminal",
        scopeFingerprint: createHash("sha256").update(`ui-consistency-sync-scope:${projectId}`).digest("hex"),
        manifestFingerprint: createHash("sha256").update(`ui-consistency-sync-manifest:${projectId}`).digest("hex"),
        deadlineAt: new Date(completedAt.getTime() + 60_000),
        warnings: [],
        startedAt: completedAt,
        completedAt,
      },
      select: { id: true },
    });
    await db.backgroundJob.update({
      where: { id: syncJob.id },
      data: { result: { syncRunId: syncRun.id, counts: { added: 0, updated: 0, deleted: 0, withheld: 0 }, warnings: [] } },
    });
    return { sourceId: source.id, sourceText, jobId: job.id, syncRunId: syncRun.id };
  } finally {
    await db.$disconnect();
  }
}
