import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  listProjectAiProviderDelegations,
  proposeProjectAiProviderDelegation,
} from "@/lib/project-ai-provider-delegation-service";

export const dynamic = "force-dynamic";

const projectIdSchema = z.string().uuid();

async function projectId(params: Promise<{ projectId: string }>): Promise<string> {
  return projectIdSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const result = await listProjectAiProviderDelegations(await projectId(context.params), actor);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const result = await proposeProjectAiProviderDelegation(
      await projectId(context.params),
      await readJsonBody(request),
      actor,
    );
    return NextResponse.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
