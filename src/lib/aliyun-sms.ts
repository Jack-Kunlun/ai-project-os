import { signAliyunAcs3 } from "@/lib/aliyun-acs3";
import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api-errors";

const ENDPOINT = "https://dypnsapi.aliyuncs.com/";
const API_VERSION = "2017-05-25";
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const EMPTY_BODY_SHA256 = createHash("sha256").update("").digest("hex");
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAINLAND_E164_PATTERN = /^\+861[3-9][0-9]{9}$/u;

export type SmsPurpose = "register" | "login" | "test" | "close" | "recover" | "bind" | "change-old" | "change-new";

export function smsPurposeSchemeSuffix(purpose: SmsPurpose): string {
  switch (purpose) {
    case "change-old": return "old";
    case "change-new": return "new";
    default: return purpose;
  }
}

export type AliyunSmsConfig = Readonly<{
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
  schemePrefix: string;
}>;

export type AliyunSmsDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  now?: () => Date;
  nonce?: () => string;
}>;

type RpcResponse = {
  Code?: unknown;
  Success?: unknown;
  Model?: { VerifyResult?: unknown } | null;
};

function notConfigured(): ApiError {
  return new ApiError(503, "SMS_NOT_CONFIGURED", "短信服务暂未配置，请联系管理员。");
}

function providerUnavailable(): ApiError {
  return new ApiError(503, "SMS_PROVIDER_UNAVAILABLE", "短信服务暂不可用，请稍后重试。");
}

function readConfigValues(values: Record<string, unknown>): AliyunSmsConfig {
  const accessKeyId = values.ALIYUN_SMS_AUTH_ACCESS_KEY_ID;
  const accessKeySecret = values.ALIYUN_SMS_AUTH_ACCESS_KEY_SECRET;
  const signName = values.ALIYUN_SMS_AUTH_SIGN_NAME;
  const templateCode = values.ALIYUN_SMS_AUTH_TEMPLATE_CODE;
  const schemePrefix = values.ALIYUN_SMS_AUTH_SCHEME_PREFIX;
  const entries = [accessKeyId, accessKeySecret, signName, templateCode, schemePrefix];
  if (entries.some((value) => typeof value !== "string" || value.length === 0 || value !== value.trim())) throw notConfigured();
  if (
    !/^[A-Za-z0-9_-]{1,12}$/u.test(schemePrefix as string)
    || (["register", "login", "test", "close", "recover", "bind", "change-old", "change-new"] as const).some((purpose) => `${schemePrefix}-${smsPurposeSchemeSuffix(purpose)}`.length > 20)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(accessKeyId as string)
    || (accessKeySecret as string).length > 512
    || /[\u0000-\u001f\u007f]/u.test(accessKeySecret as string)
    || (signName as string).length > 100
    || /[\u0000-\u001f\u007f]/u.test(signName as string)
    || (templateCode as string).length > 128
    || /[\u0000-\u001f\u007f]/u.test(templateCode as string)
  ) {
    throw notConfigured();
  }
  return Object.freeze({
    accessKeyId: accessKeyId as string,
    accessKeySecret: accessKeySecret as string,
    signName: signName as string,
    templateCode: templateCode as string,
    schemePrefix: schemePrefix as string,
  });
}

export function readAliyunSmsConfig(env: Readonly<Record<string, string | undefined>> = process.env): AliyunSmsConfig {
  return readConfigValues({
    ALIYUN_SMS_AUTH_ACCESS_KEY_ID: env.ALIYUN_SMS_AUTH_ACCESS_KEY_ID,
    ALIYUN_SMS_AUTH_ACCESS_KEY_SECRET: env.ALIYUN_SMS_AUTH_ACCESS_KEY_SECRET,
    ALIYUN_SMS_AUTH_SIGN_NAME: env.ALIYUN_SMS_AUTH_SIGN_NAME,
    ALIYUN_SMS_AUTH_TEMPLATE_CODE: env.ALIYUN_SMS_AUTH_TEMPLATE_CODE,
    ALIYUN_SMS_AUTH_SCHEME_PREFIX: env.ALIYUN_SMS_AUTH_SCHEME_PREFIX,
  });
}

