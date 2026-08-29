import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { testGitConnection } from "@/lib/git";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const id = idSchema.parse((await context.params).connectionId);
    return NextResponse.json(await testGitConnection(id, await readJsonBody(request)));
  } catch (error) {
    return handleApiError(error);
  }
}
