import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { resolveMemoryQualityIssue } from "@/lib/memory-quality";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; issueId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    const issue = await resolveMemoryQualityIssue(projectId, idSchema.parse(params.issueId), await readJsonBody(request), user);
    return NextResponse.json({ issue });
  } catch (error) {
    return handleApiError(error);
  }
}