function validateConfig(config: AliyunSmsConfig): AliyunSmsConfig {
  return readConfigValues({
    ALIYUN_SMS_AUTH_ACCESS_KEY_ID: config?.accessKeyId,
    ALIYUN_SMS_AUTH_ACCESS_KEY_SECRET: config?.accessKeySecret,
    ALIYUN_SMS_AUTH_SIGN_NAME: config?.signName,
    ALIYUN_SMS_AUTH_TEMPLATE_CODE: config?.templateCode,
    ALIYUN_SMS_AUTH_SCHEME_PREFIX: config?.schemePrefix,
  });
}

export function aliyunSmsScheme(purpose: SmsPurpose, config: AliyunSmsConfig = readAliyunSmsConfig()): string {
  if (!["register", "login", "test", "close", "recover", "bind", "change-old", "change-new"].includes(purpose)) throw notConfigured();
  const normalized = validateConfig(config);
  const schemeName = `${normalized.schemePrefix}-${smsPurposeSchemeSuffix(purpose)}`;
  if (schemeName.length > 20) throw notConfigured();
  return schemeName;
}

function assertRequestInput(input: { phoneE164: string; purpose: SmsPurpose; challengeId: string }): void {
  if (!MAINLAND_E164_PATTERN.test(input.phoneE164) || !UUID_V4_PATTERN.test(input.challengeId)) {
    throw new ApiError(400, "SMS_REQUEST_INVALID", "短信验证请求无效。");
  }
  if (!["register", "login", "test", "close", "recover", "bind", "change-old", "change-new"].includes(input.purpose)) {
    throw new ApiError(400, "SMS_REQUEST_INVALID", "短信验证请求无效。");
  }
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQueryString(parameters: Readonly<Record<string, string | number | boolean>>): string {
  return Object.entries(parameters)
    .map(([name, value]) => [rfc3986(name), rfc3986(String(value))] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function buildAuthorization(input: {
  action: "SendSmsVerifyCode" | "CheckSmsVerifyCode";
  query: string;
  config: AliyunSmsConfig;
  date: string;
  nonce: string;
}): { authorization: string; headers: Record<string, string> } {
  const headers = {
    host: "dypnsapi.aliyuncs.com",
    "x-acs-action": input.action,
    "x-acs-content-sha256": EMPTY_BODY_SHA256,
    "x-acs-date": input.date,
    "x-acs-signature-nonce": input.nonce,
    "x-acs-version": API_VERSION,
  };
  const authorization = signAliyunAcs3({ method: "POST", query: input.query, headers, payloadHash: EMPTY_BODY_SHA256, accessKeyId: input.config.accessKeyId, accessKeySecret: input.config.accessKeySecret });
  const requestHeaders = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "host"));
  return { authorization, headers: { ...requestHeaders, authorization, accept: "application/json" } };
}

async function readJsonResponse(response: Response, action: "SendSmsVerifyCode" | "CheckSmsVerifyCode"): Promise<RpcResponse> {
  // Read only the bounded body of the observed verification permission failure.
  // Other HTTP errors remain generic; provider Message/AccessDeniedDetail never escape.
  const checkPermissionFailure = action === "CheckSmsVerifyCode" && response.status === 403;
  if ((!response.ok && !checkPermissionFailure) || !response.body) {
    await response.body?.cancel().catch(() => undefined);
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
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))));
  } catch {
    throw providerUnavailable();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw providerUnavailable();
  const record = parsed as Record<string, unknown>;
  if (!response.ok) {
    if (checkPermissionFailure && record.Code === "Forbidden.NoPermission") {
      throw new ApiError(503, "SMS_PROVIDER_VERIFY_PERMISSION_DENIED", "阿里云凭据缺少验证码核验权限，请管理员授予 dypns:CheckSmsVerifyCode 权限。");
    }
    throw providerUnavailable();
  }
  const model = record.Model;
  return {
    Code: record.Code,
    Success: record.Success,
    Model: typeof model === "object" && model !== null && !Array.isArray(model)
      ? { VerifyResult: (model as Record<string, unknown>).VerifyResult }
      : null,
  };
}

