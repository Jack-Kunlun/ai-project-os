import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { revokeProjectMcpToolGrantV2 } from "@/lib/project-mcp-tool-grant-service";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const noStore = { "cache-control": "no-store" } as const;

export async function POST(request: Request, context: { params: Promise<{ projectId: string; grantId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    const grantId = idSchema.parse(params.grantId);
    return NextResponse.json(await revokeProjectMcpToolGrantV2(projectId, grantId, await readJsonBody(request), actor), { headers: noStore });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
