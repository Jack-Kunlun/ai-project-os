import { createHash, createHmac, randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api-errors";
import { signAliyunAcs3 } from "@/lib/aliyun-acs3";
import {
  aliyunSmsScheme,
  checkAliyunSmsCode,
  readAliyunSmsConfig,
  sendAliyunSmsCode,
  smsPurposeSchemeSuffix,
  type AliyunSmsConfig,
  type SmsPurpose,
} from "@/lib/aliyun-sms";

export type SmsProviderId = "aliyun-pnvs" | "aliyun-sms" | "tencent-sms";

export type AliyunSmsStandardConfig = Readonly<{
  provider: "aliyun-sms";
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
  codeParamName: string;
  validityParamName: string;
}>;

export type TencentSmsConfig = Readonly<{
  provider: "tencent-sms";
  secretId: string;
  secretKey: string;
  smsSdkAppId: string;
  signName: string;
  templateId: string;
  region: TencentSmsRegion;
  templateParams: readonly ("code" | "minutes")[];
}>;

export type TencentSmsRegion = "ap-beijing" | "ap-guangzhou" | "ap-nanjing";
export type SmsProviderConfig = AliyunSmsConfig | AliyunSmsStandardConfig | TencentSmsConfig;

export type SmsProviderDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  now?: () => Date;
  nonce?: () => string;
}>;

export type SmsSendInput = Readonly<{
  phoneE164: string;
  purpose: SmsPurpose;
  challengeId: string;
  code?: string;
}>;

export type SmsCheckInput = Readonly<{
  phoneE164: string;
  purpose: SmsPurpose;
  challengeId: string;
  code: string;
}>;

export type SmsProviderMetadata = Readonly<{
  signName: string;
  templateCode: string;
  schemePrefix: string | null;
  region?: TencentSmsRegion;
  smsSdkAppId?: string;
  codeParamName?: string;
  validityParamName?: string;
  templateParams?: readonly ("code" | "minutes")[];
}>;

const ALIYUN_SMS_ENDPOINT = "https://dysmsapi.aliyuncs.com/";
const ALIYUN_SMS_HOST = "dysmsapi.aliyuncs.com";
const ALIYUN_SMS_VERSION = "2017-05-25";
const TENCENT_SMS_ENDPOINT = "https://sms.tencentcloudapi.com/";
const TENCENT_SMS_HOST = "sms.tencentcloudapi.com";
const TENCENT_SMS_VERSION = "2021-01-11";
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAINLAND_E164_PATTERN = /^\+861[3-9][0-9]{9}$/u;
const VALID_PURPOSES = new Set<SmsPurpose>(["register", "login", "test", "close", "recover", "bind", "change-old", "change-new"]);
const TENCENT_REGIONS = new Set<TencentSmsRegion>(["ap-beijing", "ap-guangzhou", "ap-nanjing"]);

type PlainRecord = Record<string, unknown>;

function notConfigured(): ApiError {
  return new ApiError(503, "SMS_NOT_CONFIGURED", "短信服务暂未配置，请联系管理员。");
}

function providerUnavailable(): ApiError {
  return new ApiError(503, "SMS_PROVIDER_UNAVAILABLE", "短信服务暂不可用，请稍后重试。");
}

function requestInvalid(): ApiError {
  return new ApiError(400, "SMS_REQUEST_INVALID", "短信验证请求无效。");
}

function asPlainRecord(value: unknown): PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw notConfigured();
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw notConfigured();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw notConfigured();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw notConfigured();
    }
    return value as PlainRecord;
  } catch (error) {
    if (error instanceof ApiError && error.code === "SMS_NOT_CONFIGURED") throw error;
    throw notConfigured();
  }
}

function assertExactKeys(record: PlainRecord, allowed: readonly string[]): void {
  const keys = Object.keys(record);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw notConfigured();
}

