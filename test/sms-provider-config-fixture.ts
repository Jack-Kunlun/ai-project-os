import { randomUUID } from "node:crypto";
import type { Prisma, SmsProviderConfig } from "@prisma/client";
import { openSmsConfig, phoneAuthSecret, sealSmsConfig } from "@/lib/phone-auth-config";
import { phoneFingerprint, smsCodeDigest } from "@/lib/phone-auth-identity";

/** Isolated database initialization only. Uses the same evidence lifecycle as
 * the production service; never adds a bypass to production SQL guards. */
export async function seedVerifiedSmsConfigFixture(
  tx: Prisma.TransactionClient,
  row: Omit<SmsProviderConfig, "updatedAt"> & { updatedAt?: Date },
): Promise<void> {
  const configured = process.env.PHONE_AUTH_TEST_DATABASE_URL;
  if (process.env.PHONE_AUTH_POSTGRES_GATE !== "1" || !configured) throw new Error("ISOLATED_SMS_FIXTURE_REQUIRED");
  const target = new URL(configured);
  if (target.hostname !== "127.0.0.1" || target.port !== "56329" || target.pathname !== "/ai_project_os_phone_auth_test") throw new Error("ISOLATED_SMS_FIXTURE_REQUIRED");
  const database = await tx.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  if (database[0]?.name !== "ai_project_os_phone_auth_test") throw new Error("ISOLATED_SMS_FIXTURE_REQUIRED");
  const actor = await tx.appUser.findUniqueOrThrow({ where: { id: row.updatedById } });
  const id = randomUUID();
  const config = await openSmsConfig(row, "active");
  const sealed = await sealSmsConfig(config, id);
  const now = new Date();
  const phone = "+8613899999999";
  const expectedCodeDigest = row.provider === "aliyun-pnvs" ? null : smsCodeDigest({ id, phone, purpose: "test", code: "123456" }, phoneAuthSecret());
  await tx.$executeRaw`SELECT set_config('app.sms_provider_admin_context','service-v1',true)`;
  await tx.smsProviderProbe.create({ data: {
    id, actorId: actor.id, actorAccountAccessVersion: actor.accountAccessVersion, baseVersion: 0,
    provider: row.provider, ...sealed, phoneE164: phone, phoneFingerprint: phoneFingerprint(phone, phoneAuthSecret()),
    expectedCodeDigest, status: "pending", createdAt: now, expiresAt: new Date(now.getTime() + 300_000),
  } });
  await tx.smsProviderProbe.update({ where: { id }, data: { status: "sent" } });
  await tx.smsProviderProbe.update({ where: { id }, data: { attemptCount: 1 } });
  await tx.smsProviderProbe.update({ where: { id }, data: { status: "verified", verifiedAt: now } });
  await tx.smsProviderConfig.create({ data: row });
  await tx.smsProviderProbe.update({ where: { id }, data: { consumedAt: now } });
}
