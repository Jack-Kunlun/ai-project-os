import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { GitServiceError } from "@/lib/git";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    idSchema.parse((await context.params).connectionId);
    throw new GitServiceError("GIT_CONNECTION_GOVERNANCE_REQUIRED");
  } catch (error) {
    return handleApiError(error);
  }
}
