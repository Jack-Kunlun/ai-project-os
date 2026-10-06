import { consumeGraphicCaptcha } from "@/lib/graphic-captcha-service";
import { randomInt, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type SmsProviderConfig, type SmsProviderProbe } from "@prisma/client";
import { z } from "zod";
import { assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess } from "@/lib/access-linearization";
import { ApiError } from "@/lib/api-errors";
import { assertEntitlementWriterSession, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import { checkSmsCode, normalizeSmsProviderConfig, sendSmsCode, smsProviderId, smsProviderMetadata, type SmsProviderConfig as ProviderConfig, type SmsProviderId } from "@/lib/sms-providers";
import {
  isPhoneAuthEnabled,
  loadActiveSmsConfig,
  lockSmsConfiguration,
  openSmsConfig,
  phoneAuthSecret,
  sealSmsConfig,
} from "@/lib/phone-auth-config";
import { equalSmsDigest, normalizeMainlandPhone, smsCodeDigest } from "@/lib/phone-auth-identity";
import { reserveSmsSendBudget, reserveSmsVerifyBudget, smsDatabaseClock } from "@/lib/phone-auth-budget";

const CONFIG_ID = "active" as const;
// PNVS uses SchemeName to bind send/check to a purpose. This is an application
// namespace, not a supplier setting. Keep stored configurations untouched so
// outstanding challenges continue to check against their original scheme.
const PNVS_ADMIN_SCHEME_PREFIX = "aipos";
const UUID_SCHEMA = z.string().uuid();
const VERSION_SCHEMA = z.number().int().min(0).max(2_147_483_646);
const CODE_SCHEMA = z.string().regex(/^[0-9]{6}$/u);

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
export type SmsProviderAdminActor = Readonly<{ id: string; role: string; accountAccessVersion: number }>;
export type SmsProviderConfigCandidate = ProviderConfig;

function invalidInput(): never {
  throw new ApiError(400, "SMS_PROVIDER_ADMIN_INVALID_INPUT", "短信服务配置请求无效");
}
function adminRequired(): never {
  throw new ApiError(403, "SMS_PROVIDER_ADMIN_REQUIRED", "仅平台管理员可以管理短信服务");
}
function stale(): never {
  throw new ApiError(409, "SMS_PROVIDER_CONFIG_STALE", "短信服务配置已变化，请刷新后重试");
}
function probeInvalid(): never {
  throw new ApiError(409, "SMS_PROVIDER_PROBE_REQUIRED", "请先完成当前配置的短信验证");
}
function probeRestartRequired(): never {
  throw new ApiError(409, "SMS_PROVIDER_TEST_RESTART_REQUIRED", "当前短信测试已失效，请重新发送测试短信后验证");
}
function probeExpired(): never {
  throw new ApiError(409, "SMS_PROVIDER_TEST_EXPIRED", "测试验证码已过期，请重新发送测试短信");
}
function unavailable(): never {
  throw new ApiError(503, "SMS_PROVIDER_ADMIN_UNAVAILABLE", "短信服务暂不可用，请稍后再试");
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Provider registry rejects unrecognized fields and any endpoint override. */
export function parseSmsProviderCandidate(input: unknown): Readonly<{ provider: SmsProviderId; config: ProviderConfig }> {
  try {
    const value = record(input);
    const candidate = value && (value.provider === undefined || value.provider === "aliyun-pnvs")
      // Accept the legacy UI field during rolling upgrades, but never let an
      // administrator choose the application's namespace. Unknown fields are
      // still rejected by the provider registry below.
      ? { ...value, schemePrefix: PNVS_ADMIN_SCHEME_PREFIX }
      : input;
    const config = normalizeSmsProviderConfig(candidate);
    return Object.freeze({ provider: smsProviderId(config), config });
  } catch { return invalidInput(); }
}

function actorHint(actor: unknown): SmsProviderAdminActor {
  const value = record(actor);
  if (value === null || !UUID_SCHEMA.safeParse(value.id).success || value.role !== "admin"
    || typeof value.accountAccessVersion !== "number" || !Number.isSafeInteger(value.accountAccessVersion) || value.accountAccessVersion < 1) return adminRequired();
  return Object.freeze({ id: value.id as string, role: "admin", accountAccessVersion: value.accountAccessVersion });
}

/** Must be called with this actor's advisory lock held for mutations. */
async function currentAdmin(tx: Tx, actor: SmsProviderAdminActor): Promise<boolean> {
  const current = await tx.appUser.findUnique({
    where: { id: actor.id },
    select: { id: true, role: true, disabledAt: true, accountAccessVersion: true },
  });
  if (!current || current.role !== "admin" || current.disabledAt !== null || current.accountAccessVersion !== actor.accountAccessVersion) return false;
  try {
    await assertAccountAccessForActor(tx, actor);
    return true;
  } catch {
    return false;
  }
}

async function requireCurrentAdmin(tx: Tx, actor: SmsProviderAdminActor): Promise<void> {
  await lockActorAccess(tx, actor.id);
  if (!(await currentAdmin(tx, actor))) adminRequired();
}

async function writer(tx: Tx, db: Db): Promise<void> {
  if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
}

async function setSmsAdminContext(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context', 'service-v1', true)`;
}

function expectedVersion(value: unknown): number {
  const result = VERSION_SCHEMA.safeParse(value);
  return result.success ? result.data : invalidInput();
}

function assertActiveVersion(current: SmsProviderConfig | null, expected: number): number {
  const version = current?.version ?? 0;
  if (version !== expected) stale();
  if (version >= 2_147_483_646) stale();
  return version;
}

async function activeVersion(tx: Tx): Promise<SmsProviderConfig | null> {
  return tx.smsProviderConfig.findUnique({ where: { id: CONFIG_ID } });
}

function publicConfig(row: SmsProviderConfig | null, details?: ReturnType<typeof smsProviderMetadata>) {
  return Object.freeze({
    configured: row !== null,
    provider: row?.provider ?? null,
    version: row?.version ?? 0,
    enabled: row?.enabled ?? false,
    verifiedAt: row?.verifiedAt.toISOString() ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    signName: details?.signName ?? null,
    templateCode: details?.templateCode ?? null,
    schemePrefix: details?.schemePrefix ?? null,
    region: details?.region ?? null,
    smsSdkAppId: details?.smsSdkAppId ?? null,
    codeParamName: details?.codeParamName ?? null,
    validityParamName: details?.validityParamName ?? null,
    templateParams: details?.templateParams ?? null,
    canDecrypt: row === null || details !== undefined,
  });
}

export async function getSmsProviderAdminState(actorInput: unknown, db: Db = getEntitlementDb()) {
  const actor = actorHint(actorInput);
  const user = await db.appUser.findUnique({ where: { id: actor.id }, select: { id: true, role: true, disabledAt: true, accountAccessVersion: true } });
  if (!user || user.role !== "admin" || user.disabledAt !== null || user.accountAccessVersion !== actor.accountAccessVersion) adminRequired();
  try { await assertAccountAccessForActor(db, actor); } catch { adminRequired(); }
  const [row, audits] = await Promise.all([
    db.smsProviderConfig.findUnique({ where: { id: CONFIG_ID } }),
    db.smsProviderConfigAudit.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
      select: { id: true, actorId: true, action: true, provider: true, configVersion: true, enabled: true, createdAt: true },
    }),
  ]);
  let details: ReturnType<typeof smsProviderMetadata> | undefined;
  let phoneAuthReady = false;
  let smsLimitsReady = false;
  try { phoneAuthSecret(); smsLimitsReady = true; } catch { /* Admin UI reports the setup prerequisite without exposing key material. */ }
  if (row) {
    try {
      const config = await openSmsConfig(row, "active");
      details = smsProviderMetadata(config);
    } catch {
      // Show that an encrypted configuration exists, but never surface decryption details.
    }
    if (row.enabled && isPhoneAuthEnabled()) {
      try { await loadActiveSmsConfig(db); phoneAuthReady = true; } catch { /* Fail closed and report unavailable. */ }
    }
  }
  return Object.freeze({
    phoneAuthEnabled: isPhoneAuthEnabled(),
    phoneAuthReady,
    smsLimitsReady,
    config: publicConfig(row, details),
    audits: audits.map((audit) => Object.freeze({ ...audit, createdAt: audit.createdAt.toISOString() })),
  });
}

