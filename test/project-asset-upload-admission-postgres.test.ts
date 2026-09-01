import "dotenv/config";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { getDb } from "../src/lib/db";
import { acquireUploadAdmission, releaseUploadAdmission, UploadAdmissionError } from "../src/lib/project-assets/admission";
import { assetBlobStorageKey, assetContentHash, removeAssetBlob, writeAssetBlob } from "../src/lib/project-assets/storage";
import {
  createProjectAssetUploadReservation,
  getProjectAssetUploadUsage,
  reconcileStaleProjectAssetUploadReservations,
  UploadQuotaError,
} from "../src/lib/project-assets/quota";
import {
  deleteProjectAsset,
  retryProjectAssetLocalExtraction,
  runProjectAssetParsingWorkerCycle,
  uploadProjectAsset,
} from "../src/lib/project-assets/service";

const shouldRun = process.env.PROJECT_ASSET_UPLOAD_POSTGRES_GATE === "1";

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else files.push(child);
  }
  return files;
}

test(
  "durable upload admission serializes concurrent requests and counts rejected attempts",
  { skip: !shouldRun ? "PROJECT_ASSET_UPLOAD_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const user = await db.appUser.create({ data: { username: `upload_gate_${suffix}` } });
    const workspace = await db.workspace.create({ data: { name: `Upload gate ${suffix}`, slug: `upload-gate-${suffix}`, createdById: user.id } });
    const project = await db.project.create({ data: { name: `Upload gate ${suffix}`, slug: `upload-project-${suffix}`, workspaceId: workspace.id } });
    const previousRate = process.env.AI_PROJECT_OS_UPLOAD_MAX_UPLOADS_PER_MINUTE;
    const previousConcurrent = process.env.AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT;
    process.env.AI_PROJECT_OS_UPLOAD_MAX_UPLOADS_PER_MINUTE = "2";
    process.env.AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT = "1";
    let admissionId: string | null = null;
    try {
      const concurrent = await Promise.allSettled([
        acquireUploadAdmission({ projectId: project.id, userId: user.id }, db),
        acquireUploadAdmission({ projectId: project.id, userId: user.id }, db),
      ]);
      const fulfilled = concurrent.filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled");
      const rejected = concurrent.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0]?.reason instanceof UploadAdmissionError, true);
      assert.equal((rejected[0]?.reason as UploadAdmissionError).code, "UPLOAD_CONCURRENCY_LIMITED");
      admissionId = fulfilled[0]!.value;
      await releaseUploadAdmission(admissionId, db);
      admissionId = null;
      await assert.rejects(
        () => acquireUploadAdmission({ projectId: project.id, userId: user.id }, db),
        (error: unknown) => error instanceof UploadAdmissionError && error.code === "UPLOAD_RATE_LIMITED",
      );
      assert.equal(await db.projectAssetUploadAdmission.count({ where: { userId: user.id } }), 3);
    } finally {
      if (admissionId !== null) await releaseUploadAdmission(admissionId, db);
      if (previousRate === undefined) delete process.env.AI_PROJECT_OS_UPLOAD_MAX_UPLOADS_PER_MINUTE;
      else process.env.AI_PROJECT_OS_UPLOAD_MAX_UPLOADS_PER_MINUTE = previousRate;
      if (previousConcurrent === undefined) delete process.env.AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT;
      else process.env.AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT = previousConcurrent;
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.appUser.delete({ where: { id: user.id } });
    }
  },
);

