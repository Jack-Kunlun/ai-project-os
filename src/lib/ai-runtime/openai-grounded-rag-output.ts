import { createHash } from "node:crypto";
import { throwAiRuntimeServiceError } from "./errors";
import {
  getIssuedOpenAiGroundedRagPlanRequest,
  type OpenAiGroundedRagCitation,
  type OpenAiGroundedRagClaim,
  type OpenAiGroundedRagStructuredOutput,
  type OpenAiGroundedRagTransportPlan,
} from "./openai-grounded-rag-contract";
import type { ProviderResultInput, SafeUsage } from "./types";

export const OPENAI_GROUNDED_RAG_OUTPUT_CONTRACT_VERSION =
  "openai-grounded-rag-output:v1" as const;

const ROOT_FIELDS = ["kind", "claims", "conflicts", "reasonCode"] as const;
const CLAIM_FIELDS = ["text", "citations"] as const;
const CITATION_FIELDS = ["citationKey", "excerpt"] as const;
const CONFLICT_FIELDS = ["factKey", "left", "right"] as const;
const METADATA_FIELDS = ["operation_key", "run_id"] as const;
const PROVIDER_RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,240}$/;
const FACT_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const MAX_OUTPUT_ITEMS = 100;
const MAX_MESSAGE_CONTENT_ITEMS = 10;
const MAX_STRUCTURED_OUTPUT_BYTES = 128_000;

export type VerifiedOpenAiGroundedRagResponse = Readonly<{
  contractVersion: typeof OPENAI_GROUNDED_RAG_OUTPUT_CONTRACT_VERSION;
  providerResponseId: string;
  modelId: string;
  usage: Readonly<SafeUsage>;
  output: OpenAiGroundedRagStructuredOutput;
  outputFingerprint: string;
}>;

export type InspectedOpenAiGroundedRagResponse = Readonly<{
  providerResult: ProviderResultInput;
  verifiedResponse: VerifiedOpenAiGroundedRagResponse | null;
}>;

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
    if (descriptor === undefined) return { present: false, value: undefined };
    if (!("value" in descriptor) || !descriptor.enumerable) invalidResponse();
    return { present: true, value: descriptor.value };
  } catch {
    return invalidResponse();
  }
}

function requiredDataField(
  value: Record<string, unknown>,
  field: string,
): unknown {
  const result = readDataField(value, field);
  if (!result.present) invalidResponse();
  return result.value;
}

function exactDataFields(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  try {
    const keys = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return keys.length === wanted.length &&
      keys.every((key, index) => key === wanted[index]) &&
      keys.every((key) => {
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
    return invalidResponse();
  }
  try {
    const keys = Object.keys(value);
    if (
      keys.length !== value.length ||
      !keys.every((key, index) => key === String(index))
    ) {
      return invalidResponse();
    }
    return keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return invalidResponse();
      }
      return descriptor.value;
    });
  } catch {
    return invalidResponse();
  }
}

function safeNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalidResponse();
  }
  return value as number;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function safeText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string") return invalidResponse();
  let normalized: string;
  try {
    normalized = value.normalize("NFC");
  } catch {
    return invalidResponse();
  }
  if (
    normalized !== value ||
    value.trim() !== value ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    hasUnpairedSurrogate(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    return invalidResponse();
  }
  return value;
}

function parseUsage(
  rawUsage: unknown,
  maximumOutputTokens: number,
): Readonly<SafeUsage> {
  if (!isPlainRecord(rawUsage)) return invalidResponse();
  const inputTokens = safeNonNegativeInteger(requiredDataField(rawUsage, "input_tokens"));
  const outputTokens = safeNonNegativeInteger(requiredDataField(rawUsage, "output_tokens"));
  const totalTokens = safeNonNegativeInteger(requiredDataField(rawUsage, "total_tokens"));
  if (
    outputTokens > maximumOutputTokens ||
    inputTokens > Number.MAX_SAFE_INTEGER - outputTokens ||
    totalTokens !== inputTokens + outputTokens
  ) {
    return invalidResponse();
  }
  return Object.freeze({ inputTokens, outputTokens, requestCount: 1 });
}

function parseOptionalUsage(
  rawUsage: unknown,
  maximumOutputTokens: number,
): Readonly<SafeUsage> | undefined {
  return rawUsage === null || rawUsage === undefined
    ? undefined
    : parseUsage(rawUsage, maximumOutputTokens);
}

