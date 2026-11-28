import type { Conversation } from "./inquiry-session";
import { inquiryResponseError, InquiryResponseError, inquiryCodeFeedback } from "./inquiry-errors";

export const INQUIRY_STREAM_TYPE = "application/x-ndjson";
export type InquiryStreamEvent =
  | { type: "started" }
  | { type: "delta"; text: string }
  | { type: "complete"; conversation: Conversation }
  | { type: "error"; error: { code: string; message: string } };
const interrupted = () => new InquiryResponseError(inquiryCodeFeedback("INQUIRY_CONNECTION_INTERRUPTED")!);

/** Consume real network chunks; only a complete event is a successful turn. */
export async function readInquiryResponse(response: Response, onDelta: (text: string) => void, onStarted?: () => void): Promise<{ conversation: Conversation }> {
  if (!response.ok) {
    const error = await inquiryResponseError(response, "请求未完成，请稍后重试。");
    throw error;
  }
  // Older servers and existing JSON callers remain compatible.
  if (!response.headers.get("content-type")?.includes(INQUIRY_STREAM_TYPE)) {
    try { return await response.json(); } catch { throw interrupted(); }
  }
  if (!response.body) throw interrupted();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", answerLength = 0;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); } catch { throw interrupted(); }
      const { value, done } = next;
      try { buffer += done ? decoder.decode() : decoder.decode(value, { stream: true }); }
      catch { throw interrupted(); }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event: InquiryStreamEvent;
        try { event = JSON.parse(line) as InquiryStreamEvent; } catch { throw interrupted(); }
        if (!event || typeof event !== "object") throw interrupted();
        if (event.type === "started") {
          onStarted?.();
        } else if (event.type === "delta" && typeof event.text === "string") {
          answerLength += event.text.length;
          if (answerLength > 50_000) throw interrupted();
          onDelta(event.text);
        } else if (event.type === "complete" && event.conversation && typeof event.conversation.id === "string" && Array.isArray(event.conversation.turns)) {
          return { conversation: event.conversation };
        } else if (event.type === "error" && event.error && typeof event.error.code === "string") {
          const error = await inquiryResponseError(Response.json({ error: event.error }, { status: 502 }), "提问未完成。请核对会话状态后重试。");
          throw error;
        } else throw interrupted();
      }
      if (done) throw interrupted();
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