test(
  "quota rejection creates no reservation and writes no blob",
  { skip: !shouldRun ? "PROJECT_ASSET_UPLOAD_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const user = await db.appUser.create({ data: { username: `quota_gate_${suffix}` } });
    const workspace = await db.workspace.create({ data: { name: `Quota gate ${suffix}`, slug: `quota-gate-${suffix}`, createdById: user.id } });
    const project = await db.project.create({ data: { name: `Quota gate ${suffix}`, slug: `quota-project-${suffix}`, workspaceId: workspace.id } });
    const assetRoot = await mkdtemp(path.join(os.tmpdir(), `ai-project-os-upload-quota-${suffix}-`));
    const previousRoot = process.env.AI_PROJECT_OS_ASSET_DIR;
    const previousProjectBytes = process.env.AI_PROJECT_OS_UPLOAD_MAX_PROJECT_BYTES;
    process.env.AI_PROJECT_OS_ASSET_DIR = assetRoot;
    process.env.AI_PROJECT_OS_UPLOAD_MAX_PROJECT_BYTES = "1";
    try {
      await assert.rejects(
        () => uploadProjectAsset({ projectId: project.id, requestedBy: user, fileName: "quota.md", buffer: Buffer.from("quota test", "utf8") }, db),
        (error: unknown) => error instanceof UploadQuotaError && error.code === "PROJECT_ASSET_PROJECT_QUOTA_EXCEEDED",
      );
      assert.equal(await db.projectAsset.count({ where: { projectId: project.id } }), 0);
      assert.equal(await db.projectAssetUploadReservation.count({ where: { projectId: project.id } }), 0);
      assert.deepEqual(await filesUnder(assetRoot), []);
    } finally {
      if (previousRoot === undefined) delete process.env.AI_PROJECT_OS_ASSET_DIR;
      else process.env.AI_PROJECT_OS_ASSET_DIR = previousRoot;
      if (previousProjectBytes === undefined) delete process.env.AI_PROJECT_OS_UPLOAD_MAX_PROJECT_BYTES;
      else process.env.AI_PROJECT_OS_UPLOAD_MAX_PROJECT_BYTES = previousProjectBytes;
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.appUser.delete({ where: { id: user.id } });
      await rm(assetRoot, { recursive: true, force: true });
    }
  },
);

test(
  "deployment-wide admission serializes different users before body buffering",
  { skip: !shouldRun ? "PROJECT_ASSET_UPLOAD_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const users = await Promise.all([
      db.appUser.create({ data: { username: `global_upload_a_${suffix}` } }),
      db.appUser.create({ data: { username: `global_upload_b_${suffix}` } }),
    ]);
    const workspace = await db.workspace.create({ data: { name: `Global upload ${suffix}`, slug: `global-upload-${suffix}`, createdById: users[0]!.id } });
    const project = await db.project.create({ data: { name: `Global upload ${suffix}`, slug: `global-upload-project-${suffix}`, workspaceId: workspace.id } });
    const previousUserConcurrent = process.env.AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT;
    const previousGlobalConcurrent = process.env.AI_PROJECT_OS_UPLOAD_MAX_GLOBAL_CONCURRENT;
    process.env.AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT = "1";
    process.env.AI_PROJECT_OS_UPLOAD_MAX_GLOBAL_CONCURRENT = "1";
    let admissionId: string | null = null;
    try {
      const results = await Promise.allSettled(users.map((user) =>
        acquireUploadAdmission({ projectId: project.id, userId: user.id }, db)));
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled");
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0]?.reason instanceof UploadAdmissionError, true);
      assert.equal((rejected[0]?.reason as UploadAdmissionError).code, "UPLOAD_GLOBAL_CONCURRENCY_LIMITED");
      admissionId = fulfilled[0]!.value;
    } finally {
      if (admissionId !== null) await releaseUploadAdmission(admissionId, db);
      if (previousUserConcurrent === undefined) delete process.env.AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT;
      else process.env.AI_PROJECT_OS_UPLOAD_MAX_CONCURRENT = previousUserConcurrent;
      if (previousGlobalConcurrent === undefined) delete process.env.AI_PROJECT_OS_UPLOAD_MAX_GLOBAL_CONCURRENT;
      else process.env.AI_PROJECT_OS_UPLOAD_MAX_GLOBAL_CONCURRENT = previousGlobalConcurrent;
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.appUser.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    }
  },
);

