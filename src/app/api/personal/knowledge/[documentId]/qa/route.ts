import { NextResponse } from "next/server";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import {
  executePersonalKnowledgeQa,
  PersonalKnowledgeQaError,
  preparePersonalKnowledgeQa,
} from "@/lib/personal-knowledge-qa-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 180;

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function phaseOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { phase?: unknown }).phase
    : undefined;
}

/** Prepare or execute one explicitly confirmed question against the current page revision. */
export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const body = await readJsonBody(request);
    const documentId = (await context.params).documentId;
    const result = phaseOf(body) === "prepare"
      ? await preparePersonalKnowledgeQa(documentId, body, actor)
      : phaseOf(body) === "execute"
        ? await executePersonalKnowledgeQa(documentId, body, actor)
        : (() => { throw new PersonalKnowledgeQaError("PERSONAL_KNOWLEDGE_QA_INVALID_INPUT"); })();
    return noStore(NextResponse.json(phaseOf(body) === "prepare" ? { confirmation: result } : { answer: result }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
