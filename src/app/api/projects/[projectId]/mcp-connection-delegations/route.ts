import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  listProjectMcpConnectionDelegations,
  proposeProjectMcpConnectionDelegation,
} from "@/lib/project-mcp-connection-delegation-service";

export const dynamic = "force-dynamic";
const projectIdSchema = z.string().uuid();
const noStore = { "cache-control": "no-store" } as const;

function noStoreResponse(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const projectId = projectIdSchema.parse((await context.params).projectId);
    const result = await listProjectMcpConnectionDelegations(projectId, actor);
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    return noStoreResponse(handleApiError(error));
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const projectId = projectIdSchema.parse((await context.params).projectId);
    const result = await proposeProjectMcpConnectionDelegation(projectId, await readJsonBody(request), actor);
    return NextResponse.json(result, { status: 201, headers: noStore });
  } catch (error) {
    return noStoreResponse(handleApiError(error));
  }
}