test(
  "retained-object quota counts soft-deleted blobs and rejects before writing",
  { skip: !shouldRun ? "PROJECT_ASSET_UPLOAD_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const user = await db.appUser.create({ data: { username: `retained_gate_${suffix}` } });
    const workspace = await db.workspace.create({ data: { name: `Retained gate ${suffix}`, slug: `retained-gate-${suffix}`, createdById: user.id } });
    const project = await db.project.create({ data: { name: `Retained gate ${suffix}`, slug: `retained-project-${suffix}`, workspaceId: workspace.id } });
    const assetRoot = await mkdtemp(path.join(os.tmpdir(), `ai-project-os-retained-${suffix}-`));
    const previous = {
      root: process.env.AI_PROJECT_OS_ASSET_DIR,
      assets: process.env.AI_PROJECT_OS_UPLOAD_MAX_PROJECT_ASSETS,
      project: process.env.AI_PROJECT_OS_UPLOAD_MAX_PROJECT_RETAINED_OBJECTS,
      workspace: process.env.AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_RETAINED_OBJECTS,
      deployment: process.env.AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_RETAINED_OBJECTS,
    };
    process.env.AI_PROJECT_OS_ASSET_DIR = assetRoot;
    process.env.AI_PROJECT_OS_UPLOAD_MAX_PROJECT_ASSETS = "1";
    process.env.AI_PROJECT_OS_UPLOAD_MAX_PROJECT_RETAINED_OBJECTS = "1";
    process.env.AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_RETAINED_OBJECTS = "1";
    process.env.AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_RETAINED_OBJECTS = "1";
    try {
      const first = await uploadProjectAsset({
        projectId: project.id,
        requestedBy: user,
        fileName: "retained-one.md",
        buffer: Buffer.from("first retained object", "utf8"),
      }, db);
      assert.ok(first);
      await deleteProjectAsset(project.id, first!.id, db);
      const usage = await getProjectAssetUploadUsage(project.id, db);
      assert.equal(usage.activeAssetCount, 0);
      assert.equal(usage.projectRetainedObjectCount, 1);
      const filesBefore = await filesUnder(assetRoot);
      await assert.rejects(
        () => uploadProjectAsset({
          projectId: project.id,
          requestedBy: user,
          fileName: "retained-two.md",
          buffer: Buffer.from("second retained object", "utf8"),
        }, db),
        (error: unknown) => error instanceof UploadQuotaError && error.code === "PROJECT_ASSET_PROJECT_RETAINED_OBJECTS_EXCEEDED",
      );
      assert.deepEqual(await filesUnder(assetRoot), filesBefore);
      assert.equal(await db.projectAssetUploadReservation.count({ where: { projectId: project.id } }), 0);
    } finally {
      const restore = (name: keyof typeof previous, variable: string) => {
        if (previous[name] === undefined) delete process.env[variable];
        else process.env[variable] = previous[name];
      };
      restore("root", "AI_PROJECT_OS_ASSET_DIR");
      restore("assets", "AI_PROJECT_OS_UPLOAD_MAX_PROJECT_ASSETS");
      restore("project", "AI_PROJECT_OS_UPLOAD_MAX_PROJECT_RETAINED_OBJECTS");
      restore("workspace", "AI_PROJECT_OS_UPLOAD_MAX_WORKSPACE_RETAINED_OBJECTS");
      restore("deployment", "AI_PROJECT_OS_UPLOAD_MAX_DEPLOYMENT_RETAINED_OBJECTS");
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.appUser.delete({ where: { id: user.id } });
      await rm(assetRoot, { recursive: true, force: true });
    }
  },
);

