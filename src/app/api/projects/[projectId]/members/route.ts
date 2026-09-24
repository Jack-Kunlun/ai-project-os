import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { withWebAiProjectAccessTransaction } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { findConfirmedWorkspaceMembership } from "@/lib/membership-governance";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const headers = { "cache-control": "private, no-store" } as const;

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const projectId = idSchema.parse((await context.params).projectId);
    const result = await withWebAiProjectAccessTransaction(getDb(), {
      actor, projectId, required: "view", allowArchived: true,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    }, async (tx, admission) => {
      const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, membershipInheritanceMode: true } });
      const canManage = admission.permission === "owner" && admission.project.archivedAt === null;
      const actorWorkspaceMembership = await findConfirmedWorkspaceMembership(tx, admission.workspace.id, actor.id);
      const canManageWorkspace = actorWorkspaceMembership?.role === "owner" || actorWorkspaceMembership?.role === "admin";
      const memberships = canManage
        ? await tx.workspaceMembership.findMany({
          where: { workspaceId: admission.workspace.id, accessState: "confirmed", user: { disabledAt: null, role: "user" } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 201,
          select: { userId: true, role: true, user: { select: { username: true, displayName: true } } },
        })
        : [];
      const grants = await tx.projectMembership.findMany({
        where: { projectId, accessState: "confirmed" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, userId: true, role: true, user: { select: { username: true, displayName: true, disabledAt: true } } },
      });
      const grantByUser = new Map(grants.map((row) => [row.userId, row]));
      const teamMemberByUser = new Map(memberships.map((row) => [row.userId, row]));
      const visibleMembers = canManage ? [
        ...grants.map((row) => ({
          userId: row.userId, username: row.user.username, displayName: row.user.displayName,
          workspaceRole: teamMemberByUser.get(row.userId)?.role ?? null,
          membershipId: row.id, projectRole: row.role,
          inheritedOwner: project.membershipInheritanceMode === "workspaceInherited" && ["owner", "admin"].includes(teamMemberByUser.get(row.userId)?.role ?? ""),
          canGrant: teamMemberByUser.has(row.userId) && row.user.disabledAt === null
            && !(project.membershipInheritanceMode === "workspaceInherited" && ["owner", "admin"].includes(teamMemberByUser.get(row.userId)?.role ?? "")),
        })),
        ...memberships.slice(0, 200).filter((row) => !grantByUser.has(row.userId)).map((row) => ({
          userId: row.userId, username: row.user.username, displayName: row.user.displayName,
          workspaceRole: row.role, membershipId: null, projectRole: null,
          inheritedOwner: project.membershipInheritanceMode === "workspaceInherited" && (row.role === "owner" || row.role === "admin"),
          canGrant: !(project.membershipInheritanceMode === "workspaceInherited" && (row.role === "owner" || row.role === "admin")),
        })),
      ] : grants.map((row) => ({
        userId: row.userId, username: row.user.username, displayName: row.user.displayName,
        workspaceRole: null, membershipId: row.id, projectRole: row.role,
        inheritedOwner: false,
        canGrant: false,
      }));
      return {
        project: { id: projectId, name: project.name, workspaceId: admission.workspace.id, membershipInheritanceMode: project.membershipInheritanceMode },
        canManage,
        canManageWorkspace,
        members: visibleMembers,
        truncated: canManage && memberships.length > 200,
      };
    });
    return NextResponse.json(result, { headers });
  } catch (error) { return handleApiError(error); }
}
