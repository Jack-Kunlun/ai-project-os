import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { getTeamOverview } from "@/lib/team-service";

export const dynamic = "force-dynamic";
const workspaceIdSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const { workspaceId } = await context.params;
    return NextResponse.json({ overview: await getTeamOverview(actor, workspaceIdSchema.parse(workspaceId)) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
