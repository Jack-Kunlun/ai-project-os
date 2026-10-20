export type TokenUsageStatus = "known" | "partial" | "unknown" | "notAvailable";

/**
 * A usage summary is a read-only projection of provider audit rows. Token
 * values are null whenever there is no reliable observed value; zero remains
 * a valid value only when the provider explicitly reported it.
 */
export type TokenUsageSummary = Readonly<{
  status: TokenUsageStatus;
  requestCount: number;
  knownRequestCount: number;
  unknownRequestCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

export type TokenUsageRecord = Readonly<{
  usageKnown: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}>;

export type TokenUsageBucket = Readonly<{
  count: number;
  usageKnown: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}>;

export const NO_TOKEN_USAGE: TokenUsageSummary = Object.freeze({
  status: "notAvailable",
  requestCount: 0,
  knownRequestCount: 0,
  unknownRequestCount: 0,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
});

export function unknownTokenUsage(requestCount = 0): TokenUsageSummary {
  const safeCount = Number.isSafeInteger(requestCount) && requestCount >= 0 ? requestCount : 0;
  return Object.freeze({
    status: "unknown",
    requestCount: safeCount,
    knownRequestCount: 0,
    unknownRequestCount: safeCount,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  });
}

function safeCount(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeTokenPair(inputTokens: number | null, outputTokens: number | null):
  | Readonly<{ inputTokens: number; outputTokens: number }>
  | null {
  if (inputTokens === null || outputTokens === null) return null;
  if (safeCount(inputTokens) === null || safeCount(outputTokens) === null) return null;
  return { inputTokens, outputTokens };
}

function summarizeCounts(input: Readonly<{
  requestCount: number;
  knownRequestCount: number;
  inputTokens: number;
  outputTokens: number;
}>): TokenUsageSummary {
  const { requestCount, knownRequestCount, inputTokens, outputTokens } = input;
  const totalTokens = inputTokens + outputTokens;
  if (safeCount(requestCount) === null || safeCount(knownRequestCount) === null || knownRequestCount > requestCount
    || safeCount(inputTokens) === null || safeCount(outputTokens) === null || safeCount(totalTokens) === null) {
    return unknownTokenUsage(requestCount);
  }
  if (requestCount === 0) return NO_TOKEN_USAGE;
  const unknownRequestCount = requestCount - knownRequestCount;
  const status: TokenUsageStatus = knownRequestCount === 0 ? "unknown" : unknownRequestCount > 0 ? "partial" : "known";
  return Object.freeze({
    status,
    requestCount,
    knownRequestCount,
    unknownRequestCount,
    inputTokens: knownRequestCount === 0 ? null : inputTokens,
    outputTokens: knownRequestCount === 0 ? null : outputTokens,
    totalTokens: knownRequestCount === 0 ? null : totalTokens,
  });
}

export function summarizeTokenUsage(records: readonly TokenUsageRecord[]): TokenUsageSummary {
  if (records.length === 0) return NO_TOKEN_USAGE;
  let requestCount = 0;
  let knownRequestCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const record of records) {
    requestCount += 1;
    const pair = record.usageKnown ? safeTokenPair(record.inputTokens, record.outputTokens) : null;
    if (pair === null) continue;
    knownRequestCount += 1;
    inputTokens += pair.inputTokens;
    outputTokens += pair.outputTokens;
  }
  return summarizeCounts({ requestCount, knownRequestCount, inputTokens, outputTokens });
}

export function summarizeTokenUsageBuckets(buckets: readonly TokenUsageBucket[]): TokenUsageSummary {
  if (buckets.length === 0) return NO_TOKEN_USAGE;
  let requestCount = 0;
  let knownRequestCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const bucket of buckets) {
    const count = safeCount(bucket.count);
    if (count === null) return unknownTokenUsage(requestCount);
    requestCount += count;
    if (safeCount(requestCount) === null) return unknownTokenUsage();
    if (!bucket.usageKnown) continue;
    const pair = safeTokenPair(bucket.inputTokens, bucket.outputTokens);
    if (pair === null) continue;
    knownRequestCount += count;
    inputTokens += pair.inputTokens;
    outputTokens += pair.outputTokens;
  }
  return summarizeCounts({ requestCount, knownRequestCount, inputTokens, outputTokens });
}

export function mergeTokenUsageSummaries(summaries: readonly TokenUsageSummary[]): TokenUsageSummary {
  const available = summaries.filter((summary) => summary.status !== "notAvailable");
  if (available.length === 0) return NO_TOKEN_USAGE;
  let requestCount = 0;
  let knownRequestCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const summary of available) {
    requestCount += summary.requestCount;
    knownRequestCount += summary.knownRequestCount;
    if (summary.knownRequestCount > 0 && summary.inputTokens !== null && summary.outputTokens !== null) {
      inputTokens += summary.inputTokens;
      outputTokens += summary.outputTokens;
    }
  }
  return summarizeCounts({ requestCount, knownRequestCount, inputTokens, outputTokens });
}
