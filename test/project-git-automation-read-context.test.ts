import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sealSecret } from "../src/lib/credential-vault";
import { encodeGitCredential } from "../src/lib/git";
import {
  openGitAutomationCredential,
  type GitAutomationReadContext,
} from "../src/lib/project-git-automation-read-context";

test("Git worker opens only an existing sealed credential with the expected fingerprint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-project-os-git-automation-key-"));
  const masterKeyFile = join(directory, "master.key");
  const previous = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  const masterKey = Buffer.alloc(32, 0x37);
  const plaintext = encodeGitCredential("token", "safe-test-token-12345");
  const sealed = sealSecret("git", plaintext, masterKey);
  const context: GitAutomationReadContext = {
    connection: {
      id: randomUUID(),
      providerKind: "github",
      transport: "https",
      baseUrl: "https://github.com",
      authKind: "token",
      username: "x-access-token",
      allowPrivateNetwork: false,
      tlsCaCertificate: null,
      sshKnownHost: null,
      resolvedAddressFingerprint: "a".repeat(64),
      verifiedAddresses: null,
      credentialId: randomUUID(),
    },
    credential: {
      kind: "git",
      ciphertext: Buffer.from(sealed.ciphertext).toString("base64"),
      nonce: Buffer.from(sealed.nonce).toString("base64"),
      authTag: Buffer.from(sealed.authTag).toString("base64"),
      keyVersion: 1,
      secretFingerprint: sealed.secretFingerprint,
    },
    baseline: null,
  };
  try {
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyFile;
    await assert.rejects(() => openGitAutomationCredential(context), /ENOENT/u);
    await writeFile(masterKeyFile, `${masterKey.toString("base64url")}\n`, { mode: 0o600 });
    assert.equal(await openGitAutomationCredential(context), plaintext);
    await assert.rejects(
      () => openGitAutomationCredential({
        ...context,
        credential: { ...context.credential, secretFingerprint: "b".repeat(64) },
      }),
      /GIT_AUTOMATION_CONTEXT_INVALID/u,
    );
  } finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
