import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type {
  ExternalCredential,
  ExternalCredentialKind,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { getDb } from "@/lib/db";

const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_VERSION = 1;
const MASTER_KEY_FILE_NAME = "master.key";
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
type CredentialDb = PrismaClient | Prisma.TransactionClient;

export type CredentialVaultErrorCode =
  | "CREDENTIAL_INVALID_INPUT"
  | "CREDENTIAL_MASTER_KEY_UNAVAILABLE"
  | "CREDENTIAL_MASTER_KEY_INSECURE"
  | "CREDENTIAL_DECRYPTION_FAILED"
  | "CREDENTIAL_NOT_FOUND";

export class CredentialVaultError extends Error {
  constructor(readonly code: CredentialVaultErrorCode) {
    super(code);
    this.name = "CredentialVaultError";
  }
}

export type SealedSecret = Readonly<{
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  authTag: Uint8Array<ArrayBuffer>;
  keyVersion: 1;
  maskedSuffix: string;
  secretFingerprint: string;
}>;

function fail(code: CredentialVaultErrorCode): never {
  throw new CredentialVaultError(code);
}

function masterKeyPath(): string {
  const configured = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  if (configured === undefined || configured.length === 0) {
    return join(homedir(), ".ai-project-os", MASTER_KEY_FILE_NAME);
  }
  if (
    !isAbsolute(configured) ||
    normalize(configured) !== configured ||
    configured.trim() !== configured ||
    CONTROL_PATTERN.test(configured)
  ) {
    return fail("CREDENTIAL_MASTER_KEY_UNAVAILABLE");
  }
  return configured;
}

function parseMasterKey(value: string): Buffer {
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  let key: Buffer;
  try {
    key = Buffer.from(normalized, "base64url");
  } catch {
    return fail("CREDENTIAL_MASTER_KEY_UNAVAILABLE");
  }
  return key.length === MASTER_KEY_BYTES ? key : fail("CREDENTIAL_MASTER_KEY_UNAVAILABLE");
}

async function readSecureMasterKey(path: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    return fail("CREDENTIAL_MASTER_KEY_INSECURE");
  }
  return parseMasterKey(await readFile(path, "utf8"));
}

export async function loadOrCreateMasterKey(): Promise<Buffer> {
  const path = masterKeyPath();
  try {
    return await readSecureMasterKey(path);
  } catch (error) {
    if (
      error instanceof CredentialVaultError ||
      !(typeof error === "object" && error !== null && "code" in error) ||
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(MASTER_KEY_BYTES);
  try {
    const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${key.toString("base64url")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EEXIST"
    ) {
      return readSecureMasterKey(path);
    }
    return fail("CREDENTIAL_MASTER_KEY_UNAVAILABLE");
  }
}

function canonicalSecret(kind: ExternalCredentialKind, value: unknown): string {
  const maximumLength = kind === "git" ? 32_768 : kind === "mcp" || kind === "oidcClient" || kind === "oidcFlow" ? 4_096 : 512;
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /\s/u.test(value) ||
    CONTROL_PATTERN.test(value)
  ) {
    return fail("CREDENTIAL_INVALID_INPUT");
  }
  if (
    kind === "github" &&
    !/^github_pat_[A-Za-z0-9_]{32,240}$/.test(value)
  ) {
    return fail("CREDENTIAL_INVALID_INPUT");
  }
  if (kind === "git" && !/^[A-Za-z0-9_-]+$/.test(value)) {
    return fail("CREDENTIAL_INVALID_INPUT");
  }
  if (kind === "oidcFlow" && !/^[A-Za-z0-9_-]+$/.test(value)) {
    return fail("CREDENTIAL_INVALID_INPUT");
  }
  return value;
}

function aad(kind: ExternalCredentialKind, keyVersion: number): Buffer {
  return Buffer.from(`ai-project-os:credential:v2:${kind}:${keyVersion}`, "utf8");
}

export function sealSecret(
  kind: ExternalCredentialKind,
  secretInput: unknown,
  key: Buffer,
): SealedSecret {
  const secret = canonicalSecret(kind, secretInput);
  if (key.length !== MASTER_KEY_BYTES) return fail("CREDENTIAL_MASTER_KEY_UNAVAILABLE");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad(kind, KEY_VERSION));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Object.freeze({
    ciphertext: Uint8Array.from(ciphertext),
    nonce: Uint8Array.from(nonce),
    authTag: Uint8Array.from(authTag),
    keyVersion: KEY_VERSION,
    maskedSuffix: secret.slice(-4),
    secretFingerprint: createHash("sha256").update(secret, "utf8").digest("hex"),
  });
}

export function openSealedSecret(
  credential: Pick<ExternalCredential, "kind" | "ciphertext" | "nonce" | "authTag" | "keyVersion">,
  key: Buffer,
): string {
  if (
    credential.keyVersion !== KEY_VERSION ||
    key.length !== MASTER_KEY_BYTES ||
    credential.nonce.length !== NONCE_BYTES ||
    credential.authTag.length !== AUTH_TAG_BYTES
  ) {
    return fail("CREDENTIAL_DECRYPTION_FAILED");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, credential.nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(aad(credential.kind, credential.keyVersion));
    decipher.setAuthTag(credential.authTag);
    const value = Buffer.concat([
      decipher.update(credential.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return canonicalSecret(credential.kind, value);
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    return fail("CREDENTIAL_DECRYPTION_FAILED");
  }
}

export async function createCredential(
  kind: ExternalCredentialKind,
  secret: unknown,
  db: CredentialDb = getDb(),
): Promise<Pick<ExternalCredential, "id" | "kind" | "maskedSuffix" | "createdAt" | "updatedAt">> {
  const sealed = sealSecret(kind, secret, await loadOrCreateMasterKey());
  return db.externalCredential.create({
    data: { kind, ...sealed },
    select: { id: true, kind: true, maskedSuffix: true, createdAt: true, updatedAt: true },
  });
}

export async function rotateCredential(
  credentialId: string,
  kind: ExternalCredentialKind,
  secret: unknown,
  db: CredentialDb = getDb(),
): Promise<void> {
  const sealed = sealSecret(kind, secret, await loadOrCreateMasterKey());
  const result = await db.externalCredential.updateMany({
    where: { id: credentialId, kind },
    data: { ...sealed, rotatedAt: new Date() },
  });
  if (result.count !== 1) return fail("CREDENTIAL_NOT_FOUND");
}

export async function readCredentialSecret(
  credentialId: string,
  expectedKind: ExternalCredentialKind,
  db: CredentialDb = getDb(),
  options: Readonly<{ expectedSecretFingerprint?: string }> = {},
): Promise<string> {
  const credential = await db.externalCredential.findUnique({ where: { id: credentialId } });
  if (credential === null || credential.kind !== expectedKind) {
    return fail("CREDENTIAL_NOT_FOUND");
  }
  if (options.expectedSecretFingerprint !== undefined &&
    (typeof options.expectedSecretFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(options.expectedSecretFingerprint) ||
      credential.secretFingerprint !== options.expectedSecretFingerprint)) {
    return fail("CREDENTIAL_NOT_FOUND");
  }
  return openSealedSecret(credential, await loadOrCreateMasterKey());
}
