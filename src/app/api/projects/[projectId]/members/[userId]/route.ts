import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { withWebAiProjectAccessTransaction } from "@/lib/access-linearization";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  findConfirmedWorkspaceMembership,
  findCurrentProjectMembership,
  grantProjectMembership,
  revokeProjectMembership,
} from "@/lib/membership-governance";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant"), role: z.enum(["editor", "viewer"]), expectedMembershipId: idSchema.nullable(), reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ action: z.literal("revoke"), expectedMembershipId: idSchema, reason: z.string().trim().min(1).max(500) }).strict(),
]);
const headers = { "cache-control": "private, no-store" } as const;

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; userId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const { projectId: rawProjectId, userId: rawUserId } = await context.params;
    const projectId = idSchema.parse(rawProjectId);
    const userId = idSchema.parse(rawUserId);
    const input = mutationSchema.parse(await readJsonBody(request));
    const result = await withWebAiProjectAccessTransaction(getDb(), {
      actor, projectId, required: "owner", additionalActorIds: [userId],
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    }, async (tx, admission) => {
      const target = await tx.appUser.findUnique({ where: { id: userId }, select: { id: true, role: true, disabledAt: true } });
      const teamMembership = await findConfirmedWorkspaceMembership(tx, admission.workspace.id, userId);
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { membershipInheritanceMode: true } });
      const current = await findCurrentProjectMembership(tx, projectId, userId);
      if ((current?.id ?? null) !== input.expectedMembershipId) {
        throw new ApiError(409, "PROJECT_MEMBER_CONFLICT", "项目成员权限已变化，请刷新后重试");
      }
      if (current?.accessState === "pending" || current?.role === "owner") {
        throw new ApiError(409, "PROJECT_MEMBER_GOVERNANCE_REQUIRED", "待审核或 Owner 权限需通过专门治理流程处理");
      }
      if (project.membershipInheritanceMode === "workspaceInherited" && (teamMembership?.role === "owner" || teamMembership?.role === "admin")) {
        throw new ApiError(409, "PROJECT_MEMBER_INHERITED_OWNER", "团队 Owner/Admin 已继承此项目的 Owner 权限，请在团队空间管理其团队角色");
      }
      if (input.action === "revoke") {
        if (!current || current.accessState !== "confirmed") throw new ApiError(409, "PROJECT_MEMBER_CONFLICT", "项目成员权限已变化，请刷新后重试");
        await revokeProjectMembership(tx, projectId, userId, admission.workspace.id, { actorId: actor.id, reason: input.reason });
        return { membershipId: null, role: null };
      }
      if (!target || target.role !== "user" || target.disabledAt !== null || !teamMembership) {
        throw new ApiError(404, "PROJECT_MEMBER_NOT_FOUND", "该用户不是当前团队的可用成员");
      }
      const granted = await grantProjectMembership(tx, {
        projectId, workspaceId: admission.workspace.id, userId,
        role: input.role, actorId: actor.id, reason: input.reason,
      });
      return { membershipId: granted.id, role: granted.role };
    });
    return NextResponse.json(result, { headers });
  } catch (error) { return handleApiError(error); }
}
