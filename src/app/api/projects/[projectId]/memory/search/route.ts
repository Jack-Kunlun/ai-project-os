import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { prepareSemanticSearchConfirmation, runSemanticSearchJob } from "@/lib/web-rag";
import { toPublicProjectJob } from "@/lib/project-workflow";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const idSchema = z.string().uuid();
const bodySchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("prepare"), clientKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u), question: z.string().trim().min(2).max(2_000) }).strict(),
  z.object({ phase: z.literal("execute"), challengeId: z.string().uuid(), clientKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u), question: z.string().trim().min(2).max(2_000) }).strict(),
]);

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    const body = bodySchema.parse(await readJsonBody(request));
    if (body.phase === "prepare") {
      const confirmation = await prepareSemanticSearchConfirmation({ projectId, requestedBy: user, clientKey: body.clientKey, question: body.question });
      return NextResponse.json({ confirmation }, { headers: { "cache-control": "no-store" } });
    }
    const job = await runSemanticSearchJob({
      projectId,
      requestedBy: user,
      clientKey: body.clientKey,
      challengeId: body.challengeId,
      question: body.question,
    });
    return NextResponse.json({ job: toPublicProjectJob(job) });
  } catch (error) {
    return handleApiError(error);
  }
}
