import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { INQUIRY_STREAM_TYPE } from "@/lib/inquiry-stream";
import {
  executeUnifiedQuestion,
  prepareUnifiedQuestion,
  UNIFIED_QUESTION_ERROR_PRESENTATION,
  UnifiedQuestionError,
} from "@/lib/unified-question-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof UnifiedQuestionError) {
    const presentation = UNIFIED_QUESTION_ERROR_PRESENTATION[error.code];
    return noStore(NextResponse.json({ error: { code: error.code, message: presentation.message } }, { status: presentation.status }));
  }
  return noStore(handleApiError(error));
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const input = await readJsonBody(request);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      const code = "UNIFIED_QUESTION_INVALID_INPUT" as const;
      return noStore(NextResponse.json({ error: { code, message: UNIFIED_QUESTION_ERROR_PRESENTATION[code].message } }, { status: 400 }));
    }
    const record = input as Record<string, unknown>;
    if (record.phase === "execute" && request.headers.get("accept")?.includes(INQUIRY_STREAM_TYPE)) {
      const encoder = new TextEncoder();
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: unknown) => {
            if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };
          void (async () => {
            try {
              const result = await executeUnifiedQuestion(record, actor, undefined, text => send({ type: "delta", text }));
              send({ type: "complete", ...result as object });
            } catch (error) {
              const response = errorResponse(error);
              const payload = await response.json();
              send({ type: "error", error: payload.error });
            } finally {
              if (!closed) { closed = true; controller.close(); }
            }
          })();
        },
        // A disconnected browser must not interrupt durable audit/usage cleanup
        // or cause a second provider dispatch. Stop buffering; finish this call.
        cancel() { closed = true; },
      });
      return new Response(stream, { headers: {
        "content-type": `${INQUIRY_STREAM_TYPE}; charset=utf-8`,
        "cache-control": "private, no-store, no-transform",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      } });
    }
    const result = record.phase === "prepare"
      ? await prepareUnifiedQuestion(record, actor)
      : record.phase === "execute"
        ? await executeUnifiedQuestion(record, actor)
        : (() => { throw new UnifiedQuestionError("UNIFIED_QUESTION_INVALID_INPUT"); })();
    return noStore(NextResponse.json(result));
  } catch (error) {
    return errorResponse(error);
  }
}
