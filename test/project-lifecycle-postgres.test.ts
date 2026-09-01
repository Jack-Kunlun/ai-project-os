import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDb } from "../src/lib/db";
import {
  assertProjectActive,
  deleteArchivedProject,
  ProjectLifecycleError,
  updateProjectLifecycle,
} from "../src/lib/project-lifecycle";
import { exportProjectData } from "../src/lib/project-export";
import { getProjectUsageSummary } from "../src/lib/project-usage";
import { hashSourceContent } from "../src/lib/source";

const shouldRun = process.env.PROJECT_LIFECYCLE_POSTGRES_GATE === "1";

test(
  "PostgreSQL preserves audited archive and restore boundaries",
  { skip: !shouldRun ? "PROJECT_LIFECYCLE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const projectId = randomUUID();
    const assetDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-project-delete-"));
    const previousAssetDirectory = process.env.AI_PROJECT_OS_ASSET_DIR;
    process.env.AI_PROJECT_OS_ASSET_DIR = assetDirectory;
    let createdUserId: string | null = null;
    const user = await db.appUser.create({
      data: {
        username: `lifecycle_${suffix}`,
        role: "admin",
        passwordHash: "a".repeat(43),
        passwordSalt: "b".repeat(22),
        passwordVersion: 1,
      },
    });
    createdUserId = user.id;

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
      const sourceText = "exported project evidence";
      const sourceHash = hashSourceContent(sourceText);
      await db.projectSource.create({
        data: {
          projectId,
          kind: "manual",
          originScope: "project",
          contentText: sourceText,
          contentHash: sourceHash,
          manualContentDedupeKey: sourceHash,
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
      assert.equal(document.schemaVersion, "ai-project-os.project-export.v3");
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

      const archivedAgain = await updateProjectLifecycle({
        projectId,
        actorId: user.id,
        action: "archive",
        expectedUpdatedAt: restored.project.updatedAt,
      }, db);
      await assert.rejects(
        () => deleteArchivedProject({
          projectId,
          actorId: user!.id,
          confirmationName: "wrong project",
          expectedUpdatedAt: archivedAgain.project.updatedAt,
        }, db),
        (error: unknown) => error instanceof ProjectLifecycleError && error.code === "PROJECT_DELETE_CONFIRMATION_MISMATCH",
      );

      const reservation = await db.projectAssetUploadReservation.create({
        data: {
          projectId,
          workspaceId: created.workspaceId,
          userId: user.id,
          storageKey: `${projectId}/${randomUUID()}/${randomUUID()}/original`,
          sizeBytes: BigInt(64),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await assert.rejects(
        () => deleteArchivedProject({
          projectId,
          actorId: user!.id,
          confirmationName: created.name,
          expectedUpdatedAt: archivedAgain.project.updatedAt,
        }, db),
        (error: unknown) => error instanceof ProjectLifecycleError && error.code === "PROJECT_DELETE_ACTIVE_UPLOAD",
      );
      await db.projectAssetUploadReservation.delete({ where: { id: reservation.id } });

      const storedProjectDirectory = join(assetDirectory, projectId);
      await mkdir(storedProjectDirectory, { recursive: true });
      await writeFile(join(storedProjectDirectory, "deletion-proof.txt"), "delete only after database commit", "utf8");
      const deleted = await deleteArchivedProject({
        projectId,
        actorId: user.id,
        confirmationName: created.name,
        expectedUpdatedAt: archivedAgain.project.updatedAt,
      }, db);
      assert.equal(deleted.storageCleanupStatus, "completed");
      assert.equal(await db.project.count({ where: { id: projectId } }), 0);
      assert.equal(await db.projectLifecycleRevision.count({ where: { projectId } }), 0);
      assert.equal(await db.projectDataExportAudit.count({ where: { projectId } }), 0);
      await assert.rejects(() => access(storedProjectDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      const receipt = await db.projectDeletionReceipt.findUniqueOrThrow({ where: { id: deleted.receiptId } });
      assert.equal(receipt.deletedProjectId, projectId);
      assert.equal(receipt.status, "completed");
      assert.equal(receipt.storageStaged, true);
      assert.equal(receipt.projectFingerprint.length, 64);
      await assert.rejects(() => db.projectDeletionReceipt.delete({ where: { id: receipt.id } }));
      await db.appUser.delete({ where: { id: user.id } });
      createdUserId = null;
      assert.equal((await db.projectDeletionReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).requestedById, null);
    } finally {
      await db.project.deleteMany({ where: { id: projectId } });
      if (createdUserId !== null) await db.appUser.deleteMany({ where: { id: createdUserId } });
      if (previousAssetDirectory === undefined) delete process.env.AI_PROJECT_OS_ASSET_DIR;
      else process.env.AI_PROJECT_OS_ASSET_DIR = previousAssetDirectory;
      await rm(assetDirectory, { recursive: true, force: true });
    }
  },
);