function extractStructuredOutputText(rawOutput: unknown): string {
  const outputItems = dataArray(rawOutput, 1, MAX_OUTPUT_ITEMS);
  let messageCount = 0;
  let outputText: string | null = null;
  for (const rawItem of outputItems) {
    if (!isPlainRecord(rawItem)) return invalidResponse();
    const type = requiredDataField(rawItem, "type");
    if (type === "reasoning") continue;
    if (type !== "message") return invalidResponse();
    messageCount += 1;
    if (
      messageCount !== 1 ||
      requiredDataField(rawItem, "role") !== "assistant" ||
      requiredDataField(rawItem, "status") !== "completed"
    ) {
      return invalidResponse();
    }
    const contentItems = dataArray(
      requiredDataField(rawItem, "content"),
      1,
      MAX_MESSAGE_CONTENT_ITEMS,
    );
    for (const rawContent of contentItems) {
      if (!isPlainRecord(rawContent)) return invalidResponse();
      if (
        requiredDataField(rawContent, "type") !== "output_text" ||
        outputText !== null
      ) {
        return invalidResponse();
      }
      outputText = safeText(
        requiredDataField(rawContent, "text"),
        MAX_STRUCTURED_OUTPUT_BYTES,
      );
    }
  }
  if (messageCount !== 1 || outputText === null) return invalidResponse();
  return outputText;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function parseCitation(
  rawCitation: unknown,
  contexts: ReadonlyMap<string, Readonly<{ contentText: string }>>,
  claimText: string,
): OpenAiGroundedRagCitation {
  if (!isPlainRecord(rawCitation) || !exactDataFields(rawCitation, CITATION_FIELDS)) {
    return invalidResponse();
  }
  const citationKey = safeText(rawCitation.citationKey, 32);
  const excerpt = safeText(rawCitation.excerpt, 4_000);
  const context = contexts.get(citationKey);
  if (
    context === undefined ||
    !context.contentText.includes(excerpt) ||
    !excerpt.includes(claimText)
  ) {
    return invalidResponse();
  }
  return Object.freeze({ citationKey, excerpt });
}

function parseClaim(
  rawClaim: unknown,
  contexts: ReadonlyMap<string, Readonly<{ contentText: string }>>,
): OpenAiGroundedRagClaim {
  if (!isPlainRecord(rawClaim) || !exactDataFields(rawClaim, CLAIM_FIELDS)) {
    return invalidResponse();
  }
  const text = safeText(rawClaim.text, 1_000);
  const citations = Object.freeze(
    dataArray(rawClaim.citations, 1, 4)
      .map((citation) => parseCitation(citation, contexts, text)),
  );
  const unique = new Set(
    citations.map((citation) => `${citation.citationKey}\u0000${citation.excerpt}`),
  );
  if (unique.size !== citations.length) return invalidResponse();
  return Object.freeze({ text, citations });
}

function parseStructuredOutput(
  outputText: string,
  contexts: readonly Readonly<{
    citationKey: string;
    sourceId: string;
    contentText: string;
  }>[],
): OpenAiGroundedRagStructuredOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText) as unknown;
  } catch {
    return invalidResponse();
  }
  if (!isPlainRecord(parsed) || !exactDataFields(parsed, ROOT_FIELDS)) {
    return invalidResponse();
  }
  const contextByCitation = new Map(
    contexts.map((context) => [context.citationKey, context]),
  );
  const claims = Object.freeze(
    dataArray(parsed.claims, 0, 12)
      .map((claim) => parseClaim(claim, contextByCitation)),
  );
  const claimTexts = new Set(claims.map((claim) => claim.text));
  if (claimTexts.size !== claims.length) return invalidResponse();
  const conflicts = Object.freeze(
    dataArray(parsed.conflicts, 0, 10).map((rawConflict) => {
      if (!isPlainRecord(rawConflict) || !exactDataFields(rawConflict, CONFLICT_FIELDS)) {
        return invalidResponse();
      }
      const factKey = rawConflict.factKey;
      if (typeof factKey !== "string" || !FACT_KEY_PATTERN.test(factKey)) {
        return invalidResponse();
      }
      const left = parseClaim(rawConflict.left, contextByCitation);
      const right = parseClaim(rawConflict.right, contextByCitation);
      const sourceIds = (claim: typeof left) => new Set(claim.citations.map((citation) =>
        contexts.find((context) => context.citationKey === citation.citationKey)?.sourceId,
      ));
      const leftSources = sourceIds(left);
      const rightSources = sourceIds(right);
      if (
        left.text === right.text ||
        leftSources.has(undefined) ||
        rightSources.has(undefined) ||
        [...leftSources].some((sourceId) => rightSources.has(sourceId))
      ) {
        return invalidResponse();
      }
      return Object.freeze({ factKey, left, right });
    }),
  );

  const kind = parsed.kind;
  const reasonCode = parsed.reasonCode;
  if (
    (kind === "answer" &&
      (claims.length < 1 || conflicts.length !== 0 || reasonCode !== null)) ||
    (kind === "conflict" &&
      (claims.length !== 0 || conflicts.length < 1 || reasonCode !== null)) ||
    (kind === "refusal" &&
      (claims.length !== 0 || conflicts.length !== 0 ||
        reasonCode !== "INSUFFICIENT_EVIDENCE")) ||
    (kind !== "answer" && kind !== "conflict" && kind !== "refusal")
  ) {
    return invalidResponse();
  }
  if (kind === "answer") {
    return deepFreeze({ kind, claims });
  }
  if (kind === "conflict") {
    return deepFreeze({ kind, conflicts });
  }
  return deepFreeze({
    kind: "refusal" as const,
    reasonCode: "INSUFFICIENT_EVIDENCE" as const,
  });
}

