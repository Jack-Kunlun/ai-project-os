import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { getTeamActivity } from "@/lib/team-service";

export const dynamic = "force-dynamic";
const workspaceIdSchema = z.string().uuid();
const limitSchema = z.coerce.number().int().min(1).max(50).default(30);

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const { workspaceId } = await context.params;
    const limit = limitSchema.parse(new URL(request.url).searchParams.get("limit") ?? undefined);
    return NextResponse.json({ activity: await getTeamActivity(actor, workspaceIdSchema.parse(workspaceId), limit) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
