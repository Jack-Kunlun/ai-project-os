import { getDb } from "@/lib/db";
import { readWorkerHealth } from "@/lib/worker-health";

async function main() {
  const db = getDb();
  try {
    const worker = await readWorkerHealth(db);
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), component: "worker-healthcheck", worker }));
    if (worker.status !== "up") process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    component: "worker-healthcheck",
    event: "healthcheck.failed",
    errorCode: "WORKER_HEALTHCHECK_FAILED",
  }));
  process.exitCode = 1;
});
