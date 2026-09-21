import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { readPersonalKnowledgeRevision } from "@/lib/personal-knowledge-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Prevent historical owner content from entering shared HTTP caches. */
function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

/** Read one immutable historical revision while preserving the owner fence. */
/** Return one immutable historical revision after owner and active-document checks. */
export async function GET(
  request: Request,
  context: { params: Promise<{ documentId: string; version: string }> },
) {
  try {
    const actor = await requireApiSession(request);
    const params = await context.params;
    const revision = await readPersonalKnowledgeRevision(params.documentId, params.version, actor);
    return noStore(NextResponse.json({ revision }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
