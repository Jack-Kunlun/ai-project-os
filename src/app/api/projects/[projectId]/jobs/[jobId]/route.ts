import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  cancelProjectJob,
  getProjectJob,
  reconcileProjectJob,
  rejectProjectJobRetry,
  toPublicProjectJob,
} from "@/lib/project-workflow";
import { cancelGitHubProjectSync, reconcileGitHubProjectSync } from "@/lib/github/project-sync-service";
import { cancelMemoryIndexJob, reconcileMemoryIndexJob } from "@/lib/web-memory-index";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const actionSchema = z.object({
  action: z.enum(["reconcile", "cancel", "retry"]),
}).strict();

type Context = { params: Promise<{ projectId: string; jobId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    const jobId = idSchema.parse(params.jobId);
    return NextResponse.json({ job: toPublicProjectJob(await getProjectJob(projectId, jobId)) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    const jobId = idSchema.parse(params.jobId);
    await assertProjectActive(projectId);
    const body = actionSchema.parse(await readJsonBody(request));
    const existing = body.action === "reconcile" || body.action === "cancel" ? await getProjectJob(projectId, jobId) : null;
    const job = body.action === "reconcile" && existing?.kind === "githubProjectSync"
      ? await reconcileGitHubProjectSync({ projectId, jobId, requestedById: user.id })
      : body.action === "reconcile" && existing?.kind === "memoryIndex"
        ? await reconcileMemoryIndexJob({ projectId, jobId, requestedById: user.id })
      : body.action === "reconcile"
        ? await reconcileProjectJob(projectId, jobId, user.id)
      : body.action === "cancel"
        ? existing?.kind === "githubProjectSync"
          ? await cancelGitHubProjectSync({ projectId, jobId, requestedById: user.id })
          : existing?.kind === "memoryIndex"
            ? await cancelMemoryIndexJob(projectId, jobId)
          : await cancelProjectJob(projectId, jobId)
        : rejectProjectJobRetry();
    return NextResponse.json({ job: toPublicProjectJob(job) });
  } catch (error) {
    return handleApiError(error);
  }
}