export async function sendSmsProviderProbe(input: unknown, actorInput: unknown, db: Db = getEntitlementDb(), browserToken: string = "") {
  const actor = actorHint(actorInput);
  const value = record(input);
  if (value === null || Object.keys(value).sort().join(",") !== "captcha,config,expectedVersion,phone") return invalidInput();
  const candidate = parseSmsProviderCandidate(value.config);
  const version = expectedVersion(value.expectedVersion);
  let phone: string;
  try { phone = normalizeMainlandPhone(value.phone); } catch { return invalidInput(); }
  await consumeGraphicCaptcha({ phone, purpose: "test", actor, browserToken, captcha: value.captcha }, db);
  const id = randomUUID();
  const sealed = await sealSmsConfig(candidate.config, id);
  const code = candidate.provider === "aliyun-pnvs" ? undefined : randomInt(1_000_000).toString().padStart(6, "0");
  const expectedCodeDigest = code === undefined ? null : smsCodeDigest({ id, phone, purpose: "test", code }, phoneAuthSecret());
  const admitted = await db.$transaction(async (tx) => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    const budget = await reserveSmsSendBudget(tx, phone);
    await requireCurrentAdmin(tx, actor);
    await setSmsAdminContext(tx);
    const active = await activeVersion(tx);
    assertActiveVersion(active, version);
    const now = budget.now;
    const row = await tx.smsProviderProbe.create({
      data: {
        id,
        actorId: actor.id,
        actorAccountAccessVersion: actor.accountAccessVersion,
        baseVersion: version,
        provider: candidate.provider,
        expectedCodeDigest,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        authTag: sealed.authTag,
        fingerprint: sealed.fingerprint,
        phoneE164: phone,
        phoneFingerprint: budget.fingerprint,
        status: "pending",
        attemptCount: 0,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      },
      select: { id: true, expiresAt: true },
    });
    return row;
  });

  try {
    await sendSmsCode({ phoneE164: phone, purpose: "test", challengeId: id, code }, candidate.config);
  } catch {
    await markProbeFailed(id, actor, db).catch(() => undefined);
    throw new ApiError(503, "SMS_PROVIDER_TEST_SEND_FAILED", "测试短信发送失败，请核对供应商签名、模板和密钥后重试");
  }

  const completion = await db.$transaction(async (tx) => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await lockActorAccess(tx, actor.id);
    await setSmsAdminContext(tx);
    const active = await activeVersion(tx);
    const probe = await tx.smsProviderProbe.findUnique({ where: { id } });
    const authorized = await currentAdmin(tx, actor);
    const now = await smsDatabaseClock(tx);
    if (!authorized || (active?.version ?? 0) !== version || !probe || probe.status !== "pending" || probe.expiresAt <= now) {
      if (probe?.status === "pending") await tx.smsProviderProbe.update({ where: { id }, data: { status: "failed" } });
      return false;
    }
    const changed = await tx.smsProviderProbe.updateMany({ where: { id, status: "pending", expiresAt: { gt: now } }, data: { status: "sent" } });
    return changed.count === 1;
  });
  if (!completion) stale();
  return Object.freeze({ probeId: id, expiresAt: admitted.expiresAt.toISOString(), retryAfterSeconds: 60 });
}

