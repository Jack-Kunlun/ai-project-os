import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { revokeProjectMcpConnectionDelegation } from "@/lib/project-mcp-connection-delegation-service";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();
const noStore = { "cache-control": "no-store" } as const;

function noStoreResponse(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string; delegationId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await revokeProjectMcpConnectionDelegation(
      uuidSchema.parse(params.projectId),
      uuidSchema.parse(params.delegationId),
      await readJsonBody(request),
      actor,
    );
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    return noStoreResponse(handleApiError(error));
  }
}
