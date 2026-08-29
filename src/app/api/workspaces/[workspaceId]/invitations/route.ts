import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { createWorkspaceInvitation, listWorkspaceInvitations } from "@/lib/workspaces";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try { const actor = await requireApiSession(request); return NextResponse.json({ invitations: await listWorkspaceInvitations(idSchema.parse((await context.params).workspaceId), actor) }); }
  catch (error) { return handleApiError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try { assertSameOrigin(request); const actor = await requireApiSession(request); const result = await createWorkspaceInvitation(idSchema.parse((await context.params).workspaceId), await readJsonBody(request), actor); return NextResponse.json(result, { status: 201 }); }
  catch (error) { return handleApiError(error); }
}
