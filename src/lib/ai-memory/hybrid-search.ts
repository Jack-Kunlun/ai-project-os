export const HYBRID_SEARCH_VERSION = "project-hybrid-search:v1" as const;
export const HYBRID_SEARCH_RRF_K = 60 as const;
export const HYBRID_SEARCH_MAX_DOCUMENTS = 5_000 as const;
export const HYBRID_SEARCH_MAX_QUERY_BYTES = 2_000 as const;
export const HYBRID_SEARCH_MAX_RESULTS = 20 as const;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const CJK_CHARACTER_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ASCII_TERM_PATTERN = /[a-z0-9]+/g;
const IDENTIFIER_PATTERN = /[a-z_$][a-z0-9_$]*(?:[./:@-][a-z0-9_$.-]+)+|[a-z_$][a-z0-9_$]{2,}/g;

export type HybridSearchErrorCode =
  | "HYBRID_SEARCH_INVALID_INPUT"
  | "HYBRID_SEARCH_QUERY_TOO_LARGE"
  | "HYBRID_SEARCH_DOCUMENT_LIMIT";

export class HybridSearchError extends Error {
  constructor(readonly code: HybridSearchErrorCode) {
    super(code);
    this.name = "HybridSearchError";
  }
}

export type HybridSearchDocument = Readonly<{
  id: string;
  projectId: string;
  sourceId: string;
  contentText: string;
  ordinal: number;
  externalRef?: string | null;
}>;

export type HybridSearchVectorRank = Readonly<{
  documentId: string;
  distance: number;
}>;

export type HybridSearchResult = Readonly<{
  document: HybridSearchDocument;
  score: number;
  bestRank: number;
  ranks: Readonly<{
    vector: number | null;
    cjk: number | null;
    identifier: number | null;
    substring: number | null;
    token: number | null;
  }>;
  matchedFeatures: readonly ("vector" | "cjk" | "identifier" | "substring" | "token")[];
}>;

type RankedFeature = Readonly<{ documentId: string; value: number }>;
type FeatureName = keyof HybridSearchResult["ranks"];

const FEATURE_WEIGHTS: Readonly<Record<FeatureName, number>> = Object.freeze({
  vector: 1,
  cjk: 1.1,
  identifier: 1.25,
  substring: 1.4,
  token: 1,
});

function fail(code: HybridSearchErrorCode): never {
  throw new HybridSearchError(code);
}

function canonicalText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string") return fail("HYBRID_SEARCH_INVALID_INPUT");
  let normalized: string;
  try {
    normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("und");
  } catch {
    return fail("HYBRID_SEARCH_INVALID_INPUT");
  }
  if (
    normalized.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(normalized) ||
    Buffer.byteLength(normalized, "utf8") > maximumBytes
  ) {
    return fail(maximumBytes === HYBRID_SEARCH_MAX_QUERY_BYTES
      ? "HYBRID_SEARCH_QUERY_TOO_LARGE"
      : "HYBRID_SEARCH_INVALID_INPUT");
  }
  return normalized;
}

function canonicalId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return fail("HYBRID_SEARCH_INVALID_INPUT");
  }
  return value;
}

function canonicalContent(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > 16_384
  ) {
    return fail("HYBRID_SEARCH_INVALID_INPUT");
  }
  try {
    value.normalize("NFKC");
  } catch {
    return fail("HYBRID_SEARCH_INVALID_INPUT");
  }
  return value;
}

function uniqueMatches(pattern: RegExp, value: string): readonly string[] {
  return Object.freeze([...new Set(value.match(pattern) ?? [])]);
}

function cjkBigrams(value: string): readonly string[] {
  const characters = Array.from(value).filter((character) => CJK_CHARACTER_PATTERN.test(character));
  if (characters.length === 0) return Object.freeze([]);
  if (characters.length === 1) return Object.freeze(characters);
  const grams = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    grams.add(`${characters[index]}${characters[index + 1]}`);
  }
  return Object.freeze([...grams]);
}

function overlapScore(queryFeatures: readonly string[], content: string): number {
  if (queryFeatures.length === 0) return 0;
  let matches = 0;
  for (const feature of queryFeatures) {
    if (content.includes(feature)) matches += 1;
  }
  if (matches === 0) return 0;
  return matches / queryFeatures.length + matches / 1_000;
}

