import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  createWorkspaceProviderConnection,
  listWorkspaceProviderConnections,
} from "@/lib/workspace-provider-service";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function workspaceId(params: Promise<{ workspaceId: string }>): Promise<string> {
  return idSchema.parse((await params).workspaceId);
}

export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    return NextResponse.json({ providers: await listWorkspaceProviderConnections(await workspaceId(context.params), actor) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    return NextResponse.json({ provider: await createWorkspaceProviderConnection(await workspaceId(context.params), await readJsonBody(request), actor) }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
