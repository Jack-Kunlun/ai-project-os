import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { GitServiceError } from "@/lib/git";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireApiSession(request);
    throw new GitServiceError("GIT_LEGACY_CONNECTION_API_FROZEN");
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    await readJsonBody(request);
    throw new GitServiceError("GIT_LEGACY_CONNECTION_API_FROZEN");
  } catch (error) {
    return handleApiError(error);
  }
}
