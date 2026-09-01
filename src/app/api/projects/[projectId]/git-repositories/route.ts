import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { connectProjectGitRepository, gitRepositoryScanPolicy, listProjectGitRepositories } from "@/lib/git";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function projectId(params: Promise<{ projectId: string }>) {
  return idSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    await requireApiSession(request);
    return NextResponse.json({
      repositories: await listProjectGitRepositories(await projectId(context.params)),
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
    await assertProjectActive(id);
    const repository = await connectProjectGitRepository(id, await readJsonBody(request), user);
    return NextResponse.json({ repository }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
