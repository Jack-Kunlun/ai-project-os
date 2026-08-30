import { createHash } from "node:crypto";
import type { PrismaClient, WorkerRuntimeStatus } from "@prisma/client";

export const DEFAULT_WORKER_NAME = "automation-primary";
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_HEARTBEAT_STALE_AFTER_MS = 45_000;

const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/u;

export type PublicWorkerHealthStatus = "up" | "starting" | "degraded" | "stopping" | "stale" | "missing";

export interface WorkerHealthSummary {
  status: PublicWorkerHealthStatus;
  heartbeatAgeMs: number | null;
  consecutiveFailures: number;
}

interface WorkerHeartbeatRecord {
  status: WorkerRuntimeStatus;
  heartbeatAt: Date;
  consecutiveFailures: number;
}

export function getWorkerName(environment: Record<string, string | undefined> = process.env): string {
  const value = environment.AI_PROJECT_OS_WORKER_NAME ?? DEFAULT_WORKER_NAME;
  if (!WORKER_NAME_PATTERN.test(value)) throw new Error("WORKER_NAME_INVALID");
  return value;
}

export function hashWorkerInstanceId(instanceId: string): string {
  if (instanceId.length === 0) throw new Error("WORKER_INSTANCE_ID_INVALID");
  return createHash("sha256").update(instanceId, "utf8").digest("hex");
}

export function summarizeWorkerHealth(
  record: WorkerHeartbeatRecord | null,
  now = new Date(),
  staleAfterMs = WORKER_HEARTBEAT_STALE_AFTER_MS,
): WorkerHealthSummary {
  if (record === null) return { status: "missing", heartbeatAgeMs: null, consecutiveFailures: 0 };

  const heartbeatAgeMs = Math.max(0, now.getTime() - record.heartbeatAt.getTime());
  if (heartbeatAgeMs > staleAfterMs) {
    return { status: "stale", heartbeatAgeMs, consecutiveFailures: record.consecutiveFailures };
  }

  const status: PublicWorkerHealthStatus = record.status === "running" ? "up" : record.status;
  return { status, heartbeatAgeMs, consecutiveFailures: record.consecutiveFailures };
}

export async function recordWorkerHeartbeat(
  db: PrismaClient,
  input: {
    name: string;
    instanceId: string;
    status: WorkerRuntimeStatus;
    startedAt: Date;
    heartbeatAt?: Date;
    lastActionCycleAt: Date | null;
    lastAutomationCycleAt: Date | null;
    consecutiveFailures: number;
  },
): Promise<void> {
  if (!WORKER_NAME_PATTERN.test(input.name)) throw new Error("WORKER_NAME_INVALID");
  if (!Number.isSafeInteger(input.consecutiveFailures) || input.consecutiveFailures < 0 || input.consecutiveFailures > 1_000_000) {
    throw new Error("WORKER_FAILURE_COUNT_INVALID");
  }

  const heartbeatAt = input.heartbeatAt ?? new Date();
  const data = {
    instanceIdHash: hashWorkerInstanceId(input.instanceId),
    status: input.status,
    startedAt: input.startedAt,
    heartbeatAt,
    lastActionCycleAt: input.lastActionCycleAt,
    lastAutomationCycleAt: input.lastAutomationCycleAt,
    consecutiveFailures: input.consecutiveFailures,
  };

  await db.workerRuntime.upsert({
    where: { name: input.name },
    create: { name: input.name, ...data },
    update: data,
  });
}

export async function readWorkerHealth(
  db: PrismaClient,
  options: { name?: string; now?: Date; staleAfterMs?: number } = {},
): Promise<WorkerHealthSummary> {
  const name = options.name ?? getWorkerName();
  if (!WORKER_NAME_PATTERN.test(name)) throw new Error("WORKER_NAME_INVALID");

  const runtime = await db.workerRuntime.findUnique({
    where: { name },
    select: { status: true, heartbeatAt: true, consecutiveFailures: true },
  });
  return summarizeWorkerHealth(runtime, options.now, options.staleAfterMs);
}
