const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MIN_RATE_LIMIT_SECONDS = 60;
const MAX_RATE_LIMIT_SECONDS = 60 * 60;

export type SmsSendResponseResult =
  | { kind: "rate-limited"; retryAfterSeconds: number; message: string }
  | { kind: "success"; challengeId: string; retryAfterSeconds: number }
  | { kind: "error"; message: string };

function serverErrorMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const error = payload.error;
  if (typeof error !== "object" || error === null || !("message" in error)) return null;
  const message = error.message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 240) : null;
}

function boundedRateLimitSeconds(value: number): number {
  return Math.min(MAX_RATE_LIMIT_SECONDS, Math.max(MIN_RATE_LIMIT_SECONDS, Math.ceil(value)));
}

export function parseRateLimitRetryAfter(value: string | null, nowMs = Date.now()): number {
  const header = value?.trim();
  if (!header || header.length > 128) return MIN_RATE_LIMIT_SECONDS;

  if (/^\d+$/u.test(header)) {
    const seconds = Number(header);
    return boundedRateLimitSeconds(Number.isFinite(seconds) ? seconds : MAX_RATE_LIMIT_SECONDS);
  }

  const retryAt = Date.parse(header);
  if (!Number.isFinite(retryAt)) return MIN_RATE_LIMIT_SECONDS;
  return boundedRateLimitSeconds((retryAt - nowMs) / 1_000);
}

export async function readSmsSendResponse(
  response: Pick<Response, "ok" | "status" | "headers" | "json">,
  nowMs = Date.now(),
): Promise<SmsSendResponseResult> {
  const payload = await response.json().catch(() => null) as {
    challengeId?: unknown;
    retryAfterSeconds?: unknown;
    error?: { message?: unknown };
  } | null;

  if (response.status === 429) {
    const retryAfterSeconds = parseRateLimitRetryAfter(response.headers.get("retry-after"), nowMs);
    const detail = serverErrorMessage(payload);
    return {
      kind: "rate-limited",
      retryAfterSeconds,
      message: detail
        ? `短信发送受限：${detail} 请在 ${retryAfterSeconds} 秒后重试。`
        : `短信请求过于频繁，请在 ${retryAfterSeconds} 秒后重试。`,
    };
  }

  if (
    !response.ok
    || typeof payload?.challengeId !== "string"
    || !UUID_PATTERN.test(payload.challengeId)
  ) {
    return {
      kind: "error",
      message: serverErrorMessage(payload) ?? "验证码暂时无法发送，请稍后重试。",
    };
  }

  const retryAfterSeconds = typeof payload.retryAfterSeconds === "number" && Number.isFinite(payload.retryAfterSeconds)
    ? Math.min(300, Math.max(1, Math.floor(payload.retryAfterSeconds)))
    : 60;
  return { kind: "success", challengeId: payload.challengeId, retryAfterSeconds };
}