test(
  "durable local parsing processes queued work, recovers an expired lease and supports manual retry",
  { skip: !shouldRun ? "PROJECT_ASSET_UPLOAD_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const user = await db.appUser.create({ data: { username: `parse_queue_${suffix}` } });
    const workspace = await db.workspace.create({ data: { name: `Parse queue ${suffix}`, slug: `parse-queue-${suffix}`, createdById: user.id } });
    const project = await db.project.create({ data: { name: `Parse queue ${suffix}`, slug: `parse-queue-project-${suffix}`, workspaceId: workspace.id } });
    const assetRoot = await mkdtemp(path.join(os.tmpdir(), `ai-project-os-parse-queue-${suffix}-`));
    const previousRoot = process.env.AI_PROJECT_OS_ASSET_DIR;
    const previousLease = process.env.AI_PROJECT_OS_UPLOAD_PARSE_LEASE_MS;
    process.env.AI_PROJECT_OS_ASSET_DIR = assetRoot;
    process.env.AI_PROJECT_OS_UPLOAD_PARSE_LEASE_MS = "1000";

    async function seedLocalRun(status: "queued" | "running" | "failed", label: string) {
      const assetId = randomUUID();
      const versionId = randomUUID();
      const runId = randomUUID();
      const buffer = Buffer.from(`${label} durable local parse`, "utf8");
      const storageKey = assetBlobStorageKey(project.id, assetId, versionId);
      await writeAssetBlob({ projectId: project.id, assetId, versionId, buffer });
      const startedAt = status === "running" ? new Date(Date.now() - 60_000) : null;
      await db.projectAsset.create({
        data: {
          id: assetId,
          projectId: project.id,
          displayName: `${label}.md`,
          kind: "text",
          status: status === "queued" ? "uploaded" : status === "running" ? "parsing" : "failed",
          uploadedById: user.id,
          versions: {
            create: {
              id: versionId,
              originalFileName: `${label}.md`,
              mimeType: "text/markdown",
              sizeBytes: BigInt(buffer.length),
              contentHash: assetContentHash(buffer),
              storageKey,
              status: status === "queued" ? "staged" : status === "running" ? "processing" : "failed",
              processingStartedAt: startedAt,
              failureCode: status === "failed" ? "ASSET_DOCUMENT_INVALID" : null,
            },
          },
        },
      });
      await db.projectAssetExtractionRun.create({
        data: {
          id: runId,
          projectId: project.id,
          projectAssetId: assetId,
          projectAssetVersionId: versionId,
          status,
          inputManifestFingerprint: assetContentHash(buffer),
          startedAt,
          leaseToken: status === "running" ? randomUUID() : null,
          attemptCount: status === "running" ? 1 : 0,
          failureCode: status === "failed" ? "ASSET_DOCUMENT_INVALID" : null,
          completedAt: status === "failed" ? new Date() : null,
        },
      });
      return { assetId, versionId, runId };
    }

    try {
      const queued = await seedLocalRun("queued", "queued");
      const stale = await seedLocalRun("running", "stale");
      const cycle = await runProjectAssetParsingWorkerCycle({ maximumRuns: 5 }, db);
      assert.equal(cycle.claimed, 2);
      assert.equal(cycle.recovered, 1);
      assert.equal(cycle.succeeded, 2);
      assert.equal(cycle.failed, 0);
      for (const seeded of [queued, stale]) {
        const asset = await db.projectAsset.findUniqueOrThrow({ where: { id: seeded.assetId } });
        const run = await db.projectAssetExtractionRun.findUniqueOrThrow({ where: { id: seeded.runId } });
        assert.equal(asset.status, "ready");
        assert.equal(run.status, "succeeded");
        assert.equal(run.leaseToken, null);
      }
      assert.equal((await db.projectAssetExtractionRun.findUniqueOrThrow({ where: { id: stale.runId } })).attemptCount, 2);

      const failed = await seedLocalRun("failed", "retry");
      const retried = await retryProjectAssetLocalExtraction(project.id, failed.assetId, db);
      assert.equal(retried?.status, "ready");
      assert.equal(await db.projectAssetExtractionRun.count({
        where: { projectAssetVersionId: failed.versionId, status: "succeeded" },
      }), 1);
    } finally {
      if (previousRoot === undefined) delete process.env.AI_PROJECT_OS_ASSET_DIR;
      else process.env.AI_PROJECT_OS_ASSET_DIR = previousRoot;
      if (previousLease === undefined) delete process.env.AI_PROJECT_OS_UPLOAD_PARSE_LEASE_MS;
      else process.env.AI_PROJECT_OS_UPLOAD_PARSE_LEASE_MS = previousLease;
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.appUser.delete({ where: { id: user.id } });
      await rm(assetRoot, { recursive: true, force: true });
    }
  },
);