function readText(record: PlainRecord, name: string, maximumLength: number, pattern?: RegExp, allowEmpty = false): string {
  const value = record[name];
  if (
    typeof value !== "string"
    || value !== value.trim()
    || (!allowEmpty && value.length === 0)
    || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /[a-z][a-z\d+.-]*:\/\//iu.test(value)
    || (pattern !== undefined && value.length > 0 && !pattern.test(value))
  ) {
    throw notConfigured();
  }
  return value;
}

function normalizePnvsConfig(record: PlainRecord, explicitProvider: boolean): AliyunSmsConfig {
  assertExactKeys(record, explicitProvider
    ? ["provider", "accessKeyId", "accessKeySecret", "signName", "templateCode", "schemePrefix"]
    : ["accessKeyId", "accessKeySecret", "signName", "templateCode", "schemePrefix"]);
  if (explicitProvider && record.provider !== "aliyun-pnvs") throw notConfigured();
  const accessKeyId = readText(record, "accessKeyId", 128, /^[A-Za-z0-9_-]+$/u);
  const accessKeySecret = readText(record, "accessKeySecret", 256);
  const signName = readText(record, "signName", 64);
  const templateCode = readText(record, "templateCode", 128);
  const schemePrefix = readText(record, "schemePrefix", 11, /^[A-Za-z0-9_-]+$/u);
  const config = readAliyunSmsConfig({
    ALIYUN_SMS_AUTH_ACCESS_KEY_ID: accessKeyId,
    ALIYUN_SMS_AUTH_ACCESS_KEY_SECRET: accessKeySecret,
    ALIYUN_SMS_AUTH_SIGN_NAME: signName,
    ALIYUN_SMS_AUTH_TEMPLATE_CODE: templateCode,
    ALIYUN_SMS_AUTH_SCHEME_PREFIX: schemePrefix,
  });
  if ([config.accessKeyId, config.accessKeySecret, config.signName, config.templateCode].some((value) => /[a-z][a-z\d+.-]*:\/\//iu.test(value))) {
    throw notConfigured();
  }
  return config;
}

function normalizeAliyunSmsConfig(record: PlainRecord): AliyunSmsStandardConfig {
  assertExactKeys(record, ["provider", "accessKeyId", "accessKeySecret", "signName", "templateCode", "codeParamName", "validityParamName"]);
  const accessKeyId = readText(record, "accessKeyId", 128, /^[A-Za-z0-9_-]+$/u);
  const accessKeySecret = readText(record, "accessKeySecret", 512);
  const signName = readText(record, "signName", 100);
  const templateCode = readText(record, "templateCode", 128, /^SMS_[A-Za-z0-9_-]{1,124}$/u);
  const codeParamName = readText(record, "codeParamName", 32, /^[A-Za-z][A-Za-z0-9_]*$/u);
  const validityParamName = readText(record, "validityParamName", 32, /^[A-Za-z][A-Za-z0-9_]*$/u, true);
  if (
    record.provider !== "aliyun-sms"
    || (validityParamName !== "" && validityParamName === codeParamName)
    || (["register", "login", "test", "close", "recover", "bind", "change-old", "change-new"] as const).some((purpose) => `aliyun-sms-${smsPurposeSchemeSuffix(purpose)}`.length > 20)
  ) {
    throw notConfigured();
  }
  return Object.freeze({ provider: "aliyun-sms", accessKeyId, accessKeySecret, signName, templateCode, codeParamName, validityParamName });
}

function normalizeTencentSmsConfig(record: PlainRecord): TencentSmsConfig {
  assertExactKeys(record, ["provider", "secretId", "secretKey", "smsSdkAppId", "signName", "templateId", "region", "templateParams"]);
  const secretId = readText(record, "secretId", 128, /^[A-Za-z0-9_-]+$/u);
  const secretKey = readText(record, "secretKey", 512);
  const smsSdkAppId = readText(record, "smsSdkAppId", 32, /^[0-9]+$/u);
  const signName = readText(record, "signName", 100);
  const templateId = readText(record, "templateId", 32, /^[0-9]+$/u);
  const region = record.region;
  if (
    record.provider !== "tencent-sms"
    || typeof region !== "string"
    || !TENCENT_REGIONS.has(region as TencentSmsRegion)
    || !Array.isArray(record.templateParams)
    || record.templateParams.length < 1
    || record.templateParams.length > 2
    || record.templateParams.filter((value) => value === "code").length !== 1
    || record.templateParams.some((value) => value !== "code" && value !== "minutes")
    || new Set(record.templateParams).size !== record.templateParams.length
  ) {
    throw notConfigured();
  }
  return Object.freeze({
    provider: "tencent-sms",
    secretId,
    secretKey,
    smsSdkAppId,
    signName,
    templateId,
    region: region as TencentSmsRegion,
    templateParams: Object.freeze([...record.templateParams]) as readonly ("code" | "minutes")[],
  });
}

/** Normalize persisted provider config and reject endpoint/extension fields. */
export function normalizeSmsProviderConfig(input: unknown): SmsProviderConfig {
  const record = asPlainRecord(input);
  if (!Object.hasOwn(record, "provider")) return normalizePnvsConfig(record, false);
  if (record.provider === "aliyun-pnvs") return normalizePnvsConfig(record, true);
  if (record.provider === "aliyun-sms") return normalizeAliyunSmsConfig(record);
  if (record.provider === "tencent-sms") return normalizeTencentSmsConfig(record);
  throw notConfigured();
}

export function smsProviderId(config: SmsProviderConfig): SmsProviderId {
  const normalized = normalizeSmsProviderConfig(config);
  return "provider" in normalized ? normalized.provider : "aliyun-pnvs";
}

export function smsProviderScheme(purpose: SmsPurpose, config: SmsProviderConfig): string {
  if (!VALID_PURPOSES.has(purpose)) throw requestInvalid();
  const normalized = normalizeSmsProviderConfig(config);
  if (!("provider" in normalized)) return aliyunSmsScheme(purpose, normalized);
  const scheme = `${normalized.provider}-${smsPurposeSchemeSuffix(purpose)}`;
  if (scheme.length > 20) throw notConfigured();
  return scheme;
}

export function smsProviderMetadata(config: SmsProviderConfig): SmsProviderMetadata {
  const normalized = normalizeSmsProviderConfig(config);
  if (!("provider" in normalized)) {
    return Object.freeze({ signName: normalized.signName, templateCode: normalized.templateCode, schemePrefix: normalized.schemePrefix });
  }
  if (normalized.provider === "aliyun-sms") {
    return Object.freeze({
      signName: normalized.signName,
      templateCode: normalized.templateCode,
      schemePrefix: null,
      codeParamName: normalized.codeParamName,
      validityParamName: normalized.validityParamName,
    });
  }
  return Object.freeze({
    signName: normalized.signName,
    templateCode: normalized.templateId,
    schemePrefix: null,
    region: normalized.region,
    smsSdkAppId: normalized.smsSdkAppId,
    templateParams: Object.freeze([...normalized.templateParams]),
  });
}

function assertSendInput(input: SmsSendInput): void {
  if (
    !input
    || !MAINLAND_E164_PATTERN.test(input.phoneE164)
    || !UUID_V4_PATTERN.test(input.challengeId)
    || !VALID_PURPOSES.has(input.purpose)
  ) {
    throw requestInvalid();
  }
}

function assertCode(code: unknown): asserts code is string {
  if (typeof code !== "string" || !/^[0-9]{6}$/u.test(code)) throw requestInvalid();
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

function buildAliyunSmsAuthorization(input: {
  query: string;
  config: AliyunSmsStandardConfig;
  date: string;
  nonce: string;
}): { headers: Record<string, string> } {
  const emptyPayloadHash = createHash("sha256").update("").digest("hex");
  const headers = {
    host: ALIYUN_SMS_HOST,
    "x-acs-action": "SendSms",
    "x-acs-content-sha256": emptyPayloadHash,
    "x-acs-date": input.date,
    "x-acs-signature-nonce": input.nonce,
    "x-acs-version": ALIYUN_SMS_VERSION,
  };
  const authorization = signAliyunStandardRequest(input.config, headers, input.query, emptyPayloadHash);
  return {
    headers: {
      "x-acs-action": headers["x-acs-action"],
      "x-acs-content-sha256": headers["x-acs-content-sha256"],
      "x-acs-date": headers["x-acs-date"],
      "x-acs-signature-nonce": headers["x-acs-signature-nonce"],
      "x-acs-version": headers["x-acs-version"],
      authorization,
      accept: "application/json",
    },
  };
}

function signAliyunStandardRequest(
  config: AliyunSmsStandardConfig,
  headers: Readonly<Record<string, string>>,
  query: string,
  payloadHash: string,
): string {
  // Reuse the repository's ACS3 signer without changing its public compatibility surface.
  return signAliyunAcs3({
    method: "POST",
    query,
    headers,
    payloadHash,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
  });
}

function buildTencentAuthorization(input: {
  config: TencentSmsConfig;
  body: string;
  timestamp: number;
}): { authorization: string; scope: string } {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/sms/tc3_request`;
  const payloadHash = createHash("sha256").update(input.body, "utf8").digest("hex");
  const canonicalHeaders = `content-type:application/json\nhost:${TENCENT_SMS_HOST}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(input.timestamp),
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const dateKey = createHmac("sha256", `TC3${input.config.secretKey}`).update(date, "utf8").digest();
  const serviceKey = createHmac("sha256", dateKey).update("sms", "utf8").digest();
  const signingKey = createHmac("sha256", serviceKey).update("tc3_request", "utf8").digest();
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${input.config.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    scope,
  };
}

async function readJsonResponse(response: Response): Promise<PlainRecord> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw providerUnavailable();
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^[0-9]+$/u.test(declaredLength) && Number(declaredLength) > RESPONSE_LIMIT_BYTES) {
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
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return asPlainResponseRecord(parsed);
  } catch {
    throw providerUnavailable();
  }
}

