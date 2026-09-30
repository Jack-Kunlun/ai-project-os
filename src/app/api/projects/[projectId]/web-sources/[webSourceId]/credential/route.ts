import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { revokeAuthenticatedProjectWebSourceCredential, rotateAuthenticatedProjectWebSourceCredential } from "@/lib/authenticated-web-sources";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function ids(params: Promise<{ projectId: string; webSourceId: string }>) {
  const value = await params;
  return { projectId: idSchema.parse(value.projectId), webSourceId: idSchema.parse(value.webSourceId) };
}

export async function PUT(request: Request, context: { params: Promise<{ projectId: string; webSourceId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const { projectId, webSourceId } = await ids(context.params);
    const source = await rotateAuthenticatedProjectWebSourceCredential(projectId, webSourceId, await readJsonBody(request), user);
    return NextResponse.json({ source });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string; webSourceId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const { projectId, webSourceId } = await ids(context.params);
    const source = await revokeAuthenticatedProjectWebSourceCredential(projectId, webSourceId, user);
    return NextResponse.json({ source });
  } catch (error) {
    return handleApiError(error);
  }
}
