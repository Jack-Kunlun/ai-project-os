import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { GitServiceError } from "@/lib/git";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

async function connectionId(params: Promise<{ connectionId: string }>) {
  return idSchema.parse((await params).connectionId);
}

export async function PATCH(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    await connectionId(context.params);
    await readJsonBody(request);
    throw new GitServiceError("GIT_LEGACY_CONNECTION_API_FROZEN");
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    await connectionId(context.params);
    await readJsonBody(request);
    throw new GitServiceError("GIT_LEGACY_CONNECTION_API_FROZEN");
  } catch (error) {
    return handleApiError(error);
  }
}
