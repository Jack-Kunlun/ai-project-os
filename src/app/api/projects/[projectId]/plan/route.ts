import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { createProjectPlanEntry, getProjectPlan, updateProjectPlanEntry } from "@/lib/project-plan";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function projectId(params: Promise<{ projectId: string }>): Promise<string> {
  return idSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireApiSession(request);
    return NextResponse.json(await getProjectPlan(await projectId(context.params), user));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const id = await projectId(context.params);
    await assertProjectActive(id);
    return NextResponse.json(await createProjectPlanEntry(id, await readJsonBody(request), user), { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const id = await projectId(context.params);
    await assertProjectActive(id);
    return NextResponse.json(await updateProjectPlanEntry(id, await readJsonBody(request), user));
  } catch (error) {
    return handleApiError(error);
  }
}
