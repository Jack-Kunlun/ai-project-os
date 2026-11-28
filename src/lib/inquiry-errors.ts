import { safeResponseError } from "./safe-error-presentation";

export type InquiryFeedback = Readonly<{ summary: string; nextStep?: string; code?: string | null }>;
const messages: Readonly<Record<string, readonly [string, string]>> = {
  AI_PLATFORM_TOKEN_EXHAUSTED: ["平台额度不足，暂时无法生成回答。", "请查看额度与账单，补充额度后重试。"],
  AI_PLATFORM_TOKEN_EXPIRED: ["平台额度已过期。", "请查看额度与账单，更新额度后重试。"],
  AI_PLATFORM_CONCURRENCY_LIMIT: ["已有回答正在生成。", "请先恢复正在进行的回答，或停止后再发送。"],
  AI_PROVIDER_QUOTA_EXHAUSTED: ["模型供应商的余额或配额不足。", "请联系管理员补充供应商额度或切换可用模型。"],
  AI_PROVIDER_RATE_LIMITED: ["模型供应商暂时限制了请求频率。", "请稍后重试；无需新建会话。"],
  AI_PROVIDER_AUTH_FAILED: ["模型供应商身份验证失败。", "请联系管理员检查供应商凭据后重试。"],
  AI_PROVIDER_REJECTED: ["模型供应商拒绝了本次请求。", "请联系管理员核对模型配置后重试。"],
  UNIFIED_QUESTION_OUTPUT_TRUNCATED: ["本次回答达到输出上限。", "已生成的内容会保留，请核对当前会话。"],
  UNIFIED_QUESTION_PROVIDER_UNAVAILABLE: ["模型暂时不可用。", "请稍后重试，或联系管理员检查模型连接。"],
  UNIFIED_QUESTION_PROVIDER_UNCERTAIN: ["本次生成结果尚未确认。", "先恢复并核对原请求；已预留额度仍待核对，请勿重复发送。"],
  UNIFIED_QUESTION_OUTCOME_UNRESOLVED: ["本会话有尚未确认的生成结果。", "请先核对原请求状态；其他新会话仍可在额度允许时使用。"],
  UNIFIED_QUESTION_STOPPED: ["已停止生成，保留中断前的内容。", "可继续回答；继续会发起新请求，并按实际用量计量。"],
  UNIFIED_QUESTION_CONFIRMATION_STALE: ["会话、资料或模型配置已变化。", "请核对当前范围，再重新发送问题。"],
  UNIFIED_QUESTION_CONFIRMATION_EXPIRED: ["本次发送准备已过期。", "问题已保留，请重新发送。"],
  UNIFIED_QUESTION_NO_EVIDENCE: ["当前范围没有找到匹配资料。", "请调整问题或检索范围后重试。"],
  UNIFIED_QUESTION_HISTORY_OVER_BUDGET: ["会话历史超过模型上下文上限。", "请新建会话后继续。"],
  UNIFIED_QUESTION_CONTEXT_OVER_BUDGET: ["本轮资料超过模型上下文上限。", "请缩小检索范围后重试。"],
  INQUIRY_CONNECTION_INTERRUPTED: ["连接中断，正在核对原请求。", "问题和已生成内容会保留，不会自动重复发送。"],
};

export function inquiryCodeFeedback(code: string): InquiryFeedback | undefined {
  const text = Object.hasOwn(messages, code) ? messages[code] : undefined;
  return text ? { code, summary: text[0], nextStep: text[1] } : undefined;
}

export class InquiryResponseError extends Error {
  constructor(readonly feedback: InquiryFeedback, message = feedback.summary) { super(message); }
}

/** Only local allowlisted prose reaches the notification; provider bodies are untrusted. */
export async function inquiryResponseError(response: Response, fallback: string): Promise<InquiryResponseError> {
  const payload = await response.json().catch(() => null);
  const code = payload?.error?.code;
  const known = typeof code === "string" ? inquiryCodeFeedback(code) : undefined;
  if (known) return new InquiryResponseError(known);
  const safe = await safeResponseError(Response.json(payload), fallback);
  return new InquiryResponseError({ code: safe.code, summary: safe.summary, nextStep: safe.nextStep }, safe.message);
}

export function inquiryFailure(cause: unknown, fallback: string): InquiryFeedback {
  return cause instanceof InquiryResponseError ? cause.feedback : { summary: fallback, nextStep: "请核对当前会话后重试。" };
}
