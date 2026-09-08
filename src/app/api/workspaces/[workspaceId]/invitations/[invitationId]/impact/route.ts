import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getWorkspaceInvitationImpact } from "@/lib/workspaces";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string; invitationId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const params = await context.params;
    const impact = await getWorkspaceInvitationImpact(idSchema.parse(params.workspaceId), idSchema.parse(params.invitationId), actor);
    return NextResponse.json(impact, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
