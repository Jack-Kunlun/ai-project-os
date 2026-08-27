import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  HYBRID_SEARCH_MAX_DOCUMENTS,
  HybridSearchError,
  rankHybridSearch,
  type HybridSearchDocument,
} from "@/lib/ai-memory/hybrid-search";
import { hashSourceContent } from "@/lib/source";
import { chunkRepositoryCode } from "./code-chunking";

export const REPOSITORY_CODE_SEARCH_VERSION = "repository-code-search:v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RepositoryCodeSearchErrorCode =
  | "REPOSITORY_CODE_SEARCH_INVALID_INPUT"
  | "REPOSITORY_CODE_SEARCH_PROJECT_NOT_FOUND"
  | "REPOSITORY_CODE_SEARCH_LINK_NOT_FOUND"
  | "REPOSITORY_CODE_SEARCH_SNAPSHOT_NOT_READY"
  | "REPOSITORY_CODE_SEARCH_SNAPSHOT_INELIGIBLE"
  | "REPOSITORY_CODE_SEARCH_SCOPE_TOO_LARGE"
  | "REPOSITORY_CODE_SEARCH_CONFLICT";

export class RepositoryCodeSearchError extends Error {
  constructor(readonly code: RepositoryCodeSearchErrorCode) {
    super(code);
    this.name = "RepositoryCodeSearchError";
  }
}

export type RepositoryCodeSearchScope =
  | Readonly<{ kind: "project" }>
  | Readonly<{ kind: "repository"; projectRepositoryLinkId: string }>;

export type RepositoryCodeCitation = Readonly<{
  projectId: string;
  projectRepositoryLinkId: string;
  githubRepositoryId: string;
  capturedFullName: string;
  frozenCommitSha: string;
  normalizedPath: string;
  repositoryFileRevisionId: string;
  chunkId: string;
  lineStart: number;
  lineEnd: number;
  contentHash: string;
  excerpt: string;
  immutableRef: string;
}>;

export type RepositoryCodeSearchResponse = Readonly<{
  searchVersion: typeof REPOSITORY_CODE_SEARCH_VERSION;
  mode: "lexical";
  scope: Readonly<{
    kind: "project" | "repository";
    snapshotId: string;
    manifestFingerprint: string;
    repositoryCount: number;
  }>;
  results: readonly Readonly<{
    rank: number;
    score: number;
    matchedFeatures: readonly string[];
    componentRanks: Readonly<{
      cjk: number | null;
      identifier: number | null;
      substring: number | null;
      token: number | null;
    }>;
    citation: RepositoryCodeCitation;
  }>[];
}>;

type SearchGeneration = Readonly<{
  projectRepositoryLinkId: string;
  githubRepositoryId: bigint;
  capturedFullName: string;
  frozenCommitSha: string;
  id: string;
  manifestFingerprint: string;
  fileCount: number;
  entries: readonly Readonly<{
    id: string;
    ordinal: number;
    normalizedPath: string;
    repositoryFileRevisionId: string;
    contentHash: string;
    contentBytes: number;
    lineCount: number;
    fileRevision: Readonly<{
      id: string;
      contentText: string;
      contentHash: string;
      contentBytes: number;
      lineCount: number;
    }>;
  }>[];
}>;

type SearchManifest = Readonly<{
  kind: "project" | "repository";
  snapshotId: string;
  manifestFingerprint: string;
  generations: readonly SearchGeneration[];
}>;

function fail(code: RepositoryCodeSearchErrorCode): never {
  throw new RepositoryCodeSearchError(code);
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return fail("REPOSITORY_CODE_SEARCH_INVALID_INPUT");
  }
  return value;
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalScope(value: unknown): RepositoryCodeSearchScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("REPOSITORY_CODE_SEARCH_INVALID_INPUT");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "project" && exactKeys(record, ["kind"])) {
    return Object.freeze({ kind: "project" as const });
  }
  if (
    record.kind === "repository" &&
    exactKeys(record, ["kind", "projectRepositoryLinkId"])
  ) {
    return Object.freeze({
      kind: "repository" as const,
      projectRepositoryLinkId: canonicalUuid(record.projectRepositoryLinkId),
    });
  }
  return fail("REPOSITORY_CODE_SEARCH_INVALID_INPUT");
}

