import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { deleteGitConnection, getGitConnection, updateGitConnection } from "@/lib/git";

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
    const actor = await requireApiSession(request);
    const connection = await updateGitConnection(await connectionId(context.params), await readJsonBody(request), actor);
    return NextResponse.json({ connection }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const deleted = await deleteGitConnection(await connectionId(context.params), await readJsonBody(request), actor);
    return NextResponse.json({ deleted }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}
