import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getProjectMemoryIndexPlan, prepareProjectMemoryIndexConfirmation, runProjectMemoryIndexJob } from "@/lib/web-memory-index";
import { toPublicProjectJob } from "@/lib/project-workflow";

export const dynamic = "force-dynamic";
export const maxDuration = 600;
const idSchema = z.string().uuid();
const modeSchema = z.enum(["full", "incremental"]);
const bodySchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("prepare"), clientKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u), mode: modeSchema, planFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({
    phase: z.literal("execute"),
    challengeId: z.string().uuid(),
    clientKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u),
    mode: modeSchema,
    planFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    const mode = modeSchema.parse(new URL(request.url).searchParams.get("mode"));
    const plan = await getProjectMemoryIndexPlan(projectId, mode, user);
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
    const body = bodySchema.parse(await readJsonBody(request));
    if (body.phase === "prepare") {
      const confirmation = await prepareProjectMemoryIndexConfirmation({ projectId, requestedBy: user, clientKey: body.clientKey, mode: body.mode, planFingerprint: body.planFingerprint });
      return NextResponse.json({ confirmation }, { headers: { "cache-control": "no-store" } });
    }
    const job = await runProjectMemoryIndexJob({
      projectId,
      requestedBy: user,
      clientKey: body.clientKey,
      mode: body.mode,
      planFingerprint: body.planFingerprint,
      challengeId: body.challengeId,
    });
    return NextResponse.json({ job: toPublicProjectJob(job) });
  } catch (error) {
    return handleApiError(error);
  }
}
