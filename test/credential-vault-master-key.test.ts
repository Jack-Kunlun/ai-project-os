import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readExistingMasterKey } from "../src/lib/credential-vault";

test("master key read rejects a symlink and writable parent directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aipos-master-key-file-"));
  const previous = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  const keyPath = join(directory, "master.key");
  const original = join(directory, "original.key");
  const encoded = randomBytes(32).toString("base64url");
  try {
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = keyPath;
    await writeFile(original, `${encoded}\n`, { mode: 0o600 });
    await symlink(original, keyPath);
    await assert.rejects(() => readExistingMasterKey());
    await rm(keyPath);
    await writeFile(keyPath, `${encoded}\n`, { mode: 0o600 });
    assert.equal((await readExistingMasterKey()).toString("base64url"), encoded);
    await chmod(directory, 0o777);
    await assert.rejects(() => readExistingMasterKey(), { code: "CREDENTIAL_MASTER_KEY_INSECURE" });
  } finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
