import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { revokeProjectMcpToolGrant } from "@/lib/mcp";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; grantId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    await assertProjectActive(projectId);
    return NextResponse.json({ grant: await revokeProjectMcpToolGrant(projectId, idSchema.parse(params.grantId), await readJsonBody(request), user) });
  } catch (error) {
    return handleApiError(error);
  }
}
