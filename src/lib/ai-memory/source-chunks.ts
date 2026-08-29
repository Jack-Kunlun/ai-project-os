import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { hashSourceContent } from "@/lib/source";
import {
  SOURCE_CHUNKER_VERSION,
  chunkSourceText,
  type DeterministicSourceChunk,
} from "./chunking";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_RETRY_LIMIT = 3;

export type SourceChunkErrorCode =
  | "SOURCE_CHUNK_INVALID_INPUT"
  | "SOURCE_CHUNK_PROJECT_NOT_FOUND"
  | "SOURCE_CHUNK_SOURCE_NOT_FOUND"
  | "SOURCE_CHUNK_SOURCE_INELIGIBLE"
  | "SOURCE_CHUNK_CONFLICT"
  | "SOURCE_CHUNK_WRITE_CONFLICT";

export class SourceChunkError extends Error {
  constructor(readonly code: SourceChunkErrorCode) {
    super(code);
    this.name = "SourceChunkError";
  }
}

export type SourceChunkView = Readonly<{
  id: string;
  projectId: string;
  projectSourceId: string | null;
  sourceRevisionKey: string | null;
  sourceContentHash: string | null;
  ordinal: number;
  rangeStart: number;
  rangeEnd: number;
  chunkerVersion: string;
  contentText: string | null;
  contentHash: string | null;
  contentBytes: number | null;
  createdAt: Date;
}>;

const sourceChunkSelect = {
  id: true,
  projectId: true,
  projectSourceId: true,
  sourceRevisionKey: true,
  sourceContentHash: true,
  ordinal: true,
  rangeStart: true,
  rangeEnd: true,
  chunkerVersion: true,
  contentText: true,
  contentHash: true,
  contentBytes: true,
  createdAt: true,
} satisfies Prisma.SourceChunkSelect;

function fail(code: SourceChunkErrorCode): never {
  throw new SourceChunkError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("SOURCE_CHUNK_INVALID_INPUT");
  }
  return value;
}

function isPrismaCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === code;
  } catch {
    return false;
  }
}

function matchesChunk(
  row: SourceChunkView,
  expected: DeterministicSourceChunk,
  source: { id: string; revisionKey: string; contentHash: string },
): boolean {
  return row.projectSourceId === source.id &&
    row.sourceRevisionKey === source.revisionKey &&
    row.sourceContentHash === source.contentHash &&
    row.ordinal === expected.ordinal &&
    row.rangeStart === expected.rangeStart &&
    row.rangeEnd === expected.rangeEnd &&
    row.chunkerVersion === expected.chunkerVersion &&
    row.contentText === expected.contentText &&
    row.contentHash === expected.contentHash &&
    row.contentBytes === expected.contentBytes;
}

function verifyRows(
  rows: readonly SourceChunkView[],
  expected: readonly DeterministicSourceChunk[],
  source: { id: string; revisionKey: string; contentHash: string },
): readonly SourceChunkView[] {
  if (
    rows.length !== expected.length ||
    rows.some((row, index) => !matchesChunk(row, expected[index]!, source))
  ) {
    return fail("SOURCE_CHUNK_CONFLICT");
  }
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export function createSourceChunkService(options: {
  db: PrismaClient;
  transactionRetryLimit?: number;
}): {
  ensureProjectSourceChunks(input: {
    projectId: string;
    sourceId: string;
  }): Promise<readonly SourceChunkView[]>;
} {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.db?.$transaction !== "function"
  ) {
    fail("SOURCE_CHUNK_INVALID_INPUT");
  }
  const retryLimit = options.transactionRetryLimit ?? DEFAULT_RETRY_LIMIT;
  if (!Number.isSafeInteger(retryLimit) || retryLimit < 1 || retryLimit > 5) {
    fail("SOURCE_CHUNK_INVALID_INPUT");
  }

  return {
    async ensureProjectSourceChunks(input) {
      const projectId = uuid(input?.projectId);
      const sourceId = uuid(input?.sourceId);

      for (let attempt = 0; attempt < retryLimit; attempt += 1) {
        try {
          return await options.db.$transaction(async (tx) => {
            const source = await tx.projectSource.findUnique({
              where: { projectId_id: { projectId, id: sourceId } },
              select: {
                id: true,
                originScope: true,
                revisionKey: true,
                contentHash: true,
                contentText: true,
                retiredAt: true,
              },
            });
            if (source === null) {
              const project = await tx.project.findUnique({
                where: { id: projectId },
                select: { id: true },
              });
              return fail(project === null
                ? "SOURCE_CHUNK_PROJECT_NOT_FOUND"
                : "SOURCE_CHUNK_SOURCE_NOT_FOUND");
            }
            if (
              source.originScope !== "project" ||
              source.retiredAt !== null ||
              !FINGERPRINT_PATTERN.test(source.contentHash) ||
              hashSourceContent(source.contentText) !== source.contentHash
            ) {
              return fail("SOURCE_CHUNK_SOURCE_INELIGIBLE");
            }

            let expected: readonly DeterministicSourceChunk[];
            try {
              expected = chunkSourceText(source.contentText);
            } catch {
              return fail("SOURCE_CHUNK_SOURCE_INELIGIBLE");
            }
            const existing = await tx.sourceChunk.findMany({
              where: {
                projectId,
                projectSourceId: source.id,
                sourceRevisionKey: source.revisionKey,
                chunkerVersion: SOURCE_CHUNKER_VERSION,
                state: "active",
              },
              orderBy: { ordinal: "asc" },
              select: sourceChunkSelect,
            });
            if (existing.length > 0) {
              return verifyRows(existing, expected, source);
            }

            await tx.sourceChunk.createMany({
              data: expected.map((chunk) => ({
                id: randomUUID(),
                projectId,
                originScope: "project",
                projectRepositoryLinkId: null,
                projectSourceId: source.id,
                sourceRevisionKey: source.revisionKey,
                sourceContentHash: source.contentHash,
                ordinal: chunk.ordinal,
                rangeUnit: "utf8_byte",
                rangeStart: chunk.rangeStart,
                rangeEnd: chunk.rangeEnd,
                chunkerVersion: chunk.chunkerVersion,
                contentText: chunk.contentText,
                contentHash: chunk.contentHash,
                contentBytes: chunk.contentBytes,
                state: "active",
              })),
            });
            const created = await tx.sourceChunk.findMany({
              where: {
                projectId,
                projectSourceId: source.id,
                sourceRevisionKey: source.revisionKey,
                chunkerVersion: SOURCE_CHUNKER_VERSION,
                state: "active",
              },
              orderBy: { ordinal: "asc" },
              select: sourceChunkSelect,
            });
            return verifyRows(created, expected, source);
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
          if (error instanceof SourceChunkError) throw error;
          const retryable = isPrismaCode(error, "P2002") || isPrismaCode(error, "P2034");
          if (retryable && attempt + 1 < retryLimit) continue;
          if (retryable) return fail("SOURCE_CHUNK_WRITE_CONFLICT");
          throw error;
        }
      }
      return fail("SOURCE_CHUNK_WRITE_CONFLICT");
    },
  };
}