function generationView(value: {
  projectRepositoryLinkId: string;
  capturedGitHubRepositoryId: bigint;
  capturedFullName: string;
  frozenCommitSha: string;
  id: string;
  manifestFingerprint: string;
  fileCount: number;
  entries: SearchGeneration["entries"];
}): SearchGeneration {
  if (
    value.entries.length !== value.fileCount ||
    value.entries.some((entry, ordinal) =>
      entry.ordinal !== ordinal ||
      entry.fileRevision.id !== entry.repositoryFileRevisionId ||
      entry.fileRevision.contentHash !== entry.contentHash ||
      entry.fileRevision.contentBytes !== entry.contentBytes ||
      entry.fileRevision.lineCount !== entry.lineCount ||
      hashSourceContent(entry.fileRevision.contentText) !== entry.contentHash ||
      Buffer.byteLength(entry.fileRevision.contentText, "utf8") !== entry.contentBytes)
  ) {
    return fail("REPOSITORY_CODE_SEARCH_CONFLICT");
  }
  return Object.freeze({
    projectRepositoryLinkId: value.projectRepositoryLinkId,
    githubRepositoryId: value.capturedGitHubRepositoryId,
    capturedFullName: value.capturedFullName,
    frozenCommitSha: value.frozenCommitSha,
    id: value.id,
    manifestFingerprint: value.manifestFingerprint,
    fileCount: value.fileCount,
    entries: Object.freeze(value.entries),
  });
}

