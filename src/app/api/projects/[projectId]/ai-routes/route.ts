import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  getProjectAiRoutes,
  previewProjectAiRouteChange,
  upsertProjectAiRoute,
} from "@/lib/project-ai-routes";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function projectId(params: Promise<{ projectId: string }>): Promise<string> {
  return idSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireApiSession(request);
    return NextResponse.json(await getProjectAiRoutes(await projectId(context.params), user));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const resolvedProjectId = await projectId(context.params);
    return NextResponse.json(await previewProjectAiRouteChange(
      resolvedProjectId,
      await readJsonBody(request),
      user,
    ));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const resolvedProjectId = await projectId(context.params);
    const result = await upsertProjectAiRoute(
      resolvedProjectId,
      await readJsonBody(request),
      user,
    );
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
