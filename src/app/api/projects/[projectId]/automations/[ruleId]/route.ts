import { NextResponse } from "next/server";
import { z } from "zod";
import { updateProjectAutomationRule } from "@/lib/automation";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; ruleId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    const rule = await updateProjectAutomationRule(projectId, idSchema.parse(params.ruleId), await readJsonBody(request), user);
    return NextResponse.json({ rule });
  } catch (error) {
    return handleApiError(error);
  }
}