async function readProjectManifest(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<SearchManifest> {
  const pointer = await tx.projectCodeSnapshotPointer.findUnique({
    where: { projectId },
    include: {
      snapshot: {
        include: {
          entries: {
            orderBy: { projectRepositoryLinkId: "asc" },
            include: {
              config: true,
              repositoryLink: {
                include: { configPointer: true, codeGenerationPointer: true },
              },
              generation: {
                include: {
                  entries: {
                    orderBy: { ordinal: "asc" },
                    include: { fileRevision: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (pointer === null) {
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
    return fail(project === null
      ? "REPOSITORY_CODE_SEARCH_PROJECT_NOT_FOUND"
      : "REPOSITORY_CODE_SEARCH_SNAPSHOT_NOT_READY");
  }
  const snapshot = pointer.snapshot;
  if (
    snapshot.status !== "complete" ||
    snapshot.entries.length !== snapshot.requiredLinkCount ||
    snapshot.entries.some((entry) =>
      entry.requiredForProjectSnapshot !== true ||
      entry.config.requiredForProjectSnapshot !== true ||
      entry.config.codeEnabled !== true ||
      entry.config.version !== entry.linkConfigVersion ||
      entry.config.effectivePolicyVersion !== entry.effectivePolicyVersion ||
      entry.repositoryLink.status !== "active" ||
      entry.repositoryLink.effectivePolicyVersion !== entry.effectivePolicyVersion ||
      entry.repositoryLink.configPointer?.configVersion !== entry.linkConfigVersion ||
      entry.repositoryLink.configPointer.effectivePolicyVersion !== entry.effectivePolicyVersion ||
      entry.repositoryLink.codeGenerationPointer?.repositoryCodeGenerationId !==
        entry.repositoryCodeGenerationId ||
      entry.repositoryLink.codeGenerationPointer.linkConfigVersion !== entry.linkConfigVersion ||
      entry.repositoryLink.codeGenerationPointer.effectivePolicyVersion !==
        entry.effectivePolicyVersion ||
      entry.generation.status !== "codeReady" ||
      entry.generation.linkConfigVersion !== entry.linkConfigVersion ||
      entry.generation.effectivePolicyVersion !== entry.effectivePolicyVersion ||
      entry.generation.scanScopeFingerprint !== entry.config.scanScopeFingerprint ||
      entry.generation.frozenCommitSha !== entry.frozenCommitSha ||
      entry.generation.manifestFingerprint !== entry.generationManifestFingerprint)
  ) {
    return fail("REPOSITORY_CODE_SEARCH_SNAPSHOT_INELIGIBLE");
  }
  return Object.freeze({
    kind: "project" as const,
    snapshotId: snapshot.id,
    manifestFingerprint: snapshot.manifestFingerprint,
    generations: Object.freeze(snapshot.entries.map((entry) => generationView(entry.generation))),
  });
}

async function readRepositoryManifest(
  tx: Prisma.TransactionClient,
  projectId: string,
  projectRepositoryLinkId: string,
): Promise<SearchManifest> {
  const link = await tx.projectRepositoryLink.findUnique({
    where: { projectId_id: { projectId, id: projectRepositoryLinkId } },
    include: {
      configPointer: { include: { config: true } },
      codeGenerationPointer: {
        include: {
          generation: {
            include: {
              entries: {
                orderBy: { ordinal: "asc" },
                include: { fileRevision: true },
              },
            },
          },
        },
      },
    },
  });
  if (link === null) {
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
    return fail(project === null
      ? "REPOSITORY_CODE_SEARCH_PROJECT_NOT_FOUND"
      : "REPOSITORY_CODE_SEARCH_LINK_NOT_FOUND");
  }
  const pointer = link.codeGenerationPointer;
  const generation = pointer?.generation;
  if (
    link.status !== "active" || link.configPointer === null || pointer === null ||
    generation === undefined || generation.status !== "codeReady" ||
    link.effectivePolicyVersion !== link.configPointer.effectivePolicyVersion ||
    link.configPointer.config.codeEnabled !== true ||
    pointer.linkConfigVersion !== link.configPointer.configVersion ||
    pointer.effectivePolicyVersion !== link.configPointer.effectivePolicyVersion ||
    generation.linkConfigVersion !== pointer.linkConfigVersion ||
    generation.effectivePolicyVersion !== pointer.effectivePolicyVersion ||
    generation.scanScopeFingerprint !== link.configPointer.config.scanScopeFingerprint
  ) {
    return fail("REPOSITORY_CODE_SEARCH_SNAPSHOT_INELIGIBLE");
  }
  return Object.freeze({
    kind: "repository" as const,
    snapshotId: generation.id,
    manifestFingerprint: generation.manifestFingerprint,
    generations: Object.freeze([generationView(generation)]),
  });
}

function buildDocuments(projectId: string, manifest: SearchManifest): Readonly<{
  documents: readonly HybridSearchDocument[];
  citations: ReadonlyMap<string, RepositoryCodeCitation>;
}> {
  const documents: HybridSearchDocument[] = [];
  const citations = new Map<string, RepositoryCodeCitation>();
  let ordinal = 0;
  for (const generation of manifest.generations) {
    for (const entry of generation.entries) {
      let chunks;
      try {
        chunks = chunkRepositoryCode(entry.fileRevision.contentText);
      } catch {
        return fail("REPOSITORY_CODE_SEARCH_CONFLICT");
      }
      for (const chunk of chunks) {
        if (documents.length >= HYBRID_SEARCH_MAX_DOCUMENTS) {
          return fail("REPOSITORY_CODE_SEARCH_SCOPE_TOO_LARGE");
        }
        const chunkId = stableUuid([
          REPOSITORY_CODE_SEARCH_VERSION,
          projectId,
          generation.projectRepositoryLinkId,
          generation.id,
          entry.id,
          chunk.ordinal,
          chunk.contentHash,
        ].join("\x1f"));
        const searchableText = `${entry.normalizedPath}\n${chunk.contentText}`;
        documents.push(Object.freeze({
          id: chunkId,
          projectId,
          sourceId: entry.repositoryFileRevisionId,
          contentText: searchableText,
          ordinal,
          externalRef: entry.normalizedPath,
        }));
        const lineEnd = chunk.rangeEnd - 1;
        citations.set(chunkId, Object.freeze({
          projectId,
          projectRepositoryLinkId: generation.projectRepositoryLinkId,
          githubRepositoryId: generation.githubRepositoryId.toString(),
          capturedFullName: generation.capturedFullName,
          frozenCommitSha: generation.frozenCommitSha,
          normalizedPath: entry.normalizedPath,
          repositoryFileRevisionId: entry.repositoryFileRevisionId,
          chunkId,
          lineStart: chunk.rangeStart,
          lineEnd,
          contentHash: chunk.contentHash,
          excerpt: chunk.contentText,
          immutableRef: `${generation.capturedFullName}@${generation.frozenCommitSha}:${entry.normalizedPath}#L${chunk.rangeStart}-L${lineEnd}`,
        }));
        ordinal += 1;
      }
    }
  }
  return Object.freeze({ documents: Object.freeze(documents), citations });
}

export function createRepositoryCodeSearchService(options: { db: PrismaClient }): {
  search(input: Readonly<{
    projectId: string;
    query: string;
    take?: number;
    scope: RepositoryCodeSearchScope;
  }>): Promise<RepositoryCodeSearchResponse>;
} {
  if (typeof options !== "object" || options === null || typeof options.db?.$transaction !== "function") {
    return fail("REPOSITORY_CODE_SEARCH_INVALID_INPUT");
  }
  return Object.freeze({
    async search(input) {
      if (
        !isPlainRecord(input) ||
        !exactKeys(input, input.take === undefined
          ? ["projectId", "query", "scope"]
          : ["projectId", "query", "scope", "take"])
      ) {
        return fail("REPOSITORY_CODE_SEARCH_INVALID_INPUT");
      }
      const projectId = canonicalUuid(input.projectId);
      const scope = canonicalScope(input.scope);
      const take = input.take ?? 10;
      try {
        rankHybridSearch({ projectId, query: input.query, documents: [], take });
      } catch (error) {
        if (error instanceof HybridSearchError) {
          return fail("REPOSITORY_CODE_SEARCH_INVALID_INPUT");
        }
        throw error;
      }
      return options.db.$transaction(async (tx) => {
        const manifest = scope.kind === "project"
          ? await readProjectManifest(tx, projectId)
          : await readRepositoryManifest(tx, projectId, scope.projectRepositoryLinkId);
        const corpus = buildDocuments(projectId, manifest);
        let ranked;
        try {
          ranked = rankHybridSearch({
            projectId,
            query: input.query,
            documents: corpus.documents,
            take,
          });
        } catch (error) {
          if (error instanceof HybridSearchError) {
            return fail(error.code === "HYBRID_SEARCH_DOCUMENT_LIMIT"
              ? "REPOSITORY_CODE_SEARCH_SCOPE_TOO_LARGE"
              : "REPOSITORY_CODE_SEARCH_INVALID_INPUT");
          }
          throw error;
        }
        return Object.freeze({
          searchVersion: REPOSITORY_CODE_SEARCH_VERSION,
          mode: "lexical" as const,
          scope: Object.freeze({
            kind: manifest.kind,
            snapshotId: manifest.snapshotId,
            manifestFingerprint: manifest.manifestFingerprint,
            repositoryCount: manifest.generations.length,
          }),
          results: Object.freeze(ranked.map((result, index) => {
            const citation = corpus.citations.get(result.document.id);
            if (citation === undefined) return fail("REPOSITORY_CODE_SEARCH_CONFLICT");
            return Object.freeze({
              rank: index + 1,
              score: result.score,
              matchedFeatures: Object.freeze(
                result.matchedFeatures.filter((feature) => feature !== "vector"),
              ),
              componentRanks: Object.freeze({
                cjk: result.ranks.cjk,
                identifier: result.ranks.identifier,
                substring: result.ranks.substring,
                token: result.ranks.token,
              }),
              citation,
            });
          })),
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
  });
}
