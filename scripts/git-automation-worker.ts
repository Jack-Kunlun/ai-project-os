import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { getGitAutomationWorkerDb } from "@/lib/db";
import { getEnvironment } from "@/lib/env";
import { runOneGitAutomationCycle } from "@/lib/project-git-automation-execution-service";
import { runOneGitAutomationMaterialCycle } from "@/lib/project-git-automation-material-execution-service";
import type { GitAutomationDiagnosticObserver } from "@/lib/project-git-automation-diagnostics";

const IDLE_WAIT_MS = 15_000;
const GIT_AUTOMATION_WORKER_HEARTBEAT_PATH = "/tmp/ai-project-os-git-worker-heartbeat";
const stop = new AbortController();

process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());

function log(event: string, details: Record<string, string> = {}): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "git-automation-worker",
    event,
    ...details,
  }));
}

function diagnosticObserver(executionClass: "code" | "material"): GitAutomationDiagnosticObserver {
  return ({ stage, errorCode }) => {
    log("worker.run_diagnostic", { class: executionClass, stage, errorCode });
  };
}

async function waitOrStop(milliseconds: number): Promise<void> {
  if (stop.signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      stop.signal.removeEventListener("abort", done);
      resolve();
    }
    stop.signal.addEventListener("abort", done, { once: true });
  });
}

async function main(): Promise<void> {
  const environment = getEnvironment();
  if (environment.GIT_AUTOMATION_DATABASE_URL === undefined
    || environment.DATABASE_URL !== environment.GIT_AUTOMATION_DATABASE_URL) {
    throw new Error("GIT_AUTOMATION_DEDICATED_DATABASE_URL_REQUIRED");
  }
  const db = getGitAutomationWorkerDb();
  const workerId = `git-automation-${randomUUID()}`;
  log("worker.started");
  try {
    while (!stop.signal.aborted) {
      try {
        const codeOutcome = await runOneGitAutomationCycle({
          workerId,
          db,
          stopSignal: stop.signal,
          onHeartbeat: () => writeFile(GIT_AUTOMATION_WORKER_HEARTBEAT_PATH, new Date().toISOString(), { mode: 0o600 }),
          onDiagnostic: diagnosticObserver("code"),
        });
        const materialOutcome = codeOutcome === "idle"
          ? await runOneGitAutomationMaterialCycle({
            workerId,
            db,
            stopSignal: stop.signal,
            onHeartbeat: () => writeFile(GIT_AUTOMATION_WORKER_HEARTBEAT_PATH, new Date().toISOString(), { mode: 0o600 }),
            onDiagnostic: diagnosticObserver("material"),
          })
          : "idle";
        const outcome = materialOutcome === "idle" ? codeOutcome : `material_${materialOutcome}`;
        await writeFile(GIT_AUTOMATION_WORKER_HEARTBEAT_PATH, new Date().toISOString(), { mode: 0o600 });
        if (outcome !== "idle" && outcome !== "stopped") log("worker.run_settled", { outcome });
        if (outcome !== "succeeded" && outcome !== "unchanged") await waitOrStop(IDLE_WAIT_MS);
      } catch {
        log("worker.cycle_failed", {
          class: "worker",
          stage: "worker_cycle",
          errorCode: "WORKER_CYCLE_FAILED",
        });
        await waitOrStop(IDLE_WAIT_MS);
      }
    }
  } finally {
    await db.$disconnect();
    log("worker.stopped");
  }
}

void main().catch(() => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "git-automation-worker",
    event: "worker.terminated",
    class: "worker",
    stage: "worker_startup",
    errorCode: "WORKER_TERMINATED",
  }));
  process.exitCode = 1;
});