async function markProbeFailed(id: string, actor: SmsProviderAdminActor, db: Db): Promise<void> {
  await db.$transaction(async (tx) => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await lockActorAccess(tx, actor.id);
    await setSmsAdminContext(tx);
    const current = await tx.smsProviderProbe.findUnique({ where: { id }, select: { status: true, consumedAt: true } });
    if (current && current.consumedAt === null && current.status !== "failed") {
      await tx.smsProviderProbe.update({ where: { id }, data: { status: "failed" } });
    }
  });
}

type VerifyAdmission = Readonly<{ probe: SmsProviderProbe; alreadyVerified: boolean }>;
export async function verifySmsProviderProbe(input: unknown, actorInput: unknown, db: Db = getEntitlementDb()) {
  const actor = actorHint(actorInput);
  const value = record(input);
  if (value === null || Object.keys(value).sort().join(",") !== "code,probeId") return invalidInput();
  const probeId = UUID_SCHEMA.safeParse(value.probeId);
  const code = CODE_SCHEMA.safeParse(value.code);
  if (!probeId.success || !code.success) return invalidInput();
  const admission = await db.$transaction(async (tx): Promise<VerifyAdmission> => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    const initial = await tx.smsProviderProbe.findUnique({ where: { id: probeId.data } });
    if (!initial || initial.actorId !== actor.id) probeInvalid();
    const budget = await reserveSmsVerifyBudget(tx, initial.phoneE164);
    await requireCurrentAdmin(tx, actor);
    const rows = await tx.$queryRaw<SmsProviderProbe[]>`SELECT * FROM "SmsProviderProbe" WHERE "id"=${probeId.data}::uuid FOR UPDATE`;
    const probe = rows[0];
    const active = await activeVersion(tx);
    if (!probe || probe.actorId !== actor.id || probe.actorAccountAccessVersion !== actor.accountAccessVersion
      || !(["aliyun-pnvs", "aliyun-sms", "tencent-sms"].includes(probe.provider)) || probe.baseVersion !== (active?.version ?? 0)
      || probe.phoneE164 !== initial.phoneE164 || probe.phoneFingerprint !== budget.fingerprint
      || probe.consumedAt !== null) probeInvalid();
    if (probe.status === "failed") probeRestartRequired();
    if (probe.expiresAt <= budget.now) probeExpired();
    if (probe.status === "verified") return { probe, alreadyVerified: true };
    if (probe.status !== "sent" || probe.attemptCount >= 5) probeInvalid();
    await setSmsAdminContext(tx);
    const incremented = await tx.smsProviderProbe.updateMany({ where: { id: probe.id, status: "sent", attemptCount: { lt: 5 }, expiresAt: { gt: budget.now }, consumedAt: null }, data: { attemptCount: { increment: 1 } } });
    if (incremented.count !== 1) probeInvalid();
    return { probe, alreadyVerified: false };
  });

  if (admission.alreadyVerified) return Object.freeze({ verified: true, probeId: admission.probe.id, expiresAt: admission.probe.expiresAt.toISOString() });
  const config = await openSmsConfig(admission.probe, admission.probe.id).catch(() => {
    return unavailable();
  });
  let passed = false;
  try {
    if (smsProviderId(config) === "aliyun-pnvs") {
      if (admission.probe.expectedCodeDigest !== null) probeInvalid();
      passed = await checkSmsCode({ phoneE164: admission.probe.phoneE164, purpose: "test", challengeId: admission.probe.id, code: code.data }, config);
    } else {
      const digest = smsCodeDigest({ id: admission.probe.id, phone: admission.probe.phoneE164, purpose: "test", code: code.data }, phoneAuthSecret());
      passed = admission.probe.expectedCodeDigest !== null && equalSmsDigest(admission.probe.expectedCodeDigest, digest);
    }
  } catch (error) {
    await markProbeFailed(admission.probe.id, actor, db).catch(() => undefined);
    if (error instanceof ApiError && error.code === "SMS_PROVIDER_VERIFY_PERMISSION_DENIED") {
      throw new ApiError(503, "SMS_PROVIDER_TEST_VERIFY_FAILED", "阿里云凭据缺少 dypns:CheckSmsVerifyCode 核验权限。请补充授权后重新发送测试短信；当前测试已失效。");
    }
    throw new ApiError(503, "SMS_PROVIDER_TEST_VERIFY_FAILED", "短信核验调用失败，当前测试已失效。请重新发送测试短信后验证");
  }
  const completion = await db.$transaction(async (tx) => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await lockActorAccess(tx, actor.id);
    await setSmsAdminContext(tx);
    const active = await activeVersion(tx);
    const rows = await tx.$queryRaw<SmsProviderProbe[]>`SELECT * FROM "SmsProviderProbe" WHERE "id"=${admission.probe.id}::uuid FOR UPDATE`;
    const probe = rows[0];
    const now = await smsDatabaseClock(tx);
    if (!(await currentAdmin(tx, actor)) || (active?.version ?? 0) !== admission.probe.baseVersion || !probe
      || probe.status !== "sent" || probe.actorId !== actor.id || probe.actorAccountAccessVersion !== actor.accountAccessVersion
      || probe.attemptCount !== admission.probe.attemptCount + 1 || probe.expiresAt <= now || probe.consumedAt !== null) {
      if (probe?.status === "sent" && probe.consumedAt === null) await tx.smsProviderProbe.update({ where: { id: probe.id }, data: { status: "failed" } });
      return "stale" as const;
    }
    if (!passed) {
      if (probe.attemptCount >= 5) await tx.smsProviderProbe.update({ where: { id: probe.id }, data: { status: "failed" } });
      return "invalid" as const;
    }
    const updated = await tx.smsProviderProbe.updateMany({ where: { id: probe.id, status: "sent", attemptCount: admission.probe.attemptCount + 1, expiresAt: { gt: now }, consumedAt: null }, data: { status: "verified", verifiedAt: now } });
    return updated.count === 1 ? "verified" as const : "stale" as const;
  });
  if (completion === "stale") stale();
  if (completion === "invalid") throw new ApiError(400, "SMS_PROVIDER_TEST_CODE_INVALID", "验证码无效或已过期，请核对短信后重试");
  return Object.freeze({ verified: true, probeId: admission.probe.id, expiresAt: admission.probe.expiresAt.toISOString() });
}

