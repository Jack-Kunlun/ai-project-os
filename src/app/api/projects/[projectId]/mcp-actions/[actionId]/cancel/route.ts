import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { isProjectMcpActionApiEnabled, projectMcpActionApiUnavailable } from "@/lib/project-mcp-action-api-gate";
import { cancelProjectMcpAction } from "@/lib/project-mcp-action-service";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;
const id = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; actionId: string }> }) {
  if (!isProjectMcpActionApiEnabled()) return projectMcpActionApiUnavailable();
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await cancelProjectMcpAction(id.parse(params.projectId), id.parse(params.actionId), await readJsonBody(request), actor);
    return NextResponse.json(result, { status: result.created ? 201 : 200, headers: noStore });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
