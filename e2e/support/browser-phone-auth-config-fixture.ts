import { randomUUID } from "node:crypto";
import type { AppUser, Prisma } from "@prisma/client";
import { getEntitlementDb } from "@/lib/db";
import { readExistingMasterKey } from "@/lib/credential-vault";
import { lockSmsConfiguration, openSmsConfig, phoneAuthSecret, sealSmsConfig } from "@/lib/phone-auth-config";
import { phoneFingerprint, smsCodeDigest } from "@/lib/phone-auth-identity";
import { smsProviderId, type SmsProviderConfig } from "@/lib/sms-providers";

const DATABASE_NAME = "ai_project_os_feedback_layout_test";
const DATABASE_PORT = "56432";
const DATABASE_PRINCIPAL = "ai_project_os_entitlement_writer";
const APP_ORIGIN = "http://127.0.0.1:4302";
const FIXTURE_PHONE = "+8613899999999";
const FIXTURE_CONFIG: SmsProviderConfig = {
  accessKeyId: "test-key",
  accessKeySecret: "test-only-secret",
  signName: "测试专用",
  templateCode: "100001",
  schemePrefix: "gate",
};

type Admin = Pick<AppUser, "id" | "accountAccessVersion" | "role" | "disabledAt">;

function parseDatabaseUrl(value: string | undefined, expectedPrincipal?: string): URL {
  if (!value) throw new Error("BROWSER_PHONE_FIXTURE_DATABASE_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("BROWSER_PHONE_FIXTURE_DATABASE_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || parsed.hostname !== "127.0.0.1"
    || parsed.port !== DATABASE_PORT
    || decodeURIComponent(parsed.pathname) !== `/${DATABASE_NAME}`
    || parsed.search !== ""
    || parsed.hash !== ""
    || (expectedPrincipal !== undefined && decodeURIComponent(parsed.username) !== expectedPrincipal)
  ) {
    throw new Error("BROWSER_PHONE_FIXTURE_DATABASE_OUT_OF_SCOPE");
  }
  return parsed;
}

function assertFixtureEnvironment(): void {
  if (process.env.PHONE_AUTH_ENABLED !== "true") throw new Error("BROWSER_PHONE_FIXTURE_PHONE_AUTH_DISABLED");
  let app: URL;
  try {
    app = new URL(process.env.BROWSER_E2E_BASE_URL ?? "");
  } catch {
    throw new Error("BROWSER_PHONE_FIXTURE_APP_INVALID");
  }
  if (app.origin !== APP_ORIGIN || app.pathname !== "/" || app.username !== "" || app.password !== "" || app.search !== "" || app.hash !== "") {
    throw new Error("BROWSER_PHONE_FIXTURE_APP_OUT_OF_SCOPE");
  }
  const writer = parseDatabaseUrl(process.env.ENTITLEMENT_DATABASE_URL, DATABASE_PRINCIPAL);
  const runtime = parseDatabaseUrl(process.env.DATABASE_URL);
  if (writer.hostname !== runtime.hostname || writer.port !== runtime.port || writer.pathname !== runtime.pathname) {
    throw new Error("BROWSER_PHONE_FIXTURE_DATABASE_ENDPOINT_MISMATCH");
  }
  phoneAuthSecret();
}

async function createVerifiedProbe(
  tx: Prisma.TransactionClient,
  actor: Admin,
  baseVersion: number,
  config: SmsProviderConfig,
) {
  const id = randomUUID();
  const provider = smsProviderId(config);
  const sealed = await sealSmsConfig(config, id);
  const secret = phoneAuthSecret();
  const now = new Date();
  await tx.smsProviderProbe.create({
    data: {
      id,
      actorId: actor.id,
      actorAccountAccessVersion: actor.accountAccessVersion,
      baseVersion,
      provider,
      ...sealed,
      phoneE164: FIXTURE_PHONE,
      phoneFingerprint: phoneFingerprint(FIXTURE_PHONE, secret),
      expectedCodeDigest: provider === "aliyun-pnvs" ? null : smsCodeDigest({ id, phone: FIXTURE_PHONE, purpose: "test", code: "123456" }, secret),
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 240_000),
    },
  });
  await tx.smsProviderProbe.update({ where: { id }, data: { status: "sent" } });
  await tx.smsProviderProbe.update({ where: { id }, data: { attemptCount: 1 } });
  await tx.smsProviderProbe.update({ where: { id }, data: { status: "verified", verifiedAt: now } });
  return { id, now };
}

