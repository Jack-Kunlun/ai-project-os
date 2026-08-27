import { createHash } from "node:crypto";
import { throwAiRuntimeServiceError } from "./errors";
import {
  getIssuedOpenAiAutoExtractPlanSources,
  type OpenAiResponsesTransportPlan,
} from "./openai-responses-contract";
import type { SafeUsage } from "./types";

export const OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION =
  "openai-responses-output:v1" as const;

const ROOT_OUTPUT_FIELDS = ["candidates"] as const;
const CANDIDATE_FIELDS = ["statement", "sourceId", "sourceExcerpt"] as const;
const METADATA_FIELDS = ["operation_key", "run_id"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER_RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,240}$/;
const UNSAFE_TEXT_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

const MAX_OUTPUT_ITEMS = 100;
const MAX_MESSAGE_CONTENT_ITEMS = 10;
const MAX_CANDIDATE_COUNT = 100;
const MAX_STRUCTURED_OUTPUT_BYTES = 128_000;
const MAX_STATEMENT_LENGTH = 20_000;
const MAX_SOURCE_EXCERPT_LENGTH = 10_000;

export interface VerifiedOpenAiAutoExtractCandidate {
  statement: string;
  statementFingerprint: string;
  sourceId: string;
  sourceExcerpt: string;
  sourceExcerptFingerprint: string;
  sourceStart: number;
  sourceEnd: number;
}

export interface VerifiedOpenAiAutoExtractResponse {
  contractVersion: typeof OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION;
  providerResponseId: string;
  modelId: string;
  usage: Readonly<SafeUsage>;
  candidates: readonly Readonly<VerifiedOpenAiAutoExtractCandidate>[];
  candidateSetFingerprint: string;
}

function invalidInput(): never {
  return throwAiRuntimeServiceError("AI_INVALID_OPERATION_KEY_INPUT");
}

function invalidResponse(): never {
  return throwAiRuntimeServiceError("AI_INVALID_PROVIDER_RESPONSE");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function readDataField(
  value: Record<string, unknown>,
  field: string,
): { present: boolean; value: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined) {
      return { present: false, value: undefined };
    }
    if (!("value" in descriptor) || !descriptor.enumerable) {
      invalidResponse();
    }
    return { present: true, value: descriptor.value };
  } catch {
    invalidResponse();
  }
}

function requiredDataField(
  value: Record<string, unknown>,
  field: string,
): unknown {
  const result = readDataField(value, field);
  if (!result.present) {
    invalidResponse();
  }
  return result.value;
}

function exactDataFields(
  value: Record<string, unknown>,
  expectedFields: readonly string[],
): boolean {
  try {
    const keys = Object.keys(value).sort();
    const expected = [...expectedFields].sort();
    if (
      keys.length !== expected.length ||
      !keys.every((key, index) => key === expected[index])
    ) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
    });
  } catch {
    return false;
  }
}

function dataArray(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimumLength ||
    value.length > maximumLength
  ) {
    invalidResponse();
  }
  try {
    const keys = Object.keys(value);
    if (
      keys.length !== value.length ||
      !keys.every((key, index) => key === String(index))
    ) {
      invalidResponse();
    }
    return keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        invalidResponse();
      }
      return descriptor.value;
    });
  } catch {
    invalidResponse();
  }
}

function safeNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidResponse();
  }
  return value as number;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function safeText(
  value: unknown,
  maximumLength: number,
  requireNonWhitespace: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    (requireNonWhitespace && value.trim().length === 0) ||
    UNSAFE_TEXT_CONTROL_PATTERN.test(value) ||
    hasUnpairedSurrogate(value)
  ) {
    invalidResponse();
  }
  return value;
}

function hashText(label: string, value: string): string {
  return createHash("sha256")
    .update(`${OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION}:${label}\u0000${value}`, "utf8")
    .digest("hex");
}

