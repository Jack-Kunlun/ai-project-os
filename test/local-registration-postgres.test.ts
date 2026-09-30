import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { localRegistrationUsernameFingerprint, reserveLocalRegistrationAttempt } from "@/lib/local-registration-abuse-budget";
import { registerLocalAccount } from "@/lib/local-registration-service";

const shouldRun = process.env.LOCAL_REGISTRATION_POSTGRES_GATE === "1";
const configuredUrl = process.env.LOCAL_REGISTRATION_TEST_DATABASE_URL;

function testDatabaseUrl(): string {
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) throw new Error("LOCAL_REGISTRATION_TEST_DATABASE_URL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("LOCAL_REGISTRATION_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== "/ai_project_os_local_registration_test"
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("LOCAL_REGISTRATION_TEST_DATABASE_URL_INVALID");
  return parsed.toString();
}

test(
  "local registration creates a private Owner workspace and serializes duplicate normalized usernames",
  { skip: !shouldRun ? "LOCAL_REGISTRATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const adminId = randomUUID();
    const rollbackSuffix = `${suffix}rollback`;
    const previousRegistrationFlag = process.env.LOCAL_REGISTRATION_ENABLED;
    process.env.LOCAL_REGISTRATION_ENABLED = "true";
    let failingAuditTrigger: Readonly<{ functionName: string; triggerName: string }> | null = null;
    try {
      await db.appUser.create({ data: { id: adminId, username: `reg_admin_${suffix}`, role: "admin" } });

      const rateLimitedUsername = `rate_${suffix}`;
      const parallelAdmissions = await Promise.allSettled(
        Array.from({ length: 10 }, () => reserveLocalRegistrationAttempt(rateLimitedUsername, db)),
      );
      const admitted = parallelAdmissions.filter((result) => result.status === "fulfilled");
      const denied = parallelAdmissions.filter((result) => result.status === "rejected");
      assert.equal(admitted.length, 5);
      assert.equal(denied.length, 5);
      for (const result of denied) {
        assert.ok(result.status === "rejected");
        assert.ok(result.reason instanceof ApiError);
        assert.equal(result.reason.code, "LOCAL_REGISTRATION_RATE_LIMITED");
      }
      const rateFingerprint = localRegistrationUsernameFingerprint(rateLimitedUsername);
      const usernameBudget = await db.localRegistrationBudget.findUniqueOrThrow({
        where: { scope_keyFingerprint: { scope: "username_hour", keyFingerprint: rateFingerprint } },
      });
      assert.equal(usernameBudget.attemptCount, 5);
      assert.doesNotMatch(usernameBudget.keyFingerprint, new RegExp(rateLimitedUsername, "u"));
      assert.equal((await db.localRegistrationBudget.findUniqueOrThrow({
        where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: "0".repeat(64) } },
      })).attemptCount, 5);
      assert.equal((await db.localRegistrationBudget.findUniqueOrThrow({
        where: { scope_keyFingerprint: { scope: "global_day", keyFingerprint: "1".repeat(64) } },
      })).attemptCount, 5);

      const now = new Date();
      await db.localRegistrationBudget.upsert({
        where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: "0".repeat(64) } },
        create: { scope: "global_hour", keyFingerprint: "0".repeat(64), windowStartedAt: now, attemptCount: 49 },
        update: { windowStartedAt: now, attemptCount: 49 },
      });
      await db.localRegistrationBudget.upsert({
        where: { scope_keyFingerprint: { scope: "global_day", keyFingerprint: "1".repeat(64) } },
        create: { scope: "global_day", keyFingerprint: "1".repeat(64), windowStartedAt: now, attemptCount: 199 },
        update: { windowStartedAt: now, attemptCount: 199 },
      });
      await reserveLocalRegistrationAttempt(`globalcap_${suffix}`, db);
      assert.equal((await db.localRegistrationBudget.findUniqueOrThrow({
        where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: "0".repeat(64) } },
      })).attemptCount, 50);
      assert.equal((await db.localRegistrationBudget.findUniqueOrThrow({
        where: { scope_keyFingerprint: { scope: "global_day", keyFingerprint: "1".repeat(64) } },
      })).attemptCount, 200);

      await assert.rejects(
        reserveLocalRegistrationAttempt(`hourcap_${suffix}`, db),
        (error: unknown) => error instanceof ApiError && error.code === "LOCAL_REGISTRATION_RATE_LIMITED",
      );
      assert.equal(await db.localRegistrationBudget.findUnique({
        where: { scope_keyFingerprint: { scope: "username_hour", keyFingerprint: localRegistrationUsernameFingerprint(`hourcap_${suffix}`) } },
      }), null);

      await db.localRegistrationBudget.update({
        where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: "0".repeat(64) } },
        data: { windowStartedAt: new Date(), attemptCount: 1 },
      });
      await assert.rejects(
        reserveLocalRegistrationAttempt(`daycap_${suffix}`, db),
        (error: unknown) => error instanceof ApiError && error.code === "LOCAL_REGISTRATION_RATE_LIMITED",
      );
      assert.equal((await db.localRegistrationBudget.findUniqueOrThrow({
        where: { scope_keyFingerprint: { scope: "global_hour", keyFingerprint: "0".repeat(64) } },
      })).attemptCount, 1);
      assert.equal((await db.localRegistrationBudget.findUniqueOrThrow({
        where: { scope_keyFingerprint: { scope: "global_day", keyFingerprint: "1".repeat(64) } },
      })).attemptCount, 200);
      assert.equal(await db.localRegistrationBudget.findUnique({
        where: { scope_keyFingerprint: { scope: "username_hour", keyFingerprint: localRegistrationUsernameFingerprint(`daycap_${suffix}`) } },
      }), null);

      await db.localRegistrationBudget.deleteMany({ where: { scope: { in: ["global_hour", "global_day"] } } });
      const admission = reserveLocalRegistrationAttempt;
      const duplicateAttempts = await Promise.allSettled([
        registerLocalAccount({ username: `Race_${suffix}`, password: "RegistrationPassword_2026" }, admission, db),
        registerLocalAccount({ username: `race_${suffix}`, password: "RegistrationPassword_2026" }, admission, db),
      ]);
      const completed = duplicateAttempts.filter((result) => result.status === "fulfilled");
      const rejected = duplicateAttempts.filter((result) => result.status === "rejected");
      assert.equal(completed.length, 1);
      assert.equal(rejected.length, 1);
      const rejection = rejected[0];
      assert.ok(rejection?.status === "rejected");
      assert.ok(rejection.reason instanceof ApiError);
      assert.equal(rejection.reason.code, "LOCAL_REGISTRATION_USERNAME_TAKEN");

      const success = completed[0];
      assert.ok(success?.status === "fulfilled");
      const registeredUserId = success.value.user.id;
      assert.equal(success.value.user.username, `race_${suffix}`);
      assert.equal(success.value.user.role, "user");
      assert.equal(await db.appUser.count({ where: { username: { equals: `race_${suffix}`, mode: "insensitive" } } }), 1);

      const user = await db.appUser.findUniqueOrThrow({ where: { id: registeredUserId } });
      assert.equal(user.email, null);
      assert.equal(user.emailVerifiedAt, null);
      const workspace = await db.workspace.findUniqueOrThrow({ where: { slug: `user-${registeredUserId}` } });
      assert.equal(workspace.createdById, registeredUserId);
      assert.equal(await db.workspaceMembership.count({ where: { userId: registeredUserId } }), 1);
      assert.equal(await db.workspaceMembership.count({ where: { userId: registeredUserId, workspaceId: workspace.id, role: "owner", accessState: "confirmed" } }), 1);
      assert.equal(await db.membershipAccessAudit.count({ where: { userId: registeredUserId, workspaceId: workspace.id, action: "confirmed", reason: "local_registration_personal_workspace_created" } }), 1);
      assert.equal(await db.appSession.count({ where: { userId: registeredUserId, revokedAt: null } }), 1);
      assert.equal(await db.accountEntitlementActivation.count({ where: { userId: registeredUserId } }), 0);

      const triggerSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const functionName = `local_registration_fail_${triggerSuffix}`;
      const triggerName = `local_registration_fail_trigger_${triggerSuffix}`;
      failingAuditTrigger = { functionName, triggerName };
      const beforeFailedRegistration = {
        users: await db.appUser.count(),
        workspaces: await db.workspace.count(),
        memberships: await db.workspaceMembership.count(),
        registrationAudits: await db.membershipAccessAudit.count({ where: { reason: "local_registration_personal_workspace_created" } }),
        sessions: await db.appSession.count(),
      };
      await db.$executeRawUnsafe(`
        CREATE FUNCTION public."${functionName}"()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW."reason" = 'local_registration_personal_workspace_created' THEN
            RAISE EXCEPTION 'LOCAL_REGISTRATION_AUDIT_ROLLBACK_PROBE' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await db.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}"
        BEFORE INSERT ON "MembershipAccessAudit"
        FOR EACH ROW EXECUTE FUNCTION public."${functionName}"();
      `);
      await assert.rejects(
        registerLocalAccount({ username: rollbackSuffix, password: "RegistrationPassword_2026" }, admission, db),
        (error: unknown) => error instanceof Error && error.message.includes("LOCAL_REGISTRATION_AUDIT_ROLLBACK_PROBE"),
      );
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "MembershipAccessAudit"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
      failingAuditTrigger = null;

      const rolledBack = await db.appUser.findUnique({ where: { username: rollbackSuffix }, select: { id: true } });
      assert.equal(rolledBack, null);
      assert.equal(await db.appUser.count(), beforeFailedRegistration.users);
      assert.equal(await db.workspace.count(), beforeFailedRegistration.workspaces);
      assert.equal(await db.workspaceMembership.count(), beforeFailedRegistration.memberships);
      assert.equal(await db.membershipAccessAudit.count({ where: { reason: "local_registration_personal_workspace_created" } }), beforeFailedRegistration.registrationAudits);
      assert.equal(await db.appSession.count(), beforeFailedRegistration.sessions);
    } finally {
      if (previousRegistrationFlag === undefined) delete process.env.LOCAL_REGISTRATION_ENABLED;
      else process.env.LOCAL_REGISTRATION_ENABLED = previousRegistrationFlag;
      if (failingAuditTrigger !== null) {
        await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${failingAuditTrigger.triggerName}" ON "MembershipAccessAudit"`).catch(() => undefined);
        await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${failingAuditTrigger.functionName}"()`).catch(() => undefined);
      }
      // The gate runner drops this entire disposable database after the test.
      // Keep append-only session/audit history intact until that teardown.
      await db.$disconnect();
    }
  },
);
