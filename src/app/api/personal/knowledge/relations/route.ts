import { NextResponse } from "next/server";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import {
  createPersonalKnowledgeRelation,
  listPersonalKnowledgeRelations,
} from "@/lib/personal-knowledge-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

/** List bounded active explicit relations owned by the signed-in user. */
export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    return noStore(NextResponse.json(await listPersonalKnowledgeRelations(actor)));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}

/** Create an explicit relation after both current endpoint revisions are fenced. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const relation = await createPersonalKnowledgeRelation(await readJsonBody(request), actor);
    return noStore(NextResponse.json({ relation }, { status: 201 }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