function asPlainResponseRecord(value: unknown): PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw providerUnavailable();
  return value as PlainRecord;
}

async function postJson(input: {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  dependencies: SmsProviderDependencies;
}): Promise<PlainRecord> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await (input.dependencies.fetchImpl ?? fetch)(input.endpoint, {
      method: "POST",
      headers: input.headers,
      body: input.body,
      redirect: "error",
      signal: controller.signal,
    });
    return await readJsonResponse(response);
  } catch (error) {
    if (error instanceof ApiError && error.code === "SMS_PROVIDER_UNAVAILABLE") throw error;
    throw providerUnavailable();
  } finally {
    clearTimeout(timer);
  }
}

async function sendAliyunSms(input: SmsSendInput, config: AliyunSmsStandardConfig, dependencies: SmsProviderDependencies): Promise<void> {
  assertCode(input.code);
  const nonce = (dependencies.nonce ?? randomUUID)();
  if (!UUID_V4_PATTERN.test(nonce)) throw providerUnavailable();
  const dateValue = (dependencies.now ?? (() => new Date()))();
  if (!(dateValue instanceof Date) || !Number.isFinite(dateValue.getTime())) throw providerUnavailable();
  const date = dateValue.toISOString().replace(/\.\d{3}Z$/u, "Z");
  const templateParameters: Record<string, string> = { [config.codeParamName]: input.code };
  if (config.validityParamName !== "") templateParameters[config.validityParamName] = "5";
  const query = canonicalQueryString({
    Action: "SendSms",
    Format: "json",
    OutId: input.challengeId,
    PhoneNumbers: input.phoneE164.slice(3),
    SignName: config.signName,
    TemplateCode: config.templateCode,
    TemplateParam: JSON.stringify(templateParameters),
    Version: ALIYUN_SMS_VERSION,
  });
  const signed = buildAliyunSmsAuthorization({ query, config, date, nonce });
  const response = await postJson({
    endpoint: `${ALIYUN_SMS_ENDPOINT}?${query}`,
    headers: signed.headers,
    body: "",
    dependencies,
  });
  if (response.Code !== "OK" || typeof response.BizId !== "string" || response.BizId.trim().length === 0) throw providerUnavailable();
}

