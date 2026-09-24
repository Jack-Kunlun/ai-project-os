import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getGitConnection, updateGitConnection } from "@/lib/git";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const renameSchema = z.object({ name: z.string().trim().min(1).max(80), expectedUpdatedAt: z.string().datetime({ offset: true }) }).strict();
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
    const body = renameSchema.parse(await readJsonBody(request));
    return NextResponse.json({ connection: await updateGitConnection(await connectionId(context.params), body, actor) }, { headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    await connectionId(context.params);
    return NextResponse.json({ error: { code: "GIT_CONNECTION_GOVERNANCE_REQUIRED", message: "请使用连接安全治理操作" } }, { status: 409, headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}