/**
 * Installs a dummy, locally verified SMS configuration for browser tests only.
 * The guard deliberately permits one app origin and one isolated test database.
 * The caller must restore the original row in a finally block.
 */
export async function installBrowserPhoneAuthConfigFixture(): Promise<() => Promise<void>> {
  assertFixtureEnvironment();
  await readExistingMasterKey();
  const db = getEntitlementDb();
  const state = await db.$transaction(async (tx) => {
    await lockSmsConfiguration(tx);
    await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;
    const currentDatabase = await tx.$queryRaw<Array<{ name: string; role: string }>>`SELECT current_database() AS name, current_user AS role`;
    if (currentDatabase[0]?.name !== DATABASE_NAME || currentDatabase[0]?.role !== DATABASE_PRINCIPAL) {
      throw new Error("BROWSER_PHONE_FIXTURE_DATABASE_IDENTITY_INVALID");
    }
    const actor = await tx.appUser.findUnique({
      where: { username: "browser_admin" },
      select: { id: true, accountAccessVersion: true, role: true, disabledAt: true },
    });
    if (!actor || actor.role !== "admin" || actor.disabledAt !== null || actor.accountAccessVersion < 1) {
      throw new Error("BROWSER_PHONE_FIXTURE_ADMIN_REQUIRED");
    }
    const previous = await tx.smsProviderConfig.findUnique({ where: { id: "active" } });
    let restoreActor: Admin | null = null;
    if (previous) {
      const previousAdmin = await tx.appUser.findUnique({
        where: { id: previous.updatedById },
        select: { id: true, accountAccessVersion: true, role: true, disabledAt: true },
      });
      if (!previousAdmin || previousAdmin.role !== "admin" || previousAdmin.disabledAt !== null || previousAdmin.accountAccessVersion < 1) {
        throw new Error("BROWSER_PHONE_FIXTURE_PREVIOUS_ADMIN_INVALID");
      }
      restoreActor = previousAdmin;
    }

    const probe = await createVerifiedProbe(tx, actor, previous?.version ?? 0, FIXTURE_CONFIG);
    const active = await sealSmsConfig(FIXTURE_CONFIG, "active");
    const fixtureRow = previous
      ? await tx.smsProviderConfig.update({
        where: { id: "active" },
        data: {
          provider: smsProviderId(FIXTURE_CONFIG),
          version: previous.version + 1,
          enabled: true,
          verifiedAt: probe.now,
          updatedById: actor.id,
          ...active,
        },
      })
      : await tx.smsProviderConfig.create({
        data: {
          id: "active",
          provider: smsProviderId(FIXTURE_CONFIG),
          version: 1,
          enabled: true,
          verifiedAt: probe.now,
          updatedById: actor.id,
          ...active,
        },
      });
    await tx.smsProviderProbe.update({ where: { id: probe.id }, data: { consumedAt: probe.now } });
    return { actor, previous, restoreActor, fixtureVersion: fixtureRow.version, fixtureFingerprint: fixtureRow.fingerprint };
  });

  let restored = false;
  return async () => {
    if (restored) return;
    await db.$transaction(async (tx) => {
      await lockSmsConfiguration(tx);
      await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;
      const current = await tx.smsProviderConfig.findUnique({ where: { id: "active" } });
      if (
        !current
        || current.version !== state.fixtureVersion
        || current.fingerprint !== state.fixtureFingerprint
        || current.updatedById !== state.actor.id
      ) {
        throw new Error("BROWSER_PHONE_FIXTURE_CONFIG_CHANGED");
      }
      await tx.smsProviderConfig.delete({ where: { id: "active" } });
      if (state.previous) {
        const restoreActor = state.restoreActor;
        if (!restoreActor) throw new Error("BROWSER_PHONE_FIXTURE_RESTORE_ADMIN_MISSING");
        const previousConfig = await openSmsConfig(state.previous, "active");
        const probe = await createVerifiedProbe(tx, restoreActor, 0, previousConfig);
        await tx.smsProviderConfig.create({
          data: {
            id: state.previous.id,
            provider: state.previous.provider,
            version: state.previous.version,
            enabled: state.previous.enabled,
            ciphertext: state.previous.ciphertext,
            nonce: state.previous.nonce,
            authTag: state.previous.authTag,
            fingerprint: state.previous.fingerprint,
            verifiedAt: state.previous.verifiedAt,
            updatedById: state.previous.updatedById,
            updatedAt: state.previous.updatedAt,
          },
        });
        await tx.smsProviderProbe.update({ where: { id: probe.id }, data: { consumedAt: probe.now } });
      }
    });
    restored = true;
  };
}