async function sendTencentSms(input: SmsSendInput, config: TencentSmsConfig, dependencies: SmsProviderDependencies): Promise<void> {
  assertCode(input.code);
  const dateValue = (dependencies.now ?? (() => new Date()))();
  if (!(dateValue instanceof Date) || !Number.isFinite(dateValue.getTime())) throw providerUnavailable();
  const timestamp = Math.floor(dateValue.getTime() / 1000);
  const body = JSON.stringify({
    PhoneNumberSet: [input.phoneE164],
    SmsSdkAppId: config.smsSdkAppId,
    SignName: config.signName,
    TemplateId: config.templateId,
    TemplateParamSet: config.templateParams.map((parameter) => parameter === "code" ? input.code : "5"),
    SessionContext: input.challengeId,
  });
  const signed = buildTencentAuthorization({ config, body, timestamp });
  const response = await postJson({
    endpoint: TENCENT_SMS_ENDPOINT,
    headers: {
      authorization: signed.authorization,
      "content-type": "application/json",
      "x-tc-action": "SendSms",
      "x-tc-region": config.region,
      "x-tc-timestamp": String(timestamp),
      "x-tc-version": TENCENT_SMS_VERSION,
      accept: "application/json",
    },
    body,
    dependencies,
  });
  const providerResponse = response.Response;
  if (
    typeof providerResponse !== "object"
    || providerResponse === null
    || Array.isArray(providerResponse)
    || Object.hasOwn(providerResponse, "Error")
  ) {
    throw providerUnavailable();
  }
  const sendStatuses = (providerResponse as PlainRecord).SendStatusSet;
  if (!Array.isArray(sendStatuses) || sendStatuses.length !== 1) throw providerUnavailable();
  const status = sendStatuses[0];
  if (
    typeof status !== "object"
    || status === null
    || Array.isArray(status)
    || (status as PlainRecord).Code !== "Ok"
    || (status as PlainRecord).PhoneNumber !== input.phoneE164
    || typeof (status as PlainRecord).SerialNo !== "string"
    || ((status as PlainRecord).SerialNo as string).trim().length === 0
    || (Object.hasOwn(status, "SessionContext") && (status as PlainRecord).SessionContext !== input.challengeId)
  ) {
    throw providerUnavailable();
  }
}

export async function sendSmsCode(
  input: SmsSendInput,
  config: SmsProviderConfig,
  dependencies: SmsProviderDependencies = {},
): Promise<void> {
  assertSendInput(input);
  const normalized = normalizeSmsProviderConfig(config);
  if (!("provider" in normalized)) {
    await sendAliyunSmsCode({ phoneE164: input.phoneE164, purpose: input.purpose, challengeId: input.challengeId }, normalized, dependencies);
    return;
  }
  if (normalized.provider === "aliyun-sms") {
    await sendAliyunSms(input, normalized, dependencies);
    return;
  }
  await sendTencentSms(input, normalized, dependencies);
}

export async function checkSmsCode(
  input: SmsCheckInput,
  config: SmsProviderConfig,
  dependencies: SmsProviderDependencies = {},
): Promise<boolean> {
  if (!input || !MAINLAND_E164_PATTERN.test(input.phoneE164) || !UUID_V4_PATTERN.test(input.challengeId) || !VALID_PURPOSES.has(input.purpose)) {
    throw requestInvalid();
  }
  assertCode(input.code);
  const normalized = normalizeSmsProviderConfig(config);
  if ("provider" in normalized) throw providerUnavailable();
  return checkAliyunSmsCode(input, normalized, dependencies);
}
