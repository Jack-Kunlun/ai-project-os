import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { reviewWebAiCandidate } from "@/lib/web-auto-extract";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const bodySchema = z.object({
  action: z.enum(["accept", "dismiss"]),
  expectedItemUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string; candidateId: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const body = bodySchema.parse(await readJsonBody(request));
    const candidate = await reviewWebAiCandidate({
      projectId: idSchema.parse(params.projectId),
      candidateId: idSchema.parse(params.candidateId),
      action: body.action,
      expectedItemUpdatedAt: new Date(body.expectedItemUpdatedAt),
      reviewedBy: `local:${user.username}`,
    });
    return NextResponse.json({ candidate });
  } catch (error) {
    return handleApiError(error);
  }
}

