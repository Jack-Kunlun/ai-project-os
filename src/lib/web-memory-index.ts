import { randomUUID } from "node:crypto";
import { Prisma, type AppUser, type MemoryRecordScope, type PrismaClient } from "@prisma/client";
import { invokeEmbeddings } from "@/lib/ai-providers";
import { chunkSourceText } from "@/lib/ai-memory/chunking";
import { getDb } from "@/lib/db";
import { chunkRepositoryCode } from "@/lib/github";
import { requireProjectAiRoute } from "@/lib/project-ai-routes";
import {
  assertWebAiConsent,
  auditedProviderCall,
  claimWebAiJob,
  createGrantedWebAiJob,
  failWebAiJob,
  finishWebAiJob,
  manifestFingerprint,
  updateWebAiJobProgress,
} from "@/lib/web-ai-governance";

const MAX_INDEX_RECORDS = 5_000;
const MAX_INDEX_TEXT_BYTES = 24 * 1024 * 1024;
const EMBEDDING_BATCH_SIZE = 16;

export type WebMemoryIndexErrorCode =
  | "MEMORY_INDEX_EMPTY"
  | "MEMORY_INDEX_TOO_LARGE"
  | "MEMORY_INDEX_INPUT_INVALID"
  | "MEMORY_INDEX_PUBLICATION_CONFLICT";

export class WebMemoryIndexError extends Error {
  constructor(readonly code: WebMemoryIndexErrorCode) {
    super(code);
    this.name = "WebMemoryIndexError";
  }
}

type IndexInput = Readonly<{
  id: string;
  scope: MemoryRecordScope;
  projectSourceId: string | null;
  projectRepositoryLinkId: string | null;
  frozenCommitSha: string | null;
  path: string | null;
  externalRef: string | null;
  rangeStart: number;
  rangeEnd: number;
  contentText: string;
  contentHash: string;
}>;

function fail(code: WebMemoryIndexErrorCode): never {
  throw new WebMemoryIndexError(code);
}

function ensureBudget(records: readonly IndexInput[]): void {
  if (records.length === 0) return fail("MEMORY_INDEX_EMPTY");
  const bytes = records.reduce((total, record) => total + Buffer.byteLength(record.contentText, "utf8"), 0);
  if (records.length > MAX_INDEX_RECORDS || bytes > MAX_INDEX_TEXT_BYTES) {
    return fail("MEMORY_INDEX_TOO_LARGE");
  }
}

