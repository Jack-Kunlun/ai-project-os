import { createHash } from "node:crypto";

export const AUTO_FACT_ADMISSION_POLICY = "source-grounded:v1" as const;
export const AUTO_FACT_SYSTEM_ACTOR = "system:source-grounded:v1" as const;

export type AutoFactAdmissionReason =
  | "exact_source_text"
  | "content_too_short"
  | "content_not_exact_source_text"
  | "source_contains_uncertainty"
  | "conflicting_confirmed_fact"
  | "source_requires_manual_review";

export type AutoFactCandidate = Readonly<{
  type: string;
  title: string;
  content: string;
  sourceExcerpt: string;
}>;

export type ConfirmedAutoFact = Readonly<{
  type: string;
  title: string;
  content: string;
  suggestedTitle?: string;
}>;

export type AutoFactSourceEligibility = Readonly<{
  kind: string;
  originScope: string;
  mcpActionResultImportId: string | null;
  actionResultImportId: string | null;
}>;

const MIN_EXACT_FACT_CHARACTERS = 12;
const UNCERTAINTY_PATTERN = /(?:没有|并未|未曾|不会|不应|不得|否认|示例|样例|演示|待确认|待核实|待定|待补充|待处理|有待|未决|未确定|未确认|尚未(?:完成|确定|确认|实现|落地)|尚需|需要确认|暂定|假设|可能|或许|预计|计划|规划|设想|拟(?:定|建|推出|实施|采用|开发)?|考虑中|未来|后续(?:计划|考虑|再确认|再决定)|\bnot\b|\bnever\b|example|sample|hypothetical|TODO|TBD|might|may|could|will|going\s+to|planned?|future|pending|unresolved|unconfirmed|assumption|tentative|proposed|considering|expected|potential|possibly|perhaps|roadmap|to\s+be\s+decided|under\s+consideration)/iu;
const SENTENCE_BOUNDARY_PATTERN = /[。！？!?;；\n]/u;

