import { stat } from "node:fs/promises";

const HEARTBEAT_PATH = "/tmp/ai-project-os-git-worker-heartbeat";
const MAX_AGE_MS = 60_000;

void stat(HEARTBEAT_PATH).then((metadata) => {
  if (!metadata.isFile() || Date.now() - metadata.mtimeMs > MAX_AGE_MS) process.exitCode = 1;
}).catch(() => {
  process.exitCode = 1;
});
