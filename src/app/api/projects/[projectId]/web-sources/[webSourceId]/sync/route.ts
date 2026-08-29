import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { syncProjectWebSource } from "@/lib/web-sources";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; webSourceId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    const source = await syncProjectWebSource(projectId, idSchema.parse(params.webSourceId), user);
    return NextResponse.json({ source });
  } catch (error) {
    return handleApiError(error);
  }
}
