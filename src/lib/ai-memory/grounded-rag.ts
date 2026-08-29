import { createHash } from "node:crypto";
import type { ProjectSearchResponse } from "./project-search";

export const GROUNDED_RAG_VERSION = "grounded-rag:v1" as const;
export const GROUNDED_RAG_PROMPT_VERSION = "grounded-rag-prompt:v1" as const;
export const GROUNDED_RAG_MAX_CONTEXTS = 20 as const;
export const GROUNDED_RAG_MAX_CLAIMS = 12 as const;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const FACT_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

export type GroundedRagErrorCode =
  | "GROUNDED_RAG_INVALID_INPUT"
  | "GROUNDED_RAG_CONTEXT_CONFLICT"
  | "GROUNDED_RAG_INVALID_OUTPUT"
  | "GROUNDED_RAG_UNSUPPORTED_CLAIM"
  | "GROUNDED_RAG_INVALID_CITATION";

export class GroundedRagError extends Error {
  constructor(readonly code: GroundedRagErrorCode) {
    super(code);
    this.name = "GroundedRagError";
  }
}

export type GroundedRagContextEntry = Readonly<{
  projectId: string;
  sourceId: string;
  chunkId: string;
  sourceKind: "document" | "screenshot" | "github" | "git" | "web" | "manual" | "mcp";
  externalRef: string | null;
  contentHash: string;
  contentText: string;
  rangeUnit: "utf8_byte" | "line";
  rangeStart: number;
  rangeEnd: number;
}>;

export type GroundedRagPlan = Readonly<{
  version: typeof GROUNDED_RAG_VERSION;
  promptVersion: typeof GROUNDED_RAG_PROMPT_VERSION;
  projectId: string;
  snapshotId: string;
  snapshotManifestFingerprint: string;
  question: string;
  questionFingerprint: string;
  contextFingerprint: string;
  contexts: readonly Readonly<GroundedRagContextEntry & { citationKey: string }>[];
}>;

export type GroundedCitation = Readonly<{
  citationKey: string;
  projectId: string;
  sourceId: string;
  chunkId: string;
  sourceKind: GroundedRagContextEntry["sourceKind"];
  externalRef: string | null;
  excerpt: string;
  rangeUnit: GroundedRagContextEntry["rangeUnit"];
  rangeStart: number;
  rangeEnd: number;
  contentHash: string;
}>;

export type GroundedClaim = Readonly<{
  text: string;
  citations: readonly GroundedCitation[];
}>;

export type GroundedConflict = Readonly<{
  factKey: string;
  left: GroundedClaim;
  right: GroundedClaim;
}>;

export type GroundedRagResult =
  | Readonly<{
      kind: "answer";
      answer: string;
      claims: readonly GroundedClaim[];
      snapshotId: string;
      contextFingerprint: string;
    }>
  | Readonly<{
      kind: "conflict";
      answer: string;
      conflicts: readonly GroundedConflict[];
      snapshotId: string;
      contextFingerprint: string;
    }>
  | Readonly<{
      kind: "refusal";
      reasonCode: "INSUFFICIENT_EVIDENCE";
      answer: "当前检索证据不足，无法可靠回答。";
      snapshotId: string;
      contextFingerprint: string;
    }>;

type RawCitation = Readonly<{ citationKey: string; excerpt: string }>;
type RawClaim = Readonly<{ text: string; citations: readonly RawCitation[] }>;

const issuedPlans = new WeakSet<object>();

function fail(code: GroundedRagErrorCode): never {
  throw new GroundedRagError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  let keys: string[];
  try {
    keys = Object.keys(value).sort();
  } catch {
    return fail("GROUNDED_RAG_INVALID_OUTPUT");
  }
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    return fail("GROUNDED_RAG_INVALID_OUTPUT");
  }
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
    return fail("GROUNDED_RAG_INVALID_INPUT");
  }
  return value;
}