function hashCanonicalCandidateSet(
  candidates: readonly Readonly<VerifiedOpenAiAutoExtractCandidate>[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION,
        candidates: candidates.map((candidate) => ({
          statement: candidate.statement,
          sourceId: candidate.sourceId,
          sourceExcerpt: candidate.sourceExcerpt,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}

function parseUsage(
  rawUsage: unknown,
  maximumOutputTokens: number,
): Readonly<SafeUsage> {
  if (!isPlainRecord(rawUsage)) {
    invalidResponse();
  }
  const inputTokens = safeNonNegativeInteger(
    requiredDataField(rawUsage, "input_tokens"),
  );
  const outputTokens = safeNonNegativeInteger(
    requiredDataField(rawUsage, "output_tokens"),
  );
  const totalTokens = safeNonNegativeInteger(
    requiredDataField(rawUsage, "total_tokens"),
  );
  if (
    outputTokens > maximumOutputTokens ||
    inputTokens > Number.MAX_SAFE_INTEGER - outputTokens ||
    totalTokens !== inputTokens + outputTokens
  ) {
    invalidResponse();
  }
  return Object.freeze({ inputTokens, outputTokens, requestCount: 1 });
}

function extractStructuredOutputText(rawOutput: unknown): string {
  const outputItems = dataArray(rawOutput, 1, MAX_OUTPUT_ITEMS);
  let messageCount = 0;
  let outputText: string | null = null;

  for (const rawItem of outputItems) {
    if (!isPlainRecord(rawItem)) {
      invalidResponse();
    }
    const type = requiredDataField(rawItem, "type");
    if (type === "reasoning") {
      continue;
    }
    if (type !== "message") {
      invalidResponse();
    }
    messageCount += 1;
    if (
      messageCount !== 1 ||
      requiredDataField(rawItem, "role") !== "assistant" ||
      requiredDataField(rawItem, "status") !== "completed"
    ) {
      invalidResponse();
    }

    const contentItems = dataArray(
      requiredDataField(rawItem, "content"),
      1,
      MAX_MESSAGE_CONTENT_ITEMS,
    );
    for (const rawContent of contentItems) {
      if (!isPlainRecord(rawContent)) {
        invalidResponse();
      }
      if (
        requiredDataField(rawContent, "type") !== "output_text" ||
        outputText !== null
      ) {
        invalidResponse();
      }
      outputText = safeText(
        requiredDataField(rawContent, "text"),
        MAX_STRUCTURED_OUTPUT_BYTES,
        true,
      );
      if (Buffer.byteLength(outputText, "utf8") > MAX_STRUCTURED_OUTPUT_BYTES) {
        invalidResponse();
      }
    }
  }

  if (messageCount !== 1 || outputText === null) {
    invalidResponse();
  }
  return outputText;
}

function parseCandidateSet(
  outputText: string,
  sources: readonly Readonly<{ sourceId: string; content: string }>[],
): readonly Readonly<VerifiedOpenAiAutoExtractCandidate>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText) as unknown;
  } catch {
    invalidResponse();
  }
  if (!isPlainRecord(parsed) || !exactDataFields(parsed, ROOT_OUTPUT_FIELDS)) {
    invalidResponse();
  }
  const sourceById = new Map(sources.map((source) => [source.sourceId, source.content]));
  const candidates = dataArray(
    requiredDataField(parsed, "candidates"),
    0,
    MAX_CANDIDATE_COUNT,
  ).map((rawCandidate) => {
    if (!isPlainRecord(rawCandidate) || !exactDataFields(rawCandidate, CANDIDATE_FIELDS)) {
      invalidResponse();
    }
    const sourceId = requiredDataField(rawCandidate, "sourceId");
    if (typeof sourceId !== "string" || !UUID_PATTERN.test(sourceId)) {
      invalidResponse();
    }
    const source = sourceById.get(sourceId);
    if (source === undefined) {
      invalidResponse();
    }
    const statement = safeText(
      requiredDataField(rawCandidate, "statement"),
      MAX_STATEMENT_LENGTH,
      true,
    );
    const sourceExcerpt = safeText(
      requiredDataField(rawCandidate, "sourceExcerpt"),
      MAX_SOURCE_EXCERPT_LENGTH,
      true,
    );
    const sourceStart = source.indexOf(sourceExcerpt);
    if (sourceStart < 0) {
      invalidResponse();
    }
    return Object.freeze({
      statement,
      statementFingerprint: hashText("statement", statement),
      sourceId,
      sourceExcerpt,
      sourceExcerptFingerprint: hashText("source-excerpt", sourceExcerpt),
      sourceStart,
      sourceEnd: sourceStart + sourceExcerpt.length,
    });
  });

  candidates.sort((left, right) => {
    if (left.sourceId !== right.sourceId) {
      return left.sourceId < right.sourceId ? -1 : 1;
    }
    if (left.sourceStart !== right.sourceStart) {
      return left.sourceStart - right.sourceStart;
    }
    return left.statement < right.statement ? -1 : left.statement > right.statement ? 1 : 0;
  });
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1];
    const current = candidates[index];
    if (
      previous?.sourceId === current?.sourceId &&
      previous.sourceExcerpt === current.sourceExcerpt &&
      previous.statement === current.statement
    ) {
      invalidResponse();
    }
  }
  return Object.freeze(candidates);
}

