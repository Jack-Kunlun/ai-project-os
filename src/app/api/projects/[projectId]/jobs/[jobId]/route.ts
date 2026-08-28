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
    await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    const jobId = idSchema.parse(params.jobId);
    const body = actionSchema.parse(await readJsonBody(request));
    const job = body.action === "reconcile"
      ? await reconcileProjectJob(projectId, jobId)
      : body.action === "cancel"
        ? await cancelProjectJob(projectId, jobId)
        : rejectProjectJobRetry();
    return NextResponse.json({ job: toPublicProjectJob(job) });
  } catch (error) {
    return handleApiError(error);
  }
}