export function canAutoPublishSourceFacts(source: AutoFactSourceEligibility): boolean {
  return ["manual", "document", "screenshot"].includes(source.kind) &&
    source.originScope === "project" &&
    source.mcpActionResultImportId === null &&
    source.actionResultImportId === null;
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

function normalizedContent(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function autoFactDisplayTitle(content: string): string {
  const normalized = content.trim();
  const punctuation = normalized.search(/[。！？!?]/u);
  const firstSentence = punctuation >= 0 ? normalized.slice(0, punctuation + 1) : normalized;
  return Array.from(firstSentence).slice(0, 160).join("");
}

export function autoFactSuggestedTitleFromMetadata(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const admission = (metadata as { admission?: unknown }).admission;
  if (typeof admission !== "object" || admission === null || Array.isArray(admission)) return undefined;
  const suggestedTitle = (admission as { suggestedTitle?: unknown }).suggestedTitle;
  return typeof suggestedTitle === "string" && suggestedTitle.trim().length > 0
    ? suggestedTitle
    : undefined;
}

type SourceLineContext = Readonly<{
  start: number;
  end: number;
  uncertain: boolean;
  code: boolean;
}>;

type SourceSentenceContext = Readonly<{
  start: number;
  end: number;
  uncertain: boolean;
}>;

function isShortContextLabel(line: string): boolean {
  const normalized = line.trim();
  if (
    normalized.length === 0 || normalized.length > 160 ||
    /^(?:[-*+]|\d+[.)])\s/u.test(normalized) || normalized.startsWith("|")
  ) return false;
  return /[:：]$/u.test(normalized) ||
    (Array.from(normalized).length <= 40 && !SENTENCE_BOUNDARY_PATTERN.test(normalized));
}

function buildSourceLineContexts(sourceText: string): ReadonlyArray<SourceLineContext> {
  const contexts: SourceLineContext[] = [];
  const headingStack: Array<{ level: number; uncertain: boolean }> = [];
  let plainLabelUncertain = false;
  let activeFence: Readonly<{ marker: "`" | "~"; length: number }> | null = null;
  let start = 0;

  while (start < sourceText.length) {
    const newline = sourceText.indexOf("\n", start);
    const end = newline < 0 ? sourceText.length : newline + 1;
    const rawLine = sourceText.slice(start, newline < 0 ? sourceText.length : newline).replace(/\r$/u, "");
    const trimmed = rawLine.trim();
    if (activeFence !== null) {
      contexts.push(Object.freeze({ start, end, uncertain: false, code: true }));
      const closingFence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(rawLine)?.[1];
      if (closingFence?.[0] === activeFence.marker && closingFence.length >= activeFence.length) activeFence = null;
      start = end;
      continue;
    }

    const openingFence = /^ {0,3}(`{3,}|~{3,})/u.exec(rawLine)?.[1];
    if (openingFence !== undefined) {
      contexts.push(Object.freeze({ start, end, uncertain: false, code: true }));
      activeFence = Object.freeze({ marker: openingFence[0] as "`" | "~", length: openingFence.length });
      start = end;
      continue;
    }

    if (/^(?: {4}|\t)/u.test(rawLine)) {
      contexts.push(Object.freeze({ start, end, uncertain: false, code: true }));
      start = end;
      continue;
    }

    const headingPrefix = /^(#{1,6})(?:[ \t]+|(?=\S))/u.exec(trimmed);
    if (headingPrefix !== null) {
      const level = headingPrefix[1]!.length;
      const headingText = trimmed.slice(headingPrefix[0].length).replace(/[ \t]+#+[ \t]*$/u, "").trim();
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop();
      headingStack.push({ level, uncertain: UNCERTAINTY_PATTERN.test(headingText) });
      plainLabelUncertain = false;
    } else if (isShortContextLabel(trimmed)) {
      if (UNCERTAINTY_PATTERN.test(trimmed)) plainLabelUncertain = true;
      else if (/[:：]$/u.test(trimmed)) plainLabelUncertain = false;
    }

    const headingUncertain = headingStack.some((heading) => heading.uncertain);
    contexts.push(Object.freeze({ start, end, uncertain: headingUncertain || plainLabelUncertain, code: false }));
    start = end;
  }

  return Object.freeze(contexts);
}

function buildSourceSentenceContexts(sourceText: string): ReadonlyArray<SourceSentenceContext> {
  const contexts: SourceSentenceContext[] = [];
  let start = 0;
  for (let index = 0; index < sourceText.length; index += 1) {
    if (!SENTENCE_BOUNDARY_PATTERN.test(sourceText[index]!)) continue;
    const end = index + 1;
    contexts.push(Object.freeze({ start, end, uncertain: UNCERTAINTY_PATTERN.test(sourceText.slice(start, end)) }));
    start = end;
  }
  if (start < sourceText.length) {
    contexts.push(Object.freeze({ start, end: sourceText.length, uncertain: UNCERTAINTY_PATTERN.test(sourceText.slice(start)) }));
  }
  return Object.freeze(contexts);
}

function contextIndexAtOffset<T extends Readonly<{ start: number; end: number }>>(
  contexts: ReadonlyArray<T>,
  offset: number,
): number {
  let low = 0;
  let high = contexts.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const context = contexts[middle]!;
    if (offset < context.start) high = middle - 1;
    else if (offset >= context.end) low = middle + 1;
    else return middle;
  }
  return -1;
}

function hasUncertaintyInFactContext(sourceText: string, content: string): boolean {
  const lineContexts = buildSourceLineContexts(sourceText);
  const sentenceContexts = buildSourceSentenceContexts(sourceText);
  let offset = 0;

  while (offset < sourceText.length) {
    const position = sourceText.indexOf(content, offset);
    if (position < 0) break;
    const candidateEnd = position + content.length;
    let lineIndex = contextIndexAtOffset(lineContexts, position);
    while (lineIndex >= 0 && lineIndex < lineContexts.length && lineContexts[lineIndex]!.start < candidateEnd) {
      const line = lineContexts[lineIndex]!;
      if (line.uncertain || line.code) return true;
      lineIndex += 1;
    }

    let sentenceIndex = contextIndexAtOffset(sentenceContexts, position);
    while (sentenceIndex >= 0 && sentenceIndex < sentenceContexts.length && sentenceContexts[sentenceIndex]!.start < candidateEnd) {
      if (sentenceContexts[sentenceIndex]!.uncertain) return true;
      sentenceIndex += 1;
    }
    offset = position + 1;
  }

  return false;
}

export function decideAutoFactAdmission(
  candidate: AutoFactCandidate,
  confirmedFacts: readonly ConfirmedAutoFact[] = [],
  sourceText: string = candidate.sourceExcerpt,
): Readonly<{ autoAccept: boolean; reason: AutoFactAdmissionReason }> {
  const content = candidate.content.trim();
  if (Array.from(content).length < MIN_EXACT_FACT_CHARACTERS) {
    return Object.freeze({ autoAccept: false, reason: "content_too_short" });
  }
  if (content.length === 0 || !candidate.sourceExcerpt.includes(content) || !sourceText.includes(content)) {
    return Object.freeze({ autoAccept: false, reason: "content_not_exact_source_text" });
  }
  if (hasUncertaintyInFactContext(sourceText, content)) {
    return Object.freeze({ autoAccept: false, reason: "source_contains_uncertainty" });
  }

  const titleKeys = new Set([candidate.title, autoFactDisplayTitle(content)].map(normalizedTitle));
  const contentKey = normalizedContent(content);
  const hasConflict = confirmedFacts.some((fact) =>
    fact.type === candidate.type &&
    (titleKeys.has(normalizedTitle(fact.title)) ||
      (fact.suggestedTitle !== undefined && titleKeys.has(normalizedTitle(fact.suggestedTitle)))) &&
    normalizedContent(fact.content) !== contentKey,
  );
  if (hasConflict) {
    return Object.freeze({ autoAccept: false, reason: "conflicting_confirmed_fact" });
  }

  return Object.freeze({ autoAccept: true, reason: "exact_source_text" });
}

export function stableAutoFactFingerprint(sourceId: string, sourceHash: string, content: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ sourceId, sourceHash, content: content.trim() }), "utf8")
    .digest("hex");
}