test(
  "reservation is billable before the blob and converts atomically on a successful upload",
  { skip: !shouldRun ? "PROJECT_ASSET_UPLOAD_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const user = await db.appUser.create({ data: { username: `reservation_gate_${suffix}` } });
    const workspace = await db.workspace.create({ data: { name: `Reservation gate ${suffix}`, slug: `reservation-gate-${suffix}`, createdById: user.id } });
    const project = await db.project.create({ data: { name: `Reservation gate ${suffix}`, slug: `reservation-project-${suffix}`, workspaceId: workspace.id } });
    const assetRoot = await mkdtemp(path.join(os.tmpdir(), `ai-project-os-upload-reservation-${suffix}-`));
    const previousRoot = process.env.AI_PROJECT_OS_ASSET_DIR;
    process.env.AI_PROJECT_OS_ASSET_DIR = assetRoot;
    const reservationAssetId = randomUUID();
    const reservationVersionId = randomUUID();
    const reservationId = randomUUID();
    const reservationKey = assetBlobStorageKey(project.id, reservationAssetId, reservationVersionId);
    try {
      await createProjectAssetUploadReservation({ id: reservationId, projectId: project.id, userId: user.id, storageKey: reservationKey, sizeBytes: 5 }, db);
      assert.equal(await db.projectAssetUploadReservation.count({ where: { id: reservationId } }), 1);
      assert.deepEqual(await filesUnder(assetRoot), []);
      const usageBeforeBlob = await getProjectAssetUploadUsage(project.id, db);
      assert.equal(usageBeforeBlob.projectBytes, BigInt(5));
      await writeAssetBlob({ projectId: project.id, assetId: reservationAssetId, versionId: reservationVersionId, buffer: Buffer.from("hello") });
      await removeAssetBlob(reservationKey);
      await db.projectAssetUploadReservation.delete({ where: { id: reservationId } });

      const uploaded = await import("../src/lib/project-assets/service").then(({ uploadProjectAsset }) => uploadProjectAsset({
        projectId: project.id,
        requestedBy: user,
        fileName: "atomic.md",
        buffer: Buffer.from("atomic upload", "utf8"),
      }, db));
      assert.ok(uploaded);
      assert.equal(await db.projectAssetVersion.count({ where: { projectId: project.id } }), 1);
      assert.equal(await db.projectAssetUploadReservation.count({ where: { projectId: project.id } }), 0);
      assert.equal((await filesUnder(assetRoot)).length, 1);
    } finally {
      if (previousRoot === undefined) delete process.env.AI_PROJECT_OS_ASSET_DIR;
      else process.env.AI_PROJECT_OS_ASSET_DIR = previousRoot;
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.appUser.delete({ where: { id: user.id } });
      await rm(assetRoot, { recursive: true, force: true });
    }
  },
);

