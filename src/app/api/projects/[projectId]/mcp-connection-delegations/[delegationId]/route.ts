import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getProjectMcpConnectionDelegation } from "@/lib/project-mcp-connection-delegation-service";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();
const noStore = { "cache-control": "no-store" } as const;

function noStoreResponse(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string; delegationId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await getProjectMcpConnectionDelegation(
      uuidSchema.parse(params.projectId),
      uuidSchema.parse(params.delegationId),
      actor,
    );
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    return noStoreResponse(handleApiError(error));
  }
}
