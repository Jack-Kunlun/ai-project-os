import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_WORKER_NAME,
  getWorkerName,
  hashWorkerInstanceId,
  summarizeWorkerHealth,
} from "../src/lib/worker-health";

test("worker identity is deployment-scoped and the process identifier is one-way hashed", () => {
  assert.equal(getWorkerName({}), DEFAULT_WORKER_NAME);
  assert.equal(getWorkerName({ AI_PROJECT_OS_WORKER_NAME: "automation-east-1" }), "automation-east-1");
  assert.throws(() => getWorkerName({ AI_PROJECT_OS_WORKER_NAME: "Worker East" }), /WORKER_NAME_INVALID/u);

  const instanceId = "automation-primary:00000000-0000-4000-8000-000000000001";
  const digest = hashWorkerInstanceId(instanceId);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(digest.includes(instanceId), false);
});

test("worker heartbeat summary distinguishes live, degraded, stopping, stale and missing states", () => {
  const now = new Date("2026-08-31T00:00:45.000Z");
  assert.deepEqual(summarizeWorkerHealth(null, now), { status: "missing", heartbeatAgeMs: null, consecutiveFailures: 0 });
  assert.deepEqual(
    summarizeWorkerHealth({ status: "running", heartbeatAt: new Date("2026-08-31T00:00:40.000Z"), consecutiveFailures: 0 }, now),
    { status: "up", heartbeatAgeMs: 5_000, consecutiveFailures: 0 },
  );
  assert.equal(summarizeWorkerHealth({ status: "degraded", heartbeatAt: now, consecutiveFailures: 2 }, now).status, "degraded");
  assert.equal(summarizeWorkerHealth({ status: "stopping", heartbeatAt: now, consecutiveFailures: 0 }, now).status, "stopping");
  assert.equal(
    summarizeWorkerHealth({ status: "running", heartbeatAt: new Date("2026-08-30T23:59:59.999Z"), consecutiveFailures: 0 }, now).status,
    "stale",
  );
});

test("migration, worker entrypoint and Compose preserve the health boundary", async () => {
  const [migration, worker, compose] = await Promise.all([
    readFile("prisma/migrations/20260831000000_add_worker_runtime_health/migration.sql", "utf8"),
    readFile("scripts/automation-worker.ts", "utf8"),
    readFile("compose.yaml", "utf8"),
  ]);

  assert.match(migration, /WorkerRuntime_name_check/u);
  assert.match(migration, /WorkerRuntime_instance_hash_check/u);
  assert.match(migration, /WorkerRuntime_failures_check/u);
  assert.match(worker, /recordWorkerHeartbeat/u);
  assert.match(worker, /JSON\.stringify/u);
  assert.match(compose, /AI_PROJECT_OS_WORKER_NAME/u);
  assert.match(compose, /scripts\/worker-healthcheck\.ts/u);
});
