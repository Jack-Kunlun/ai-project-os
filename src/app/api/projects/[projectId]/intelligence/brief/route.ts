import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { prepareProjectBriefConfirmation, runProjectBriefJob } from "@/lib/web-project-intelligence";
import { toPublicProjectJob } from "@/lib/project-workflow";

export const dynamic = "force-dynamic";
export const maxDuration = 180;
const idSchema = z.string().uuid();
const bodySchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("prepare"), clientKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u) }).strict(),
  z.object({ phase: z.literal("execute"), challengeId: z.string().uuid(), clientKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u) }).strict(),
]);

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    const body = bodySchema.parse(await readJsonBody(request));
    if (body.phase === "prepare") {
      const confirmation = await prepareProjectBriefConfirmation({ projectId, requestedBy: user, clientKey: body.clientKey });
      return NextResponse.json({ confirmation }, { headers: { "cache-control": "no-store" } });
    }
    const job = await runProjectBriefJob({
      projectId,
      requestedBy: user,
      clientKey: body.clientKey,
      challengeId: body.challengeId,
    });
    return NextResponse.json({ job: toPublicProjectJob(job) });
  } catch (error) {
    return handleApiError(error);
  }
}
