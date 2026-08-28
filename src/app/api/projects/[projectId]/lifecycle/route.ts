import { NextResponse } from "next/server";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { updateProjectLifecycle } from "@/lib/project-lifecycle";
import { projectIdSchema, updateProjectLifecycleSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const { projectId: rawProjectId } = await context.params;
    const projectId = projectIdSchema.parse(rawProjectId);
    const input = updateProjectLifecycleSchema.parse(await readJsonBody(request));
    const result = await updateProjectLifecycle({
      projectId,
      actorId: user.id,
      action: input.action,
      expectedUpdatedAt: new Date(input.expectedUpdatedAt),
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
