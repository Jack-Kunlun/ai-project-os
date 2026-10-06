import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { normalizeSmsProviderConfig, smsProviderId, type SmsProviderConfig, type SmsProviderId } from "@/lib/sms-providers";
import { loadOrCreateMasterKey, readExistingMasterKey } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";

export type PhoneAuthStatus = "disabled" | "unavailable" | "available";
type Db = PrismaClient | Prisma.TransactionClient;
export type ActiveSmsConfig = { version: number; provider: SmsProviderId; fingerprint: string; config: SmsProviderConfig };
type SealedConfig = { ciphertext: Uint8Array<ArrayBuffer>; nonce: Uint8Array<ArrayBuffer>; authTag: Uint8Array<ArrayBuffer>; fingerprint: string };
export function isPhoneAuthEnabled(): boolean { return process.env.PHONE_AUTH_ENABLED === "true"; }
function unavailable(): ApiError { return new ApiError(503, "PHONE_AUTH_UNAVAILABLE", "短信验证暂不可用，请稍后再试或使用其他登录方式"); }
export function phoneAuthSecret(): Buffer {
  const value = process.env.PHONE_AUTH_SECRET;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) throw unavailable();
  const secret = Buffer.from(value, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== value) throw unavailable();
  return secret;
}

/** All activation, issue/verification admission and final consumption share this fence.
 * Lock order: configuration -> admission/phone identity -> actor -> workspace.
 * External HTTP requests always occur after the transaction commits.
 */
export async function lockSmsConfiguration(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sms-provider-configuration-v1',0))`;
}
function aad(context: string, provider: SmsProviderId): Buffer { return Buffer.from(`ai-project-os:sms-provider:${provider}:v1:${context}`, "utf8"); }
export async function sealSmsConfig(config: SmsProviderConfig, context: string): Promise<SealedConfig> {
  try {
    const key = await loadOrCreateMasterKey();
    const normalized = normalizeSmsProviderConfig(config);
    const plain = JSON.stringify(normalized);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(context, smsProviderId(normalized)));
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const fingerprint = createHmac("sha256", key).update(aad("fingerprint", smsProviderId(normalized))).update(plain).digest("hex");
    return { ciphertext: Uint8Array.from(ciphertext), nonce: Uint8Array.from(nonce), authTag: Uint8Array.from(cipher.getAuthTag()), fingerprint };
  } catch { throw unavailable(); }
}
export async function openSmsConfig(row: Pick<SealedConfig, "ciphertext" | "nonce" | "authTag" | "fingerprint"> & { provider?: string }, context: string): Promise<SmsProviderConfig> {
  try {
    if (row.nonce.length !== 12 || row.authTag.length !== 16 || row.ciphertext.length > 4096) throw unavailable();
    const provider = row.provider ?? "aliyun-pnvs";
    if (provider !== "aliyun-pnvs" && provider !== "aliyun-sms" && provider !== "tencent-sms") throw unavailable();
    const key = await readExistingMasterKey();
    const decipher = createDecipheriv("aes-256-gcm", key, row.nonce);
    decipher.setAAD(aad(context, provider));
    decipher.setAuthTag(row.authTag);
    const plain = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
    const config = normalizeSmsProviderConfig(JSON.parse(plain));
    if (smsProviderId(config) !== provider) throw unavailable();
    const fingerprint = createHmac("sha256", key).update(aad("fingerprint", provider)).update(JSON.stringify(config)).digest("hex");
    if (row.fingerprint !== fingerprint) throw unavailable();
    return config;
  } catch { throw unavailable(); }
}
export async function loadActiveSmsConfig(db: Db = getDb()): Promise<ActiveSmsConfig> {
  if (!isPhoneAuthEnabled()) throw unavailable();
  phoneAuthSecret();
  const row = await db.smsProviderConfig.findUnique({ where: { id: "active" } });
  if (!row || !row.enabled || !(["aliyun-pnvs", "aliyun-sms", "tencent-sms"].includes(row.provider)) || row.version < 1) throw unavailable();
  return { version: row.version, provider: row.provider as SmsProviderId, fingerprint: row.fingerprint, config: await openSmsConfig(row, "active") };
}
export async function assertSmsConfigVersion(tx: Prisma.TransactionClient, version: number): Promise<void> {
  if (!isPhoneAuthEnabled()) throw unavailable();
  const row = await tx.smsProviderConfig.findUnique({ where: { id: "active" }, select: { version: true, enabled: true } });
  if (!row?.enabled || row.version !== version) throw unavailable();
}
export async function getPhoneAuthStatus(db: Db = getDb()): Promise<PhoneAuthStatus> {
  if (!isPhoneAuthEnabled()) return "disabled";
  try { await loadActiveSmsConfig(db); return "available"; } catch { return "unavailable"; }
}