test(
  "an in-flight reservation prevents destructive parent deletion",
  { skip: !shouldRun ? "PROJECT_ASSET_UPLOAD_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const user = await db.appUser.create({ data: { username: `reservation_fk_${suffix}` } });
    const workspace = await db.workspace.create({ data: { name: `Reservation FK ${suffix}`, slug: `reservation-fk-${suffix}`, createdById: user.id } });
    const project = await db.project.create({ data: { name: `Reservation FK ${suffix}`, slug: `reservation-fk-project-${suffix}`, workspaceId: workspace.id } });
    const reservationId = randomUUID();
    try {
      await createProjectAssetUploadReservation({
        id: reservationId,
        projectId: project.id,
        userId: user.id,
        storageKey: assetBlobStorageKey(project.id, randomUUID(), randomUUID()),
        sizeBytes: 1,
      }, db);
      await assert.rejects(
        () => db.project.delete({ where: { id: project.id } }),
        (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003",
      );
      assert.equal(await db.projectAssetUploadReservation.count({ where: { id: reservationId } }), 1);
    } finally {
      await db.projectAssetUploadReservation.deleteMany({ where: { id: reservationId } });
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.appUser.delete({ where: { id: user.id } });
    }
  },
);

test(
  "expired reservations remain billable until bounded cleanup proves their blob is gone",
  { skip: !shouldRun ? "PROJECT_ASSET_UPLOAD_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const user = await db.appUser.create({ data: { username: `stale_reservation_${suffix}` } });
    const workspace = await db.workspace.create({ data: { name: `Stale reservation ${suffix}`, slug: `stale-reservation-${suffix}`, createdById: user.id } });
    const project = await db.project.create({ data: { name: `Stale reservation ${suffix}`, slug: `stale-project-${suffix}`, workspaceId: workspace.id } });
    const assetRoot = await mkdtemp(path.join(os.tmpdir(), `ai-project-os-upload-stale-${suffix}-`));
    const previousRoot = process.env.AI_PROJECT_OS_ASSET_DIR;
    process.env.AI_PROJECT_OS_ASSET_DIR = assetRoot;
    const assetId = randomUUID();
    const versionId = randomUUID();
    const storageKey = assetBlobStorageKey(project.id, assetId, versionId);
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const leaseExpiresAt = new Date(Date.now() - 60 * 60 * 1000);
    try {
      await db.projectAssetUploadReservation.create({ data: { id: randomUUID(), projectId: project.id, workspaceId: workspace.id, userId: user.id, storageKey, sizeBytes: BigInt(9), createdAt, leaseExpiresAt } });
      assert.equal((await getProjectAssetUploadUsage(project.id, db)).projectBytes, BigInt(9));
      await writeAssetBlob({ projectId: project.id, assetId, versionId, buffer: Buffer.from("stale key") });
      assert.equal(await reconcileStaleProjectAssetUploadReservations(db, 1), 1);
      assert.equal(await db.projectAssetUploadReservation.count({ where: { projectId: project.id } }), 0);
      assert.deepEqual(await filesUnder(assetRoot), []);
    } finally {
      if (previousRoot === undefined) delete process.env.AI_PROJECT_OS_ASSET_DIR;
      else process.env.AI_PROJECT_OS_ASSET_DIR = previousRoot;
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.appUser.delete({ where: { id: user.id } });
      await rm(assetRoot, { recursive: true, force: true });
    }
  },
);

test(
  "admission cleanup is global and bounded while preserving recent rows",
  { skip: !shouldRun ? "PROJECT_ASSET_UPLOAD_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const inactiveUser = await db.appUser.create({ data: { username: `inactive_upload_${suffix}` } });
    const activeUser = await db.appUser.create({ data: { username: `active_upload_${suffix}` } });
    const workspace = await db.workspace.create({ data: { name: `Admission cleanup ${suffix}`, slug: `admission-cleanup-${suffix}`, createdById: activeUser.id } });
    const project = await db.project.create({ data: { name: `Admission cleanup ${suffix}`, slug: `admission-cleanup-project-${suffix}`, workspaceId: workspace.id } });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 2 * 60 * 1000);
    try {
      await db.projectAssetUploadAdmission.create({ data: { id: randomUUID(), projectId: project.id, workspaceId: workspace.id, userId: inactiveUser.id, windowStartedAt: old, leaseExpiresAt: new Date(old.getTime() + 60_000), releasedAt: old, createdAt: old } });
      await db.projectAssetUploadAdmission.create({ data: { id: randomUUID(), projectId: project.id, workspaceId: workspace.id, userId: inactiveUser.id, windowStartedAt: recent, leaseExpiresAt: new Date(recent.getTime() + 60_000), releasedAt: recent, createdAt: recent } });
      const admissionId = await acquireUploadAdmission({ projectId: project.id, userId: activeUser.id }, db);
      assert.equal(await db.projectAssetUploadAdmission.count({ where: { userId: inactiveUser.id, createdAt: { lt: recent } } }), 0);
      assert.equal(await db.projectAssetUploadAdmission.count({ where: { userId: inactiveUser.id, createdAt: recent } }), 1);
      await releaseUploadAdmission(admissionId, db);
    } finally {
      await db.project.delete({ where: { id: project.id } });
      await db.workspace.delete({ where: { id: workspace.id } });
      await db.appUser.deleteMany({ where: { id: { in: [inactiveUser.id, activeUser.id] } } });
    }
  },
);
