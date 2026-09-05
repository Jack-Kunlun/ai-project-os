import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  listProjectGitRepositoryDelegations,
  proposeProjectGitRepositoryDelegation,
} from "@/lib/project-git-repository-delegation-service";

export const dynamic = "force-dynamic";
const projectIdSchema = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const projectId = projectIdSchema.parse((await context.params).projectId);
    const result = await listProjectGitRepositoryDelegations(projectId, actor);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const projectId = projectIdSchema.parse((await context.params).projectId);
    const result = await proposeProjectGitRepositoryDelegation(projectId, await readJsonBody(request), actor);
    return NextResponse.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
