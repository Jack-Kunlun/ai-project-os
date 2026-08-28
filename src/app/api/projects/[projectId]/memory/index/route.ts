import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getProjectMemoryIndexPlan, runProjectMemoryIndexJob } from "@/lib/web-memory-index";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { toPublicProjectJob } from "@/lib/project-workflow";

export const dynamic = "force-dynamic";
export const maxDuration = 600;
const idSchema = z.string().uuid();
const modeSchema = z.enum(["full", "incremental"]);
const bodySchema = z.object({
  clientKey: z.string().min(8).max(200),
  mode: modeSchema,
  planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  consent: z.object({ acknowledged: z.literal(true), version: z.string() }).strict(),
}).strict();

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    const mode = modeSchema.parse(new URL(request.url).searchParams.get("mode"));
    const plan = await getProjectMemoryIndexPlan(projectId, mode);
    return NextResponse.json({ plan }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    await assertProjectActive(projectId);
    const body = bodySchema.parse(await readJsonBody(request));
    const job = await runProjectMemoryIndexJob({
      projectId,
      requestedBy: user,
      clientKey: body.clientKey,
      mode: body.mode,
      planFingerprint: body.planFingerprint,
      consent: body.consent,
    });
    return NextResponse.json({ job: toPublicProjectJob(job) });
  } catch (error) {
    return handleApiError(error);
  }
}
