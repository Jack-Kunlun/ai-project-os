import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { updateProjectWebSource } from "@/lib/web-sources";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; webSourceId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    const source = await updateProjectWebSource(projectId, idSchema.parse(params.webSourceId), await readJsonBody(request));
    return NextResponse.json({ source });
  } catch (error) {
    return handleApiError(error);
  }
}