/**
 * Validates one completed Responses payload against its exact issued request.
 * Raw provider text is discarded after strict parsing; only verified candidate
 * claims, safe usage and opaque provider identifiers are returned.
 */
export function verifyOpenAiAutoExtractResponse(
  plan: OpenAiResponsesTransportPlan,
  rawResponse: unknown,
): VerifiedOpenAiAutoExtractResponse {
  const sources = getIssuedOpenAiAutoExtractPlanSources(plan);
  if (sources === null) {
    invalidInput();
  }
  if (!isPlainRecord(rawResponse)) {
    invalidResponse();
  }
  if (
    requiredDataField(rawResponse, "object") !== "response" ||
    requiredDataField(rawResponse, "status") !== "completed" ||
    requiredDataField(rawResponse, "error") !== null ||
    requiredDataField(rawResponse, "incomplete_details") !== null ||
    requiredDataField(rawResponse, "model") !== plan.body.model ||
    requiredDataField(rawResponse, "store") !== false ||
    requiredDataField(rawResponse, "tool_choice") !== "none" ||
    requiredDataField(rawResponse, "parallel_tool_calls") !== false
  ) {
    invalidResponse();
  }
  if (dataArray(requiredDataField(rawResponse, "tools"), 0, 0).length !== 0) {
    invalidResponse();
  }

  const rawMetadata = requiredDataField(rawResponse, "metadata");
  if (!isPlainRecord(rawMetadata) || !exactDataFields(rawMetadata, METADATA_FIELDS)) {
    invalidResponse();
  }
  if (
    requiredDataField(rawMetadata, "run_id") !== plan.body.metadata.run_id ||
    requiredDataField(rawMetadata, "operation_key") !==
      plan.body.metadata.operation_key
  ) {
    invalidResponse();
  }

  const providerResponseId = requiredDataField(rawResponse, "id");
  if (
    typeof providerResponseId !== "string" ||
    !PROVIDER_RESPONSE_ID_PATTERN.test(providerResponseId)
  ) {
    invalidResponse();
  }
  const outputText = extractStructuredOutputText(
    requiredDataField(rawResponse, "output"),
  );
  const topLevelOutputText = readDataField(rawResponse, "output_text");
  if (
    topLevelOutputText.present &&
    topLevelOutputText.value !== outputText
  ) {
    invalidResponse();
  }
  const usage = parseUsage(
    requiredDataField(rawResponse, "usage"),
    plan.body.max_output_tokens,
  );
  const candidates = parseCandidateSet(outputText, sources);
  return Object.freeze({
    contractVersion: OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION,
    providerResponseId,
    modelId: plan.body.model,
    usage,
    candidates,
    candidateSetFingerprint: hashCanonicalCandidateSet(candidates),
  });
}
