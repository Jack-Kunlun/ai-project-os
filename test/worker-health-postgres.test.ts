import "dotenv/config";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getDb } from "../src/lib/db";
import { readWorkerHealth, recordWorkerHeartbeat } from "../src/lib/worker-health";

const shouldRun = process.env.WORKER_HEALTH_POSTGRES_GATE === "1";

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForRunningWorker(name: string) {
  const db = getDb();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const runtime = await db.workerRuntime.findUnique({ where: { name } });
    if (runtime?.status === "running") return runtime;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("WORKER_DID_NOT_BECOME_HEALTHY");
}

test("worker heartbeat persists safe identity and enforces database constraints", { skip: !shouldRun ? "WORKER_HEALTH_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const name = `worker-test-${randomUUID().slice(0, 8)}`;
  const instanceId = `${name}:${randomUUID()}`;
  const startedAt = new Date("2026-08-31T00:00:00.000Z");
  const heartbeatAt = new Date("2026-08-31T00:00:10.000Z");

  try {
    await recordWorkerHeartbeat(db, {
      name,
      instanceId,
      status: "running",
      startedAt,
      heartbeatAt,
      lastActionCycleAt: heartbeatAt,
      lastAutomationCycleAt: heartbeatAt,
      consecutiveFailures: 0,
    });

    const persisted = await db.workerRuntime.findUniqueOrThrow({ where: { name } });
    assert.match(persisted.instanceIdHash, /^[0-9a-f]{64}$/u);
    assert.notEqual(persisted.instanceIdHash, instanceId);
    assert.equal(persisted.status, "running");
    assert.deepEqual(
      await readWorkerHealth(db, { name, now: new Date("2026-08-31T00:00:15.000Z") }),
      { status: "up", heartbeatAgeMs: 5_000, consecutiveFailures: 0 },
    );

    await assert.rejects(() => db.workerRuntime.create({
      data: {
        name: "INVALID WORKER",
        instanceIdHash: "a".repeat(64),
        status: "running",
        startedAt,
        heartbeatAt,
        consecutiveFailures: 0,
      },
    }));
  } finally {
    await db.workerRuntime.deleteMany({ where: { name } });
  }
});

test("worker process publishes structured lifecycle logs and passes its container healthcheck", { skip: !shouldRun ? "WORKER_HEALTH_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const name = `worker-process-${randomUUID().slice(0, 8)}`;
  const environment = { ...process.env, AI_PROJECT_OS_WORKER_NAME: name };
  const worker = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/automation-worker.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const workerExit = waitForExit(worker);
  let stdout = "";
  let stderr = "";
  worker.stdout?.setEncoding("utf8");
  worker.stderr?.setEncoding("utf8");
  worker.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  worker.stderr?.on("data", (chunk: string) => { stderr += chunk; });

  try {
    const runtime = await waitForRunningWorker(name);
    assert.match(runtime.instanceIdHash, /^[0-9a-f]{64}$/u);
    assert.equal((await readWorkerHealth(db, { name })).status, "up");

    const healthcheck = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/worker-healthcheck.ts"], {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let healthcheckOutput = "";
    healthcheck.stdout?.setEncoding("utf8");
    healthcheck.stdout?.on("data", (chunk: string) => { healthcheckOutput += chunk; });
    assert.deepEqual(await waitForExit(healthcheck), { code: 0, signal: null });
    assert.equal(JSON.parse(healthcheckOutput.trim()).worker.status, "up");
  } finally {
    worker.kill("SIGTERM");
  }

  const forcedStop = setTimeout(() => worker.kill("SIGKILL"), 5_000);
  const exit = await workerExit;
  clearTimeout(forcedStop);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(stderr, "");

  const entries = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(entries.some((entry) => entry.event === "worker.started" && entry.worker === name));
  assert.ok(entries.some((entry) => entry.event === "worker.stopped" && entry.worker === name));
  assert.equal((await db.workerRuntime.findUniqueOrThrow({ where: { name } })).status, "stopping");
  await db.workerRuntime.deleteMany({ where: { name } });
});
