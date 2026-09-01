import { randomUUID } from "node:crypto";
import { Prisma, type AppUser, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { hashSourceContent, MAX_SOURCE_CONTENT_LENGTH } from "@/lib/source";
import { manifestFingerprint } from "@/lib/web-ai-governance";
import {
  assertProjectAssetCountAvailable,
  createProjectAssetUploadReservation,
  PROJECT_ASSET_UPLOAD_RESERVATION_LOCK_NAMESPACE,
  reconcileStaleProjectAssetUploadReservations,
  releaseProjectAssetUploadReservation,
} from "@/lib/project-assets/quota";
import { parseAssetBuffer, PROJECT_ASSET_PARSER_VERSION } from "@/lib/project-assets/parser";
import { getUploadPolicy } from "@/lib/project-assets/policy";
import { isSerializableTransactionConflict, withSerializableRetry } from "@/lib/prisma-transaction";
import {
  assetBlobStorageKey,
  assetContentHash,
  detectAssetFile,
  readAssetBlob,
  removeAssetBlob,
  sanitizeAssetFileName,
  writeAssetBlob,
} from "@/lib/project-assets/storage";

const assetIdSchema = z.string().uuid();
const segmentIdSchema = z.string().uuid();
const reviewSchema = z.object({
  action: z.enum(["accept", "dismiss"]),
  reviewedText: z.string().trim().min(1).max(MAX_SOURCE_CONTENT_LENGTH).optional(),
}).strict();

export type ProjectAssetErrorCode =
  | "PROJECT_ASSET_INVALID_INPUT"
  | "PROJECT_ASSET_NOT_FOUND"
  | "PROJECT_ASSET_DUPLICATE"
  | "PROJECT_ASSET_INVALID_STATE"
  | "PROJECT_ASSET_SEGMENT_NOT_FOUND"
  | "PROJECT_ASSET_SEGMENT_ALREADY_REVIEWED"
  | "PROJECT_ASSET_PROJECT_QUOTA_EXCEEDED"
  | "PROJECT_ASSET_WORKSPACE_QUOTA_EXCEEDED"
  | "PROJECT_ASSET_DEPLOYMENT_QUOTA_EXCEEDED"
  | "PROJECT_ASSET_COUNT_QUOTA_EXCEEDED";

export class ProjectAssetError extends Error {
  constructor(readonly code: ProjectAssetErrorCode) {
    super(code);
    this.name = "ProjectAssetError";
  }
}

function fail(code: ProjectAssetErrorCode): never {
  throw new ProjectAssetError(code);
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function locatorFragment(segment: Readonly<{
  pageNumber: number | null;
  slideNumber: number | null;
  sheetName: string | null;
  ordinal: number;
}>): string {
  if (segment.pageNumber !== null) return `page=${segment.pageNumber}`;
  if (segment.slideNumber !== null) return `slide=${segment.slideNumber}`;
  if (segment.sheetName !== null) {
    const sheetName = encodeURIComponent(segment.sheetName).replace(/[!'()*]/g, (character) =>
      `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
    );
    return `sheet=${sheetName}`;
  }
  return `segment=${segment.ordinal + 1}`;
}

function publicAsset(asset: Awaited<ReturnType<typeof readAssetRecord>>) {
  if (asset === null) return null;
  const version = asset.versions[0];
  return Object.freeze({
    id: asset.id,
    projectId: asset.projectId,
    displayName: asset.displayName,
    kind: asset.kind,
    status: asset.status,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    version: version === undefined ? null : Object.freeze({
      id: version.id,
      version: version.version,
      originalFileName: version.originalFileName,
      mimeType: version.mimeType,
      sizeBytes: Number(version.sizeBytes),
      contentHash: version.contentHash,
      status: version.status,
      parserVersion: version.parserVersion,
      failureCode: version.failureCode,
      createdAt: version.createdAt,
      completedAt: version.completedAt,
    }),
    segments: version?.segments.map((segment) => Object.freeze({
      id: segment.id,
      ordinal: segment.ordinal,
      locatorKind: segment.locatorKind,
      locatorLabel: segment.locatorLabel,
      pageNumber: segment.pageNumber,
      slideNumber: segment.slideNumber,
      sheetName: segment.sheetName,
      cellRange: segment.cellRange,
      requiresVision: segment.requiresVision,
      extractionMethod: segment.extractionMethod,
      contentText: segment.contentText,
      contentHash: segment.contentHash,
      reviewedText: segment.reviewedText,
      reviewStatus: segment.reviewStatus,
      reviewedAt: segment.reviewedAt,
      modelId: segment.modelId,
      projectSourceId: segment.projectSourceId,
      providerConnection: segment.providerConnection,
    })) ?? [],
    latestRun: version?.extractionRuns[0] ?? null,
  });
}

function readAssetRecord(projectId: string, assetId: string, db: PrismaClient) {
  return db.projectAsset.findUnique({
    where: { projectId_id: { projectId, id: assetId } },
    include: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        include: {
          segments: {
            orderBy: { ordinal: "asc" },
            include: { providerConnection: { select: { id: true, name: true, kind: true } } },
          },
          extractionRuns: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: {
              id: true,
              status: true,
              providerConnectionId: true,
              modelId: true,
              localSegmentCount: true,
              visionSegmentCount: true,
              failureCode: true,
              createdAt: true,
              completedAt: true,
            },
          },
        },
      },
    },
  });
}

export async function getProjectAsset(projectId: string, assetIdInput: unknown, db: PrismaClient = getDb()) {
  const assetId = assetIdSchema.parse(assetIdInput);
  const asset = await readAssetRecord(projectId, assetId, db);
  if (asset === null || asset.status === "deleted") return fail("PROJECT_ASSET_NOT_FOUND");
  return publicAsset(asset);
}

export async function listProjectAssets(projectId: string, db: PrismaClient = getDb()) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (project === null) return fail("PROJECT_ASSET_NOT_FOUND");
  const assets = await db.projectAsset.findMany({
    where: { projectId, status: { not: "deleted" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return Object.freeze(await Promise.all(assets.map(async ({ id }) => publicAsset(await readAssetRecord(projectId, id, db)))));
}

/**
 * Settle a failed upload only after the generated storage key is known to be
 * either committed or physically absent. If filesystem cleanup fails, the
 * reservation intentionally remains billable and the original error survives.
 */
async function settleUploadReservationAfterFailure(
  reservationId: string,
  storageKey: string,
  db: PrismaClient,
): Promise<string | null> {
  const committed = await db.projectAssetVersion.findFirst({ where: { storageKey }, select: { projectAssetId: true } });
  if (committed !== null) {
    await releaseProjectAssetUploadReservation(reservationId, storageKey, db);
    return committed.projectAssetId;
  }
  await removeAssetBlob(storageKey);
  await releaseProjectAssetUploadReservation(reservationId, storageKey, db);
  return null;
}

export async function uploadProjectAsset(input: Readonly<{
  projectId: string;
  requestedBy: Pick<AppUser, "id">;
  fileName: string;
  buffer: Buffer;
}>, db: PrismaClient = getDb()) {
  await assertProjectActive(input.projectId, db);
  const fileName = sanitizeAssetFileName(input.fileName);
  const detected = detectAssetFile(fileName, input.buffer);
  const contentHash = assetContentHash(input.buffer);
  // Opportunistic cleanup is global and bounded; a failed stale cleanup keeps
  // its reservation and therefore continues to count against quotas.
  await reconcileStaleProjectAssetUploadReservations(db);
  const duplicate = await db.projectAssetVersion.findUnique({
    where: { projectId_contentHash: { projectId: input.projectId, contentHash } },
    select: {
      id: true,
      projectAssetId: true,
      status: true,
      storageKey: true,
      sizeBytes: true,
      asset: { select: { status: true } },
      segments: { where: { projectSourceId: { not: null } }, select: { projectSourceId: true } },
    },
  });
  if (duplicate !== null) {
    await readAssetBlob(duplicate.storageKey, duplicate.sizeBytes);
    // Content identity is the upload idempotency boundary. Returning the
    // existing active asset lets a client safely retry after an uncertain HTTP
    // response without creating a second blob or receiving a misleading 409.
    if (duplicate.asset.status !== "deleted") return getProjectAsset(input.projectId, duplicate.projectAssetId, db);
    const restoredStatus = {
      staged: "uploaded",
      processing: "parsing",
      waitingVision: "waitingVision",
      awaitingReview: "awaitingReview",
      ready: "ready",
      failed: "failed",
      superseded: "failed",
    }[duplicate.status] as "uploaded" | "parsing" | "waitingVision" | "awaitingReview" | "ready" | "failed";
    await withSerializableRetry(db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.projectId}:${duplicate.projectAssetId}`}, 29082026))`;
      await assertProjectAssetCountAvailable(tx, input.projectId);
      const restored = await tx.projectAsset.updateMany({
        where: { projectId: input.projectId, id: duplicate.projectAssetId, status: "deleted" },
        data: { status: restoredStatus, deletedAt: null },
      });
      if (restored.count !== 1) return fail("PROJECT_ASSET_DUPLICATE");
      const sourceIds = duplicate.segments.flatMap((segment) => segment.projectSourceId ? [segment.projectSourceId] : []);
      if (sourceIds.length > 0) {
        await tx.projectSource.updateMany({
          where: { projectId: input.projectId, id: { in: sourceIds } },
          data: { retiredAt: null },
        });
      }
      await tx.project.update({ where: { id: input.projectId }, data: { updatedAt: new Date() } });
    });
    return getProjectAsset(input.projectId, duplicate.projectAssetId, db);
  }

  const assetId = randomUUID();
  const versionId = randomUUID();
  const localRunId = randomUUID();
  const reservationId = randomUUID();
  const storageKey = assetBlobStorageKey(input.projectId, assetId, versionId);
  let reservationCreated = false;
  try {
    await createProjectAssetUploadReservation({
      id: reservationId,
      projectId: input.projectId,
      userId: input.requestedBy.id,
      storageKey,
      sizeBytes: input.buffer.length,
    }, db);
    reservationCreated = true;
    await writeAssetBlob({
      projectId: input.projectId,
      assetId,
      versionId,
      buffer: input.buffer,
    });
  } catch (error) {
    if (reservationCreated) {
      try {
        await settleUploadReservationAfterFailure(reservationId, storageKey, db);
      } catch {
        // Keep the reservation when cleanup cannot prove the blob is absent.
        console.error("Upload reservation retained because blob cleanup failed");
      }
    }
    throw error;
  }

  let stored: { assetId: string; runId: string | null; reused: boolean };
  try {
    stored = await withSerializableRetry(db, async (tx) => {
      // Share the reservation lock with stale reconciliation so a crash
      // cleanup cannot remove a blob while this transaction is converting it
      // into a committed version.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${reservationId}::text, ${PROJECT_ASSET_UPLOAD_RESERVATION_LOCK_NAMESPACE}))`;
      const reservationRows = await tx.$queryRaw<Array<{ storageKey: string }>>`
        SELECT "storageKey"
        FROM "ProjectAssetUploadReservation"
        WHERE "id" = ${reservationId}
        FOR UPDATE
      `;
      const reservation = reservationRows[0];
      if (reservation === undefined || reservation.storageKey !== storageKey) throw new Error("PROJECT_ASSET_UPLOAD_RESERVATION_MISSING");
      // The preflight duplicate check above is only an optimization. Recheck
      // inside the reservation conversion transaction so concurrent uploads
      // cannot bypass the unique content rule.
      const existing = await tx.projectAssetVersion.findUnique({
        where: { projectId_contentHash: { projectId: input.projectId, contentHash } },
        select: {
          projectAssetId: true,
          status: true,
          asset: { select: { status: true } },
          segments: { where: { projectSourceId: { not: null } }, select: { projectSourceId: true } },
        },
      });
      if (existing !== null) {
        if (existing.asset.status === "deleted") {
          const restoredStatus = {
            staged: "uploaded",
            processing: "parsing",
            waitingVision: "waitingVision",
            awaitingReview: "awaitingReview",
            ready: "ready",
            failed: "failed",
            superseded: "failed",
          }[existing.status] as "uploaded" | "parsing" | "waitingVision" | "awaitingReview" | "ready" | "failed";
          const restored = await tx.projectAsset.updateMany({
            where: { projectId: input.projectId, id: existing.projectAssetId, status: "deleted" },
            data: { status: restoredStatus, deletedAt: null },
          });
          if (restored.count !== 1) return fail("PROJECT_ASSET_DUPLICATE");
          const sourceIds = existing.segments.flatMap((segment) => segment.projectSourceId ? [segment.projectSourceId] : []);
          if (sourceIds.length > 0) {
            await tx.projectSource.updateMany({ where: { projectId: input.projectId, id: { in: sourceIds } }, data: { retiredAt: null } });
          }
          await tx.project.update({ where: { id: input.projectId }, data: { updatedAt: new Date() } });
        }
        return { assetId: existing.projectAssetId, runId: null, reused: true } as const;
      }

      await tx.projectAsset.create({
        data: {
          id: assetId,
          projectId: input.projectId,
          displayName: fileName,
          kind: detected.kind,
          uploadedById: input.requestedBy.id,
          versions: {
            create: {
              id: versionId,
              originalFileName: fileName,
              mimeType: detected.mimeType,
              sizeBytes: BigInt(input.buffer.length),
              contentHash,
              storageKey,
            },
          },
        },
      });
      await tx.projectAssetExtractionRun.create({
        data: {
          id: localRunId,
          projectId: input.projectId,
          projectAssetId: assetId,
          projectAssetVersionId: versionId,
          status: "queued",
          inputManifestFingerprint: manifestFingerprint({
            contentHash,
            parserVersion: PROJECT_ASSET_PARSER_VERSION,
          }),
        },
      });
      const released = await tx.projectAssetUploadReservation.deleteMany({ where: { id: reservationId, storageKey } });
      if (released.count !== 1) throw new Error("PROJECT_ASSET_UPLOAD_RESERVATION_RELEASE_MISSING");
      await tx.project.update({ where: { id: input.projectId }, data: { updatedAt: new Date() } });
      return { assetId, runId: localRunId, reused: false } as const;
    });
  } catch (error) {
    let committedAssetId: string | null = null;
    try {
      committedAssetId = await settleUploadReservationAfterFailure(reservationId, storageKey, db);
    } catch {
      // The durable reservation deliberately remains in place if cleanup or
      // database release cannot prove safe settlement.
      console.error("Upload reservation retained because failed upload cleanup did not complete");
    }
    if (committedAssetId !== null) return getProjectAsset(input.projectId, committedAssetId, db);
    if (isKnown(error, "P2002")) return fail("PROJECT_ASSET_DUPLICATE");
    if (isSerializableTransactionConflict(error)) throw error;
    throw error;
  }

  if (stored.reused) {
    try {
      await settleUploadReservationAfterFailure(reservationId, storageKey, db);
    } catch {
      // The existing version is still accounted for; retain the reservation if
      // temporary blob cleanup or release is not fully confirmed.
      console.error("Duplicate upload reservation retained because blob cleanup failed");
    }
    return getProjectAsset(input.projectId, stored.assetId, db);
  }

  if (stored.runId !== null) {
    // Parsing is attempted immediately for responsive uploads, but the queued
    // row was committed with the asset and remains recoverable by the worker if
    // this process exits or the local parser fails.
    await processProjectAssetLocalExtractionRun(stored.runId, db).catch(() => undefined);
  }
  return getProjectAsset(input.projectId, assetId, db);
}

