import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getProjectMcpAction } from "@/lib/project-mcp-action-service";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const noStore = { "cache-control": "no-store" } as const;

export async function GET(request: Request, context: { params: Promise<{ projectId: string; actionId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    const actionId = idSchema.parse(params.actionId);
    return NextResponse.json(await getProjectMcpAction(projectId, actionId, actor), { headers: noStore });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
