import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  executePersonalKnowledgeSemantic,
  getPersonalKnowledgeSemanticOverview,
  preparePersonalKnowledgeSemantic,
} from "@/lib/personal-knowledge-semantic-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    return noStore(NextResponse.json(await getPersonalKnowledgeSemanticOverview(actor)));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const input = await readJsonBody(request);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return noStore(NextResponse.json({ error: { code: "PERSONAL_KNOWLEDGE_SEMANTIC_INVALID_INPUT", message: "个人知识语义搜索请求无效" } }, { status: 400 }));
    }
    const record = input as Record<string, unknown>;
    const result = record.phase === "execute" || record.challengeId !== undefined
      ? await executePersonalKnowledgeSemantic(record, actor)
      : await preparePersonalKnowledgeSemantic({ ...record, kind: "build" }, actor);
    return noStore(NextResponse.json(result));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
