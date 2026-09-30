import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { isProjectMcpActionApiEnabled, projectMcpActionApiUnavailable } from "@/lib/project-mcp-action-api-gate";
import { getProjectMcpAction } from "@/lib/project-mcp-action-service";

export const dynamic = "force-dynamic";
const noStore = { "cache-control": "no-store" } as const;
const id = z.string().uuid();

export async function GET(request: Request, context: { params: Promise<{ projectId: string; actionId: string }> }) {
  if (!isProjectMcpActionApiEnabled()) return projectMcpActionApiUnavailable();
  try {
    const actor = await requireApiSession(request);
    const params = await context.params;
    return NextResponse.json(await getProjectMcpAction(id.parse(params.projectId), id.parse(params.actionId), actor), { headers: noStore });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
