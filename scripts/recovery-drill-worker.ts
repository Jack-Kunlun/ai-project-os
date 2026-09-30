import { randomUUID } from "node:crypto";
import { getDb } from "../src/lib/db";
import {
  getWorkerName,
  recordWorkerHeartbeat,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from "../src/lib/worker-health";

let stopping = false;
let finishWait: (() => void) | null = null;

function requestStop(): void {
  stopping = true;
  finishWait?.();
}

process.on("SIGTERM", requestStop);
process.on("SIGINT", requestStop);

async function wait(milliseconds: number): Promise<void> {
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

async function main(): Promise<void> {
  // The isolated Git Worker sets this to an empty value to discard its source
  // credential. Remove the empty key before the shared environment validator.
  if (process.env.GIT_AUTOMATION_DATABASE_URL !== undefined && process.env.GIT_AUTOMATION_DATABASE_URL !== "") {
    throw new Error("RECOVERY_DRILL_PRIVILEGED_URL_PRESENT");
  }
  if (process.env.GIT_AUTOMATION_DATABASE_URL === "") delete process.env.GIT_AUTOMATION_DATABASE_URL;
  const db = getDb();
  const workerName = getWorkerName();
  const workerId = `${workerName}:${randomUUID()}`;
  const startedAt = new Date();
  let currentStatus: "starting" | "running" | "stopping" = "starting";
  let heartbeatPending = false;

  const heartbeat = async (): Promise<void> => {
    await recordWorkerHeartbeat(db, {
      name: workerName,
      instanceId: workerId,
      status: currentStatus,
      startedAt,
      lastActionCycleAt: null,
      lastAutomationCycleAt: null,
      consecutiveFailures: 0,
    });
  };

  try {
    await heartbeat();
    currentStatus = "running";
    await heartbeat();
    const heartbeatTimer = setInterval(() => {
      if (heartbeatPending || stopping) return;
      heartbeatPending = true;
      void heartbeat().finally(() => { heartbeatPending = false; });
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    try {
      while (!stopping) await wait(WORKER_HEARTBEAT_INTERVAL_MS);
    } finally {
      clearInterval(heartbeatTimer);
      currentStatus = "stopping";
      await heartbeat();
    }
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  process.exitCode = 1;
});
