import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { disableProjectGitRepository } from "@/lib/git";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string; linkId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    const repository = await disableProjectGitRepository(projectId, idSchema.parse(params.linkId), user);
    return NextResponse.json({ repository });
  } catch (error) {
    return handleApiError(error);
  }
}
