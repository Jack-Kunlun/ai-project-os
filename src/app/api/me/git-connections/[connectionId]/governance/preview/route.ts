import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { previewGitConnectionMutation } from "@/lib/git";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const noStore = { "cache-control": "no-store" } as const;

export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const connectionId = idSchema.parse((await context.params).connectionId);
    const preview = await previewGitConnectionMutation(connectionId, await readJsonBody(request), actor);
    return NextResponse.json({ preview }, { status: 201, headers: noStore });
  } catch (error) {
    return handleApiError(error);
  }
}