async function materializeSource(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    projectId: string;
    assetId: string;
    versionId: string;
    storageKey: string;
    assetKind: "text" | "document" | "spreadsheet" | "presentation" | "image";
    segment: Readonly<{
      id: string;
      ordinal: number;
      locatorLabel: string;
      pageNumber: number | null;
      slideNumber: number | null;
      sheetName: string | null;
      contentText: string;
      reviewedText: string | null;
      projectSourceId: string | null;
    }>;
  }>,
): Promise<string> {
  if (input.segment.projectSourceId !== null) return input.segment.projectSourceId;
  const contentText = (input.segment.reviewedText ?? input.segment.contentText).trim();
  if (contentText.length === 0 || contentText.length > MAX_SOURCE_CONTENT_LENGTH) return fail("PROJECT_ASSET_INVALID_INPUT");
  const source = await tx.projectSource.create({
    data: {
      projectId: input.projectId,
      kind: input.assetKind === "image" ? "screenshot" : "document",
      originScope: "project",
      projectRepositoryLinkId: null,
      externalRef: `/api/projects/${input.projectId}/assets/${input.assetId}/download#${locatorFragment(input.segment)}`,
      contentText,
      contentHash: hashSourceContent(contentText),
      manualContentDedupeKey: null,
      storageKey: input.storageKey,
      capturedAt: new Date(),
    },
    select: { id: true },
  });
  await tx.projectAssetSegment.update({
    where: { projectId_id: { projectId: input.projectId, id: input.segment.id } },
    data: { projectSourceId: source.id },
  });
  return source.id;
}

