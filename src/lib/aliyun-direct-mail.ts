import { createHmac, randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api-errors";

const API_VERSION = "2015-11-23";
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EMAIL_LOCAL_PART_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u;
const EMAIL_DOMAIN_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const SAFE_PROVIDER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

const REGION_ENDPOINTS = Object.freeze({
  "cn-hangzhou": "dm.aliyuncs.com",
  "ap-southeast-1": "dm.ap-southeast-1.aliyuncs.com",
  "ap-southeast-2": "dm.ap-southeast-2.aliyuncs.com",
  "us-east-1": "dm.us-east-1.aliyuncs.com",
  "eu-central-1": "dm.eu-central-1.aliyuncs.com",
});

export type AliyunDirectMailRegion = keyof typeof REGION_ENDPOINTS;
export type AliyunDirectMailConfig = Readonly<{
  accessKeyId: string;
  accessKeySecret: string;
  regionId: AliyunDirectMailRegion;
  accountName: string;
}>;

export type AliyunDirectMailDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  now?: () => Date;
  nonce?: () => string;
}>;

type RpcParameters = Readonly<Record<string, string | number | boolean>>;
type EmailCodePurpose = "register" | "verify" | "password";

function notConfigured(): ApiError {
  return new ApiError(503, "EMAIL_NOT_CONFIGURED", "邮箱服务暂未配置，请联系管理员。");
}

function providerUnavailable(): ApiError {
  return new ApiError(503, "EMAIL_PROVIDER_UNAVAILABLE", "邮箱服务暂不可用，请稍后重试。");
}

