import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { isProjectMcpActionApiEnabled, projectMcpActionApiUnavailable } from "@/lib/project-mcp-action-api-gate";
import { listProjectMcpActions, proposeProjectMcpAction } from "@/lib/project-mcp-action-service";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;
const id = z.string().uuid();
type Context = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: Context) {
  if (!isProjectMcpActionApiEnabled()) return projectMcpActionApiUnavailable();
  try {
    const actor = await requireApiSession(request);
    return NextResponse.json(await listProjectMcpActions(id.parse((await context.params).projectId), actor), { headers: noStore });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}

export async function POST(request: Request, context: Context) {
  if (!isProjectMcpActionApiEnabled()) return projectMcpActionApiUnavailable();
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const result = await proposeProjectMcpAction(id.parse((await context.params).projectId), await readJsonBody(request), actor);
    return NextResponse.json(result, { status: result.created ? 201 : 200, headers: noStore });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
