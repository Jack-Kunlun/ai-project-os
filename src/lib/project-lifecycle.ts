import { Prisma, type PrismaClient } from "@prisma/client";
import { getDb } from "@/lib/db";

export type ProjectLifecycleErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ARCHIVED"
  | "PROJECT_ALREADY_ACTIVE"
  | "PROJECT_LIFECYCLE_STALE"
  | "PROJECT_HAS_UNRESOLVED_JOBS"
  | "PROJECT_LIFECYCLE_CONFLICT";

export class ProjectLifecycleError extends Error {
  constructor(readonly code: ProjectLifecycleErrorCode) {
    super(code);
    this.name = "ProjectLifecycleError";
  }
}

const lifecycleProjectSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export async function assertProjectActive(projectId: string, db: PrismaClient = getDb()): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } });
  if (project === null) throw new ProjectLifecycleError("PROJECT_NOT_FOUND");
  if (project.archivedAt !== null) throw new ProjectLifecycleError("PROJECT_ARCHIVED");
}

export async function updateProjectLifecycle(
  input: Readonly<{
    projectId: string;
    actorId: string;
    action: "archive" | "restore";
    expectedUpdatedAt: Date;
  }>,
  db: PrismaClient = getDb(),
) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}::text, 23082915))
        `);
        const current = await tx.project.findUnique({
          where: { id: input.projectId },
          select: { ...lifecycleProjectSelect, archivedAt: true },
        });
        if (current === null) throw new ProjectLifecycleError("PROJECT_NOT_FOUND");
        if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
          throw new ProjectLifecycleError("PROJECT_LIFECYCLE_STALE");
        }

        if (input.action === "archive") {
          if (current.archivedAt !== null) throw new ProjectLifecycleError("PROJECT_ARCHIVED");
          const unresolvedJobs = await tx.backgroundJob.count({
            where: {
              projectId: input.projectId,
              OR: [
                { status: { in: ["queued", "waitingConsent", "running"] } },
                { reconciliationRequired: true },
              ],
            },
          });
          const runningAutomations = await tx.automationRun.count({ where: { projectId: input.projectId, status: "running" } });
          if (unresolvedJobs > 0 || runningAutomations > 0) throw new ProjectLifecycleError("PROJECT_HAS_UNRESOLVED_JOBS");
        } else if (current.archivedAt === null) {
          throw new ProjectLifecycleError("PROJECT_ALREADY_ACTIVE");
        }

        const changedAt = new Date();
        const archivedAt = input.action === "archive" ? changedAt : null;
        const project = await tx.project.update({
          where: { id: input.projectId },
          data: { archivedAt, updatedAt: changedAt },
          select: lifecycleProjectSelect,
        });
        if (input.action === "archive") {
          await tx.automationRule.updateMany({ where: { projectId: input.projectId, status: "active" }, data: { status: "paused" } });
        }
        const revision = await tx.projectLifecycleRevision.create({
          data: {
            projectId: input.projectId,
            action: input.action === "archive" ? "archived" : "restored",
            actorId: input.actorId,
            previousArchivedAt: current.archivedAt,
            currentArchivedAt: archivedAt,
            projectUpdatedAt: project.updatedAt,
          },
          select: { id: true, action: true, createdAt: true },
        });
        return Object.freeze({ project, revision });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      if (isSerializationConflict(error)) throw new ProjectLifecycleError("PROJECT_LIFECYCLE_CONFLICT");
      throw error;
    }
  }
  throw new ProjectLifecycleError("PROJECT_LIFECYCLE_CONFLICT");
}
