import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { listTeams } from "@/lib/team-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    return NextResponse.json({ teams: await listTeams(actor) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
