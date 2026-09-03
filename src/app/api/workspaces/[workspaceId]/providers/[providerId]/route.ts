import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  deleteWorkspaceProviderConnection,
  updateWorkspaceProviderConnection,
} from "@/lib/workspace-provider-service";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function ids(params: Promise<{ workspaceId: string; providerId: string }>) {
  const resolved = await params;
  return { workspaceId: idSchema.parse(resolved.workspaceId), providerId: idSchema.parse(resolved.providerId) };
}

export async function PATCH(request: Request, context: { params: Promise<{ workspaceId: string; providerId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const resolved = await ids(context.params);
    return NextResponse.json({ provider: await updateWorkspaceProviderConnection(resolved.workspaceId, resolved.providerId, await readJsonBody(request), actor) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ workspaceId: string; providerId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const resolved = await ids(context.params);
    return NextResponse.json({ deleted: await deleteWorkspaceProviderConnection(resolved.workspaceId, resolved.providerId, await readJsonBody(request), actor) });
  } catch (error) {
    return handleApiError(error);
  }
}