function rankedFeature(
  documents: readonly HybridSearchDocument[],
  score: (document: HybridSearchDocument) => number,
  descending = true,
): readonly RankedFeature[] {
  return Object.freeze(documents
    .map((document) => ({ documentId: document.id, value: score(document) }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .sort((left, right) => {
      const valueOrder = descending
        ? right.value - left.value
        : left.value - right.value;
      if (valueOrder !== 0) return valueOrder;
      return left.documentId.localeCompare(right.documentId);
    }));
}

function rankMap(items: readonly RankedFeature[]): ReadonlyMap<string, number> {
  return new Map(items.map((item, index) => [item.documentId, index + 1]));
}

function canonicalDocuments(
  projectId: string,
  value: readonly HybridSearchDocument[],
): readonly HybridSearchDocument[] {
  if (!Array.isArray(value)) return fail("HYBRID_SEARCH_INVALID_INPUT");
  if (value.length > HYBRID_SEARCH_MAX_DOCUMENTS) {
    return fail("HYBRID_SEARCH_DOCUMENT_LIMIT");
  }
  const ids = new Set<string>();
  const scoped: HybridSearchDocument[] = [];
  for (const document of value) {
    if (typeof document !== "object" || document === null) {
      return fail("HYBRID_SEARCH_INVALID_INPUT");
    }
    const id = canonicalId(document.id);
    if (ids.has(id)) return fail("HYBRID_SEARCH_INVALID_INPUT");
    ids.add(id);
    const documentProjectId = canonicalId(document.projectId);
    const sourceId = canonicalId(document.sourceId);
    if (!Number.isSafeInteger(document.ordinal) || document.ordinal < 0) {
      return fail("HYBRID_SEARCH_INVALID_INPUT");
    }
    const contentText = canonicalContent(document.contentText);
    if (documentProjectId !== projectId) continue;
    scoped.push(Object.freeze({
      id,
      projectId: documentProjectId,
      sourceId,
      contentText,
      ordinal: document.ordinal,
      externalRef: document.externalRef ?? null,
    }));
  }
  return Object.freeze(scoped);
}

function canonicalVectorRanks(
  scopedIds: ReadonlySet<string>,
  value: readonly HybridSearchVectorRank[] | undefined,
): readonly RankedFeature[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > HYBRID_SEARCH_MAX_DOCUMENTS) {
    return fail("HYBRID_SEARCH_INVALID_INPUT");
  }
  const seen = new Set<string>();
  const ranks: RankedFeature[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null) {
      return fail("HYBRID_SEARCH_INVALID_INPUT");
    }
    const documentId = canonicalId(row.documentId);
    if (
      seen.has(documentId) ||
      typeof row.distance !== "number" ||
      !Number.isFinite(row.distance) ||
      row.distance < 0 ||
      row.distance > 2
    ) {
      return fail("HYBRID_SEARCH_INVALID_INPUT");
    }
    seen.add(documentId);
    if (scopedIds.has(documentId)) ranks.push({ documentId, value: row.distance + Number.EPSILON });
  }
  return Object.freeze(ranks.sort((left, right) =>
    left.value - right.value || left.documentId.localeCompare(right.documentId),
  ));
}

/**
 * Stable reciprocal-rank fusion over project-scoped vector, CJK bigram,
 * identifier/path, exact-substring and general token rankings.
 */
export function rankHybridSearch(input: Readonly<{
  projectId: string;
  query: string;
  documents: readonly HybridSearchDocument[];
  vectorRanks?: readonly HybridSearchVectorRank[];
  take?: number;
}>): readonly HybridSearchResult[] {
  if (typeof input !== "object" || input === null) {
    return fail("HYBRID_SEARCH_INVALID_INPUT");
  }
  const projectId = canonicalId(input.projectId);
  const query = canonicalText(input.query, HYBRID_SEARCH_MAX_QUERY_BYTES);
  const take = input.take ?? 10;
  if (!Number.isSafeInteger(take) || take < 1 || take > HYBRID_SEARCH_MAX_RESULTS) {
    return fail("HYBRID_SEARCH_INVALID_INPUT");
  }
  const documents = canonicalDocuments(projectId, input.documents);
  if (documents.length === 0) return Object.freeze([]);

  const queryCjk = cjkBigrams(query);
  const queryIdentifiers = uniqueMatches(IDENTIFIER_PATTERN, query);
  const queryTokens = uniqueMatches(ASCII_TERM_PATTERN, query);
  const normalizedContent = new Map(documents.map((document) => [
    document.id,
    canonicalText(document.contentText, 16_384),
  ]));

  const featureLists: Readonly<Record<FeatureName, readonly RankedFeature[]>> = Object.freeze({
    vector: canonicalVectorRanks(new Set(documents.map((document) => document.id)), input.vectorRanks),
    cjk: rankedFeature(documents, (document) => overlapScore(queryCjk, normalizedContent.get(document.id)!)),
    identifier: rankedFeature(documents, (document) => overlapScore(queryIdentifiers, normalizedContent.get(document.id)!)),
    substring: rankedFeature(documents, (document) => normalizedContent.get(document.id)!.includes(query) ? 1 : 0),
    token: rankedFeature(documents, (document) => overlapScore(queryTokens, normalizedContent.get(document.id)!)),
  });
  const ranks = Object.fromEntries(
    Object.entries(featureLists).map(([feature, rows]) => [feature, rankMap(rows)]),
  ) as Record<FeatureName, ReadonlyMap<string, number>>;

  const results = documents.flatMap((document) => {
    const documentRanks = {
      vector: ranks.vector.get(document.id) ?? null,
      cjk: ranks.cjk.get(document.id) ?? null,
      identifier: ranks.identifier.get(document.id) ?? null,
      substring: ranks.substring.get(document.id) ?? null,
      token: ranks.token.get(document.id) ?? null,
    } satisfies HybridSearchResult["ranks"];
    const matchedFeatures = (Object.keys(documentRanks) as FeatureName[])
      .filter((feature) => documentRanks[feature] !== null);
    if (matchedFeatures.length === 0) return [];
    const score = matchedFeatures.reduce((sum, feature) =>
      sum + FEATURE_WEIGHTS[feature] / (HYBRID_SEARCH_RRF_K + documentRanks[feature]!),
    0);
    return [Object.freeze({
      document,
      score,
      bestRank: Math.min(...matchedFeatures.map((feature) => documentRanks[feature]!)),
      ranks: Object.freeze(documentRanks),
      matchedFeatures: Object.freeze(matchedFeatures),
    })];
  });

  return Object.freeze(results.sort((left, right) =>
    right.score - left.score ||
    left.bestRank - right.bestRank ||
    left.document.ordinal - right.document.ordinal ||
    left.document.id.localeCompare(right.document.id),
  ).slice(0, take));
}
