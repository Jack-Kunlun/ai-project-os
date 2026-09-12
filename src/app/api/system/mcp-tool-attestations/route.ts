import { McpCapabilityError } from "@/lib/mcp";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    throw new McpCapabilityError("MCP_TOOL_REVIEW_REQUIRED");
  } catch (error) {
    return handleApiError(error);
  }
}
