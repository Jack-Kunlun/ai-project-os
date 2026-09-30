import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { fetchAuthenticatedProjectWebSource } from "@/lib/authenticated-web-sources";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; webSourceId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    const webSourceId = idSchema.parse(params.webSourceId);
    const revision = await fetchAuthenticatedProjectWebSource(projectId, webSourceId, user);
    return NextResponse.json({ revision }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
