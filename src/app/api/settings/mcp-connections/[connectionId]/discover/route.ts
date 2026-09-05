import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { McpCapabilityError } from "@/lib/mcp";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    idSchema.parse((await context.params).connectionId);
    throw new McpCapabilityError("MCP_LEGACY_CONNECTION_API_FROZEN");
  } catch (error) {
    return handleApiError(error);
  }
}
