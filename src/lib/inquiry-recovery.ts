import { beginInquiryRequest, finishInquiryRequest, getInquirySession, inquiryRequestIsCurrent, inquiryDrafts, setInquiryRecovery, setInquiryState, type Conversation, type InquiryRecovery } from "./inquiry-session";
import { inquiryCodeFeedback, inquiryFailure, inquiryResponseError } from "./inquiry-errors";
import { createInquiryReveal } from "./inquiry-reveal";

export type InquiryRecoveryResult = { request: InquiryRecovery; conversation?: Conversation };
const active = (status: InquiryRecovery["status"]) => status === "running" || status === "stopping";

/** A shared read-only poller survives either Ask surface unmounting. Never redispatches a model call. */
export async function recoverInquiryRequest(id: string, expectedConversationId?: string): Promise<void> {
  const job = beginInquiryRequest("recover");
  if (!job) return;
  if (getInquirySession().recovery?.id !== id) setInquiryRecovery({ id, conversationId: expectedConversationId ?? "", status: "unknown", question: "", answer: "", scope: "all", contextName: "", errorCode: null, canResume: false }, job);
  let failures = 0;
  let reveal: ReturnType<typeof createInquiryReveal> | undefined, received = "";
  try {
    while (inquiryRequestIsCurrent(job)) {
      try {
        const response = await fetch(`/api/ask/requests/${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
        if (!response.ok) {
          if (inquiryRequestIsCurrent(job) && [401, 403, 404].includes(response.status)) {
            setInquiryRecovery(null, job);
            setInquiryState({ conversation: null, question: "", preview: null }, job);
          }
          throw await inquiryResponseError(response, "无法读取本次生成状态。");
        }
        const result = await response.json() as InquiryRecoveryResult;
        if (!inquiryRequestIsCurrent(job)) return;
        if (result.request.id !== id) throw new Error("RECOVERY_ID_MISMATCH");
        const request = result.request;
        if (expectedConversationId && request.conversationId !== expectedConversationId) { setInquiryRecovery(null, job); return; }
        if (!result.conversation && (request.status === "succeeded" || getInquirySession().conversation?.id !== request.conversationId)) {
          const history = await fetch(`/api/ask/conversations/${encodeURIComponent(request.conversationId)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
          if (!history.ok) throw await inquiryResponseError(history, "会话加载失败。");
          result.conversation = (await history.json()).conversation;
          if (!inquiryRequestIsCurrent(job)) return;
        }
        failures = 0;
        if (active(request.status) && typeof window !== "undefined") {
          if (!reveal || !request.answer.startsWith(received)) {
            reveal?.dispose();
            setInquiryState({ preview: { question: request.question, answer: "" } }, job);
            reveal = createInquiryReveal(job);
            reveal.buffer.append(request.answer); reveal.buffer.flush();
          } else reveal.buffer.append(request.answer.slice(received.length));
          received = request.answer;
        } else if (request.status === "succeeded" && reveal) {
          await reveal.buffer.finish(result.conversation?.turns.at(-1)?.answer ?? request.answer);
          if (!inquiryRequestIsCurrent(job)) return;
        }
        setInquiryRecovery(request.status === "succeeded" ? null : request, job);
        setInquiryState({
          ...(result.conversation ? { conversation: result.conversation } : {}),
          scope: request.scope, projectId: request.projectId ?? "", focusDocumentId: request.focusDocumentId,
          question: request.status === "succeeded" ? "" : request.question,
          ...(active(request.status) && reveal ? {} : { preview: active(request.status) ? { question: request.question, answer: request.answer } : null }),
          error: request.errorCode ? inquiryCodeFeedback(request.errorCode) ?? { summary: "本次回答未完成。", nextStep: "已保留问题，请核对会话状态。" } : null,
        }, job);
        if (request.status === "succeeded") {
          inquiryDrafts.delete(request.conversationId); inquiryDrafts.delete("new");
        }
        if (!active(request.status)) return;
      } catch (cause) {
        if (!inquiryRequestIsCurrent(job)) return;
        if (!getInquirySession().error || getInquirySession().error?.code === "INQUIRY_CONNECTION_INTERRUPTED") setInquiryState({ error: inquiryFailure(cause, "暂时无法核对生成状态。") }, job);
        // Preserve the request pointer for an explicit retry, but never lock every new conversation offline.
        if (++failures >= 3 || !getInquirySession().recovery) return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { reveal?.dispose(); finishInquiryRequest(job); }
}

export async function stopInquiryRequest(id: string): Promise<void> {
  const original = getInquirySession().request;
  const response = await fetch(`/api/ask/requests/${encodeURIComponent(id)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await inquiryResponseError(response, "停止请求尚未确认，请核对状态。");
  // A stop acknowledgement is not a completed answer. Read the authoritative status next.
  if (original && !inquiryRequestIsCurrent(original)) return;
  if (getInquirySession().recovery?.id !== id) return;
  if (original) finishInquiryRequest(original);
  await recoverInquiryRequest(id);
}
