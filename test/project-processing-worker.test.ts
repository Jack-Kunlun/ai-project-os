import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { ProjectProcessingQueueScheduler } from "../src/lib/project-processing-worker";

type FakeQueueJob = {
  id: string;
  projectId: string;
  requestedById: string;
  kind: "assetExtract" | "autoExtract";
  status: "queued" | "succeeded";
  stage: string;
  createdAt: Date;
};

function fakeDatabase(jobs: FakeQueueJob[]) {
  return {
    backgroundJob: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        const cursorOr = args.where.OR as Array<Record<string, unknown>> | undefined;
        const cursorDate = cursorOr?.[0]?.createdAt as { gt?: Date } | undefined;
        const cursorId = cursorOr?.[1]?.id as { gt?: string } | undefined;
        return jobs
          .filter((job) => job.status === "queued" && job.stage === "worker_queued")
          .filter((job) => cursorDate === undefined || job.createdAt > cursorDate.gt!
            || (job.createdAt.getTime() === cursorDate.gt!.getTime() && job.id > cursorId!.gt!))
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
          .slice(0, 100)
          .map(({ id, projectId, requestedById, kind, createdAt }) => ({ id, projectId, requestedById, kind, createdAt }));
      },
      findFirst: async (args: { where: Record<string, unknown> }) => {
        const requestedById = args.where.requestedById as string;
        const earlierOr = args.where.OR as Array<Record<string, unknown>>;
        const earlierDate = earlierOr[0]?.createdAt as { lt?: Date };
        const sameDate = earlierOr[1]?.createdAt as Date;
        const earlierId = earlierOr[1]?.id as { lt?: string };
        return jobs
          .filter((job) => job.status === "queued" && job.stage === "worker_queued" && job.requestedById === requestedById)
          .find((job) => job.createdAt < earlierDate.lt!
            || (job.createdAt.getTime() === sameDate.getTime() && job.id < earlierId.lt!)) ?? null;
      },
    },
    appUser: {
      findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, role: "user", accountAccessVersion: 1 }),
    },
  } as unknown as PrismaClient;
}

function queuedJob(index: number, requestedById = `actor-${String(index).padStart(3, "0")}`): FakeQueueJob {
  return {
    id: `job-${String(index).padStart(3, "0")}`,
    projectId: `project-${requestedById}`,
    requestedById,
    kind: "autoExtract",
    status: "queued",
    stage: "worker_queued",
    createdAt: new Date(1_800_000_000_000 + index),
  };
}

test("processing queue cursor passes five blocked actors with twenty jobs each and reaches the 101st job", async () => {
  const jobs = Array.from({ length: 100 }, (_, index) => queuedJob(index, `blocked-actor-${Math.floor(index / 20)}`));
  jobs.push(queuedJob(100, "runnable-actor"));
  const db = fakeDatabase(jobs);
  const scheduler = new ProjectProcessingQueueScheduler();
  const executed: string[] = [];
  const execute = async (job: Readonly<{ id: string; requestedById: string }>) => {
    executed.push(job.id);
    if (job.requestedById !== "runnable-actor") return { status: "queued" };
    const stored = jobs.find((candidate) => candidate.id === job.id)!;
    stored.status = "succeeded";
    return { status: "succeeded" };
  };

  const firstCycle = await scheduler.runCycle({ maximumJobs: 1 }, db, execute);
  assert.deepEqual(firstCycle, { claimed: 0, failed: 0, waiting: 5 });
  assert.equal(executed.length, 5, "the actor skip must still advance the cursor across its other nineteen jobs");

  const secondCycle = await scheduler.runCycle({ maximumJobs: 1 }, db, execute);
  assert.deepEqual(secondCycle, { claimed: 1, failed: 0, waiting: 0 });
  assert.equal(executed.at(-1), "job-100");
});

test("rotating processing cursor never dispatches a later queued job before its actor's earlier job", async () => {
  const jobs = [queuedJob(0, "same-actor"), queuedJob(1, "same-actor")];
  const db = fakeDatabase(jobs);
  const scheduler = new ProjectProcessingQueueScheduler();
  const executed: string[] = [];
  let firstAttempt = true;
  const execute = async (job: Readonly<{ id: string }>) => {
    executed.push(job.id);
    if (job.id === "job-000" && firstAttempt) {
      firstAttempt = false;
      return { status: "queued" };
    }
    jobs.find((candidate) => candidate.id === job.id)!.status = "succeeded";
    return { status: "succeeded" };
  };

  await scheduler.runCycle({ maximumJobs: 1 }, db, execute);
  assert.deepEqual(executed, ["job-000"]);
  await scheduler.runCycle({ maximumJobs: 1 }, db, execute);
  assert.deepEqual(executed, ["job-000", "job-000"]);
  await scheduler.runCycle({ maximumJobs: 1 }, db, execute);
  assert.deepEqual(executed, ["job-000", "job-000", "job-001"]);
});