const LOCAL_EXTRACTION_LOCK_NAMESPACE = 2026090104;

class ProjectAssetLocalExtractionLeaseLost extends Error {
  constructor() {
    super("PROJECT_ASSET_LOCAL_EXTRACTION_LEASE_LOST");
    this.name = "ProjectAssetLocalExtractionLeaseLost";
  }
}

type LocalExtractionClaim = Readonly<{
  runId: string;
  leaseToken: string;
  recovered: boolean;
  projectId: string;
  assetId: string;
  versionId: string;
  assetKind: "text" | "document" | "spreadsheet" | "presentation" | "image";
  uploadedById: string;
  storageKey: string;
  sizeBytes: bigint;
  mimeType: string;
  originalFileName: string;
}>;

function safeLocalExtractionFailureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 64);
  }
  return "ASSET_EXTRACTION_FAILED";
}

async function claimProjectAssetLocalExtractionRun(
  runIdInput: unknown,
  db: PrismaClient,
): Promise<LocalExtractionClaim | null> {
  const runId = assetIdSchema.parse(runIdInput);
  const now = new Date();
  const staleBefore = new Date(now.getTime() - getUploadPolicy().parseLeaseMs);
  return withSerializableRetry(db, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${runId}::text, ${LOCAL_EXTRACTION_LOCK_NAMESPACE}))`;
    const candidate = await tx.projectAssetExtractionRun.findUnique({
      where: { id: runId },
      select: {
        projectId: true,
        projectAssetId: true,
        jobId: true,
        providerConnectionId: true,
      },
    });
    if (candidate === null) return null;
    if (candidate.jobId !== null || candidate.providerConnectionId !== null) return fail("PROJECT_ASSET_INVALID_STATE");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${candidate.projectId}:${candidate.projectAssetId}`}, 29082026))`;
    // The asset may have been deleted, retried, or claimed while this worker
    // waited for its asset lock. Re-read the complete state under that lock;
    // using the earlier snapshot would allow two queued siblings to parse the
    // same version concurrently.
    const run = await tx.projectAssetExtractionRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        projectId: true,
        projectAssetId: true,
        status: true,
        startedAt: true,
        jobId: true,
        providerConnectionId: true,
        asset: { select: { status: true, kind: true, uploadedById: true } },
        version: {
          select: {
            id: true,
            status: true,
            storageKey: true,
            sizeBytes: true,
            mimeType: true,
            originalFileName: true,
          },
        },
      },
    });
    if (run === null) return null;
    if (run.jobId !== null || run.providerConnectionId !== null) return fail("PROJECT_ASSET_INVALID_STATE");
    if (run.asset.status === "deleted") {
      await tx.projectAssetExtractionRun.updateMany({
        where: { id: run.id, status: { in: ["queued", "running"] } },
        data: { status: "cancelled", leaseToken: null, completedAt: now },
      });
      return null;
    }
    const queued = run.status === "queued" && run.asset.status === "uploaded" && run.version.status === "staged";
    const recovered = run.status === "running"
      && run.startedAt !== null
      && run.startedAt <= staleBefore
      && run.asset.status === "parsing"
      && run.version.status === "processing";
    if (!queued && !recovered) return null;
    const leaseToken = randomUUID();
    const claimed = await tx.projectAssetExtractionRun.updateMany({
      where: {
        id: run.id,
        status: run.status,
        ...(recovered ? { startedAt: { lte: staleBefore } } : {}),
      },
      data: {
        status: "running",
        leaseToken,
        attemptCount: { increment: 1 },
        startedAt: now,
        completedAt: null,
        failureCode: null,
      },
    });
    if (claimed.count !== 1) return null;
    await tx.projectAsset.update({
      where: { projectId_id: { projectId: run.projectId, id: run.projectAssetId } },
      data: { status: "parsing" },
    });
    await tx.projectAssetVersion.update({
      where: { projectId_id: { projectId: run.projectId, id: run.version.id } },
      data: { status: "processing", processingStartedAt: now, completedAt: null, failureCode: null },
    });
    return Object.freeze({
      runId: run.id,
      leaseToken,
      recovered,
      projectId: run.projectId,
      assetId: run.projectAssetId,
      versionId: run.version.id,
      assetKind: run.asset.kind,
      uploadedById: run.asset.uploadedById,
      storageKey: run.version.storageKey,
      sizeBytes: run.version.sizeBytes,
      mimeType: run.version.mimeType,
      originalFileName: run.version.originalFileName,
    });
  });
}

export async function processProjectAssetLocalExtractionRun(
  runId: unknown,
  db: PrismaClient = getDb(),
): Promise<Readonly<{ claimed: boolean; recovered: boolean; superseded: boolean }>> {
  const claim = await claimProjectAssetLocalExtractionRun(runId, db);
  if (claim === null) return Object.freeze({ claimed: false, recovered: false, superseded: false });
  try {
    const buffer = await readAssetBlob(claim.storageKey, claim.sizeBytes);
    const parsed = await parseAssetBuffer({
      buffer,
      mimeType: claim.mimeType,
      fileName: claim.originalFileName,
    });
    const requiresVision = parsed.some((entry) => entry.requiresVision);
    await withSerializableRetry(db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${claim.projectId}:${claim.assetId}`}, 29082026))`;
      const owned = await tx.projectAssetExtractionRun.count({
        where: { id: claim.runId, status: "running", leaseToken: claim.leaseToken },
      });
      if (owned !== 1) throw new ProjectAssetLocalExtractionLeaseLost();
      await tx.projectAssetSegment.deleteMany({
        where: { projectId: claim.projectId, projectAssetVersionId: claim.versionId, projectSourceId: null },
      });
      for (const entry of parsed) {
        const segmentId = randomUUID();
        const reviewStatus = requiresVision ? "pending" : "accepted";
        await tx.projectAssetSegment.create({
          data: {
            id: segmentId,
            projectId: claim.projectId,
            projectAssetId: claim.assetId,
            projectAssetVersionId: claim.versionId,
            ordinal: entry.ordinal,
            locatorKind: entry.locatorKind,
            locatorLabel: entry.locatorLabel,
            pageNumber: entry.pageNumber,
            slideNumber: entry.slideNumber,
            sheetName: entry.sheetName,
            cellRange: entry.cellRange,
            requiresVision: entry.requiresVision,
            extractionMethod: entry.extractionMethod,
            contentText: entry.contentText,
            contentHash: entry.contentHash,
            reviewedText: requiresVision ? null : entry.contentText,
            reviewStatus,
            reviewedById: requiresVision ? null : claim.uploadedById,
            reviewedAt: requiresVision ? null : new Date(),
          },
        });
        if (!requiresVision) {
          await materializeSource(tx, {
            projectId: claim.projectId,
            assetId: claim.assetId,
            versionId: claim.versionId,
            storageKey: claim.storageKey,
            assetKind: claim.assetKind,
            segment: {
              id: segmentId,
              ordinal: entry.ordinal,
              locatorLabel: entry.locatorLabel,
              pageNumber: entry.pageNumber,
              slideNumber: entry.slideNumber,
              sheetName: entry.sheetName,
              contentText: entry.contentText,
              reviewedText: entry.contentText,
              projectSourceId: null,
            },
          });
        }
      }
      const completedAt = new Date();
      await tx.projectAsset.update({
        where: { projectId_id: { projectId: claim.projectId, id: claim.assetId } },
        data: { status: requiresVision ? "waitingVision" : "ready" },
      });
      await tx.projectAssetVersion.update({
        where: { projectId_id: { projectId: claim.projectId, id: claim.versionId } },
        data: {
          status: requiresVision ? "waitingVision" : "ready",
          parserVersion: PROJECT_ASSET_PARSER_VERSION,
          completedAt: requiresVision ? null : completedAt,
        },
      });
      const finished = await tx.projectAssetExtractionRun.updateMany({
        where: { id: claim.runId, status: "running", leaseToken: claim.leaseToken },
        data: {
          status: "succeeded",
          leaseToken: null,
          localSegmentCount: parsed.length,
          visionSegmentCount: parsed.filter((entry) => entry.requiresVision).length,
          completedAt,
        },
      });
      if (finished.count !== 1) throw new ProjectAssetLocalExtractionLeaseLost();
      await tx.project.update({ where: { id: claim.projectId }, data: { updatedAt: completedAt } });
    });
    return Object.freeze({ claimed: true, recovered: claim.recovered, superseded: false });
  } catch (error) {
    if (error instanceof ProjectAssetLocalExtractionLeaseLost) {
      return Object.freeze({ claimed: true, recovered: claim.recovered, superseded: true });
    }
    const failureCode = safeLocalExtractionFailureCode(error);
    await withSerializableRetry(db, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${claim.projectId}:${claim.assetId}`}, 29082026))`;
      const failed = await tx.projectAssetExtractionRun.updateMany({
        where: { id: claim.runId, status: "running", leaseToken: claim.leaseToken },
        data: { status: "failed", leaseToken: null, failureCode, completedAt: new Date() },
      });
      if (failed.count !== 1) return;
      await tx.projectAsset.updateMany({
        where: { projectId: claim.projectId, id: claim.assetId, status: "parsing" },
        data: { status: "failed" },
      });
      await tx.projectAssetVersion.updateMany({
        where: { projectId: claim.projectId, id: claim.versionId, status: "processing" },
        data: { status: "failed", failureCode, completedAt: new Date() },
      });
      await tx.project.updateMany({ where: { id: claim.projectId }, data: { updatedAt: new Date() } });
    });
    throw error;
  }
}

export async function runProjectAssetParsingWorkerCycle(
  input: Readonly<{ maximumRuns?: number }> = {},
  db: PrismaClient = getDb(),
) {
  const maximumRuns = Math.max(1, Math.min(20, Math.floor(input.maximumRuns ?? 5)));
  const staleBefore = new Date(Date.now() - getUploadPolicy().parseLeaseMs);
  const candidates = await db.projectAssetExtractionRun.findMany({
    where: {
      jobId: null,
      providerConnectionId: null,
      OR: [
        { status: "queued" },
        { status: "running", startedAt: { lte: staleBefore } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: maximumRuns,
    select: { id: true },
  });
  let claimed = 0;
  let recovered = 0;
  let succeeded = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const result = await processProjectAssetLocalExtractionRun(candidate.id, db);
      if (!result.claimed) continue;
      claimed += 1;
      if (result.recovered) recovered += 1;
      if (!result.superseded) succeeded += 1;
    } catch {
      claimed += 1;
      failed += 1;
    }
  }
  return Object.freeze({ claimed, recovered, succeeded, failed });
}

export async function retryProjectAssetLocalExtraction(
  projectId: string,
  assetIdInput: unknown,
  db: PrismaClient = getDb(),
) {
  const assetId = assetIdSchema.parse(assetIdInput);
  await assertProjectActive(projectId, db);
  const runId = await withSerializableRetry(db, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${assetId}`}, 29082026))`;
    const asset = await tx.projectAsset.findUnique({
      where: { projectId_id: { projectId, id: assetId } },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    const version = asset?.versions[0];
    if (asset === null || version === undefined || asset.status === "deleted") return fail("PROJECT_ASSET_NOT_FOUND");
    if (asset.status !== "failed" || version.status !== "failed") return fail("PROJECT_ASSET_INVALID_STATE");
    const activeRun = await tx.projectAssetExtractionRun.count({
      where: {
        projectId,
        projectAssetVersionId: version.id,
        jobId: null,
        providerConnectionId: null,
        status: { in: ["queued", "running"] },
      },
    });
    if (activeRun > 0) return fail("PROJECT_ASSET_INVALID_STATE");
    const createdRunId = randomUUID();
    await tx.projectAssetExtractionRun.create({
      data: {
        id: createdRunId,
        projectId,
        projectAssetId: assetId,
        projectAssetVersionId: version.id,
        status: "queued",
        inputManifestFingerprint: manifestFingerprint({
          contentHash: version.contentHash,
          parserVersion: PROJECT_ASSET_PARSER_VERSION,
        }),
      },
    });
    await tx.projectAsset.update({
      where: { projectId_id: { projectId, id: assetId } },
      data: { status: "uploaded" },
    });
    await tx.projectAssetVersion.update({
      where: { projectId_id: { projectId, id: version.id } },
      data: {
        status: "staged",
        failureCode: null,
        processingStartedAt: null,
        completedAt: null,
      },
    });
    await tx.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
    return createdRunId;
  });
  await processProjectAssetLocalExtractionRun(runId, db).catch(() => undefined);
  return getProjectAsset(projectId, assetId, db);
}

export async function reviewProjectAssetSegment(input: Readonly<{
  projectId: string;
  assetId: unknown;
  segmentId: unknown;
  requestedBy: Pick<AppUser, "id">;
  review: unknown;
}>, db: PrismaClient = getDb()) {
  const assetId = assetIdSchema.parse(input.assetId);
  const segmentId = segmentIdSchema.parse(input.segmentId);
  const review = reviewSchema.parse(input.review);
  await assertProjectActive(input.projectId, db);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.projectId}:${assetId}`}, 29082026))`;
    const segment = await tx.projectAssetSegment.findUnique({
      where: { projectId_id: { projectId: input.projectId, id: segmentId } },
      include: { asset: true, version: true },
    });
    if (segment === null || segment.projectAssetId !== assetId || segment.asset.status === "deleted") {
      return fail("PROJECT_ASSET_SEGMENT_NOT_FOUND");
    }
    if (segment.asset.status !== "awaitingReview") return fail("PROJECT_ASSET_INVALID_STATE");
    if (segment.reviewStatus !== "pending") return fail("PROJECT_ASSET_SEGMENT_ALREADY_REVIEWED");
    const reviewedText = review.action === "accept" ? (review.reviewedText ?? segment.contentText).trim() : null;
    if (review.action === "accept" && (!reviewedText || reviewedText.length > MAX_SOURCE_CONTENT_LENGTH)) {
      return fail("PROJECT_ASSET_INVALID_INPUT");
    }
    await tx.projectAssetSegment.update({
      where: { projectId_id: { projectId: input.projectId, id: segmentId } },
      data: {
        reviewStatus: review.action === "accept" ? "accepted" : "dismissed",
        reviewedText,
        reviewedById: input.requestedBy.id,
        reviewedAt: new Date(),
      },
    });
    await tx.project.update({ where: { id: input.projectId }, data: { updatedAt: new Date() } });
    const pending = await tx.projectAssetSegment.count({
      where: { projectId: input.projectId, projectAssetVersionId: segment.projectAssetVersionId, reviewStatus: "pending" },
    });
    if (pending > 0) return;
    const accepted = await tx.projectAssetSegment.findMany({
      where: { projectId: input.projectId, projectAssetVersionId: segment.projectAssetVersionId, reviewStatus: "accepted" },
      orderBy: { ordinal: "asc" },
    });
    for (const acceptedSegment of accepted) {
      await materializeSource(tx, {
        projectId: input.projectId,
        assetId,
        versionId: segment.projectAssetVersionId,
        storageKey: segment.version.storageKey,
        assetKind: segment.asset.kind,
        segment: acceptedSegment,
      });
    }
    await tx.projectAsset.update({
      where: { projectId_id: { projectId: input.projectId, id: assetId } },
      data: { status: "ready" },
    });
    await tx.projectAssetVersion.update({
      where: { projectId_id: { projectId: input.projectId, id: segment.projectAssetVersionId } },
      data: { status: "ready", completedAt: new Date() },
    });
    await tx.projectAssetExtractionRun.updateMany({
      where: { projectId: input.projectId, projectAssetVersionId: segment.projectAssetVersionId, status: "waitingReview" },
      data: { status: "succeeded", completedAt: new Date() },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return getProjectAsset(input.projectId, assetId, db);
}

export async function getProjectAssetBlob(projectId: string, assetIdInput: unknown, db: PrismaClient = getDb()) {
  const assetId = assetIdSchema.parse(assetIdInput);
  const asset = await db.projectAsset.findUnique({
    where: { projectId_id: { projectId, id: assetId } },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  const version = asset?.versions[0];
  if (asset === null || asset.status === "deleted" || version === undefined) return fail("PROJECT_ASSET_NOT_FOUND");
  return Object.freeze({
    fileName: version.originalFileName,
    mimeType: version.mimeType,
    sizeBytes: Number(version.sizeBytes),
    buffer: await readAssetBlob(version.storageKey, version.sizeBytes),
  });
}

export async function deleteProjectAsset(projectId: string, assetIdInput: unknown, db: PrismaClient = getDb()) {
  const assetId = assetIdSchema.parse(assetIdInput);
  await assertProjectActive(projectId, db);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${assetId}`}, 29082026))`;
    const asset = await tx.projectAsset.findUnique({
      where: { projectId_id: { projectId, id: assetId } },
      select: {
        id: true,
        status: true,
        extractionRuns: {
          where: { status: { in: ["queued", "running"] } },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (asset === null || asset.status === "deleted") return fail("PROJECT_ASSET_NOT_FOUND");
    if (asset.status === "parsing" || asset.extractionRuns.length > 0) return fail("PROJECT_ASSET_INVALID_STATE");
    const segments = await tx.projectAssetSegment.findMany({
      where: { projectId, projectAssetId: assetId, projectSourceId: { not: null } },
      select: { projectSourceId: true },
    });
    const sourceIds = segments.flatMap((segment) => segment.projectSourceId ? [segment.projectSourceId] : []);
    if (sourceIds.length > 0) {
      await tx.projectSource.updateMany({
        where: { projectId, id: { in: sourceIds } },
        data: { retiredAt: new Date() },
      });
    }
    await tx.projectAsset.update({
      where: { projectId_id: { projectId, id: assetId } },
      data: { status: "deleted", deletedAt: new Date() },
    });
    await tx.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
