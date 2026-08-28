import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { runSemanticSearchJob } from "@/lib/web-rag";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const idSchema = z.string().uuid();
const bodySchema = z.object({
  clientKey: z.string().min(8).max(200),
  question: z.string().min(2).max(2_000),
  consent: z.object({ acknowledged: z.literal(true), version: z.string() }).strict(),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    const body = bodySchema.parse(await readJsonBody(request));
    const job = await runSemanticSearchJob({
      projectId,
      requestedBy: user,
      clientKey: body.clientKey,
      consent: body.consent,
      question: body.question,
    });
    return NextResponse.json({ job });
  } catch (error) {
    return handleApiError(error);
  }
}

