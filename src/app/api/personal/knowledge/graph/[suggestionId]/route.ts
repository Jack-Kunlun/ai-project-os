import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { reviewPersonalKnowledgeGraph } from "@/lib/personal-knowledge-graph";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" } as const;

export async function PATCH(request: Request, context: { params: Promise<{ suggestionId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    return NextResponse.json(await reviewPersonalKnowledgeGraph((await context.params).suggestionId, await readJsonBody(request), actor), { headers });
  } catch (error) { return handleApiError(error); }
}