export async function saveSmsProviderConfig(input: unknown, actorInput: unknown, db: Db = getEntitlementDb()) {
  const actor = actorHint(actorInput);
  const value = record(input);
  if (value === null || Object.keys(value).sort().join(",") !== "expectedVersion,probeId") return invalidInput();
  const version = expectedVersion(value.expectedVersion);
  const probeId = UUID_SCHEMA.safeParse(value.probeId);
  if (!probeId.success) return invalidInput();
  const snapshot = await db.smsProviderProbe.findUnique({ where: { id: probeId.data } });
  if (!snapshot || snapshot.actorId !== actor.id || snapshot.actorAccountAccessVersion !== actor.accountAccessVersion || snapshot.baseVersion !== version || snapshot.status !== "verified" || snapshot.consumedAt !== null) probeInvalid();
  const config = await openSmsConfig(snapshot, snapshot.id).catch(() => unavailable());
  const sealed = await sealSmsConfig(config, "active").catch(() => unavailable());

  const saved = await db.$transaction(async (tx) => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await requireCurrentAdmin(tx, actor);
    await setSmsAdminContext(tx);
    const now = await smsDatabaseClock(tx);
    const current = await activeVersion(tx);
    const baseVersion = assertActiveVersion(current, version);
    const rows = await tx.$queryRaw<SmsProviderProbe[]>`SELECT * FROM "SmsProviderProbe" WHERE "id"=${probeId.data}::uuid FOR UPDATE`;
    const probe = rows[0];
    if (!probe || probe.actorId !== actor.id || probe.actorAccountAccessVersion !== actor.accountAccessVersion || probe.baseVersion !== baseVersion
      || probe.fingerprint !== snapshot.fingerprint || probe.status !== "verified" || !probe.verifiedAt || probe.consumedAt !== null || probe.expiresAt <= now) probeInvalid();
    const nextVersion = baseVersion + 1;
    const data = { provider: smsProviderId(config), version: nextVersion, enabled: true, ciphertext: sealed.ciphertext, nonce: sealed.nonce, authTag: sealed.authTag, fingerprint: sealed.fingerprint, verifiedAt: now, updatedById: actor.id, updatedAt: now };
    // PostgreSQL fires BEFORE INSERT even for ON CONFLICT updates. Choose the
    // operation under the shared configuration lock so each proof uses its base version.
    const updated = current
      ? await tx.smsProviderConfig.update({ where: { id: CONFIG_ID }, data })
      : await tx.smsProviderConfig.create({ data: { id: CONFIG_ID, ...data } });
    await tx.smsProviderProbe.update({ where: { id: probe.id }, data: { consumedAt: now } });
    await tx.smsProviderConfigAudit.create({ data: { id: randomUUID(), actorId: actor.id, action: "configured", provider: smsProviderId(config), configVersion: nextVersion, enabled: true, createdAt: now } });
    await invalidateVersion(tx, baseVersion);
    return updated;
  });
  return Object.freeze({ config: publicConfig(saved, smsProviderMetadata(config)) });
}