function outputFingerprint(output: OpenAiGroundedRagStructuredOutput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      contractVersion: OPENAI_GROUNDED_RAG_OUTPUT_CONTRACT_VERSION,
      output,
    }), "utf8")
    .digest("hex");
}

export function inspectOpenAiGroundedRagResponse(
  plan: OpenAiGroundedRagTransportPlan,
  rawResponse: unknown,
): InspectedOpenAiGroundedRagResponse {
  const request = getIssuedOpenAiGroundedRagPlanRequest(plan);
  if (request === null) return invalidInput();
  if (!isPlainRecord(rawResponse)) return invalidResponse();
  if (
    requiredDataField(rawResponse, "object") !== "response" ||
    requiredDataField(rawResponse, "model") !== plan.body.model ||
    requiredDataField(rawResponse, "store") !== false ||
    requiredDataField(rawResponse, "tool_choice") !== "none" ||
    requiredDataField(rawResponse, "parallel_tool_calls") !== false ||
    dataArray(requiredDataField(rawResponse, "tools"), 0, 0).length !== 0
  ) {
    return invalidResponse();
  }
  const rawMetadata = requiredDataField(rawResponse, "metadata");
  if (!isPlainRecord(rawMetadata) || !exactDataFields(rawMetadata, METADATA_FIELDS)) {
    return invalidResponse();
  }
  if (
    requiredDataField(rawMetadata, "run_id") !== plan.body.metadata.run_id ||
    requiredDataField(rawMetadata, "operation_key") !== plan.body.metadata.operation_key
  ) {
    return invalidResponse();
  }
  const providerResponseId = requiredDataField(rawResponse, "id");
  if (
    typeof providerResponseId !== "string" ||
    !PROVIDER_RESPONSE_ID_PATTERN.test(providerResponseId)
  ) {
    return invalidResponse();
  }

  const status = requiredDataField(rawResponse, "status");
  const rawError = requiredDataField(rawResponse, "error");
  const rawIncompleteDetails = requiredDataField(rawResponse, "incomplete_details");
  const rawUsage = requiredDataField(rawResponse, "usage");
  if (status !== "completed") {
    const usage = parseOptionalUsage(rawUsage, plan.body.max_output_tokens);
    let providerResult: ProviderResultInput;
    switch (status) {
      case "failed":
        if (!isPlainRecord(rawError) || rawIncompleteDetails !== null) {
          return invalidResponse();
        }
        providerResult = {
          kind: "failed",
          providerResponseId,
          safeCode: "AI_PROVIDER_FAILED",
          ...(usage === undefined ? {} : { usage }),
        };
        break;
      case "incomplete":
        if (rawError !== null || !isPlainRecord(rawIncompleteDetails)) {
          return invalidResponse();
        }
        providerResult = {
          kind: "incomplete",
          providerResponseId,
          safeCode: "AI_PROVIDER_INCOMPLETE",
          ...(usage === undefined ? {} : { usage }),
        };
        break;
      case "cancelled":
        if (rawError !== null || rawIncompleteDetails !== null) return invalidResponse();
        providerResult = {
          kind: "cancelled",
          providerResponseId,
          safeCode: "AI_PROVIDER_CANCELLED",
        };
        break;
      case "queued":
      case "in_progress":
        if (rawError !== null || rawIncompleteDetails !== null || usage !== undefined) {
          return invalidResponse();
        }
        providerResult = { kind: status, providerResponseId };
        break;
      default:
        return invalidResponse();
    }
    return Object.freeze({
      providerResult: Object.freeze(providerResult),
      verifiedResponse: null,
    });
  }

  if (rawError !== null || rawIncompleteDetails !== null) return invalidResponse();
  const outputText = extractStructuredOutputText(requiredDataField(rawResponse, "output"));
  const topLevelOutputText = readDataField(rawResponse, "output_text");
  if (topLevelOutputText.present && topLevelOutputText.value !== outputText) {
    return invalidResponse();
  }
  const usage = parseUsage(rawUsage, plan.body.max_output_tokens);
  const output = parseStructuredOutput(outputText, request.contexts);
  const verifiedResponse = Object.freeze({
    contractVersion: OPENAI_GROUNDED_RAG_OUTPUT_CONTRACT_VERSION,
    providerResponseId,
    modelId: plan.body.model,
    usage,
    output,
    outputFingerprint: outputFingerprint(output),
  });
  return Object.freeze({
    providerResult: Object.freeze({
      kind: "completed" as const,
      providerResponseId,
      usage,
    }),
    verifiedResponse,
  });
}

export function verifyOpenAiGroundedRagResponse(
  plan: OpenAiGroundedRagTransportPlan,
  rawResponse: unknown,
): VerifiedOpenAiGroundedRagResponse {
  const inspected = inspectOpenAiGroundedRagResponse(plan, rawResponse);
  if (
    inspected.providerResult.kind !== "completed" ||
    inspected.verifiedResponse === null
  ) {
    return invalidResponse();
  }
  return inspected.verifiedResponse;
}
