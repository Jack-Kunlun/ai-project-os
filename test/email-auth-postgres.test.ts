import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { ApiError } from "@/lib/api-errors";
import { AuthError, changeAccountPassword, createPasswordRecord, loginAdmin, readSessionToken, sessionCookie, setLocalAccountPassword, setVerifiedAccountEmail, updateAccountProfile, verifyAccountEmail } from "@/lib/auth";
import { getDb, getEntitlementDb } from "@/lib/db";
import { consumeEmailAuthProof, issueEmailChallenge, verifyEmailChallenge, type EmailMailTransport } from "@/lib/email-auth-service";
import { issueEmailGraphicCaptcha } from "@/lib/email-graphic-captcha-service";
import { emailDatabaseClock } from "@/lib/email-auth-budget";
import { loadEmailAuthConfig } from "@/lib/email-auth-config";
import { registerEmailAccount } from "@/lib/local-registration-service";
import { GRAPHIC_CAPTCHA_COOKIE, newCaptchaBrowserToken } from "@/lib/graphic-captcha-cookie";
import { ACCESS_ACTOR_LOCK_NAMESPACE, lockActorAccess } from "@/lib/access-linearization";
import { PATCH as patchProfile } from "@/app/api/profile/route";
import { createSignupOfferFixture } from "./platform-grant-offer-policy-fixture";

const enabled = process.env.PHONE_AUTH_POSTGRES_GATE === "1";
const publicOrigin = "https://phone-auth.example.com";
const publicHost = new URL(publicOrigin).host;
const currentPassword = "EmailAuth_CurrentPassword_2026";
const replacementPassword = "Abcd1234";
type Purpose = "register" | "verify" | "password";

function databaseUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("EMAIL_AUTH_ISOLATED_URL_REQUIRED");
  const parsed = new URL(value);
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)) || parsed.hostname !== "127.0.0.1" || parsed.port !== "56329" || parsed.pathname !== "/ai_project_os_phone_auth_test" || parsed.search || parsed.hash) {
    throw new Error("EMAIL_AUTH_ISOLATED_URL_INVALID");
  }
  return value;
}

function apiCode(expected: string) {
  return (error: unknown) => error instanceof ApiError && error.code === expected;
}

function authCode(expected: string) {
  return (error: unknown) => error instanceof AuthError && error.code === expected;
}

function postgresCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const root = error as Record<string, unknown>;
  const meta = typeof root.meta === "object" && root.meta !== null ? root.meta as Record<string, unknown> : null;
  const driverAdapterError = typeof meta?.driverAdapterError === "object" && meta.driverAdapterError !== null
    ? meta.driverAdapterError as Record<string, unknown>
    : null;
  const adapterCause = typeof driverAdapterError?.cause === "object" && driverAdapterError.cause !== null
    ? driverAdapterError.cause as Record<string, unknown>
    : null;
  const cause = typeof root.cause === "object" && root.cause !== null ? root.cause as Record<string, unknown> : null;
  const candidates = [
    meta?.code,
    meta?.sqlState,
    meta?.sqlstate,
    adapterCause?.originalCode,
    adapterCause?.sqlState,
    adapterCause?.sqlstate,
    cause?.originalCode,
    cause?.sqlState,
    cause?.sqlstate,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^[0-9A-Z]{5}$/u.test(candidate)) return candidate;
  }
  if (root.code === "P2002") return root.code;
  if (typeof root.code === "string" && /^[0-9A-Z]{5}$/u.test(root.code) && !/^P[0-9]{4}$/u.test(root.code)) return root.code;
  return null;
}

function postgresMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const root = error as Record<string, unknown>;
  const meta = typeof root.meta === "object" && root.meta !== null ? root.meta as Record<string, unknown> : null;
  const driverAdapterError = typeof meta?.driverAdapterError === "object" && meta.driverAdapterError !== null
    ? meta.driverAdapterError as Record<string, unknown>
    : null;
  const adapterCause = typeof driverAdapterError?.cause === "object" && driverAdapterError.cause !== null
    ? driverAdapterError.cause as Record<string, unknown>
    : null;
  const cause = typeof root.cause === "object" && root.cause !== null ? root.cause as Record<string, unknown> : null;
  return [root.message, meta?.message, adapterCause?.originalMessage, adapterCause?.message, cause?.originalMessage, cause?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

test("email authentication proofs, password protection, alias revalidation, and database ACL", { skip: !enabled }, async (t) => {
  const db = getEntitlementDb();
  const runtime = getDb();
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl("PHONE_AUTH_TEST_OWNER_URL") }) });
  const adminId = randomUUID();
  await owner.appUser.create({ data: { id: adminId, username: `email_admin_${adminId.slice(0, 8)}`, role: "admin" } });
  await createSignupOfferFixture(owner, adminId);
  assert.equal(await db.platformTokenGrant.count({ where: { userId: adminId, kind: "signup" } }), 0);
  assert.equal(await db.accountEntitlementActivation.count({ where: { userId: adminId } }), 0);
  let sentCount = 0;
  const mail: EmailMailTransport = {
    send: async () => {
      sentCount += 1;
      return { requestId: `email-request-${randomUUID()}`, envId: `email-env-${randomUUID()}` };
    },
  };

  async function makeCaptcha(email: string | undefined, purpose: Purpose, actor?: Awaited<ReturnType<typeof loginAdmin>>["user"]) {
    const browserToken = newCaptchaBrowserToken();
    let answer = "";
    const captcha = await issueEmailGraphicCaptcha({ email, purpose, browserToken, ...(actor ? { actor } : {}) }, db, async (value) => {
      answer = value;
      return Buffer.from("isolated-captcha-image");
    });
    return { browserToken, captcha: { challengeId: captcha.challengeId, answer } };
  }

  async function send(email: string, purpose: Purpose, actor?: Awaited<ReturnType<typeof loginAdmin>>["user"]) {
    const issued = await makeCaptcha(email, purpose, actor);
    let deliveredCode = "";
    const transport: EmailMailTransport = {
      send: async (input) => {
        deliveredCode = input.code;
        sentCount += 1;
        return { requestId: `email-request-${randomUUID()}`, envId: `email-env-${randomUUID()}` };
      },
    };
    const challenge = await issueEmailChallenge({
      email,
      purpose,
      captcha: issued.captcha,
      browserToken: issued.browserToken,
      ...(actor ? { actor } : {}),
    }, db, transport);
    assert.match(deliveredCode, /^[0-9]{6}$/u);
    return { ...challenge, code: deliveredCode, browserToken: issued.browserToken };
  }

  async function createUser(prefix: string, email: string | null, options: { verified?: boolean; password?: boolean } = {}) {
    const id = randomUUID();
    const username = `email_${prefix}_${id.slice(0, 8)}`;
    const credential = options.password === false ? {} : await createPasswordRecord(currentPassword);
    const user = await owner.appUser.create({
      data: {
        id,
        username,
        role: "user",
        email,
        emailVerifiedAt: email && options.verified ? new Date() : null,
        ...credential,
      },
    });
    return { id, username, email, user };
  }

  async function waitForAdvisoryWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await owner.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS "count" FROM pg_locks WHERE locktype='advisory' AND granted=false`;
      if (Number(row?.count ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("EMAIL_AUTH_TEST_ADVISORY_WAITER_NOT_OBSERVED");
  }

  async function waitForAnyDatabaseWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await owner.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS "count" FROM pg_locks WHERE granted=false`;
      if (Number(row?.count ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("EMAIL_AUTH_TEST_DATABASE_WAITER_NOT_OBSERVED");
  }

  async function waitForConsumedCaptchaAdmissionWaiter(challengeId: string): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const captcha = await owner.emailGraphicCaptchaChallenge.findUnique({ where: { id: challengeId }, select: { consumedAt: true } });
      const [lock] = await owner.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
           WHERE locktype='advisory' AND granted=false AND objsubid=1
             AND ((classid::bigint << 32) + objid::bigint) = hashtextextended('email-auth-admission-v1',0)
        ) AS "waiting"
      `;
      if (captcha?.consumedAt && lock?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("EMAIL_AUTH_TEST_CONSUMED_CAPTCHA_ADMISSION_WAITER_NOT_OBSERVED");
  }

  async function runDuringHeldEmailAdmissionLock(
    captchaId: string,
    action: () => Promise<unknown>,
    changeEmail: () => Promise<void>,
  ): Promise<unknown> {
    let announceLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { announceLocked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holder = owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('email-auth-admission-v1',0))`;
      announceLocked();
      await released;
    });
    await locked;
    const observedAction = action().then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    let setupError: unknown;
    try {
      await waitForConsumedCaptchaAdmissionWaiter(captchaId);
      await changeEmail();
    } catch (error) {
      setupError = error;
    } finally {
      release();
    }
    await holder;
    const result = await observedAction;
    if (setupError !== undefined) throw setupError;
    if (result.status === "rejected") throw result.error;
    return result.value;
  }

  async function runDuringHeldActorLock(actorId: string, action: () => Promise<unknown>, changeEmail: () => Promise<void>): Promise<unknown> {
    let announceLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { announceLocked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const holder = owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actorId}::text, ${ACCESS_ACTOR_LOCK_NAMESPACE}))`;
      announceLocked();
      await released;
    });
    await locked;
    const pending = action();
    try {
      await waitForAdvisoryWaiter();
      await changeEmail();
    } finally {
      release();
    }
    await holder;
    return pending;
  }

  try {
    await t.test("email migration rejects normalized legacy duplicates before schema changes and rolls back", async () => {
      const migrationClient = new Client({ connectionString: databaseUrl("PHONE_AUTH_TEST_OWNER_URL") });
      const schema = `email_auth_legacy_${randomUUID().replaceAll("-", "")}`;
      try {
        await migrationClient.connect();
        await migrationClient.query(`CREATE SCHEMA "${schema}"`);
        await migrationClient.query(`SET search_path TO "${schema}"`);
        await migrationClient.query('CREATE TABLE "AppUser" ("id" UUID PRIMARY KEY, "email" TEXT)');
        await migrationClient.query(
          'INSERT INTO "AppUser" ("id", "email") VALUES ($1::uuid, $3), ($2::uuid, $4)',
          [randomUUID(), randomUUID(), " Duplicate@Example.test ", "duplicate@example.test"],
        );
        const migrationSql = await readFile("prisma/migrations/20261013010000_add_email_auth/migration.sql", "utf8");
        let migrationError: unknown;
        try {
          await migrationClient.query(migrationSql);
        } catch (error) {
          migrationError = error;
        }
        assert.ok(migrationError, "expected duplicate preflight to reject the migration");
        assert.equal(postgresCode(migrationError), "23505");
        assert.match(migrationError instanceof Error ? migrationError.message : "", /EMAIL_AUTH_LEGACY_DUPLICATE_EMAIL/u);
        await migrationClient.query("ROLLBACK");

        const revision = await migrationClient.query(
          "SELECT count(*)::integer AS count FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'AppUser' AND column_name = 'emailRevision'",
          [schema],
        );
        assert.equal(revision.rows[0]?.count, 0);
        const tables = await migrationClient.query(
          "SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])",
          [schema, ["EmailAuthChallenge", "EmailAuthBudget", "EmailGraphicCaptchaChallenge", "EmailGraphicCaptchaBudget"]],
        );
        assert.equal(tables.rows[0]?.count, 0);
        const retained = await migrationClient.query('SELECT count(*)::integer AS count FROM "AppUser"');
        assert.equal(retained.rows[0]?.count, 2);
      } finally {
        await migrationClient.query("ROLLBACK").catch(() => undefined);
        await migrationClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await migrationClient.end().catch(() => undefined);
      }
    });

    await t.test("email registration consumes one proof, creates the ordinary owner workspace, and rejects normalized duplicates", async () => {
      const email = `register-${randomUUID().slice(0, 8)}@example.test`;
      const challenge = await send(email, "register");
      const username = `email_reg_${randomUUID().slice(0, 8)}`;
      const session = await registerEmailAccount({
        username,
        password: currentPassword,
        email,
        challengeId: challenge.challengeId,
        code: challenge.code,
        browserToken: challenge.browserToken,
      }, async () => undefined, db);
      const user = await db.appUser.findUniqueOrThrow({ where: { id: session.user.id } });
      assert.equal(user.email, email);
      assert.ok(user.emailVerifiedAt);
      const activation = await db.accountEntitlementActivation.findUniqueOrThrow({ where: { userId_lifecycleKey: { userId: user.id, lifecycleKey: "initial_account_v1" } } });
      assert.equal(activation.source, "localRegistration");
      assert.equal(activation.decision, "granted");
      assert.equal(activation.status, "granted");
      const grant = await db.platformTokenGrant.findFirstOrThrow({ where: { userId: user.id, kind: "signup" } });
      assert.equal(grant.amount, 500_000);
      assert.equal(grant.eligibilitySource, "localRegistration");
      assert.equal(await db.platformTokenGrant.count({ where: { userId: user.id, kind: "signup" } }), 1);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: user.id, reasonCode: "AI_SIGNUP_GRANT" } }), 1);
      assert.equal(await db.accountEntitlementActivationAudit.count({ where: { userId: user.id } }), 1);
      const memberships = await db.workspaceMembership.findMany({ where: { userId: user.id, accessState: "confirmed" } });
      assert.equal(memberships.length, 1);
      assert.equal(memberships[0]?.role, "owner");
      assert.ok(await db.appSession.findFirst({ where: { userId: user.id, revokedAt: null } }));
      const audit = await db.appUserEmailVerificationAudit.findFirstOrThrow({ where: { userId: user.id, source: "email" } });
      assert.equal(audit.event, "verified");
      assert.match(audit.emailFingerprintAfter ?? "", /^[a-f0-9]{64}$/u);
      const challengeRow = await db.emailAuthChallenge.findUniqueOrThrow({ where: { id: challenge.challengeId } });
      assert.equal(challengeRow.consumedByUserId, user.id);
      assert.equal(JSON.stringify(challengeRow).includes(email), false);
      assert.equal(JSON.stringify(challengeRow).includes(challenge.code), false);
      const unproven = await owner.appUser.create({ data: { username: `email_unproven_${randomUUID().slice(0, 8)}`, role: "user" } });
      assert.equal(await db.accountEntitlementActivation.count({ where: { userId: unproven.id } }), 0);
      assert.equal(await db.platformTokenGrant.count({ where: { userId: unproven.id, kind: "signup" } }), 0);
      await assert.rejects(owner.appUser.update({ where: { id: unproven.id }, data: { email: `unproven-${randomUUID().slice(0, 8)}@example.test`, emailVerifiedAt: new Date() } }), (error: unknown) => postgresCode(error) === "23514" && postgresMessage(error).includes("EMAIL_IDENTITY_PROOF_REQUIRED"));
      assert.equal((await owner.appUser.findUniqueOrThrow({ where: { id: unproven.id } })).email, null);
      await assert.rejects(verifyEmailChallenge({ challengeId: challenge.challengeId, code: challenge.code, purpose: "register", email, browserToken: challenge.browserToken }, db), apiCode("EMAIL_AUTH_CODE_INVALID"));
      // Assert the exact database index without depending on Prisma's layered
      // unique-error wrapping (P2002 outside, 23505 inside the adapter).
      const duplicateClient = new Client({ connectionString: databaseUrl("PHONE_AUTH_TEST_OWNER_URL") });
      try {
        await duplicateClient.connect();
        await assert.rejects(duplicateClient.query(
          'INSERT INTO "AppUser" ("id","username","role","email","updatedAt") VALUES ($1::uuid,$2,\'user\',$3,clock_timestamp())',
          [randomUUID(), `email_dupe_${randomUUID().slice(0, 8)}`, email.toUpperCase()],
        ), (error: unknown) => {
          if (typeof error !== "object" || error === null) return false;
          const failure = error as { code?: unknown; constraint?: unknown };
          return failure.code === "23505" && failure.constraint === "AppUser_email_normalized_key";
        });
      } finally { await duplicateClient.end(); }
    });

    await t.test("wrong codes commit five attempts; wrong purpose, browser, expiry, and sender rotation fail closed", async () => {
      const wrongCodeEmail = `wrong-code-${randomUUID().slice(0, 8)}@example.test`;
      const wrongCodeChallenge = await send(wrongCodeEmail, "register");
      const wrongCode = wrongCodeChallenge.code === "000000" ? "000001" : "000000";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await assert.rejects(verifyEmailChallenge({ challengeId: wrongCodeChallenge.challengeId, code: wrongCode, purpose: "register", email: wrongCodeEmail, browserToken: wrongCodeChallenge.browserToken }, db), apiCode("EMAIL_AUTH_CODE_INVALID"));
      }
      assert.equal((await db.emailAuthChallenge.findUniqueOrThrow({ where: { id: wrongCodeChallenge.challengeId } })).attemptCount, 5);
      await assert.rejects(verifyEmailChallenge({ challengeId: wrongCodeChallenge.challengeId, code: wrongCodeChallenge.code, purpose: "register", email: wrongCodeEmail, browserToken: wrongCodeChallenge.browserToken }, db), apiCode("EMAIL_AUTH_CODE_INVALID"));

      const actor = await createUser("wrongpurpose", `wrong-purpose-${randomUUID().slice(0, 8)}@example.test`, { verified: true });
      const actorSession = await loginAdmin({ username: actor.username, password: currentPassword }, db);
      const wrongPurposeEmail = `wrong-purpose-register-${randomUUID().slice(0, 8)}@example.test`;
      const wrongPurpose = await send(wrongPurposeEmail, "register");
      await assert.rejects(verifyEmailChallenge({ challengeId: wrongPurpose.challengeId, code: wrongPurpose.code, purpose: "password", actor: actorSession.user, browserToken: wrongPurpose.browserToken }, db), apiCode("EMAIL_AUTH_CODE_INVALID"));
      assert.equal((await db.emailAuthChallenge.findUniqueOrThrow({ where: { id: wrongPurpose.challengeId } })).attemptCount, 1);

      const browserEmail = `wrong-browser-${randomUUID().slice(0, 8)}@example.test`;
      const wrongBrowser = await send(browserEmail, "register");
      await assert.rejects(verifyEmailChallenge({ challengeId: wrongBrowser.challengeId, code: wrongBrowser.code, purpose: "register", email: browserEmail, browserToken: newCaptchaBrowserToken() }, db), apiCode("EMAIL_AUTH_CODE_INVALID"));
      assert.equal((await db.emailAuthChallenge.findUniqueOrThrow({ where: { id: wrongBrowser.challengeId } })).attemptCount, 1);

      const actorExpected = await createUser("wrongactor", `wrong-actor-one-${randomUUID().slice(0, 8)}@example.test`, { verified: true });
      const actorOther = await createUser("wrongactor2", `wrong-actor-two-${randomUUID().slice(0, 8)}@example.test`, { verified: true });
      const [expectedSession, otherSession] = await Promise.all([
        loginAdmin({ username: actorExpected.username, password: currentPassword }, db),
        loginAdmin({ username: actorOther.username, password: currentPassword }, db),
      ]);
      const actorChallenge = await send(actorExpected.email!, "password", expectedSession.user);
      await assert.rejects(verifyEmailChallenge({ challengeId: actorChallenge.challengeId, code: actorChallenge.code, purpose: "password", actor: otherSession.user, browserToken: actorChallenge.browserToken }, db), apiCode("EMAIL_AUTH_CODE_INVALID"));
      assert.equal((await db.emailAuthChallenge.findUniqueOrThrow({ where: { id: actorChallenge.challengeId } })).attemptCount, 1);

      const expiredEmail = `expired-${randomUUID().slice(0, 8)}@example.test`;
      const expired = await send(expiredEmail, "register");
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE "EmailAuthChallenge" DISABLE TRIGGER "EmailAuthChallenge_binding_guard"`;
        await tx.emailAuthChallenge.update({ where: { id: expired.challengeId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
        await tx.$executeRaw`ALTER TABLE "EmailAuthChallenge" ENABLE TRIGGER "EmailAuthChallenge_binding_guard"`;
      });
      await assert.rejects(verifyEmailChallenge({ challengeId: expired.challengeId, code: expired.code, purpose: "register", email: expiredEmail, browserToken: expired.browserToken }, db), apiCode("EMAIL_AUTH_CODE_INVALID"));

      const rotatedEmail = `rotated-config-${randomUUID().slice(0, 8)}@example.test`;
      const rotated = await send(rotatedEmail, "register");
      const originalId = process.env.AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID;
      process.env.AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID = "rotated-isolated-test-key";
      try {
        await assert.rejects(verifyEmailChallenge({ challengeId: rotated.challengeId, code: rotated.code, purpose: "register", email: rotatedEmail, browserToken: rotated.browserToken }, db), apiCode("EMAIL_AUTH_CODE_INVALID"));
      } finally {
        if (originalId === undefined) delete process.env.AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID;
        else process.env.AI_PROJECT_OS_ALIYUN_DM_ACCESS_KEY_ID = originalId;
      }
    });

    await t.test("verified current email supports alias login and same-transaction verification; password changes require email proof and revoke sessions", async () => {
      const email = `verify-current-${randomUUID().slice(0, 8)}@example.test`;
      const account = await createUser("verify", email, { verified: false });
      const initialSession = await loginAdmin({ username: account.username, password: currentPassword }, db);
      await assert.rejects(loginAdmin({ username: email, password: currentPassword }, db), authCode("AUTH_INVALID_CREDENTIALS"));
      const challenge = await send(email, "verify", initialSession.user);
      const proof = await verifyEmailChallenge({ challengeId: challenge.challengeId, code: challenge.code, purpose: "verify", actor: initialSession.user, browserToken: challenge.browserToken }, db);
      const verified = await verifyAccountEmail(initialSession.user, proof, challenge.browserToken, db);
      assert.equal(verified.email, email);
      assert.ok(verified.emailVerifiedAt);
      const audit = await db.appUserEmailVerificationAudit.findFirstOrThrow({ where: { userId: account.id, source: "email", event: "verified" } });
      assert.match(audit.emailFingerprintBefore ?? "", /^[a-f0-9]{64}$/u);
      assert.equal(audit.emailFingerprintBefore, audit.emailFingerprintAfter);
      assert.match(audit.emailFingerprintAfter ?? "", /^[a-f0-9]{64}$/u);
      assert.equal(audit.verifiedAtBefore, null);
      assert.equal((await loginAdmin({ username: email, password: currentPassword }, db)).user.id, account.id);

      const passwordAccount = await createUser("password", `change-password-${randomUUID().slice(0, 8)}@example.test`, { verified: true });
      const session = await loginAdmin({ username: passwordAccount.username, password: currentPassword }, db);
      await assert.rejects(changeAccountPassword(passwordAccount.id, currentPassword, replacementPassword, db), apiCode("EMAIL_AUTH_PROOF_REQUIRED"));
      const passwordChallenge = await send(passwordAccount.email!, "password", session.user);
      const proofForBadPassword = await verifyEmailChallenge({ challengeId: passwordChallenge.challengeId, code: passwordChallenge.code, purpose: "password", actor: session.user, browserToken: passwordChallenge.browserToken }, db);
      await assert.rejects(changeAccountPassword(passwordAccount.id, "WrongCurrentPassword_2026", replacementPassword, db, { proof: proofForBadPassword, browserToken: passwordChallenge.browserToken }), authCode("AUTH_CURRENT_PASSWORD_INVALID"));
      assert.equal((await db.emailAuthChallenge.findUniqueOrThrow({ where: { id: passwordChallenge.challengeId } })).consumedAt, null);

      const cookie = `${sessionCookie(session.token, session.expiresAt).split(";", 1)[0]}; ${GRAPHIC_CAPTCHA_COOKIE}=${passwordChallenge.browserToken}`;
      const response = await patchProfile(new Request(`${publicOrigin}/api/profile`, {
        method: "PATCH",
        headers: { origin: publicOrigin, host: publicHost, cookie, "content-type": "application/json" },
        body: JSON.stringify({ action: "changePassword", currentPassword, newPassword: replacementPassword, challengeId: passwordChallenge.challengeId, code: passwordChallenge.code }),
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { passwordChanged: true });
      assert.equal(await readSessionToken(session.token, db), null);
      assert.equal((await loginAdmin({ username: passwordAccount.email, password: replacementPassword }, db)).user.id, passwordAccount.id);
      await assert.rejects(loginAdmin({ username: passwordAccount.email, password: currentPassword }, db), authCode("AUTH_INVALID_CREDENTIALS"));
      await assert.rejects(verifyEmailChallenge({ challengeId: passwordChallenge.challengeId, code: passwordChallenge.code, purpose: "password", actor: session.user, browserToken: passwordChallenge.browserToken }, db), apiCode("EMAIL_AUTH_CODE_INVALID"));
    });

    await t.test("verified profile email is locked while email auth is enabled, without blocking display-name edits", async () => {
      const originalEmail = `Verified.Profile-${randomUUID().slice(0, 8)}@example.test`;
      const account = await createUser("profilelock", originalEmail, { verified: true });
      const verifiedBefore = account.user.emailVerifiedAt;
      const revisionBefore = account.user.emailRevision;
      const session = await loginAdmin({ username: account.username, password: currentPassword }, db);

      await assert.rejects(updateAccountProfile(account.id, { displayName: "Blocked clear", email: null }, db), apiCode("EMAIL_AUTH_VERIFIED_EMAIL_LOCKED"));
      await assert.rejects(updateAccountProfile(account.id, { displayName: "Blocked replacement", email: `replacement-${randomUUID().slice(0, 8)}@example.test` }, db), apiCode("EMAIL_AUTH_VERIFIED_EMAIL_LOCKED"));

      const cookie = `${sessionCookie(session.token, session.expiresAt).split(";", 1)[0]}`;
      for (const email of [null, `replacement-${randomUUID().slice(0, 8)}@example.test`]) {
        const response = await patchProfile(new Request(`${publicOrigin}/api/profile`, {
          method: "PATCH",
          headers: { origin: publicOrigin, host: publicHost, cookie, "content-type": "application/json" },
          body: JSON.stringify({ action: "updateProfile", displayName: "Rejected by API", email }),
        }));
        assert.equal(response.status, 409);
        assert.equal((await response.json() as { error?: { code?: string } }).error?.code, "EMAIL_AUTH_VERIFIED_EMAIL_LOCKED");
      }

      const updated = await updateAccountProfile(account.id, { displayName: "Profile name updated", email: originalEmail.toUpperCase() }, db);
      assert.equal(updated.displayName, "Profile name updated");
      assert.equal(updated.email, originalEmail);
      assert.equal(updated.emailVerifiedAt?.toISOString(), verifiedBefore?.toISOString());
      const unchangedRevision = await db.appUser.findUniqueOrThrow({ where: { id: account.id }, select: { emailRevision: true } });
      assert.equal(unchangedRevision.emailRevision, revisionBefore);

      const unverifiedEmail = `unverified-profile-${randomUUID().slice(0, 8)}@example.test`;
      const unverified = await createUser("profileunverified", unverifiedEmail, { verified: false });
      const changedUnverified = await updateAccountProfile(unverified.id, { displayName: null, email: `changed-${randomUUID().slice(0, 8)}@example.test` }, db);
      assert.notEqual(changedUnverified.email, unverifiedEmail);
      assert.equal(changedUnverified.emailVerifiedAt, null);

      const previousEnabled = process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED;
      process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED = "false";
      try {
        const disabledEmail = `disabled-profile-${randomUUID().slice(0, 8)}@example.test`;
        const disabledAccount = await createUser("profiledisabled", disabledEmail, { verified: true });
        const changedDisabled = await updateAccountProfile(disabledAccount.id, { displayName: "Legacy behavior", email: `replacement-${randomUUID().slice(0, 8)}@example.test` }, db);
        assert.notEqual(changedDisabled.email, disabledEmail);
        assert.equal(changedDisabled.emailVerifiedAt, null);
      } finally {
        if (previousEnabled === undefined) delete process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED;
        else process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED = previousEnabled;
      }
    });

    await t.test("concurrent proof consumption has one winner and an A-to-B-to-A email cycle invalidates pending proof", async () => {
      const account = await createUser("concurrent", `concurrent-password-${randomUUID().slice(0, 8)}@example.test`, { verified: true });
      const session = await loginAdmin({ username: account.username, password: currentPassword }, db);
      const challenge = await send(account.email!, "password", session.user);
      const proof = await verifyEmailChallenge({ challengeId: challenge.challengeId, code: challenge.code, purpose: "password", actor: session.user, browserToken: challenge.browserToken }, db);
      const attempts = await Promise.allSettled([
        changeAccountPassword(account.id, currentPassword, replacementPassword, db, { proof, browserToken: challenge.browserToken }),
        changeAccountPassword(account.id, currentPassword, replacementPassword, db, { proof, browserToken: challenge.browserToken }),
      ]);
      assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
      assert.equal((await db.emailAuthChallenge.findUniqueOrThrow({ where: { id: challenge.challengeId } })).consumedByUserId, account.id);

      const revisionAccount = await createUser("revision", `revision-${randomUUID().slice(0, 8)}@example.test`, { verified: true });
      const revisionSession = await loginAdmin({ username: revisionAccount.username, password: currentPassword }, db);
      const revisionChallenge = await send(revisionAccount.email!, "password", revisionSession.user);
      const before = await db.appUser.findUniqueOrThrow({ where: { id: revisionAccount.id }, select: { emailRevision: true } });
      await owner.appUser.update({ where: { id: revisionAccount.id }, data: { email: `temporarily-${randomUUID().slice(0, 8)}@example.test` } });
      await owner.appUser.update({ where: { id: revisionAccount.id }, data: { email: revisionAccount.email } });
      const after = await db.appUser.findUniqueOrThrow({ where: { id: revisionAccount.id }, select: { emailRevision: true, emailVerifiedAt: true } });
      assert.equal(after.emailRevision, before.emailRevision + 2);
      assert.ok(after.emailVerifiedAt);
      await assert.rejects(verifyEmailChallenge({ challengeId: revisionChallenge.challengeId, code: revisionChallenge.code, purpose: "password", actor: revisionSession.user, browserToken: revisionChallenge.browserToken }, db), apiCode("EMAIL_AUTH_CODE_INVALID"));

      const delayedAccount = await createUser("expirywait", `expiry-wait-${randomUUID().slice(0, 8)}@example.test`, { verified: true });
      const delayedSession = await loginAdmin({ username: delayedAccount.username, password: currentPassword }, db);
      const delayedChallenge = await send(delayedAccount.email!, "password", delayedSession.user);
      const delayedProof = await verifyEmailChallenge({ challengeId: delayedChallenge.challengeId, code: delayedChallenge.code, purpose: "password", actor: delayedSession.user, browserToken: delayedChallenge.browserToken }, db);
      const activeConfig = await loadEmailAuthConfig();
      let announceRowLock!: () => void;
      const rowLocked = new Promise<void>((resolve) => { announceRowLock = resolve; });
      const holdChallenge = owner.$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE "EmailAuthChallenge" DISABLE TRIGGER "EmailAuthChallenge_binding_guard"`;
        await tx.$executeRaw`UPDATE "EmailAuthChallenge" SET "expiresAt"=clock_timestamp()+interval '1 second' WHERE "id"=${delayedChallenge.challengeId}::uuid`;
        await tx.$executeRaw`ALTER TABLE "EmailAuthChallenge" ENABLE TRIGGER "EmailAuthChallenge_binding_guard"`;
        await tx.$queryRaw`SELECT "id" FROM "EmailAuthChallenge" WHERE "id"=${delayedChallenge.challengeId}::uuid FOR UPDATE`;
        announceRowLock();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      });
      await rowLocked;
      const delayedConsume = db.$transaction(async (tx) => {
        await lockActorAccess(tx, delayedAccount.id);
        const now = await emailDatabaseClock(tx);
        await consumeEmailAuthProof(tx, delayedProof, delayedAccount.id, delayedChallenge.browserToken, now, activeConfig);
      });
      await waitForAnyDatabaseWaiter();
      await holdChallenge;
      await assert.rejects(delayedConsume, apiCode("EMAIL_AUTH_CODE_INVALID"));
      assert.equal((await db.emailAuthChallenge.findUniqueOrThrow({ where: { id: delayedChallenge.challengeId } })).consumedAt, null);
    });

    await t.test("email-less password setup and verified-email alias login reject in-flight email revision races", async () => {
      const passwordless = await createUser("passwordless", null, { password: false });
      const setPassword = runDuringHeldActorLock(passwordless.id, () => setLocalAccountPassword(passwordless.id, replacementPassword, db), async () => {
        await owner.appUser.update({ where: { id: passwordless.id }, data: { email: `late-email-${randomUUID().slice(0, 8)}@example.test` } });
      });
      await assert.rejects(setPassword, apiCode("EMAIL_AUTH_RECIPIENT_CHANGED"));
      assert.equal((await db.appUser.findUniqueOrThrow({ where: { id: passwordless.id } })).passwordHash, null);

      const alias = await createUser("aliasrace", `alias-race-${randomUUID().slice(0, 8)}@example.test`, { verified: true });
      await loginAdmin({ username: alias.username, password: currentPassword }, db);
      const originalRevision = alias.user.emailRevision;
      const login = runDuringHeldActorLock(alias.id, () => loginAdmin({ username: alias.email, password: currentPassword }, db), async () => {
        await owner.appUser.update({ where: { id: alias.id }, data: { email: `alias-temp-${randomUUID().slice(0, 8)}@example.test` } });
        await owner.appUser.update({ where: { id: alias.id }, data: { email: alias.email } });
      });
      await assert.rejects(login, authCode("AUTH_INVALID_CREDENTIALS"));
      assert.equal((await db.appUser.findUniqueOrThrow({ where: { id: alias.id }, select: { emailRevision: true } })).emailRevision, originalRevision + 2);
    });

    await t.test("a verified CAPTCHA cannot authorize sending after the actor email changes before admission", async () => {
      const firstEmail = `captcha-race-${randomUUID().slice(0, 8)}@example.test`;
      const omittedEmailActor = await createUser("captcharace", firstEmail, { verified: false });
      const omittedEmailSession = await loginAdmin({ username: omittedEmailActor.username, password: currentPassword }, db);
      const omittedEmailCaptcha = await makeCaptcha(undefined, "verify", omittedEmailSession.user);
      const beforeOmittedSend = sentCount;
      await assert.rejects(runDuringHeldEmailAdmissionLock(
        omittedEmailCaptcha.captcha.challengeId,
        () => issueEmailChallenge({
          purpose: "verify",
          actor: omittedEmailSession.user,
          captcha: omittedEmailCaptcha.captcha,
          browserToken: omittedEmailCaptcha.browserToken,
        }, db, mail),
        async () => {
          await updateAccountProfile(omittedEmailActor.id, { displayName: null, email: `captcha-race-next-${randomUUID().slice(0, 8)}@example.test` }, db);
        },
      ), apiCode("EMAIL_GRAPHIC_CAPTCHA_INVALID"));
      assert.equal(sentCount, beforeOmittedSend);

      const explicitEmail = `captcha-cycle-${randomUUID().slice(0, 8)}@example.test`;
      const explicitEmailActor = await createUser("captchacycle", explicitEmail, { verified: false });
      const explicitEmailSession = await loginAdmin({ username: explicitEmailActor.username, password: currentPassword }, db);
      const explicitEmailCaptcha = await makeCaptcha(explicitEmail, "verify", explicitEmailSession.user);
      const beforeExplicitSend = sentCount;
      await assert.rejects(runDuringHeldEmailAdmissionLock(
        explicitEmailCaptcha.captcha.challengeId,
        () => issueEmailChallenge({
          email: explicitEmail,
          purpose: "verify",
          actor: explicitEmailSession.user,
          captcha: explicitEmailCaptcha.captcha,
          browserToken: explicitEmailCaptcha.browserToken,
        }, db, mail),
        async () => {
          await updateAccountProfile(explicitEmailActor.id, { displayName: null, email: `captcha-cycle-next-${randomUUID().slice(0, 8)}@example.test` }, db);
          await updateAccountProfile(explicitEmailActor.id, { displayName: null, email: explicitEmail }, db);
        },
      ), apiCode("EMAIL_GRAPHIC_CAPTCHA_INVALID"));
      assert.equal(sentCount, beforeExplicitSend);
      assert.equal((await db.appUser.findUniqueOrThrow({ where: { id: explicitEmailActor.id }, select: { emailRevision: true } })).emailRevision, explicitEmailActor.user.emailRevision + 2);
    });

    await t.test("email authentication off rejects trusted verified-email aliases and preserves username and phone login", async () => {
      const previousEnabled = process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED;
      process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED = "false";
      try {
        const trusted = await createUser("trustedemailoff", null);
        const trustedEmail = `trusted-oidc-${randomUUID().slice(0, 8)}@example.test`;
        await owner.$transaction(async (tx) => {
          await lockActorAccess(tx, trusted.id);
          await setVerifiedAccountEmail(tx, trusted.id, trustedEmail, "oidc");
        });
        await assert.rejects(loginAdmin({ username: trustedEmail, password: currentPassword }, db), authCode("AUTH_INVALID_CREDENTIALS"));
        assert.equal((await loginAdmin({ username: trusted.username, password: currentPassword }, db)).user.id, trusted.id);

        const phoneId = randomUUID();
        const phone = `+86138${randomInt(0, 100_000_000).toString().padStart(8, "0")}`;
        const phoneUserName = `email_phone_${phoneId.slice(0, 8)}`;
        const credential = await createPasswordRecord(currentPassword);
        const now = new Date();
        const challengeId = randomUUID();
        const digest = "a".repeat(64);
        await owner.$transaction(async (tx) => {
          await tx.smsAuthChallenge.create({
            data: {
              id: challengeId,
              phoneE164: phone,
              phoneFingerprint: digest,
              purpose: "register",
              providerScheme: "isolated-test",
              configVersion: 1,
              expectedCodeDigest: digest,
              codeDigest: digest,
              verifiedAt: now,
              status: "sent",
              attemptCount: 1,
              expiresAt: new Date(now.getTime() + 60_000),
              consumedAt: now,
              consumedByUserId: phoneId,
              createdAt: now,
            },
          });
          await tx.$executeRaw`SELECT set_config('app.phone_auth_challenge_id',${challengeId},true)`;
          await tx.appUser.create({ data: {
            id: phoneId,
            username: phoneUserName,
            role: "user",
            phoneE164: phone,
            phoneVerifiedAt: now,
            ...credential,
          } });
        });
        assert.equal((await loginAdmin({ username: phone, password: currentPassword }, db)).user.id, phoneId);
      } finally {
        if (previousEnabled === undefined) delete process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED;
        else process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED = previousEnabled;
      }
    });

    await t.test("concurrent send admission is bounded and runtime cannot write protected email tables", async () => {
      const email = `parallel-send-${randomUUID().slice(0, 8)}@example.test`;
      const firstCaptcha = await makeCaptcha(email, "register");
      const secondCaptcha = await makeCaptcha(email, "register");
      const before = sentCount;
      const results = await Promise.allSettled([
        issueEmailChallenge({ email, purpose: "register", captcha: firstCaptcha.captcha, browserToken: firstCaptcha.browserToken }, db, mail),
        issueEmailChallenge({ email, purpose: "register", captcha: secondCaptcha.captcha, browserToken: secondCaptcha.browserToken }, db, mail),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(sentCount, before + 1);
      const failure = results.find((result) => result.status === "rejected");
      assert.ok(failure?.status === "rejected" && failure.reason instanceof ApiError && failure.reason.status === 429);
      const [privileges] = await runtime.$queryRaw<Array<{ canInsert: boolean }>>`SELECT has_table_privilege(current_user, 'public."EmailAuthBudget"', 'INSERT') AS "canInsert"`;
      assert.equal(privileges?.canInsert, false);
      const keyFingerprint = randomUUID().replaceAll("-", "").padEnd(64, "a").slice(0, 64);
      await assert.rejects(runtime.$executeRaw`INSERT INTO "EmailAuthBudget" ("scope","keyFingerprint","windowStartedAt","attemptCount") VALUES ('send_email_hour',${keyFingerprint},clock_timestamp(),1)`, (error: unknown) => postgresCode(error) === "42501" && /permission denied/iu.test(postgresMessage(error)) && postgresMessage(error).includes("EmailAuthBudget"));
    });
  } finally {
    await db.$disconnect();
    await runtime.$disconnect();
    await owner.$disconnect();
  }
});
