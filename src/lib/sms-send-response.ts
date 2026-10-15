const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MIN_RATE_LIMIT_SECONDS = 60;
const MAX_RATE_LIMIT_SECONDS = 60 * 60;

export type SmsSendResponseResult =
  | { kind: "rate-limited"; retryAfterSeconds: number; message: string }
  | { kind: "success"; challengeId: string; retryAfterSeconds: number }
  | { kind: "error"; message: string };

export type CodeSendResponseOptions =
  | { channel: "sms"; allowedCode: "PHONE_AUTH_RATE_LIMITED" }
  | { channel: "email"; allowedCode: "EMAIL_AUTH_RATE_LIMITED" };

const SMS_RESPONSE_OPTIONS: CodeSendResponseOptions = { channel: "sms", allowedCode: "PHONE_AUTH_RATE_LIMITED" };

function serverErrorMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const error = payload.error;
  if (typeof error !== "object" || error === null || !("message" in error)) return null;
  const message = error.message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 240) : null;
}

function serverErrorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const error = payload.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
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
  options: CodeSendResponseOptions = SMS_RESPONSE_OPTIONS,
  nowMs = Date.now(),
): Promise<SmsSendResponseResult> {
  const payload = await response.json().catch(() => null) as {
    challengeId?: unknown;
    retryAfterSeconds?: unknown;
    error?: { message?: unknown };
  } | null;

  if (response.status === 429) {
    const detail = serverErrorMessage(payload);
    const channelLabel = options.channel === "sms" ? "短信" : "邮件";
    if (serverErrorCode(payload) !== options.allowedCode) {
      return {
        kind: "error",
        message: detail ?? `${channelLabel}请求触发网络防护限制，请稍后重试。`,
      };
    }

    const retryAfterSeconds = parseRateLimitRetryAfter(response.headers.get("retry-after"), nowMs);
    return {
      kind: "rate-limited",
      retryAfterSeconds,
      message: detail
        ? `${channelLabel}发送受限：${detail} 请在 ${retryAfterSeconds} 秒后重试。`
        : `${channelLabel}请求过于频繁，请在 ${retryAfterSeconds} 秒后重试。`,
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
