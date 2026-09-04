import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { connectProjectGitRepository, gitRepositoryScanPolicy, listProjectGitRepositories } from "@/lib/git";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function projectId(params: Promise<{ projectId: string }>) {
  return idSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireApiSession(request);
    const id = await projectId(context.params);
    return NextResponse.json({
      repositories: await listProjectGitRepositories(id, user),
      scanPolicy: gitRepositoryScanPolicy(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const id = await projectId(context.params);
    const repository = await connectProjectGitRepository(id, await readJsonBody(request), user);
    return NextResponse.json({ repository }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
