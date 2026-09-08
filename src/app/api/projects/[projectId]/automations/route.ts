import { NextResponse } from "next/server";
import { z } from "zod";
import { createProjectAutomationRule, getProjectAutomationCapabilities, getProjectAutomationRun, listProjectAutomationRules } from "@/lib/automation";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function projectId(params: Promise<{ projectId: string }>) {
  return idSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireApiSession(request);
    const id = await projectId(context.params);
    const runId = new URL(request.url).searchParams.get("run");
    const [rules, capabilities, run] = await Promise.all([
      listProjectAutomationRules(id, user),
      getProjectAutomationCapabilities(id, user),
      runId === null ? Promise.resolve(null) : getProjectAutomationRun(id, runId, user),
    ]);
    return NextResponse.json({ rules, capabilities, run });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const id = await projectId(context.params);
    const rule = await createProjectAutomationRule(id, await readJsonBody(request), user);
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
