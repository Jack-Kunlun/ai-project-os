import { NextResponse } from "next/server";
import { z } from "zod";
import { updateProjectActionPolicy } from "@/lib/action-engine";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; capability: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    const policy = await updateProjectActionPolicy(projectId, params.capability, await readJsonBody(request), user);
    return NextResponse.json({ policy });
  } catch (error) {
    return handleApiError(error);
  }
}
