import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitHubCredentialFromToken } from "../src/lib/github/read-only-client";
import { encodeGitCredential } from "../src/lib/git/credentials";
import { sealSecret } from "../src/lib/credential-vault";
import {
  openGitAutomationMaterialCredential,
  type GitAutomationMaterialReadContext,
} from "../src/lib/project-git-automation-material-read-context";

const INVALID_CONTEXT = "GIT_AUTOMATION_MATERIAL_CONTEXT_INVALID";

async function withMasterKey<T>(run: (masterKey: Buffer) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ai-project-os-git-material-key-"));
  const masterKeyFile = join(directory, "master.key");
  const previous = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  const masterKey = Buffer.alloc(32, 0x57);
  try {
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyFile;
    await writeFile(masterKeyFile, `${masterKey.toString("base64url")}\n`, { mode: 0o600 });
    return await run(masterKey);
  } finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function makeContext(
  plaintext: string,
  masterKey: Buffer,
  fingerprintOverride?: string,
): GitAutomationMaterialReadContext {
  const sealed = sealSecret("git", plaintext, masterKey);
  return Object.freeze({
    scope: {
      repositoryPath: "org/material-gate",
      trackedRef: "main",
      materialKind: "issue",
    },
    connection: {
      id: randomUUID(),
      baseUrl: "https://github.com",
      providerKind: "github",
      transport: "https",
      authKind: "token",
    },
    credential: {
      kind: "git",
      ciphertext: Buffer.from(sealed.ciphertext).toString("base64"),
      nonce: Buffer.from(sealed.nonce).toString("base64"),
      authTag: Buffer.from(sealed.authTag).toString("base64"),
      keyVersion: 1,
      secretFingerprint: fingerprintOverride ?? sealed.secretFingerprint,
    },
    baseline: null,
  });
}

function safeInvalidCredential(secret: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, INVALID_CONTEXT);
    assert.equal(String(error).includes(secret), false);
    return true;
  };
}

test("material credential read decodes the stored token package for the GitHub client", async () => {
  await withMasterKey(async (masterKey) => {
    const token = `github_pat_${"x".repeat(32)}`;
    const context = makeContext(encodeGitCredential("token", token), masterKey);
    const opened = await openGitAutomationMaterialCredential(context);

    assert.equal(opened, token);
    assert.doesNotThrow(() => createGitHubCredentialFromToken(opened));
  });
});

test("material credential read rejects legacy, wrong-kind, malformed, and fingerprint-tampered values safely", async () => {
  await withMasterKey(async (masterKey) => {
    const legacyToken = `github_pat_${"y".repeat(32)}`;
    await assert.rejects(
      () => openGitAutomationMaterialCredential(makeContext(legacyToken, masterKey)),
      safeInvalidCredential(legacyToken),
    );

    const basicPassword = "synthetic-basic-password-that-must-not-leak";
    const basicPayload = encodeGitCredential("basic", basicPassword);
    await assert.rejects(
      () => openGitAutomationMaterialCredential(makeContext(basicPayload, masterKey)),
      safeInvalidCredential(basicPassword),
    );

    const malformedPayload = Buffer.from("not-json", "utf8").toString("base64url");
    await assert.rejects(
      () => openGitAutomationMaterialCredential(makeContext(malformedPayload, masterKey)),
      safeInvalidCredential(malformedPayload),
    );

    const token = `github_pat_${"z".repeat(32)}`;
    const encodedToken = encodeGitCredential("token", token);
    await assert.rejects(
      () => openGitAutomationMaterialCredential(makeContext(encodedToken, masterKey, "b".repeat(64))),
      safeInvalidCredential(token),
    );
  });
});
