import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { disableWebGitHubRepository } from "@/lib/web-github";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function DELETE(
  request: Request,
  context: { params: Promise<{ projectId: string; linkId: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    const link = await disableWebGitHubRepository(
      projectId,
      idSchema.parse(params.linkId),
    );
    return NextResponse.json({ link });
  } catch (error) {
    return handleApiError(error);
  }
}
