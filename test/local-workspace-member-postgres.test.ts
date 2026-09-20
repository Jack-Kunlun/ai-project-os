import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { grantWorkspaceMembership } from "../src/lib/membership-governance";
import { lockActorsAccess, lockWorkspaceAccess } from "../src/lib/access-linearization";
import { WorkspaceError, createLocalWorkspaceMember } from "../src/lib/workspaces";

const shouldRun = process.env.LOCAL_WORKSPACE_MEMBER_POSTGRES_GATE === "1";

test(
  "local workspace provisioning creates an isolated personal owner workspace atomically",
  { skip: !shouldRun ? "LOCAL_WORKSPACE_MEMBER_POSTGRES_GATE=1 is required" : false },
  async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
      throw new Error("LOCAL_WORKSPACE_MEMBER_DATABASE_URL_REQUIRED");
    }

    const db = getDb();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const adminId = randomUUID();
    const workspaceId = randomUUID();
    const username = `local_member_${suffix}`;
    const admin: { id: string; role: "user"; accountAccessVersion: number } = {
      id: adminId,
      role: "user",
      accountAccessVersion: 1,
    };

    await db.appUser.create({ data: { id: adminId, username: `local_owner_${suffix}`, role: "user" } });
    await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [adminId]);
      await lockWorkspaceAccess(tx, workspaceId);
      await tx.workspace.create({ data: { id: workspaceId, name: `Local target ${suffix}`, slug: `local-target-${suffix}`, createdById: adminId } });
      await grantWorkspaceMembership(tx, {
        workspaceId,
        userId: adminId,
        role: "owner",
        actorId: adminId,
        reason: "local_workspace_member_gate_admin_fixture",
      });
    });

    const created = await createLocalWorkspaceMember(
      workspaceId,
      { username, password: "ValidPassword123", displayName: "Local member", email: `${username}@example.com` },
      admin,
      db,
    );
    const user = await db.appUser.findUniqueOrThrow({ where: { username } });
    const personalWorkspace = await db.workspace.findUniqueOrThrow({ where: { slug: `user-${user.id}` } });
    const memberships = await db.workspaceMembership.findMany({
      where: { userId: user.id, accessState: "confirmed" },
      orderBy: { createdAt: "asc" },
    });
    const personalMembership = memberships.find((membership) => membership.workspaceId === personalWorkspace.id && membership.role === "owner");
    const ownerAudit = await db.membershipAccessAudit.findFirst({
      where: { membershipKind: "workspace", membershipId: personalMembership?.id, action: "confirmed" },
    });

    assert.equal(created.user.id, user.id);
    assert.equal(personalWorkspace.createdById, user.id);
    assert.equal(personalWorkspace.slug, `user-${user.id}`);
    assert.equal(memberships.length, 2);
    assert.ok(personalMembership);
    assert.ok(memberships.some((membership) => membership.workspaceId === workspaceId && membership.role === "member"));
    assert.equal(ownerAudit?.actorId, user.id);
    assert.equal(ownerAudit?.reason, "local_member_personal_workspace_created");

    const beforeWorkspaceCount = await db.workspace.count({ where: { createdById: user.id } });
    await assert.rejects(
      () => createLocalWorkspaceMember(
        workspaceId,
        { username, password: "ValidPassword123", displayName: null, email: `duplicate-${username}@example.com` },
        admin,
        db,
      ),
      (error: unknown) => error instanceof WorkspaceError && error.code === "WORKSPACE_MEMBER_CONFLICT",
    );
    assert.equal(await db.workspace.count({ where: { createdById: user.id } }), beforeWorkspaceCount);
    assert.equal(await db.appUser.count({ where: { username } }), 1);
  },
);
