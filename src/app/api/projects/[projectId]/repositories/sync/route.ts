import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { runGitHubProjectSyncJob } from "@/lib/github";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const idSchema = z.string().uuid();
const inputSchema = z.object({ clientKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/) }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    await assertProjectActive(projectId);
    const input = inputSchema.parse(await readJsonBody(request));
    const job = await runGitHubProjectSyncJob({ projectId, requestedBy: user, clientKey: input.clientKey });
    return NextResponse.json({ job });
  } catch (error) {
    return handleApiError(error);
  }
}
