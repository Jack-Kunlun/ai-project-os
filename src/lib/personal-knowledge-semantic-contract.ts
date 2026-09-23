import { createHash } from "node:crypto";
import { z } from "zod";
import { chunkSourceText, SOURCE_CHUNKER_VERSION, type DeterministicSourceChunk } from "@/lib/ai-memory/chunking";

export const PERSONAL_KNOWLEDGE_SEMANTIC_VERSION = "personal-knowledge-semantic:v1" as const;
export const PERSONAL_KNOWLEDGE_SEMANTIC_MAX_DOCUMENTS = 100 as const;
export const PERSONAL_KNOWLEDGE_SEMANTIC_MAX_ENTRIES = 400 as const;
export const PERSONAL_KNOWLEDGE_SEMANTIC_MAX_SOURCE_BYTES = 800_000 as const;
export const PERSONAL_KNOWLEDGE_SEMANTIC_MAX_RESULTS = 10 as const;
export const PERSONAL_KNOWLEDGE_SEMANTIC_CHALLENGE_TTL_MS = 10 * 60 * 1_000;
export const PERSONAL_KNOWLEDGE_SEMANTIC_MAX_QUERY_LENGTH = 1_000 as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CLIENT_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/u;

export const personalKnowledgeSemanticClientKeySchema = z.string().min(8).max(200).regex(CLIENT_KEY_PATTERN);
export const personalKnowledgeSemanticQuerySchema = z.string().trim().min(1).max(PERSONAL_KNOWLEDGE_SEMANTIC_MAX_QUERY_LENGTH);
export const personalKnowledgeSemanticProviderIdSchema = z.string().uuid();

export const personalKnowledgeSemanticPrepareSchema = z.object({
  phase: z.literal("prepare").optional(),
  kind: z.enum(["build", "search"]),
  providerId: personalKnowledgeSemanticProviderIdSchema,
  clientKey: personalKnowledgeSemanticClientKeySchema,
  query: personalKnowledgeSemanticQuerySchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "search" && value.query === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["query"], message: "query required" });
  }
  if (value.kind === "build" && value.query !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["query"], message: "query forbidden" });
  }
});

export const personalKnowledgeSemanticExecuteSchema = z.object({
  phase: z.literal("execute").optional(),
  challengeId: z.string().uuid(),
  clientKey: personalKnowledgeSemanticClientKeySchema,
  query: personalKnowledgeSemanticQuerySchema.optional(),
}).strict();

export type SemanticPage = Readonly<{
  documentId: string;
  revisionId: string;
  version: number;
  title: string;
  content: string;
  contentHash: string;
}>;

export type SemanticChunk = Readonly<DeterministicSourceChunk>;

export type PersonalKnowledgeSemanticManifestItem = Readonly<{
  documentId: string;
  revisionId: string;
  version: number;
  contentHash: string;
  chunkCount: number;
  ranges: readonly Readonly<{
    ordinal: number;
    rangeStart: number;
    rangeEnd: number;
    contentHash: string;
  }>[];
}>;

function canonicalValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return String(value);
}

export function canonicalPersonalKnowledgeSemanticJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function personalKnowledgeSemanticSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildPersonalKnowledgeSemanticChunks(page: SemanticPage): readonly SemanticChunk[] {
  if (!UUID_PATTERN.test(page.documentId) || !UUID_PATTERN.test(page.revisionId)) {
    throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_PAGE");
  }
  if (!Number.isSafeInteger(page.version) || page.version < 1 || !HASH_PATTERN.test(page.contentHash)) {
    throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_PAGE");
  }
  if (personalKnowledgeSemanticSha256(page.content) !== page.contentHash) {
    throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_PAGE");
  }
  const chunks = chunkSourceText(page.content);
  if (chunks.length === 0) throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_NO_ENTRIES");
  return chunks;
}

export function personalKnowledgeSemanticManifest(
  pages: readonly Readonly<{ page: SemanticPage; chunks: readonly SemanticChunk[] }>[],
): readonly PersonalKnowledgeSemanticManifestItem[] {
  const manifest = pages.map(({ page, chunks }) => Object.freeze({
    documentId: page.documentId,
    revisionId: page.revisionId,
    version: page.version,
    contentHash: page.contentHash,
    chunkCount: chunks.length,
    ranges: Object.freeze(chunks.map((chunk) => Object.freeze({
      ordinal: chunk.ordinal,
      rangeStart: chunk.rangeStart,
      rangeEnd: chunk.rangeEnd,
      contentHash: chunk.contentHash,
    }))),
  }));
  return Object.freeze(manifest);
}

export function personalKnowledgeSemanticManifestFingerprint(
  manifest: readonly PersonalKnowledgeSemanticManifestItem[],
): string {
  return personalKnowledgeSemanticSha256(canonicalPersonalKnowledgeSemanticJson(manifest));
}

export function personalKnowledgeSemanticTotalEntries(
  manifest: readonly PersonalKnowledgeSemanticManifestItem[],
): number {
  return manifest.reduce((total, item) => total + item.chunkCount, 0);
}

export function personalKnowledgeSemanticTotalBytes(pages: readonly SemanticPage[]): number {
  return pages.reduce((total, page) => total + Buffer.byteLength(page.content, "utf8"), 0);
}

export function personalKnowledgeSemanticExcerpt(
  content: string,
  rangeStart: number,
  rangeEnd: number,
): string {
  const bytes = Buffer.from(content, "utf8");
  if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd) || rangeStart < 0 || rangeEnd <= rangeStart || rangeEnd > bytes.length) {
    throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_RANGE");
  }
  if ((rangeStart > 0 && (bytes[rangeStart]! & 0xc0) === 0x80) || (rangeEnd < bytes.length && (bytes[rangeEnd]! & 0xc0) === 0x80)) {
    throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_RANGE");
  }
  return bytes.subarray(rangeStart, rangeEnd).toString("utf8");
}

export { SOURCE_CHUNKER_VERSION };
