import { randomUUID } from "node:crypto";
import { Prisma, type AppUser, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { hashSourceContent, MAX_SOURCE_CONTENT_LENGTH } from "@/lib/source";
import { manifestFingerprint } from "@/lib/web-ai-governance";
import { parseAssetBuffer, PROJECT_ASSET_PARSER_VERSION } from "@/lib/project-assets/parser";
import {
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
  | "PROJECT_ASSET_SEGMENT_ALREADY_REVIEWED";

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
    if (duplicate.asset.status !== "deleted") return fail("PROJECT_ASSET_DUPLICATE");
    await readAssetBlob(duplicate.storageKey, duplicate.sizeBytes);
    const restoredStatus = {
      staged: "uploaded",
      processing: "parsing",
      waitingVision: "waitingVision",
      awaitingReview: "awaitingReview",
      ready: "ready",
      failed: "failed",
      superseded: "failed",
    }[duplicate.status] as "uploaded" | "parsing" | "waitingVision" | "awaitingReview" | "ready" | "failed";
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.projectId}:${duplicate.projectAssetId}`}, 29082026))`;
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return getProjectAsset(input.projectId, duplicate.projectAssetId, db);
  }

  const assetId = randomUUID();
  const versionId = randomUUID();
  const storageKey = await writeAssetBlob({
    projectId: input.projectId,
    assetId,
    versionId,
    buffer: input.buffer,
  });
  try {
    await db.$transaction(async (tx) => {
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
      await tx.project.update({ where: { id: input.projectId }, data: { updatedAt: new Date() } });
    });
  } catch (error) {
    await removeAssetBlob(storageKey);
    if (isKnown(error, "P2002")) return fail("PROJECT_ASSET_DUPLICATE");
    throw error;
  }

  await extractLocalProjectAsset(input.projectId, assetId, db);
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

export async function extractLocalProjectAsset(projectId: string, assetIdInput: unknown, db: PrismaClient = getDb()) {
  const assetId = assetIdSchema.parse(assetIdInput);
  const asset = await db.projectAsset.findUnique({
    where: { projectId_id: { projectId, id: assetId } },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  const version = asset?.versions[0];
  if (asset === null || version === undefined || asset.status === "deleted") return fail("PROJECT_ASSET_NOT_FOUND");
  if (!(["uploaded", "failed"] as const).includes(asset.status as "uploaded" | "failed")) {
    return fail("PROJECT_ASSET_INVALID_STATE");
  }
  await db.$transaction([
    db.projectAsset.update({ where: { projectId_id: { projectId, id: assetId } }, data: { status: "parsing" } }),
    db.projectAssetVersion.update({
      where: { projectId_id: { projectId, id: version.id } },
      data: { status: "processing", processingStartedAt: new Date(), failureCode: null },
    }),
  ]);
  try {
    const buffer = await readAssetBlob(version.storageKey, version.sizeBytes);
    const parsed = await parseAssetBuffer({ buffer, mimeType: version.mimeType, fileName: version.originalFileName });
    const requiresVision = parsed.some((entry) => entry.requiresVision);
    const runId = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${assetId}`}, 29082026))`;
      await tx.projectAssetSegment.deleteMany({
        where: { projectId, projectAssetVersionId: version.id, projectSourceId: null },
      });
      await tx.projectAssetExtractionRun.create({
        data: {
          id: runId,
          projectId,
          projectAssetId: assetId,
          projectAssetVersionId: version.id,
          status: requiresVision ? "succeeded" : "succeeded",
          inputManifestFingerprint: manifestFingerprint({
            contentHash: version.contentHash,
            parserVersion: PROJECT_ASSET_PARSER_VERSION,
          }),
          localSegmentCount: parsed.length,
          visionSegmentCount: parsed.filter((entry) => entry.requiresVision).length,
          startedAt: new Date(),
          completedAt: new Date(),
        },
      });
      for (const entry of parsed) {
        const segmentId = randomUUID();
        const reviewStatus = requiresVision ? "pending" : "accepted";
        await tx.projectAssetSegment.create({
          data: {
            id: segmentId,
            projectId,
            projectAssetId: assetId,
            projectAssetVersionId: version.id,
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
            reviewedById: requiresVision ? null : asset.uploadedById,
            reviewedAt: requiresVision ? null : new Date(),
          },
        });
        if (!requiresVision) {
          await materializeSource(tx, {
            projectId,
            assetId,
            versionId: version.id,
            storageKey: version.storageKey,
            assetKind: asset.kind,
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
      await tx.projectAsset.update({
        where: { projectId_id: { projectId, id: assetId } },
        data: { status: requiresVision ? "waitingVision" : "ready" },
      });
      await tx.projectAssetVersion.update({
        where: { projectId_id: { projectId, id: version.id } },
        data: {
          status: requiresVision ? "waitingVision" : "ready",
          parserVersion: PROJECT_ASSET_PARSER_VERSION,
          completedAt: requiresVision ? null : new Date(),
        },
      });
      await tx.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    const failureCode = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code.slice(0, 64)
      : "ASSET_EXTRACTION_FAILED";
    await db.$transaction([
      db.projectAsset.updateMany({ where: { projectId, id: assetId }, data: { status: "failed" } }),
      db.projectAssetVersion.updateMany({
        where: { projectId, id: version.id },
        data: { status: "failed", failureCode, completedAt: new Date() },
      }),
      db.project.updateMany({ where: { id: projectId }, data: { updatedAt: new Date() } }),
    ]);
    throw error;
  }
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
