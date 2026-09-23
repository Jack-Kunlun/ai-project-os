import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { probeMcpConnectionDraft } from "@/lib/mcp";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" } as const;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    return NextResponse.json({ probe: await probeMcpConnectionDraft(await readJsonBody(request), actor) }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}
