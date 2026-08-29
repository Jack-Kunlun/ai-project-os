import { randomUUID } from "node:crypto";
import { runProjectActionWorkerCycle } from "@/lib/action-engine";
import { runAutomationWorkerCycle } from "@/lib/automation";

const workerId = `worker:${randomUUID()}`;
let stopping = false;

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  while (!stopping) {
    let claimed = 0;
    try {
      const result = await runProjectActionWorkerCycle({ workerId, maximumActions: 5 });
      claimed += result.claimed;
    } catch {
      console.error("Action worker cycle failed");
    }
    try {
      const result = await runAutomationWorkerCycle({ workerId, maximumRuns: 5 });
      claimed += result.claimed;
    } catch {
      console.error("Automation worker cycle failed");
    }
    if (claimed === 0) await wait(10_000);
  }
}

void main().catch(() => {
  console.error("Automation worker terminated unexpectedly");
  process.exitCode = 1;
});
