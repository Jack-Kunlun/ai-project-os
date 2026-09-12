import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { GitServiceError, getGitConnection } from "@/lib/git";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const noStore = { "cache-control": "no-store" } as const;

async function connectionId(params: Promise<{ connectionId: string }>) {
  return idSchema.parse((await params).connectionId);
}

export async function GET(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const connection = await getGitConnection(await connectionId(context.params), actor);
    return NextResponse.json({ connection }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    await connectionId(context.params);
    throw new GitServiceError("GIT_CONNECTION_GOVERNANCE_REQUIRED");
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    await connectionId(context.params);
    throw new GitServiceError("GIT_CONNECTION_GOVERNANCE_REQUIRED");
  } catch (error) {
    return handleApiError(error);
  }
}
