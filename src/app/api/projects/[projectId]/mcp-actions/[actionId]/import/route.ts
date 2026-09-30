import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { isProjectMcpActionApiEnabled, projectMcpActionApiUnavailable } from "@/lib/project-mcp-action-api-gate";
import { importProjectMcpActionResult } from "@/lib/project-mcp-action-result-import-service";

export const dynamic = "force-dynamic";
const noStoreHeaders = { "cache-control": "private, no-store" } as const;

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string; actionId: string }> }) {
  if (!isProjectMcpActionApiEnabled()) return noStore(projectMcpActionApiUnavailable());
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const { projectId, actionId } = await context.params;
    const imported = await importProjectMcpActionResult(projectId, actionId, await readJsonBody(request), actor);
    return NextResponse.json(imported, {
      status: imported.created ? 201 : 200,
      headers: noStoreHeaders,
    });
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