export async function collectProjectMemoryInputs(
  projectId: string,
  db: PrismaClient = getDb(),
): Promise<readonly IndexInput[]> {
  const [manualSources, materialPointers, codePointer] = await Promise.all([
    db.projectSource.findMany({
      where: { projectId, originScope: "project" },
      orderBy: { id: "asc" },
      select: { id: true, externalRef: true, contentText: true },
    }),
    db.repositoryMaterialGenerationPointer.findMany({
      where: { projectId },
      orderBy: { projectRepositoryLinkId: "asc" },
      select: {
        projectRepositoryLinkId: true,
        generation: {
          select: {
            observedHeadCommitSha: true,
            entries: {
              orderBy: { ordinal: "asc" },
              select: {
                sourceVersion: {
                  select: {
                    normalizedPath: true,
                    projectSource: { select: { id: true, externalRef: true, contentText: true } },
                  },
                },
              },
            },
          },
        },
      },
    }),
    db.projectCodeSnapshotPointer.findUnique({
      where: { projectId },
      select: {
        snapshot: {
          select: {
            entries: {
              orderBy: { projectRepositoryLinkId: "asc" },
              select: {
                projectRepositoryLinkId: true,
                frozenCommitSha: true,
                generation: {
                  select: {
                    capturedFullName: true,
                    entries: {
                      orderBy: { ordinal: "asc" },
                      select: {
                        normalizedPath: true,
                        fileRevision: { select: { contentText: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const records: IndexInput[] = [];
  for (const source of manualSources) {
    for (const chunk of chunkSourceText(source.contentText)) {
      records.push(Object.freeze({
        id: randomUUID(),
        scope: "projectSource",
        projectSourceId: source.id,
        projectRepositoryLinkId: null,
        frozenCommitSha: null,
        path: null,
        externalRef: source.externalRef,
        rangeStart: chunk.rangeStart,
        rangeEnd: chunk.rangeEnd,
        contentText: chunk.contentText,
        contentHash: chunk.contentHash,
      }));
    }
  }

  for (const pointer of materialPointers) {
    for (const entry of pointer.generation.entries) {
      const source = entry.sourceVersion.projectSource;
      for (const chunk of chunkSourceText(source.contentText)) {
        records.push(Object.freeze({
          id: randomUUID(),
          scope: "repositoryMaterial",
          projectSourceId: source.id,
          projectRepositoryLinkId: pointer.projectRepositoryLinkId,
          frozenCommitSha: pointer.generation.observedHeadCommitSha,
          path: entry.sourceVersion.normalizedPath,
          externalRef: source.externalRef,
          rangeStart: chunk.rangeStart,
          rangeEnd: chunk.rangeEnd,
          contentText: chunk.contentText,
          contentHash: chunk.contentHash,
        }));
      }
    }
  }

  for (const snapshotEntry of codePointer?.snapshot.entries ?? []) {
    for (const entry of snapshotEntry.generation.entries) {
      for (const chunk of chunkRepositoryCode(entry.fileRevision.contentText)) {
        records.push(Object.freeze({
          id: randomUUID(),
          scope: "repositoryCode",
          projectSourceId: null,
          projectRepositoryLinkId: snapshotEntry.projectRepositoryLinkId,
          frozenCommitSha: snapshotEntry.frozenCommitSha,
          path: entry.normalizedPath,
          externalRef: `github://${snapshotEntry.generation.capturedFullName}/${entry.normalizedPath}@${snapshotEntry.frozenCommitSha}`,
          rangeStart: chunk.rangeStart,
          rangeEnd: chunk.rangeEnd,
          contentText: chunk.contentText,
          contentHash: chunk.contentHash,
        }));
      }
    }
  }

  records.sort((left, right) =>
    left.scope.localeCompare(right.scope) ||
    (left.projectRepositoryLinkId ?? "").localeCompare(right.projectRepositoryLinkId ?? "") ||
    (left.projectSourceId ?? "").localeCompare(right.projectSourceId ?? "") ||
    (left.path ?? "").localeCompare(right.path ?? "") ||
    left.rangeStart - right.rangeStart,
  );
  ensureBudget(records);
  return Object.freeze(records);
}

export async function getProjectMemoryIndexStatus(projectId: string, db: PrismaClient = getDb()) {
  const [pointer, sourceCount, codePointer, materialPointerCount, route] = await Promise.all([
    db.memoryIndexPointer.findUnique({
      where: { projectId },
      select: {
        publishedAt: true,
        generation: {
          select: {
            id: true,
            providerConnectionId: true,
            modelId: true,
            dimensions: true,
            recordCount: true,
            inputManifestFingerprint: true,
            completedAt: true,
          },
        },
      },
    }),
    db.projectSource.count({ where: { projectId, originScope: "project" } }),
    db.projectCodeSnapshotPointer.findUnique({ where: { projectId }, select: { projectCodeSnapshotId: true } }),
    db.repositoryMaterialGenerationPointer.count({ where: { projectId } }),
    db.projectAiRoute.findUnique({
      where: { projectId_operation: { projectId, operation: "embedding" } },
      select: { providerConnectionId: true, modelId: true, embeddingDimensions: true },
    }),
  ]);
  const compatible =
    pointer !== null &&
    route !== null &&
    pointer.generation.providerConnectionId === route.providerConnectionId &&
    pointer.generation.modelId === route.modelId &&
    pointer.generation.dimensions === route.embeddingDimensions;
  return Object.freeze({
    activeIndex: pointer,
    compatible,
    inputs: {
      projectSourceCount: sourceCount,
      hasCodeSnapshot: codePointer !== null,
      repositoryMaterialGenerationCount: materialPointerCount,
    },
    route,
  });
}

export async function runProjectMemoryIndexJob(input: Readonly<{
  projectId: string;
  requestedBy: Pick<AppUser, "id">;
  clientKey: unknown;
  consent: unknown;
}>, db: PrismaClient = getDb()) {
  assertWebAiConsent(input.consent);
  const [route, records] = await Promise.all([
    requireProjectAiRoute(input.projectId, "embedding", db),
    collectProjectMemoryInputs(input.projectId, db),
  ]);
  if (route.embeddingDimensions === null) return fail("MEMORY_INDEX_INPUT_INVALID");
  const manifest = manifestFingerprint(records.map((record) => ({
    scope: record.scope,
    projectSourceId: record.projectSourceId,
    projectRepositoryLinkId: record.projectRepositoryLinkId,
    frozenCommitSha: record.frozenCommitSha,
    path: record.path,
    rangeStart: record.rangeStart,
    rangeEnd: record.rangeEnd,
    contentHash: record.contentHash,
  })));
  const granted = await createGrantedWebAiJob({
    projectId: input.projectId,
    kind: "memoryIndex",
    route,
    requestedBy: input.requestedBy,
    clientKey: input.clientKey,
    scopeKind: "projectMemory",
    scopeIds: { recordCount: records.length, manifest },
    manifestFingerprint: manifest,
    payload: { recordCount: records.length, manifest },
  }, db);
  if (!granted.created) {
    return db.backgroundJob.findUniqueOrThrow({ where: { id: granted.jobId } });
  }
  if (!(await claimWebAiJob(granted.jobId, db))) {
    return db.backgroundJob.findUniqueOrThrow({ where: { id: granted.jobId } });
  }

  let generationId: string | null = null;
  try {
    const generation = await db.memoryIndexGeneration.create({
      data: {
        projectId: input.projectId,
        providerConnectionId: route.providerConnectionId,
        modelId: route.modelId,
        dimensions: route.embeddingDimensions,
        inputManifestFingerprint: manifest,
      },
    });
    generationId = generation.id;

    for (let offset = 0; offset < records.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = records.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      await updateWebAiJobProgress(granted.jobId, "embedding", offset, records.length, db);
      const embeddingResult = await auditedProviderCall({
        jobId: granted.jobId,
        route,
        call: () => invokeEmbeddings({
          connection: route.providerConnection,
          modelId: route.modelId,
          texts: batch.map((record) => record.contentText),
          expectedDimensions: route.embeddingDimensions,
        }),
      }, db);
      await db.memoryRecord.createMany({
        data: batch.map((record, index) => ({
          id: record.id,
          projectId: input.projectId,
          indexGenerationId: generation.id,
          scope: record.scope,
          projectSourceId: record.projectSourceId,
          projectRepositoryLinkId: record.projectRepositoryLinkId,
          frozenCommitSha: record.frozenCommitSha,
          path: record.path,
          externalRef: record.externalRef,
          rangeStart: record.rangeStart,
          rangeEnd: record.rangeEnd,
          contentText: record.contentText,
          contentHash: record.contentHash,
          embedding: [...embeddingResult.vectors[index]!],
        })),
      });
    }

    await updateWebAiJobProgress(granted.jobId, "publishing", records.length, records.length, db);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 29082026))`;
      const previous = await tx.memoryIndexPointer.findUnique({ where: { projectId: input.projectId } });
      await tx.memoryIndexGeneration.update({
        where: { projectId_id: { projectId: input.projectId, id: generation.id } },
        data: { status: "complete", recordCount: records.length, completedAt: new Date() },
      });
      await tx.memoryIndexPointer.upsert({
        where: { projectId: input.projectId },
        create: { projectId: input.projectId, indexGenerationId: generation.id },
        update: { indexGenerationId: generation.id, publishedAt: new Date() },
      });
      if (previous !== null && previous.indexGenerationId !== generation.id) {
        await tx.memoryIndexGeneration.updateMany({
          where: { projectId: input.projectId, id: previous.indexGenerationId, status: "complete" },
          data: { status: "superseded", supersededAt: new Date() },
        });
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return finishWebAiJob(granted.jobId, {
      indexGenerationId: generation.id,
      recordCount: records.length,
      dimensions: route.embeddingDimensions,
      manifest,
    }, db);
  } catch (error) {
    if (generationId !== null) {
      await db.memoryIndexGeneration.updateMany({
        where: { id: generationId, status: "staging" },
        data: { status: "failed", completedAt: new Date() },
      }).catch(() => undefined);
    }
    await failWebAiJob(granted.jobId, error, db);
    throw error;
  }
}
