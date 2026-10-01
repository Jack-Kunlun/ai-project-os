import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
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
const WEB_SOURCE_FORM_KIND: ExternalCredentialKind = "webSourceForm";
const WEB_SOURCE_FORM_PACKAGE_VERSION = "web-source-form-v1";
const MAX_WEB_SOURCE_FORM_PACKAGE_LENGTH = 32_768;
type CredentialDb = PrismaClient | Prisma.TransactionClient;

export type WebSourceFormCredential = Readonly<{
  username: string;
  password: string;
}>;

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
  await assertSecureMasterKeyParent(path);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size < 43 || metadata.size > 44) {
      return fail("CREDENTIAL_MASTER_KEY_INSECURE");
    }
    return parseMasterKey(await handle.readFile({ encoding: "utf8" }));
  } finally {
    await handle.close();
  }
}

async function assertSecureMasterKeyParent(path: string): Promise<void> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 || ![0, process.getuid?.()].includes(parent.uid)) {
    return fail("CREDENTIAL_MASTER_KEY_INSECURE");
  }
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
  await assertSecureMasterKeyParent(path);
  const key = randomBytes(MASTER_KEY_BYTES);
  try {
    const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${key.toString("base64url")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return readSecureMasterKey(path);
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

/**
 * Recovery verification must never create a key while checking an existing
 * database.  Keep this read-only counterpart separate from the normal
 * application bootstrap path so a missing key fails closed.
 */
export async function readExistingMasterKey(): Promise<Buffer> {
  return readSecureMasterKey(masterKeyPath());
}

function validateWebSourceFormUsername(
  value: unknown,
  invalidCode: CredentialVaultErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    CONTROL_PATTERN.test(value) ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    return fail(invalidCode);
  }
  return value;
}

function encodeWebSourceFormCredential(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("CREDENTIAL_INVALID_INPUT");
  }
  let username: unknown;
  let password: unknown;
  try {
    const keys = Reflect.ownKeys(input);
    const usernameDescriptor = Object.getOwnPropertyDescriptor(input, "username");
    const passwordDescriptor = Object.getOwnPropertyDescriptor(input, "password");
    if (
      keys.length !== 2 ||
      !keys.includes("username") ||
      !keys.includes("password") ||
      usernameDescriptor === undefined ||
      !("value" in usernameDescriptor) ||
      passwordDescriptor === undefined ||
      !("value" in passwordDescriptor)
    ) {
      return fail("CREDENTIAL_INVALID_INPUT");
    }
    username = usernameDescriptor.value;
    password = passwordDescriptor.value;
  } catch {
    return fail("CREDENTIAL_INVALID_INPUT");
  }
  username = validateWebSourceFormUsername(username, "CREDENTIAL_INVALID_INPUT");
  if (
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > 4_096 ||
    CONTROL_PATTERN.test(password) ||
    Buffer.from(password, "utf8").toString("utf8") !== password
  ) {
    return fail("CREDENTIAL_INVALID_INPUT");
  }
  const serialized = JSON.stringify([WEB_SOURCE_FORM_PACKAGE_VERSION, username, password]);
  const encoded = Buffer.from(serialized, "utf8").toString("base64url");
  if (encoded.length > MAX_WEB_SOURCE_FORM_PACKAGE_LENGTH) {
    return fail("CREDENTIAL_INVALID_INPUT");
  }
  return encoded;
}

function decodeWebSourceFormCredential(
  encoded: unknown,
  invalidCode: CredentialVaultErrorCode,
): WebSourceFormCredential {
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length > MAX_WEB_SOURCE_FORM_PACKAGE_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    return fail(invalidCode);
  }
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return fail(invalidCode);
    const serialized = bytes.toString("utf8");
    if (!Buffer.from(serialized, "utf8").equals(bytes)) return fail(invalidCode);
    const parsed: unknown = JSON.parse(serialized);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed[0] !== WEB_SOURCE_FORM_PACKAGE_VERSION ||
      typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string" ||
      JSON.stringify(parsed) !== serialized
    ) {
      return fail(invalidCode);
    }
    const username = validateWebSourceFormUsername(parsed[1], invalidCode);
    const password = parsed[2];
    if (
      password.length < 1 ||
      password.length > 4_096 ||
      CONTROL_PATTERN.test(password) ||
      Buffer.from(password, "utf8").toString("utf8") !== password
    ) {
      return fail(invalidCode);
    }
    return Object.freeze({ username, password });
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    return fail(invalidCode);
  }
}

function canonicalSecret(
  kind: ExternalCredentialKind,
  value: unknown,
  invalidCode: CredentialVaultErrorCode = "CREDENTIAL_INVALID_INPUT",
): string {
  if (kind === WEB_SOURCE_FORM_KIND) {
    decodeWebSourceFormCredential(value, invalidCode);
    return value as string;
  }
  const maximumLength = kind === "git" ? 32_768 : kind === "mcp" || kind === "webSource" || kind === "oidcClient" || kind === "oidcFlow" || kind === "githubOauthFlow" ? 4_096 : 512;
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
  if ((kind === "oidcFlow" || kind === "githubOauthFlow") && !/^[A-Za-z0-9_-]+$/.test(value)) {
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
  const secret = canonicalSecret(
    kind,
    kind === WEB_SOURCE_FORM_KIND ? encodeWebSourceFormCredential(secretInput) : secretInput,
  );
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
    maskedSuffix: kind === WEB_SOURCE_FORM_KIND ? "form" : secret.slice(-4),
    secretFingerprint: kind === WEB_SOURCE_FORM_KIND
      ? createHmac("sha256", key).update("ai-project-os:web-source-form-fingerprint:v1\n", "utf8").update(secret, "utf8").digest("hex")
      : createHash("sha256").update(secret, "utf8").digest("hex"),
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
    return canonicalSecret(
      credential.kind,
      value,
      credential.kind === WEB_SOURCE_FORM_KIND ? "CREDENTIAL_DECRYPTION_FAILED" : "CREDENTIAL_INVALID_INPUT",
    );
  } catch (error) {
    if (error instanceof CredentialVaultError) throw error;
    return fail("CREDENTIAL_DECRYPTION_FAILED");
  }
}

export function sealWebSourceFormCredential(
  input: WebSourceFormCredential,
  key: Buffer,
): SealedSecret {
  return sealSecret(WEB_SOURCE_FORM_KIND, input, key);
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

export async function readWebSourceFormCredential(
  credentialId: string,
  db: CredentialDb,
  options: Readonly<{ expectedSecretFingerprint?: string }> = {},
): Promise<WebSourceFormCredential> {
  const packageValue = await readCredentialSecret(
    credentialId,
    WEB_SOURCE_FORM_KIND,
    db,
    options,
  );
  return decodeWebSourceFormCredential(packageValue, "CREDENTIAL_DECRYPTION_FAILED");
}
