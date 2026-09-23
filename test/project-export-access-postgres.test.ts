import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { WebAiAccessError } from "../src/lib/access-linearization";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import { exportProjectData } from "../src/lib/project-export";

const shouldRun = process.env.PROJECT_EXPORT_ACCESS_POSTGRES_GATE === "1";

test("project export service admits only a current active Owner before reading or auditing", {
  skip: !shouldRun ? "PROJECT_EXPORT_ACCESS_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const owner = await db.appUser.create({ data: { username: `export_owner_${suffix}`, role: "user" } });
  const viewer = await db.appUser.create({ data: { username: `export_viewer_${suffix}`, role: "user" } });
  const editor = await db.appUser.create({ data: { username: `export_editor_${suffix}`, role: "user" } });
  const outsider = await db.appUser.create({ data: { username: `export_outsider_${suffix}`, role: "user" } });
  const disabledOwner = await db.appUser.create({ data: { username: `export_disabled_${suffix}`, role: "user", disabledAt: new Date() } });
  const userIds = [owner.id, viewer.id, editor.id, outsider.id, disabledOwner.id];

  try {
    const project = await db.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: `Export ${suffix}`, slug: `export-${suffix}`, createdById: owner.id } });
      const created = await tx.project.create({ data: { id: projectId, workspaceId, name: `Export ${suffix}`, slug: `export-${suffix}` } });
      for (const [user, role] of [[owner, "owner"], [viewer, "viewer"], [editor, "member"]] as const) {
        await grantWorkspaceMembership(tx, { workspaceId, userId: user.id, role, actorId: owner.id, reason: "project_export_access_gate" });
      }
      for (const [user, role] of [[owner, "owner"], [viewer, "viewer"], [editor, "editor"], [disabledOwner, "owner"]] as const) {
        await grantProjectMembership(tx, { projectId, workspaceId, userId: user.id, role, actorId: owner.id, reason: "project_export_access_gate" });
      }
      return created;
    });

    for (const actor of [viewer, editor, outsider, disabledOwner]) {
      await assert.rejects(
        () => exportProjectData({ projectId, actor, expectedUpdatedAt: project.updatedAt }, db),
        (error: unknown) => error instanceof WebAiAccessError && ["ACCESS_FORBIDDEN", "ACCOUNT_DISABLED"].includes(error.code),
      );
    }
    assert.equal(await db.projectDataExportAudit.count({ where: { projectId } }), 0);

    const exported = await exportProjectData({ projectId, actor: owner, expectedUpdatedAt: project.updatedAt }, db);
    assert.equal(exported.audit.byteCount, Buffer.byteLength(exported.json, "utf8"));
    assert.equal(await db.projectDataExportAudit.count({ where: { projectId } }), 1);
  } finally {
    await db.project.deleteMany({ where: { id: projectId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.appUser.deleteMany({ where: { id: { in: userIds } } });
  }
});
