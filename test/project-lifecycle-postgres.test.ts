import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import {
  assertProjectActive,
  ProjectLifecycleError,
  updateProjectLifecycle,
} from "../src/lib/project-lifecycle";
import { exportProjectData } from "../src/lib/project-export";
import { getProjectUsageSummary } from "../src/lib/project-usage";

const shouldRun = process.env.PROJECT_LIFECYCLE_POSTGRES_GATE === "1";

test(
  "PostgreSQL preserves audited archive and restore boundaries",
  { skip: !shouldRun ? "PROJECT_LIFECYCLE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const projectId = randomUUID();
    let createdUserId: string | null = null;
    let user = await db.appUser.findFirst({ where: { role: "admin" } });
    if (user === null) {
      user = await db.appUser.create({
        data: {
          username: `lifecycle_${suffix}`,
          role: "admin",
          passwordHash: "a".repeat(43),
          passwordSalt: "b".repeat(22),
          passwordVersion: 1,
        },
      });
      createdUserId = user.id;
    }

    try {
      const created = await db.project.create({
        data: { id: projectId, name: `Lifecycle ${suffix}`, slug: `lifecycle-${suffix}` },
      });
      await assert.rejects(
        () => updateProjectLifecycle({
          projectId,
          actorId: user!.id,
          action: "archive",
          expectedUpdatedAt: new Date(created.updatedAt.getTime() - 1),
        }, db),
        (error: unknown) => error instanceof ProjectLifecycleError && error.code === "PROJECT_LIFECYCLE_STALE",
      );

      const job = await db.backgroundJob.create({
        data: {
          projectId,
          kind: "projectBrief",
          requestedById: user.id,
          idempotencyKey: `${"a".repeat(56)}${suffix}`,
          payload: {},
        },
      });
      await assert.rejects(
        () => updateProjectLifecycle({ projectId, actorId: user!.id, action: "archive", expectedUpdatedAt: created.updatedAt }, db),
        (error: unknown) => error instanceof ProjectLifecycleError && error.code === "PROJECT_HAS_UNRESOLVED_JOBS",
      );
      await db.backgroundJob.update({
        where: { id: job.id },
        data: { status: "cancelled", stage: "cancelled", completedAt: new Date() },
      });
      await db.projectSource.create({
        data: {
          projectId,
          kind: "manual",
          originScope: "project",
          contentText: "exported project evidence",
          contentHash: "c".repeat(64),
          manualContentDedupeKey: "c".repeat(64),
        },
      });

      const archived = await updateProjectLifecycle({
        projectId,
        actorId: user.id,
        action: "archive",
        expectedUpdatedAt: created.updatedAt,
      }, db);
      assert.notEqual(archived.project.archivedAt, null);
      assert.equal(archived.revision.action, "archived");
      await assert.rejects(
        () => assertProjectActive(projectId, db),
        (error: unknown) => error instanceof ProjectLifecycleError && error.code === "PROJECT_ARCHIVED",
      );
      const archivedRevision = await db.projectLifecycleRevision.findUniqueOrThrow({ where: { id: archived.revision.id } });
      assert.equal(archivedRevision.currentArchivedAt?.getTime(), archived.project.archivedAt?.getTime());
      await assert.rejects(() => db.projectLifecycleRevision.update({
        where: { id: archivedRevision.id },
        data: { projectUpdatedAt: new Date() },
      }));
      await assert.rejects(() => db.projectLifecycleRevision.delete({ where: { id: archivedRevision.id } }));

      const exported = await exportProjectData({
        projectId,
        requestedById: user.id,
        expectedUpdatedAt: archived.project.updatedAt,
      }, db);
      const document = JSON.parse(exported.json) as {
        schemaVersion: string;
        project: { archivedAt: string | null };
        sources: Array<{ contentText: string }>;
        exclusions: string[];
      };
      assert.equal(document.schemaVersion, "ai-project-os.project-export.v1");
      assert.notEqual(document.project.archivedAt, null);
      assert.equal(document.sources[0]?.contentText, "exported project evidence");
      assert.equal(exported.audit.byteCount, Buffer.byteLength(exported.json, "utf8"));
      assert.equal(exported.audit.contentHash.length, 64);
      await assert.rejects(() => db.projectDataExportAudit.update({
        where: { id: exported.audit.id },
        data: { byteCount: exported.audit.byteCount + 1 },
      }));
      await assert.rejects(() => db.projectDataExportAudit.delete({ where: { id: exported.audit.id } }));
      await assert.rejects(() => db.backgroundJob.create({
        data: {
          projectId,
          kind: "projectBrief",
          requestedById: user!.id,
          idempotencyKey: `${"b".repeat(56)}${suffix}`,
          payload: {},
        },
      }));

      const restored = await updateProjectLifecycle({
        projectId,
        actorId: user.id,
        action: "restore",
        expectedUpdatedAt: archived.project.updatedAt,
      }, db);
      assert.equal(restored.project.archivedAt, null);
      assert.equal(restored.revision.action, "restored");
      await assertProjectActive(projectId, db);
      assert.equal(await db.projectLifecycleRevision.count({ where: { projectId } }), 2);
      const usage = await getProjectUsageSummary(projectId, 30, db);
      assert.ok(usage);
      assert.equal(usage.totals.requestCount, 0);
      assert.equal(usage.totals.totalTokens, 0);

      await db.project.delete({ where: { id: projectId } });
      assert.equal(await db.projectLifecycleRevision.count({ where: { projectId } }), 0);
      assert.equal(await db.projectDataExportAudit.count({ where: { projectId } }), 0);
    } finally {
      await db.project.deleteMany({ where: { id: projectId } });
      if (createdUserId !== null) await db.appUser.deleteMany({ where: { id: createdUserId } });
    }
  },
);
