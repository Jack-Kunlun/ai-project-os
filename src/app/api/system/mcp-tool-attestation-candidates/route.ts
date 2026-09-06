import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listMcpControlPlaneAttestationCandidates } from "@/lib/mcp";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams.entries());
    return NextResponse.json(
      await listMcpControlPlaneAttestationCandidates(actor.id, query),
      { headers: noStore },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
