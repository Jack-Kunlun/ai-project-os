import { NextResponse } from "next/server";
import { z } from "zod";
import { decideProjectAction } from "@/lib/action-engine";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; actionId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    const action = await decideProjectAction(projectId, idSchema.parse(params.actionId), await readJsonBody(request), user);
    return NextResponse.json({ action });
  } catch (error) {
    return handleApiError(error);
  }
}
