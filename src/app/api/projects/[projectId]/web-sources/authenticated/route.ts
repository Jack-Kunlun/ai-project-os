import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { createAuthenticatedProjectWebSource } from "@/lib/authenticated-web-sources";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    const source = await createAuthenticatedProjectWebSource(projectId, await readJsonBody(request), user);
    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
