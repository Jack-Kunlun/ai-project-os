import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { WebGitHubError } from "@/lib/web-github";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    throw new WebGitHubError("GITHUB_WEB_PROJECT_CONNECT_FROZEN");
  } catch (error) {
    return handleApiError(error);
  }
}