function requestInvalid(): ApiError {
  return new ApiError(400, "EMAIL_REQUEST_INVALID", "邮箱验证码请求无效。");
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Signs DirectMail RPC parameters with the vendor's documented HMAC-SHA1 scheme. */
export function signAliyunDirectMailParameters(parameters: RpcParameters, accessKeySecret: string): string {
  const canonicalQuery = Object.entries(parameters)
    .filter(([name]) => name !== "Signature")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${rfc3986(name)}=${rfc3986(String(value))}`)
    .join("&");
  const stringToSign = `POST&%2F&${rfc3986(canonicalQuery)}`;
  return createHmac("sha1", `${accessKeySecret}&`).update(stringToSign, "utf8").digest("base64");
}

function isValidEmailShape(value: string): boolean {
  if (value.length === 0 || value.length > 320 || /[^\x21-\x7e]/u.test(value)) return false;
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf("@") !== separator) return false;
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  const labels = domain.split(".");
  return !(
    local.length > 64
    || local.startsWith(".")
    || local.endsWith(".")
    || local.includes("..")
    || !EMAIL_LOCAL_PART_PATTERN.test(local)
    || labels.length < 2
    || labels.some((label) => label.length === 0 || label.length > 63 || !EMAIL_DOMAIN_LABEL_PATTERN.test(label))
  );
}

function normalizeRecipient(value: unknown): string {
  if (typeof value !== "string") throw requestInvalid();
  const normalized = value.trim().toLowerCase();
  if (!isValidEmailShape(normalized)) throw requestInvalid();
  return normalized;
}

function validateAccountName(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !isValidEmailShape(value)) throw notConfigured();
  return value;
}

function readConfigValues(values: Readonly<Record<string, unknown>>): AliyunDirectMailConfig {
  const accessKeyId = values.AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID;
  const accessKeySecret = values.AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET;
  const regionId = values.AI_PROJECT_OS_ALIYUN_DM_REGION_ID;
  const accountName = values.AI_PROJECT_OS_ALIYUN_DM_ACCOUNT_NAME;
  const entries = [accessKeyId, accessKeySecret, regionId, accountName];
  if (entries.some((value) => typeof value !== "string" || value.length === 0 || value !== value.trim())) throw notConfigured();
  if (
    !/^[A-Za-z0-9_-]{1,128}$/u.test(accessKeyId as string)
    || !/^[!-~]{1,512}$/u.test(accessKeySecret as string)
    || !Object.hasOwn(REGION_ENDPOINTS, regionId as string)
  ) {
    throw notConfigured();
  }

  return Object.freeze({
    accessKeyId: accessKeyId as string,
    accessKeySecret: accessKeySecret as string,
    regionId: regionId as AliyunDirectMailRegion,
    accountName: validateAccountName(accountName),
  });
}

export function readAliyunDirectMailConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AliyunDirectMailConfig {
  return readConfigValues({
    AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID: env.AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID,
    AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET: env.AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET,
    AI_PROJECT_OS_ALIYUN_DM_REGION_ID: env.AI_PROJECT_OS_ALIYUN_DM_REGION_ID,
    AI_PROJECT_OS_ALIYUN_DM_ACCOUNT_NAME: env.AI_PROJECT_OS_ALIYUN_DM_ACCOUNT_NAME,
  });
}

function validateConfig(config: AliyunDirectMailConfig): AliyunDirectMailConfig {
  return readConfigValues({
    AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID: config?.accessKeyId,
    AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_SECRET: config?.accessKeySecret,
    AI_PROJECT_OS_ALIYUN_DM_REGION_ID: config?.regionId,
    AI_PROJECT_OS_ALIYUN_DM_ACCOUNT_NAME: config?.accountName,
  });
}

function assertRequest(input: unknown): {
  email: string;
  code: string;
  purpose: EmailCodePurpose;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw requestInvalid();
  const record = input as Record<string, unknown>;
  const email = normalizeRecipient(record.email);
  if (typeof record.code !== "string" || !/^[0-9]{6}$/u.test(record.code)) throw requestInvalid();
  if (record.purpose !== "register" && record.purpose !== "verify" && record.purpose !== "password") throw requestInvalid();
  return { email, code: record.code, purpose: record.purpose };
}

function mailContent(purpose: EmailCodePurpose, code: string): { subject: string; textBody: string } {
  const message = {
    register: { subject: "AI Project OS 注册邮箱验证码", action: "注册" },
    verify: { subject: "AI Project OS 邮箱验证", action: "验证邮箱" },
    password: { subject: "AI Project OS 密码重置验证码", action: "重置密码" },
  }[purpose];
  return {
    subject: message.subject,
    textBody: `你正在使用 AI Project OS ${message.action}。验证码：${code}。验证码 10 分钟内有效，请勿泄露给他人。`,
  };
}

function readSafeProviderId(value: unknown): string | null {
  return typeof value === "string" && SAFE_PROVIDER_ID_PATTERN.test(value) ? value : null;
}

async function readSuccessResponse(response: Response): Promise<{ requestId: string; envId: string }> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw providerUnavailable();
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && /^[0-9]{1,12}$/u.test(contentLength) && Number(contentLength) > RESPONSE_LIMIT_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw providerUnavailable();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw providerUnavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let parsed: unknown;
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    parsed = JSON.parse(body);
  } catch {
    throw providerUnavailable();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw providerUnavailable();

  const record = parsed as Record<string, unknown>;
  if (record.Code !== undefined && record.Code !== "OK") throw providerUnavailable();
  const requestId = readSafeProviderId(record.RequestId);
  const envId = readSafeProviderId(record.EnvId);
  if (!requestId || !envId) throw providerUnavailable();
  return { requestId, envId };
}

/** Sends one code email; the recipient is trimmed and lowercased before signing. */
export async function sendAliyunEmailCode(
  input: { email: string; code: string; purpose: EmailCodePurpose },
  config: AliyunDirectMailConfig,
  dependencies: AliyunDirectMailDependencies = {},
): Promise<{ requestId: string; envId: string }> {
  const request = assertRequest(input);
  const normalizedConfig = validateConfig(config);
  const nonce = (dependencies.nonce ?? randomUUID)();
  const now = (dependencies.now ?? (() => new Date()))();
  if (!UUID_V4_PATTERN.test(nonce) || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw providerUnavailable();

  const content = mailContent(request.purpose, request.code);
  const parameters = {
    Action: "SingleSendMail",
    Format: "JSON",
    Version: API_VERSION,
    RegionId: normalizedConfig.regionId,
    AccessKeyId: normalizedConfig.accessKeyId,
    Timestamp: now.toISOString().replace(/\.\d{3}Z$/u, "Z"),
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: nonce,
    AccountName: normalizedConfig.accountName,
    AddressType: 1,
    ReplyToAddress: false,
    ToAddress: request.email,
    FromAlias: "AI Project OS",
    Subject: content.subject,
    TextBody: content.textBody,
    ClickTrace: 0,
  } satisfies RpcParameters;
  const signature = signAliyunDirectMailParameters(parameters, normalizedConfig.accessKeySecret);
  const form = new URLSearchParams({ Signature: signature });
  for (const [name, value] of Object.entries(parameters)) form.append(name, String(value));

  const endpoint = `https://${REGION_ENDPOINTS[normalizedConfig.regionId]}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    const response = await (dependencies.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: form.toString(),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    return await readSuccessResponse(response);
  } catch (error) {
    if (error instanceof ApiError && error.code === "EMAIL_PROVIDER_UNAVAILABLE") throw error;
    throw providerUnavailable();
  } finally {
    clearTimeout(timer);
  }
}
