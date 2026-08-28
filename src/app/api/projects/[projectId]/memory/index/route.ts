import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { runProjectMemoryIndexJob } from "@/lib/web-memory-index";
import { toPublicProjectJob } from "@/lib/project-workflow";

export const dynamic = "force-dynamic";
export const maxDuration = 600;
const idSchema = z.string().uuid();
const bodySchema = z.object({
  clientKey: z.string().min(8).max(200),
  consent: z.object({ acknowledged: z.literal(true), version: z.string() }).strict(),
}).strict();

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    const body = bodySchema.parse(await readJsonBody(request));
    const job = await runProjectMemoryIndexJob({
      projectId,
      requestedBy: user,
      clientKey: body.clientKey,
      consent: body.consent,
    });
    return NextResponse.json({ job: toPublicProjectJob(job) });
  } catch (error) {
    return handleApiError(error);
  }
}
