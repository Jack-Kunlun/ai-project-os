import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isProjectSnapshotGenerationConflict } from "@/lib/project-snapshot-errors";
import {
  assembleProjectSnapshot,
  parseSnapshotRecord,
  SnapshotAssemblyError,
  type ProjectSnapshotItemInput,
  type SnapshotRecord,
} from "@/lib/project-snapshot";
import { createProjectSnapshotSchema, projectIdSchema } from "@/lib/validation";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";

const ADVISORY_LOCK_SEED = BigInt("20260826");

const snapshotRecordSelect = {
  id: true,
  projectId: true,
  scanId: true,
  generatedAt: true,
  payload: true,
} as const;

const snapshotItemSelect = {
  id: true,
  type: true,
  reviewStatus: true,
  title: true,
  content: true,
  sourceExcerpt: true,
  occurredAt: true,
  confirmedAt: true,
  source: {
    select: {
      id: true,
      kind: true,
      externalRef: true,
      contentText: true,
      contentHash: true,
      capturedAt: true,
      ingestedAt: true,
    },
  },
} as const;

type ProjectLockRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  readAt: Date | string;
  lockAcquired: boolean;
};

type SnapshotTransactionOutcome =
  | { kind: "missing-project" }
  | { kind: "in-progress" }
  | { kind: "failed"; code: SnapshotAssemblyError["code"] }
  | { kind: "success"; snapshot: SnapshotRecord };

async function parseProjectId(params: Promise<{ projectId: string }>): Promise<string> {
  const { projectId } = await params;
  return projectIdSchema.parse(projectId);
}

function projectNotFoundError(): ApiError {
  return new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
}

function snapshotDataInvalidError(): ApiError {
  return new ApiError(500, "SNAPSHOT_DATA_INVALID", "Stored snapshot data is invalid");
}

function toIsoTimestamp(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw snapshotDataInvalidError();
  }

  return value.toISOString();
}

function toSnapshotRecord(record: {
  id: string;
  projectId: string;
  scanId: string | null;
  generatedAt: Date;
  payload: unknown;
}): SnapshotRecord {
  try {
    return parseSnapshotRecord({
      id: record.id,
      projectId: record.projectId,
      scanId: record.scanId,
      generatedAt: toIsoTimestamp(record.generatedAt),
      payload: record.payload,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw snapshotDataInvalidError();
  }
}

async function assertProjectExists(db: ReturnType<typeof getDb>, projectId: string): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw projectNotFoundError();
}

async function getLatestSnapshot(db: ReturnType<typeof getDb>, projectId: string): Promise<SnapshotRecord | null> {
  const snapshot = await db.projectSnapshot.findFirst({
    where: {
      projectId,
      scanId: { not: null },
      scan: { is: { status: "completed" } },
    },
    orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
    select: snapshotRecordSelect,
  });

  return snapshot ? toSnapshotRecord(snapshot) : null;
}

async function getDatabaseTimestamp(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ generatedAt: Date | string }>>(Prisma.sql`
    SELECT clock_timestamp() AS "generatedAt"
  `);
  const generatedAt = rows[0]?.generatedAt;
  const parsedGeneratedAt = generatedAt instanceof Date ? generatedAt : new Date(generatedAt ?? "");
  if (Number.isNaN(parsedGeneratedAt.getTime())) {
    throw new Error("Database timestamp was invalid");
  }
  return parsedGeneratedAt;
}

async function generateSnapshot(projectId: string): Promise<SnapshotTransactionOutcome> {
  const db = getDb();

  return db.$transaction(
    async (tx): Promise<SnapshotTransactionOutcome> => {
      const rows = await tx.$queryRaw<ProjectLockRow[]>(Prisma.sql`
        SELECT
          p.id,
          p.name,
          p.slug,
          p.description,
          statement_timestamp() AS "readAt",
          pg_try_advisory_xact_lock(
            hashtextextended(p.id::text, CAST(${ADVISORY_LOCK_SEED} AS bigint))
          ) AS "lockAcquired"
        FROM "Project" AS p
        WHERE p.id = CAST(${projectId} AS uuid)
        FOR KEY SHARE
      `);
      const project = rows[0];

      if (!project) return { kind: "missing-project" };
      if (!project.lockAcquired) return { kind: "in-progress" };

      const items = await tx.projectItem.findMany({
        where: { projectId },
        select: snapshotItemSelect,
      });

      let payload;
      try {
        const generatedAt = await getDatabaseTimestamp(tx);
        payload = assembleProjectSnapshot({
          project: {
            id: project.id,
            name: project.name,
            slug: project.slug,
            description: project.description,
          },
          items: items as unknown as ProjectSnapshotItemInput[],
          readAt: project.readAt,
          generatedAt,
        });

        const scan = await tx.projectScan.create({
          data: {
            projectId,
            trigger: "manual",
            status: "running",
            startedAt: project.readAt,
          },
        });

        const snapshot = await tx.projectSnapshot.create({
          data: {
            projectId,
            scanId: scan.id,
            generatedAt,
            payload,
          },
          select: snapshotRecordSelect,
        });

        await tx.projectScan.update({
          where: { projectId_id: { projectId, id: scan.id } },
          data: {
            status: "completed",
            completedAt: generatedAt,
            error: null,
          },
        });

        return { kind: "success", snapshot: toSnapshotRecord(snapshot) };
      } catch (error) {
        if (!(error instanceof SnapshotAssemblyError)) throw error;

        const generatedAt = await getDatabaseTimestamp(tx);
        await tx.projectScan.create({
          data: {
            projectId,
            trigger: "manual",
            status: "failed",
            startedAt: project.readAt,
            completedAt: generatedAt,
            error: error.code,
          },
        });

        return { kind: "failed", code: error.code };
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    await requireApiSession(request);
    const projectId = await parseProjectId(context.params);
    const db = getDb();
    await assertProjectExists(db, projectId);
    const snapshot = await getLatestSnapshot(db, projectId);
    return NextResponse.json({ snapshot });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const projectId = await parseProjectId(context.params);
    await assertProjectActive(projectId);
    createProjectSnapshotSchema.parse(await readJsonBody(request));
    const outcome = await generateSnapshot(projectId);

    if (outcome.kind === "missing-project") {
      throw projectNotFoundError();
    }
    if (outcome.kind === "in-progress") {
      throw new ApiError(409, "SNAPSHOT_GENERATION_IN_PROGRESS", "Snapshot generation is already in progress");
    }
    if (outcome.kind === "failed") {
      if (outcome.code === "SNAPSHOT_NO_CONFIRMED_ITEMS") {
        throw new ApiError(422, outcome.code, "At least one confirmed Item is required to generate a snapshot");
      }
      throw new ApiError(409, outcome.code, "A confirmed Item has invalid source provenance");
    }

    return NextResponse.json({ snapshot: outcome.snapshot }, { status: 201 });
  } catch (error) {
    if (isProjectSnapshotGenerationConflict(error)) {
      return handleApiError(new ApiError(409, "SNAPSHOT_GENERATION_CONFLICT", "Snapshot generation conflicted; retry the request"));
    }
    return handleApiError(error);
  }
}
