import { NextResponse } from "next/server";
import { z } from "zod";
import { triggerProjectAutomationRule } from "@/lib/automation";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; ruleId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    const rule = await triggerProjectAutomationRule(projectId, idSchema.parse(params.ruleId), user);
    return NextResponse.json({ rule });
  } catch (error) {
    return handleApiError(error);
  }
}
