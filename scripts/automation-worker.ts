import { randomUUID } from "node:crypto";
import { runProjectActionWorkerCycle } from "@/lib/action-engine";
import { runAutomationWorkerCycle } from "@/lib/automation";
import { getDb } from "@/lib/db";
import {
  getWorkerName,
  recordWorkerHeartbeat,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from "@/lib/worker-health";

let stopping = false;
let finishWait: (() => void) | null = null;

function requestStop() {
  stopping = true;
  finishWait?.();
}

process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);

async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      finishWait = null;
      resolve();
    }, milliseconds);
    finishWait = () => {
      clearTimeout(timeout);
      finishWait = null;
      resolve();
    };
  });
}

async function main() {
  const db = getDb();
  const workerName = getWorkerName();
  const workerId = `${workerName}:${randomUUID()}`;
  const startedAt = new Date();
  let currentStatus: "starting" | "running" | "degraded" | "stopping" = "starting";
  let consecutiveFailures = 0;
  let lastActionCycleAt: Date | null = null;
  let lastAutomationCycleAt: Date | null = null;
  let heartbeatPending = false;

  const writeLog = (level: "info" | "warn" | "error", event: string, details: Record<string, number | string> = {}) => {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, component: "automation-worker", event, worker: workerName, ...details });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };

  const heartbeat = async () => {
    await recordWorkerHeartbeat(db, {
      name: workerName,
      instanceId: workerId,
      status: currentStatus,
      startedAt,
      lastActionCycleAt,
      lastAutomationCycleAt,
      consecutiveFailures,
    });
  };

  await heartbeat();
  writeLog("info", "worker.started");

  const heartbeatTimer = setInterval(() => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    void heartbeat()
      .catch(() => writeLog("error", "worker.heartbeat_failed", { errorCode: "WORKER_HEARTBEAT_FAILED" }))
      .finally(() => { heartbeatPending = false; });
  }, WORKER_HEARTBEAT_INTERVAL_MS);

  try {
    while (!stopping) {
      let claimed = 0;
      let cycleFailures = 0;
      try {
        const result = await runProjectActionWorkerCycle({ workerId, maximumActions: 5 }, db);
        claimed += result.claimed;
        if (result.claimed > 0 || result.recoveredLeases > 0 || result.expiredApprovals > 0 || result.failed > 0) {
          writeLog(result.failed > 0 ? "warn" : "info", "worker.action_cycle_completed", result);
        }
      } catch {
        cycleFailures += 1;
        writeLog("error", "worker.action_cycle_failed", { errorCode: "ACTION_CYCLE_FAILED" });
      }
      lastActionCycleAt = new Date();

      try {
        const result = await runAutomationWorkerCycle({ workerId, maximumRuns: 5 }, db);
        claimed += result.claimed;
        if (result.claimed > 0 || result.recovered > 0 || result.failed > 0) {
          writeLog(result.failed > 0 ? "warn" : "info", "worker.automation_cycle_completed", result);
        }
      } catch {
        cycleFailures += 1;
        writeLog("error", "worker.automation_cycle_failed", { errorCode: "AUTOMATION_CYCLE_FAILED" });
      }
      lastAutomationCycleAt = new Date();

      if (cycleFailures === 0) {
        if (currentStatus === "degraded") writeLog("info", "worker.recovered");
        currentStatus = "running";
        consecutiveFailures = 0;
      } else {
        currentStatus = "degraded";
        consecutiveFailures = Math.min(1_000_000, consecutiveFailures + cycleFailures);
      }
      await heartbeat();
      if (claimed === 0) await wait(WORKER_HEARTBEAT_INTERVAL_MS);
    }
  } finally {
    clearInterval(heartbeatTimer);
    currentStatus = "stopping";
    try {
      await heartbeat();
      writeLog("info", "worker.stopped");
    } catch {
      writeLog("error", "worker.stop_heartbeat_failed", { errorCode: "WORKER_HEARTBEAT_FAILED" });
    }
    await db.$disconnect();
  }
}

void main().catch(() => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    component: "automation-worker",
    event: "worker.terminated",
    errorCode: "WORKER_TERMINATED",
  }));
  process.exitCode = 1;
});
