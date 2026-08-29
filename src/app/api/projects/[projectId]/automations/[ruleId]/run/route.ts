import { NextResponse } from "next/server";
import { z } from "zod";
import { triggerProjectAutomationRule } from "@/lib/automation";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; ruleId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    const rule = await triggerProjectAutomationRule(projectId, idSchema.parse(params.ruleId));
    return NextResponse.json({ rule });
  } catch (error) {
    return handleApiError(error);
  }
}
