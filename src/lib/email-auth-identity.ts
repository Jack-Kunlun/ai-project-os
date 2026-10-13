import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api-errors";
import type { AliyunDirectMailConfig } from "@/lib/aliyun-direct-mail";

const EMAIL_LOCAL_PART_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u;
const EMAIL_DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

function invalidEmail(): ApiError {
  return new ApiError(400, "EMAIL_AUTH_INVALID_EMAIL", "请输入有效的邮箱地址");
}

export function normalizeEmailAddress(value: unknown): string {
  if (typeof value !== "string") throw invalidEmail();
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 320 || /[^\x21-\x7e]/u.test(email)) throw invalidEmail();
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator !== email.indexOf("@") || separator === email.length - 1) throw invalidEmail();
  const local = email.slice(0, separator);
  const labels = email.slice(separator + 1).split(".");
  if (
    local.length > 64
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !EMAIL_LOCAL_PART_PATTERN.test(local)
    || labels.length < 2
    || labels.some((label) => label.length === 0 || label.length > 63 || !EMAIL_DOMAIN_LABEL_PATTERN.test(label))
  ) throw invalidEmail();
  return email;
}

export function deriveEmailAuthKey(masterKey: Buffer): Buffer {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new ApiError(503, "EMAIL_AUTH_UNAVAILABLE", "邮箱验证暂不可用，请稍后重试");
  }
  return createHmac("sha256", masterKey).update("ai-project-os:email-auth:key:v1", "utf8").digest();
}

function hmac(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key).update(`ai-project-os:email-auth:${domain}:v1:`, "utf8").update(value, "utf8").digest("hex");
}

export function emailFingerprint(email: string, key: Buffer): string {
  return hmac(key, "recipient", normalizeEmailAddress(email));
}

export function emailBudgetFingerprint(scope: string, value: string, key: Buffer): string {
  if (!/^[a-z_]{1,32}$/u.test(scope) || value.length === 0 || value.length > 256) {
    throw new ApiError(503, "EMAIL_AUTH_UNAVAILABLE", "邮箱验证暂不可用，请稍后重试");
  }
  return hmac(key, `budget:${scope}`, value);
}

export function emailConfigurationFingerprint(config: AliyunDirectMailConfig, key: Buffer): string {
  // The secret participates only as HMAC input; the resulting fingerprint is
  // safe to persist and changes when sender, region, key ID or key changes.
  return hmac(key, "sender-config", JSON.stringify([
    config.accessKeyId,
    config.accessKeySecret,
    config.regionId,
    config.accountName.trim().toLowerCase(),
  ]));
}

export function emailCodeDigest(input: { id: string; recipientFingerprint: string; purpose: string; code: string }, key: Buffer): string {
  if (
    !/^[0-9a-f-]{36}$/iu.test(input.id)
    || !FINGERPRINT_PATTERN.test(input.recipientFingerprint)
    || !/^(?:register|verify|password)$/u.test(input.purpose)
    || !/^[0-9]{6}$/u.test(input.code)
  ) throw new ApiError(400, "EMAIL_AUTH_CODE_INVALID", "邮箱验证码无效或已过期，请重新获取");
  return hmac(key, "code", JSON.stringify([input.id.toLowerCase(), input.recipientFingerprint, input.purpose, input.code]));
}

export function emailCaptchaDigest(input: {
  id: string;
  recipientFingerprint: string;
  browserFingerprint: string;
  purpose: string;
  actorId: string | null;
  actorAccountAccessVersion: number | null;
  actorSecurityRevision: number | null;
  actorEmailRevision: number | null;
  answer: string;
}, key: Buffer): string {
  return hmac(key, "captcha-answer", JSON.stringify([
    input.id.toLowerCase(),
    input.recipientFingerprint,
    input.browserFingerprint,
    input.purpose,
    input.actorId,
    input.actorAccountAccessVersion,
    input.actorSecurityRevision,
    input.actorEmailRevision,
    input.answer.toUpperCase(),
  ]));
}

export function equalEmailDigest(left: string, right: string): boolean {
  if (!FINGERPRINT_PATTERN.test(left) || !FINGERPRINT_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