async function invokeRpc(
  action: "SendSmsVerifyCode" | "CheckSmsVerifyCode",
  parameters: Readonly<Record<string, string | number | boolean>>,
  config: AliyunSmsConfig,
  dependencies: AliyunSmsDependencies,
): Promise<RpcResponse> {
  const normalizedConfig = validateConfig(config);
  const nonce = (dependencies.nonce ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(nonce)) throw providerUnavailable();
  const dateValue = (dependencies.now ?? (() => new Date()))();
  if (!(dateValue instanceof Date) || !Number.isFinite(dateValue.getTime())) throw providerUnavailable();
  const date = dateValue.toISOString().replace(/\.\d{3}Z$/u, "Z");
  const queryParameters = {
    Action: action,
    Format: "json",
    Version: API_VERSION,
    ...parameters,
  };
  const query = canonicalQueryString(queryParameters);
  const url = new URL(ENDPOINT);
  url.search = query;
  const signed = buildAuthorization({ action, query, config: normalizedConfig, date, nonce });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();

  try {
    const response = await (dependencies.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: signed.headers,
      redirect: "error",
      signal: controller.signal,
    });
    return await readJsonResponse(response, action);
  } catch (error) {
    if (error instanceof ApiError && (error.code === "SMS_PROVIDER_UNAVAILABLE" || error.code === "SMS_PROVIDER_VERIFY_PERMISSION_DENIED")) throw error;
    throw providerUnavailable();
  } finally {
    clearTimeout(timer);
  }
}

export async function sendAliyunSmsCode(
  input: { phoneE164: string; purpose: SmsPurpose; challengeId: string },
  config: AliyunSmsConfig,
  dependencies: AliyunSmsDependencies = {},
): Promise<void> {
  assertRequestInput(input);
  const normalizedConfig = validateConfig(config);
  const localPhone = input.phoneE164.slice(3);
  const result = await invokeRpc("SendSmsVerifyCode", {
    AutoRetry: 0,
    CodeLength: 6,
    CodeType: 1,
    CountryCode: 86,
    DuplicatePolicy: 1,
    Interval: 60,
    OutId: input.challengeId,
    PhoneNumber: localPhone,
    ReturnVerifyCode: false,
    SchemeName: aliyunSmsScheme(input.purpose, normalizedConfig),
    SignName: normalizedConfig.signName,
    TemplateCode: normalizedConfig.templateCode,
    TemplateParam: JSON.stringify({ code: "##code##", min: "5" }),
    ValidTime: 300,
  }, normalizedConfig, dependencies);
  if (result.Code !== "OK" || result.Success !== true) throw providerUnavailable();
}

export async function checkAliyunSmsCode(
  input: { phoneE164: string; purpose: SmsPurpose; challengeId: string; code: string },
  config: AliyunSmsConfig,
  dependencies: AliyunSmsDependencies = {},
): Promise<boolean> {
  assertRequestInput(input);
  if (!/^[0-9]{6}$/u.test(input.code)) throw new ApiError(400, "SMS_REQUEST_INVALID", "短信验证请求无效。");
  const normalizedConfig = validateConfig(config);
  const result = await invokeRpc("CheckSmsVerifyCode", {
    CountryCode: 86,
    OutId: input.challengeId,
    PhoneNumber: input.phoneE164.slice(3),
    SchemeName: aliyunSmsScheme(input.purpose, normalizedConfig),
    VerifyCode: input.code,
  }, normalizedConfig, dependencies);
  if (result.Code !== "OK" || result.Success !== true) throw providerUnavailable();
  return result.Model?.VerifyResult === "PASS";
}
