import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { revokePersonalKnowledgeRelation } from "@/lib/personal-knowledge-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

/** Revoke one active relation without exposing cross-owner existence. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ relationId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const { relationId } = await context.params;
    const revoked = await revokePersonalKnowledgeRelation(relationId, actor);
    return noStore(NextResponse.json({ revoked }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
