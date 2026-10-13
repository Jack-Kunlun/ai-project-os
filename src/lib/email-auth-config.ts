import { ApiError } from "@/lib/api-errors";
import { readAliyunDirectMailConfig, type AliyunDirectMailConfig } from "@/lib/aliyun-direct-mail";
import { readExistingMasterKey } from "@/lib/credential-vault";
import { deriveEmailAuthKey, emailConfigurationFingerprint } from "@/lib/email-auth-identity";

export type EmailAuthStatus = "disabled" | "unavailable" | "available";
export type ActiveEmailAuthConfig = Readonly<{
  mail: AliyunDirectMailConfig;
  key: Buffer;
  configFingerprint: string;
}>;

export function isEmailAuthEnabled(): boolean {
  return process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED === "true";
}

function unavailable(): ApiError {
  return new ApiError(503, "EMAIL_AUTH_UNAVAILABLE", "邮箱验证暂不可用，请稍后重试");
}

export async function loadEmailAuthConfig(): Promise<ActiveEmailAuthConfig> {
  if (!isEmailAuthEnabled()) throw new ApiError(503, "EMAIL_AUTH_DISABLED", "邮箱验证暂未开放");
  try {
    const mail = readAliyunDirectMailConfig();
    const key = deriveEmailAuthKey(await readExistingMasterKey());
    return Object.freeze({ mail, key, configFingerprint: emailConfigurationFingerprint(mail, key) });
  } catch {
    throw unavailable();
  }
}

export async function getEmailAuthStatus(): Promise<EmailAuthStatus> {
  if (!isEmailAuthEnabled()) return "disabled";
  try {
    await loadEmailAuthConfig();
    return "available";
  } catch {
    return "unavailable";
  }
}
