import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api-errors";

export type SmsCodePurpose = "register" | "login" | "close" | "recover" | "bind" | "change-old" | "change-new";
export function normalizeMainlandPhone(value: unknown): string {
  if (typeof value !== "string" || !/^(?:\+86)?1[3-9][0-9]{9}$/u.test(value)) {
    throw new ApiError(400, "PHONE_AUTH_INVALID_PHONE", "请输入有效的中国大陆手机号");
  }
  return value.startsWith("+86") ? value : `+86${value}`;
}
export function phoneFingerprint(phone: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(`phone-auth:phone:v1:${phone}`).digest("hex");
}
export function smsCodeDigest(input: { id: string; phone: string; purpose: SmsCodePurpose | "test"; code: string }, secret: Buffer): string {
  return createHmac("sha256", secret).update(`phone-auth:code:v1:${input.id}:${input.phone}:${input.purpose}:${input.code}`).digest("hex");
}
export function equalSmsDigest(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(a) || !/^[a-f0-9]{64}$/u.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