async function invalidateVersion(tx: Tx, oldVersion: number): Promise<void> {
  await setSmsAdminContext(tx);
  await tx.smsAuthChallenge.updateMany({
    where: { configVersion: oldVersion, status: { in: ["pending", "sent"] }, consumedAt: null },
    data: { status: "superseded" },
  });
  await tx.smsProviderProbe.updateMany({
    where: { baseVersion: oldVersion, status: { in: ["pending", "sent", "verified"] }, consumedAt: null },
    data: { status: "failed" },
  });
}

export async function setSmsProviderEnabled(input: unknown, actorInput: unknown, db: Db = getEntitlementDb()) {
  const actor = actorHint(actorInput);
  const value = record(input);
  if (value === null || Object.keys(value).sort().join(",") !== "enabled,expectedVersion" || typeof value.enabled !== "boolean") return invalidInput();
  const enabled = value.enabled;
  const version = expectedVersion(value.expectedVersion);
  const result = await db.$transaction(async (tx) => {
    await writer(tx, db);
    await lockSmsConfiguration(tx);
    await requireCurrentAdmin(tx, actor);
    await setSmsAdminContext(tx);
    const now = await smsDatabaseClock(tx);
    const current = await activeVersion(tx);
    const baseVersion = assertActiveVersion(current, version);
    if (!current) probeInvalid();
    if (current.enabled === enabled) return current;
    const nextVersion = baseVersion + 1;
    const updated = await tx.smsProviderConfig.update({
      where: { id: CONFIG_ID },
      data: { enabled, version: nextVersion, updatedById: actor.id, updatedAt: now },
    });
    await tx.smsProviderConfigAudit.create({ data: { id: randomUUID(), actorId: actor.id, action: enabled ? "enabled" : "disabled", provider: current.provider, configVersion: nextVersion, enabled, createdAt: now } });
    await invalidateVersion(tx, baseVersion);
    return updated;
  });
  const config = await openSmsConfig(result, "active").catch(() => unavailable());
  const details = smsProviderMetadata(config);
  return Object.freeze({ config: publicConfig(result, details) });
}
