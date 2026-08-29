import { randomUUID } from "node:crypto";
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
    try {
      const result = await runAutomationWorkerCycle({ workerId, maximumRuns: 5 });
      if (result.claimed === 0) await wait(10_000);
    } catch {
      console.error("Automation worker cycle failed");
      await wait(10_000);
    }
  }
}

void main().catch(() => {
  console.error("Automation worker terminated unexpectedly");
  process.exitCode = 1;
});