function canonicalText(value: unknown, maximumBytes: number, output = false): string {
  if (typeof value !== "string") {
    return fail(output ? "GROUNDED_RAG_INVALID_OUTPUT" : "GROUNDED_RAG_INVALID_INPUT");
  }
  let normalized: string;
  try {
    normalized = value.normalize("NFC").trim();
  } catch {
    return fail(output ? "GROUNDED_RAG_INVALID_OUTPUT" : "GROUNDED_RAG_INVALID_INPUT");
  }
  if (
    normalized.length === 0 ||
    normalized !== value ||
    CONTROL_CHARACTER_PATTERN.test(normalized) ||
    Buffer.byteLength(normalized, "utf8") > maximumBytes
  ) {
    return fail(output ? "GROUNDED_RAG_INVALID_OUTPUT" : "GROUNDED_RAG_INVALID_INPUT");
  }
  return normalized;
}

function canonicalContextContent(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > 16_384
  ) {
    return fail("GROUNDED_RAG_INVALID_INPUT");
  }
  try {
    if (value.normalize("NFC") !== value) {
      return fail("GROUNDED_RAG_INVALID_INPUT");
    }
  } catch {
    return fail("GROUNDED_RAG_INVALID_INPUT");
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function contextFingerprint(
  projectId: string,
  snapshotId: string,
  snapshotManifestFingerprint: string,
  questionFingerprint: string,
  contexts: GroundedRagPlan["contexts"],
): string {
  return sha256(JSON.stringify({
    version: GROUNDED_RAG_VERSION,
    projectId,
    snapshotId,
    snapshotManifestFingerprint,
    questionFingerprint,
    contexts: contexts.map((context) => ({
      citationKey: context.citationKey,
      sourceId: context.sourceId,
      chunkId: context.chunkId,
      contentHash: context.contentHash,
      rangeUnit: context.rangeUnit,
      rangeStart: context.rangeStart,
      rangeEnd: context.rangeEnd,
    })),
  }));
}

function canonicalContext(
  projectId: string,
  value: GroundedRagContextEntry,
  index: number,
): GroundedRagPlan["contexts"][number] {
  if (!isPlainRecord(value)) return fail("GROUNDED_RAG_INVALID_INPUT");
  const contextProjectId = canonicalId(value.projectId);
  if (contextProjectId !== projectId) return fail("GROUNDED_RAG_CONTEXT_CONFLICT");
  const sourceKind = value.sourceKind;
  if (!["document", "screenshot", "github", "git", "web", "manual", "mcp"].includes(sourceKind)) {
    return fail("GROUNDED_RAG_INVALID_INPUT");
  }
  const externalRef = value.externalRef === null
    ? null
    : canonicalText(value.externalRef, 2_048);
  if (
    typeof value.contentHash !== "string" ||
    !FINGERPRINT_PATTERN.test(value.contentHash) ||
    (value.rangeUnit !== "utf8_byte" && value.rangeUnit !== "line") ||
    !Number.isSafeInteger(value.rangeStart) ||
    !Number.isSafeInteger(value.rangeEnd) ||
    value.rangeStart < 0 ||
    value.rangeEnd <= value.rangeStart
  ) {
    return fail("GROUNDED_RAG_INVALID_INPUT");
  }
  const contentText = canonicalContextContent(value.contentText);
  if (sha256(contentText) !== value.contentHash) {
    return fail("GROUNDED_RAG_INVALID_INPUT");
  }
  if (value.rangeUnit === "utf8_byte") {
    const bytes = Buffer.byteLength(contentText, "utf8");
    if (value.rangeEnd - value.rangeStart !== bytes) {
      return fail("GROUNDED_RAG_INVALID_INPUT");
    }
  }
  return Object.freeze({
    citationKey: `c${index + 1}`,
    projectId,
    sourceId: canonicalId(value.sourceId),
    chunkId: canonicalId(value.chunkId),
    sourceKind: sourceKind as GroundedRagContextEntry["sourceKind"],
    externalRef,
    contentHash: value.contentHash,
    contentText,
    rangeUnit: value.rangeUnit,
    rangeStart: value.rangeStart,
    rangeEnd: value.rangeEnd,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function buildGroundedRagPlan(input: Readonly<{
  projectId: string;
  snapshotId: string;
  snapshotManifestFingerprint: string;
  question: string;
  contexts: readonly GroundedRagContextEntry[];
}>): GroundedRagPlan {
  if (!isPlainRecord(input)) return fail("GROUNDED_RAG_INVALID_INPUT");
  const projectId = canonicalId(input.projectId);
  const snapshotId = canonicalId(input.snapshotId);
  if (
    typeof input.snapshotManifestFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(input.snapshotManifestFingerprint) ||
    !Array.isArray(input.contexts) ||
    input.contexts.length > GROUNDED_RAG_MAX_CONTEXTS
  ) {
    return fail("GROUNDED_RAG_INVALID_INPUT");
  }
  const question = canonicalText(input.question, 2_000);
  const contexts = Object.freeze(input.contexts.map((context, index) =>
    canonicalContext(projectId, context, index),
  ));
  const chunkIds = new Set(contexts.map((context) => context.chunkId));
  if (chunkIds.size !== contexts.length) return fail("GROUNDED_RAG_CONTEXT_CONFLICT");
  const questionFingerprint = sha256(question);
  const plan = deepFreeze({
    version: GROUNDED_RAG_VERSION,
    promptVersion: GROUNDED_RAG_PROMPT_VERSION,
    projectId,
    snapshotId,
    snapshotManifestFingerprint: input.snapshotManifestFingerprint,
    question,
    questionFingerprint,
    contextFingerprint: contextFingerprint(
      projectId,
      snapshotId,
      input.snapshotManifestFingerprint,
      questionFingerprint,
      contexts,
    ),
    contexts,
  } satisfies GroundedRagPlan);
  issuedPlans.add(plan);
  return plan;
}

export function getIssuedGroundedRagPlan(
  value: unknown,
): GroundedRagPlan | null {
  if (typeof value !== "object" || value === null || !issuedPlans.has(value)) {
    return null;
  }
  return value as GroundedRagPlan;
}

export function buildGroundedRagPlanFromSearch(input: Readonly<{
  projectId: string;
  question: string;
  search: ProjectSearchResponse;
}>): GroundedRagPlan {
  if (!isPlainRecord(input) || !isPlainRecord(input.search)) {
    return fail("GROUNDED_RAG_INVALID_INPUT");
  }
  return buildGroundedRagPlan({
    projectId: input.projectId,
    snapshotId: input.search.snapshot.id,
    snapshotManifestFingerprint: input.search.snapshot.manifestFingerprint,
    question: input.question,
    contexts: input.search.results.map((result) => ({
      projectId: result.citation.projectId,
      sourceId: result.citation.sourceId,
      chunkId: result.citation.chunkId,
      sourceKind: result.citation.sourceKind,
      externalRef: result.citation.externalRef,
      contentHash: result.citation.contentHash,
      contentText: result.citation.excerpt,
      rangeUnit: result.citation.rangeUnit,
      rangeStart: result.citation.rangeStart,
      rangeEnd: result.citation.rangeEnd,
    })),
  });
}

function canonicalRawCitation(value: unknown): RawCitation {
  if (!isPlainRecord(value)) return fail("GROUNDED_RAG_INVALID_OUTPUT");
  exactKeys(value, ["citationKey", "excerpt"]);
  return Object.freeze({
    citationKey: canonicalText(value.citationKey, 32, true),
    excerpt: canonicalText(value.excerpt, 4_000, true),
  });
}

function canonicalRawClaim(value: unknown): RawClaim {
  if (!isPlainRecord(value)) return fail("GROUNDED_RAG_INVALID_OUTPUT");
  exactKeys(value, ["text", "citations"]);
  if (!Array.isArray(value.citations) || value.citations.length < 1 || value.citations.length > 4) {
    return fail("GROUNDED_RAG_INVALID_OUTPUT");
  }
  const citations = Object.freeze(value.citations.map(canonicalRawCitation));
  const keys = new Set(citations.map((citation) => `${citation.citationKey}\0${citation.excerpt}`));
  if (keys.size !== citations.length) return fail("GROUNDED_RAG_INVALID_OUTPUT");
  return Object.freeze({
    text: canonicalText(value.text, 1_000, true),
    citations,
  });
}

function absoluteCitation(
  context: GroundedRagPlan["contexts"][number],
  raw: RawCitation,
  claimText: string,
): GroundedCitation {
  const relativeCharacterStart = context.contentText.indexOf(raw.excerpt);
  if (relativeCharacterStart < 0 || !raw.excerpt.includes(claimText)) {
    return fail(relativeCharacterStart < 0
      ? "GROUNDED_RAG_INVALID_CITATION"
      : "GROUNDED_RAG_UNSUPPORTED_CLAIM");
  }
  let rangeStart: number;
  let rangeEnd: number;
  if (context.rangeUnit === "utf8_byte") {
    rangeStart = context.rangeStart + Buffer.byteLength(
      context.contentText.slice(0, relativeCharacterStart),
      "utf8",
    );
    rangeEnd = rangeStart + Buffer.byteLength(raw.excerpt, "utf8");
  } else {
    rangeStart = context.rangeStart + (
      context.contentText.slice(0, relativeCharacterStart).match(/\n/g)?.length ?? 0
    );
    rangeEnd = rangeStart + (raw.excerpt.match(/\n/g)?.length ?? 0);
  }
  if (rangeStart < context.rangeStart || rangeEnd > context.rangeEnd) {
    return fail("GROUNDED_RAG_INVALID_CITATION");
  }
  return Object.freeze({
    citationKey: context.citationKey,
    projectId: context.projectId,
    sourceId: context.sourceId,
    chunkId: context.chunkId,
    sourceKind: context.sourceKind,
    externalRef: context.externalRef,
    excerpt: raw.excerpt,
    rangeUnit: context.rangeUnit,
    rangeStart,
    rangeEnd,
    contentHash: context.contentHash,
  });
}

function groundedClaim(
  plan: GroundedRagPlan,
  raw: RawClaim,
): GroundedClaim {
  const contexts = new Map(plan.contexts.map((context) => [context.citationKey, context]));
  const citations = raw.citations.map((citation) => {
    const context = contexts.get(citation.citationKey);
    if (context === undefined) return fail("GROUNDED_RAG_INVALID_CITATION");
    return absoluteCitation(context, citation, raw.text);
  });
  return Object.freeze({ text: raw.text, citations: Object.freeze(citations) });
}

export function verifyGroundedClaimSet(
  plan: GroundedRagPlan,
  value: unknown,
  bounds: Readonly<{ minimum: number; maximum: number }>,
): readonly GroundedClaim[] {
  if (
    !issuedPlans.has(plan) ||
    !Number.isSafeInteger(bounds.minimum) ||
    !Number.isSafeInteger(bounds.maximum) ||
    bounds.minimum < 0 ||
    bounds.maximum < bounds.minimum ||
    bounds.maximum > 40 ||
    !Array.isArray(value) ||
    value.length < bounds.minimum ||
    value.length > bounds.maximum
  ) {
    return fail(!issuedPlans.has(plan)
      ? "GROUNDED_RAG_INVALID_INPUT"
      : "GROUNDED_RAG_INVALID_OUTPUT");
  }
  const rawClaims = value.map(canonicalRawClaim);
  const claimTexts = new Set(rawClaims.map((claim) => claim.text));
  if (claimTexts.size !== rawClaims.length) {
    return fail("GROUNDED_RAG_INVALID_OUTPUT");
  }
  return Object.freeze(rawClaims.map((claim) => groundedClaim(plan, claim)));
}

export function verifyGroundedConflictSet(
  plan: GroundedRagPlan,
  value: unknown,
  bounds: Readonly<{ minimum: number; maximum: number }>,
): readonly GroundedConflict[] {
  if (
    !issuedPlans.has(plan) ||
    !Number.isSafeInteger(bounds.minimum) ||
    !Number.isSafeInteger(bounds.maximum) ||
    bounds.minimum < 0 ||
    bounds.maximum < bounds.minimum ||
    bounds.maximum > 20 ||
    !Array.isArray(value) ||
    value.length < bounds.minimum ||
    value.length > bounds.maximum
  ) {
    return fail(!issuedPlans.has(plan)
      ? "GROUNDED_RAG_INVALID_INPUT"
      : "GROUNDED_RAG_INVALID_OUTPUT");
  }
  return Object.freeze(value.map((conflict) => {
    if (!isPlainRecord(conflict)) return fail("GROUNDED_RAG_INVALID_OUTPUT");
    exactKeys(conflict, ["factKey", "left", "right"]);
    if (typeof conflict.factKey !== "string" || !FACT_KEY_PATTERN.test(conflict.factKey)) {
      return fail("GROUNDED_RAG_INVALID_OUTPUT");
    }
    const left = groundedClaim(plan, canonicalRawClaim(conflict.left));
    const right = groundedClaim(plan, canonicalRawClaim(conflict.right));
    const leftSources = new Set(left.citations.map((citation) => citation.sourceId));
    const rightSources = new Set(right.citations.map((citation) => citation.sourceId));
    if (
      left.text === right.text ||
      [...leftSources].some((sourceId) => rightSources.has(sourceId))
    ) {
      return fail("GROUNDED_RAG_UNSUPPORTED_CLAIM");
    }
    return Object.freeze({ factKey: conflict.factKey, left, right });
  }));
}

function verifyAnswer(plan: GroundedRagPlan, value: Record<string, unknown>): GroundedRagResult {
  exactKeys(value, ["kind", "claims"]);
  const claims = verifyGroundedClaimSet(plan, value.claims, {
    minimum: 1,
    maximum: GROUNDED_RAG_MAX_CLAIMS,
  });
  const answer = claims.length === 1
    ? `仅依据 ${claims[0]!.citations[0]!.sourceId} 回答：${claims[0]!.text}。`
    : `仅依据已检索项目资料回答：${claims.map((claim) => claim.text).join("；")}。`;
  return Object.freeze({
    kind: "answer" as const,
    answer,
    claims,
    snapshotId: plan.snapshotId,
    contextFingerprint: plan.contextFingerprint,
  });
}

function verifyConflict(plan: GroundedRagPlan, value: Record<string, unknown>): GroundedRagResult {
  exactKeys(value, ["kind", "conflicts"]);
  const conflicts = verifyGroundedConflictSet(plan, value.conflicts, {
    minimum: 1,
    maximum: 10,
  });
  const answer = `项目资料存在冲突：${conflicts.map((conflict) =>
    `${conflict.factKey} 分别记录为“${conflict.left.text}”和“${conflict.right.text}”`,
  ).join("；")}。请人工复核。`;
  return Object.freeze({
    kind: "conflict" as const,
    answer,
    conflicts,
    snapshotId: plan.snapshotId,
    contextFingerprint: plan.contextFingerprint,
  });
}

export function verifyGroundedRagOutput(
  plan: GroundedRagPlan,
  value: unknown,
): GroundedRagResult {
  if (!issuedPlans.has(plan)) return fail("GROUNDED_RAG_INVALID_INPUT");
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    return fail("GROUNDED_RAG_INVALID_OUTPUT");
  }
  if (value.kind === "answer") return verifyAnswer(plan, value);
  if (value.kind === "conflict") return verifyConflict(plan, value);
  if (value.kind === "refusal") {
    exactKeys(value, ["kind", "reasonCode"]);
    if (value.reasonCode !== "INSUFFICIENT_EVIDENCE") {
      return fail("GROUNDED_RAG_INVALID_OUTPUT");
    }
    return Object.freeze({
      kind: "refusal" as const,
      reasonCode: "INSUFFICIENT_EVIDENCE" as const,
      answer: "当前检索证据不足，无法可靠回答。" as const,
      snapshotId: plan.snapshotId,
      contextFingerprint: plan.contextFingerprint,
    });
  }
  return fail("GROUNDED_RAG_INVALID_OUTPUT");
}
