import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { getPersonalKnowledgeOverview } from "@/lib/personal-knowledge-service";
import { getPersonalKnowledgeSemanticOverview } from "@/lib/personal-knowledge-semantic-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

/** Return the signed-in user's graph, capacity and real index availability. */
export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    const [overview, index] = await Promise.all([
      getPersonalKnowledgeOverview(actor),
      getPersonalKnowledgeSemanticOverview(actor),
    ]);
    return noStore(NextResponse.json({ ...overview, index: { status: index.status, label: index.label } }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
