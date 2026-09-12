import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { executeWorkspaceRoleMutation } from "@/lib/workspace-role-governance-service";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const bodySchema = z.object({
  previewId: z.string().uuid(),
  currentRole: z.enum(["owner", "admin", "member", "viewer"]),
  targetRole: z.enum(["owner", "admin", "member", "viewer"]),
  reason: z.string().trim().min(1).max(500),
  requestKey: z.string().trim().min(8).max(180),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  expectedImpactFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  expectedOwnerCount: z.number().int().nonnegative().optional(),
  expectedProjectGrantCount: z.number().int().nonnegative().optional(),
  expectedProjectGrantFingerprint: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  expectedMembershipFingerprint: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  previewIssuedAt: z.union([z.string(), z.date()]),
  previewExpiresAt: z.union([z.string(), z.date()]),
  confirmation: z.literal(true),
  confirmationUsername: z.string().min(1).max(64),
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
    const result = await executeWorkspaceRoleMutation({
      ...body,
      workspaceId,
      subjectId,
      actorId: actor.id,
      actorAccountAccessVersion: actor.accountAccessVersion,
    });
    return noStore(NextResponse.json({ result }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
