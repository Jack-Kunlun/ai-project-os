import type { Prisma, PrismaClient } from "@prisma/client";
import { getDb } from "@/lib/db";
import { runQueuedProjectAssetVisionExtraction } from "@/lib/project-assets/vision";
import type { WebAiActor } from "@/lib/web-ai-access";
import { runQueuedAutoExtractJob } from "@/lib/web-auto-extract";

const MAXIMUM_QUEUE_CANDIDATES = 100;

type QueueCandidate = Readonly<{
  id: string;
  projectId: string | null;
  requestedById: string;
  kind: "assetExtract" | "autoExtract";
  createdAt: Date;
}>;

type ProjectProcessingExecutor = (
  job: QueueCandidate & Readonly<{ projectId: string }>,
  actor: WebAiActor,
  db: PrismaClient,
) => Promise<Readonly<{ status: string }>>;

type QueueCursor = Readonly<{ createdAt: Date; id: string }>;

const queueWhere = {
  status: "queued" as const,
  stage: "worker_queued",
  kind: { in: ["assetExtract", "autoExtract"] },
  projectId: { not: null },
} satisfies Prisma.BackgroundJobWhereInput;

async function executeProjectProcessingJob(
  job: QueueCandidate & Readonly<{ projectId: string }>,
  actor: WebAiActor,
  db: PrismaClient,
) {
  return job.kind === "assetExtract"
    ? runQueuedProjectAssetVisionExtraction({ projectId: job.projectId, jobId: job.id, requestedBy: actor }, db)
    : runQueuedAutoExtractJob({ projectId: job.projectId, jobId: job.id, requestedBy: actor }, db);
}

/**
 * A worker instance keeps this cursor across cycles so a fixed head of jobs
 * whose actors are at their model concurrency limit cannot starve later
 * actors. It is deliberately in-memory: restarting a worker safely starts at
 * the queue head, while durable jobs remain the source of truth.
 */
export class ProjectProcessingQueueScheduler {
  private cursor: QueueCursor | null = null;

  async runCycle(
    input: Readonly<{ maximumJobs?: number }> = {},
    db: PrismaClient = getDb(),
    execute: ProjectProcessingExecutor = executeProjectProcessingJob,
  ): Promise<Readonly<{ claimed: number; failed: number; waiting: number }>> {
    const maximumJobs = input.maximumJobs ?? 5;
    if (!Number.isSafeInteger(maximumJobs) || maximumJobs < 1 || maximumJobs > 20) {
      throw new RangeError("maximumJobs must be an integer between 1 and 20");
    }

    const findCandidates = (cursor: QueueCursor | null) => db.backgroundJob.findMany({
      where: {
        ...queueWhere,
        ...(cursor === null ? {} : {
          OR: [
            { createdAt: { gt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { gt: cursor.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: MAXIMUM_QUEUE_CANDIDATES,
      select: { id: true, projectId: true, requestedById: true, kind: true, createdAt: true },
    });

    const startingCursor = this.cursor;
    let queued = await findCandidates(startingCursor);
    if (queued.length === 0 && startingCursor !== null) {
      this.cursor = null;
      queued = await findCandidates(null);
    }

    let claimed = 0;
    let failed = 0;
    let waiting = 0;
    const blockedActors = new Set<string>();
    for (const candidate of queued as QueueCandidate[]) {
      if (claimed >= maximumJobs) break;
      // Advance only after reaching this candidate. Jobs later in the page
      // remain ahead of the cursor when this cycle stops at its claim limit.
      this.cursor = Object.freeze({ createdAt: candidate.createdAt, id: candidate.id });
      if (candidate.projectId === null || blockedActors.has(candidate.requestedById)) continue;

      // A rotating global cursor must never dispatch a later queued job for
      // the same actor while an earlier confirmed job is still waiting.
      if (startingCursor !== null) {
        const olderQueuedJob = await db.backgroundJob.findFirst({
          where: {
            ...queueWhere,
            requestedById: candidate.requestedById,
            OR: [
              { createdAt: { lt: candidate.createdAt } },
              { createdAt: candidate.createdAt, id: { lt: candidate.id } },
            ],
          },
          select: { id: true },
        });
        if (olderQueuedJob !== null) {
          blockedActors.add(candidate.requestedById);
          continue;
        }
      }

      const actor = await db.appUser.findUnique({
        where: { id: candidate.requestedById },
        select: { id: true, role: true, accountAccessVersion: true },
      });
      if (actor === null) {
        failed += 1;
        continue;
      }
      if (candidate.projectId === null) continue;
      try {
        const result = await execute({ ...candidate, projectId: candidate.projectId }, actor, db);
        if (result.status === "queued") {
          waiting += 1;
          blockedActors.add(candidate.requestedById);
        } else {
          claimed += 1;
          if (result.status === "failed") failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return Object.freeze({ claimed, failed, waiting });
  }
}

const projectProcessingQueueScheduler = new ProjectProcessingQueueScheduler();

export async function runProjectProcessingWorkerCycle(
  input: Readonly<{ maximumJobs?: number }> = {},
  db: PrismaClient = getDb(),
): Promise<Readonly<{ claimed: number; failed: number; waiting: number }>> {
  return projectProcessingQueueScheduler.runCycle(input, db);
}
