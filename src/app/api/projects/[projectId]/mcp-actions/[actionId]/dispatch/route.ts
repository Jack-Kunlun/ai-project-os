import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { isProjectMcpActionApiEnabled, projectMcpActionApiUnavailable } from "@/lib/project-mcp-action-api-gate";
import { dispatchProjectMcpAction } from "@/lib/project-mcp-action-dispatch-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const noStore = { "cache-control": "no-store" } as const;
const id = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; actionId: string }> }) {
  if (!isProjectMcpActionApiEnabled()) return projectMcpActionApiUnavailable();
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await dispatchProjectMcpAction(id.parse(params.projectId), id.parse(params.actionId), await readJsonBody(request), actor);
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
