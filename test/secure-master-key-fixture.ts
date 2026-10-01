import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createSecureMasterKeyFixture(): Promise<Readonly<{ path: string; cleanup: () => Promise<void> }>> {
  const directory = await mkdtemp(join(tmpdir(), "ai-project-os-test-key-"));
  return Object.freeze({
    path: join(directory, "master.key"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  });
}
