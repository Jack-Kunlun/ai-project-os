import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { cancelProjectMcpAction } from "@/lib/project-mcp-action-service";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const noStore = { "cache-control": "no-store" } as const;

export async function POST(request: Request, context: { params: Promise<{ projectId: string; actionId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    return NextResponse.json(
      await cancelProjectMcpAction(idSchema.parse(params.projectId), idSchema.parse(params.actionId), await readJsonBody(request), actor),
      { headers: noStore },
    );
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
