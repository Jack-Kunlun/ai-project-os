import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { previewWorkspaceRoleMutation } from "@/lib/workspace-role-governance-service";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const bodySchema = z.object({
  targetRole: z.enum(["owner", "admin", "member", "viewer"]),
  reason: z.string().trim().min(1).max(500),
  requestKey: z.string().trim().min(8).max(180),
}).strict();

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; userId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const body = bodySchema.parse(await readJsonBody(request));
    const workspaceId = idSchema.parse(params.workspaceId);
    const subjectId = idSchema.parse(params.userId);
    const preview = await previewWorkspaceRoleMutation({
      workspaceId,
      subjectId,
      actorId: actor.id,
      actorAccountAccessVersion: actor.accountAccessVersion,
      targetRole: body.targetRole,
      reason: body.reason,
      requestKey: body.requestKey,
    });
    return noStore(NextResponse.json({ preview }, { status: 201 }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
