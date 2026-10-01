import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalCredential, ExternalCredentialKind, PrismaClient } from "@prisma/client";
import test from "node:test";
import {
  CredentialVaultError,
  openSealedSecret,
  readWebSourceFormCredential,
  rotateCredential,
  sealSecret,
  sealWebSourceFormCredential,
} from "../src/lib/credential-vault";

const webSourceFormKind = "webSourceForm" as unknown as ExternalCredentialKind;
const legacyWebSourceKind = "webSource" as ExternalCredentialKind;
const FIXED_AAD = Buffer.from("ai-project-os:credential:v2:webSourceForm:1", "utf8");

type CredentialRow = Pick<
  ExternalCredential,
  "id" | "kind" | "ciphertext" | "nonce" | "authTag" | "keyVersion" | "maskedSuffix" | "secretFingerprint"
>;

function encryptedStoredValue(raw: string, key: Buffer): Omit<CredentialRow, "id" | "kind" | "maskedSuffix" | "secretFingerprint"> {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(FIXED_AAD);
  const ciphertext = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  return {
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
    keyVersion: 1,
  };
}

function credentialDatabase(initial: CredentialRow) {
  let row = initial;
  const db = {
    externalCredential: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === row.id ? row : null),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; kind: ExternalCredentialKind };
        data: Partial<CredentialRow> & { rotatedAt?: Date };
      }) => {
        if (where.id !== row.id || where.kind !== row.kind) return { count: 0 };
        row = { ...row, ...data } as CredentialRow;
        return { count: 1 };
      },
    },
  };
  return { db: db as unknown as PrismaClient, getRow: () => row, setRow: (next: CredentialRow) => { row = next; } };
}

test("site form credential package round-trips atomically and always uses a fixed mask", () => {
  const key = randomBytes(32);
  const input = { username: "person@example.test", password: "  space / & = # password  " };
  const sealed = sealWebSourceFormCredential(input, key);
  const opened = sealSecret(webSourceFormKind, input, key);
  const packaged = openSealedSecret({ kind: webSourceFormKind, ...sealed }, key);

  assert.equal(sealed.maskedSuffix, "form");
  assert.equal(opened.maskedSuffix, "form");
  assert.equal(sealed.secretFingerprint, opened.secretFingerprint);
  assert.notEqual(sealed.secretFingerprint, createHash("sha256").update(packaged, "utf8").digest("hex"));
  assert.match(packaged, /^[A-Za-z0-9_-]+$/u);
  assert.deepEqual(JSON.parse(Buffer.from(packaged, "base64url").toString("utf8")), [
    "web-source-form-v1",
    input.username,
    input.password,
  ]);
  assert.equal(Buffer.from(sealed.ciphertext).includes(Buffer.from(input.username)), false);
  assert.equal(Buffer.from(sealed.ciphertext).includes(Buffer.from(input.password)), false);
  assert.equal(JSON.stringify({ maskedSuffix: sealed.maskedSuffix }).includes(input.username), false);
  assert.equal(JSON.stringify({ maskedSuffix: sealed.maskedSuffix }).includes(input.password.slice(-4)), false);
  assert.throws(
    () => openSealedSecret({ kind: "mcp", ...sealed }, key),
    (error: unknown) => error instanceof CredentialVaultError && error.code === "CREDENTIAL_DECRYPTION_FAILED",
  );
});

test("site form credential fields enforce the stated bounds and reject control characters", () => {
  const key = randomBytes(32);
  assert.doesNotThrow(() => sealWebSourceFormCredential({
    username: "u".repeat(512),
    password: "p".repeat(4_096),
  }, key));
  for (const invalid of [
    { username: "", password: "password" },
    { username: "u".repeat(513), password: "password" },
    { username: "owner", password: "" },
    { username: "owner", password: "p".repeat(4_097) },
    { username: "bad\nname", password: "password" },
    { username: "owner", password: "bad\u0000password" },
  ]) {
    assert.throws(
      () => sealWebSourceFormCredential(invalid, key),
      (error: unknown) => error instanceof CredentialVaultError && error.code === "CREDENTIAL_INVALID_INPUT",
    );
  }
});

test("site form credentials bind kind and fingerprint and rotate as one package", async () => {
  const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  const directory = await mkdtemp(join(tmpdir(), "ai-project-os-form-credential-"));
  const keyPath = join(directory, "master.key");
  const key = randomBytes(32);
  await writeFile(keyPath, `${key.toString("base64url")}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = keyPath;
  try {
    const firstInput = { username: "owner", password: "first password with spaces" };
    const first = sealWebSourceFormCredential(firstInput, key);
    const database = credentialDatabase({
      id: "credential-1",
      kind: webSourceFormKind,
      ...first,
    });

    assert.deepEqual(
      await readWebSourceFormCredential("credential-1", database.db, {
        expectedSecretFingerprint: first.secretFingerprint,
      }),
      firstInput,
    );
    await assert.rejects(
      readWebSourceFormCredential("credential-1", database.db, {
        expectedSecretFingerprint: "0".repeat(64),
      }),
      (error: unknown) => error instanceof CredentialVaultError && error.code === "CREDENTIAL_NOT_FOUND",
    );

    await rotateCredential("credential-1", webSourceFormKind, {
      username: "next-owner",
      password: "new password !@#$%^&*()",
    }, database.db);
    const rotated = database.getRow();
    assert.equal(rotated.maskedSuffix, "form");
    assert.notEqual(rotated.secretFingerprint, first.secretFingerprint);
    await assert.rejects(
      readWebSourceFormCredential("credential-1", database.db, {
        expectedSecretFingerprint: first.secretFingerprint,
      }),
      (error: unknown) => error instanceof CredentialVaultError && error.code === "CREDENTIAL_NOT_FOUND",
    );
    assert.deepEqual(
      await readWebSourceFormCredential("credential-1", database.db, {
        expectedSecretFingerprint: rotated.secretFingerprint,
      }),
      { username: "next-owner", password: "new password !@#$%^&*()" },
    );

    database.setRow({ ...rotated, kind: legacyWebSourceKind });
    await assert.rejects(
      readWebSourceFormCredential("credential-1", database.db),
      (error: unknown) => error instanceof CredentialVaultError && error.code === "CREDENTIAL_NOT_FOUND",
    );
  } finally {
    if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed authenticated site form package returns a stable decryption error", async () => {
  const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  const directory = await mkdtemp(join(tmpdir(), "ai-project-os-form-credential-"));
  const keyPath = join(directory, "master.key");
  const key = randomBytes(32);
  await writeFile(keyPath, `${key.toString("base64url")}\n`, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = keyPath;
  try {
    const malformed = "not-a-versioned-form-package";
    const encrypted = encryptedStoredValue(malformed, key);
    const database = credentialDatabase({
      id: "credential-malformed",
      kind: webSourceFormKind,
      maskedSuffix: "form",
      secretFingerprint: createHash("sha256").update(malformed, "utf8").digest("hex"),
      ...encrypted,
    });

    await assert.rejects(
      readWebSourceFormCredential("credential-malformed", database.db, {
        expectedSecretFingerprint: database.getRow().secretFingerprint,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CredentialVaultError);
        assert.equal(error.code, "CREDENTIAL_DECRYPTION_FAILED");
        assert.equal(error.message.includes(malformed), false);
        assert.equal(error.message.includes(key.toString("base64url")), false);
        return true;
      },
    );
  } finally {
    if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    await rm(directory, { recursive: true, force: true });
  }
});
