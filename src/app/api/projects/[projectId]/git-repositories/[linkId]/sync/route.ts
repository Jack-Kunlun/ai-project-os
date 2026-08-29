import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { runGitRepositorySyncJob } from "@/lib/git";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; linkId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    const body = await readJsonBody(request) as { clientKey?: unknown };
    const job = await runGitRepositorySyncJob({
      projectId,
      linkId: idSchema.parse(params.linkId),
      requestedBy: user,
      clientKey: body.clientKey,
    });
    return NextResponse.json({ job }, { status: job.status === "succeeded" ? 200 : 202 });
  } catch (error) {
    return handleApiError(error);
  }
}
