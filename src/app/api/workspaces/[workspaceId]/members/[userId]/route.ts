import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { updateWorkspaceMember } from "@/lib/workspaces";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ workspaceId: string; userId: string }> }) {
  try { assertSameOrigin(request); const actor = await requireApiSession(request); const params = await context.params; const member = await updateWorkspaceMember(idSchema.parse(params.workspaceId), idSchema.parse(params.userId), await readJsonBody(request), actor); return NextResponse.json({ member }); }
  catch (error) { return handleApiError(error); }
}
