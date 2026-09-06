import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { failMcp } from "@/lib/mcp";
import { z } from "zod";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; grantId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const params = await context.params;
    idSchema.parse(params.projectId);
    idSchema.parse(params.grantId);
    return failMcp("MCP_LEGACY_PROJECT_RUNTIME_FROZEN");
  } catch (error) {
    return handleApiError(error);
  }
}
