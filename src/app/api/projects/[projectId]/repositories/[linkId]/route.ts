import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { disableWebGitHubRepository } from "@/lib/web-github";

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
    const link = await disableWebGitHubRepository(
      idSchema.parse(params.projectId),
      idSchema.parse(params.linkId),
    );
    return NextResponse.json({ link });
  } catch (error) {
    return handleApiError(error);
  }
}

