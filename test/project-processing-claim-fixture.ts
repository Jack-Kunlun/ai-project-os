import type { Prisma, PrismaClient } from "@prisma/client";

/** Mutate access exactly after a durable worker claim commits, before its runner resumes. */
export function afterProcessingClaim(
  db: PrismaClient,
  jobId: string,
  afterClaim: () => Promise<unknown>,
): PrismaClient {
  let applied = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return (async (
        work: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
      ) => {
        const result = await target.$transaction(work, options);
        if (!applied && await db.backgroundJob.count({ where: { id: jobId, status: "running", stage: "worker_processing" } }) === 1) {
          applied = true;
          await afterClaim();
        }
        return result;
      }) as PrismaClient["$transaction"];
    },
  });
}
