import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { createLocalWorkspaceMember, listWorkspaceMembers } from "@/lib/workspaces";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try { const user = await requireApiSession(request); return NextResponse.json({ members: await listWorkspaceMembers(idSchema.parse((await context.params).workspaceId), user) }); }
  catch (error) { return handleApiError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try { assertSameOrigin(request); const user = await requireApiSession(request); const member = await createLocalWorkspaceMember(idSchema.parse((await context.params).workspaceId), await readJsonBody(request), user); return NextResponse.json({ member }, { status: 201 }); }
  catch (error) { return handleApiError(error); }
}
