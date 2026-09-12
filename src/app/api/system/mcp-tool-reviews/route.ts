import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { createMcpToolReview, listMcpToolReviewHistory } from "@/lib/mcp";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams.entries());
    return NextResponse.json(await listMcpToolReviewHistory(actor, query), { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const result = await createMcpToolReview(actor, await readJsonBody(request));
    return NextResponse.json(result, { status: result.created ? 201 : 200, headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}
