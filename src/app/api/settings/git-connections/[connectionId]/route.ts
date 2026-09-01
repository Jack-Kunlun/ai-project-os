import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { deleteGitConnection, updateGitConnection } from "@/lib/git";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function connectionId(params: Promise<{ connectionId: string }>) {
  return idSchema.parse((await params).connectionId);
}

export async function PATCH(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const connection = await updateGitConnection(await connectionId(context.params), await readJsonBody(request));
    return NextResponse.json({ connection });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const deleted = await deleteGitConnection(
      await connectionId(context.params),
      await readJsonBody(request),
    );
    return NextResponse.json({ deleted });
  } catch (error) {
    return handleApiError(error);
  }
}
