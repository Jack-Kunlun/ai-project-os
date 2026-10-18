import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { getSystemOverview } from "../src/lib/system-overview";

const actorId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-09-03T00:00:00.000Z");

function createDb(options: { analyticsFailure?: boolean; failureFailure?: boolean; queryLog?: string[] } = {}): PrismaClient {
  return {
    $queryRaw: async (query: { strings?: readonly string[]; values?: readonly unknown[] }) => {
      const sql = query.strings?.join("") ?? "";
      options.queryLog?.push(sql);
      if (options.analyticsFailure && sql.includes('WITH "platformCalls"')) throw new Error("source unavailable");
      if (options.failureFailure && sql.includes('WITH "platformFailures"')) throw new Error("source unavailable");
      if (sql.includes('FROM "AppUser"')) return [{ date: "2026-09-03", value: BigInt(2) }];
      if (sql.includes('WITH "platformCalls"')) {
        return [
          { date: "2026-09-02", tokens: BigInt(9), unknownCalls: BigInt(1) },
          { date: "2026-09-03", tokens: BigInt(56), unknownCalls: BigInt(2) },
        ];
      }
      if (sql.includes('WITH "platformFailures"')) return [
        { safeErrorCode: "PLATFORM_PROVIDER_FAILURE", count: BigInt(1) },
        { safeErrorCode: "UNIFIED_QUESTION_FAILED", count: BigInt(1) },
        { safeErrorCode: "PERSONAL_QA_FAILED", count: BigInt(1) },
      ];
      if (sql.includes('FROM "PlatformTokenReservation"')) return [{ date: "2026-09-03", value: BigInt(5) }];
      if (sql.includes('FROM "McpToolDefinition"')) return [{ count: BigInt(0) }];
      if (sql.includes("SELECT 1")) return [{ ok: 1 }];
      return [];
    },
    appUser: {
      findUnique: async () => ({ id: actorId, role: "admin" as const, disabledAt: null, accountAccessVersion: 1 }),
      count: async () => 4,
    },
    membershipSubscription: { count: async () => 3 },
    aiProviderConnection: { count: async () => 1 },
    platformTokenGrant: { aggregate: async (input: { where?: unknown }) => ({ _sum: input.where ? { remainingTokens: 10 } : { amount: 10 } }) },
    platformTokenReservation: { aggregate: async (input: { where?: unknown }) => ({ _sum: input.where && JSON.stringify(input.where).includes("settled") ? { settledTokens: 5 } : { reservedTokens: 2 } }) },
    workerRuntime: { findUnique: async () => null },
    platformDefaultAiRoute: { findMany: async () => [] },
    platformBootstrap: { findUnique: async () => ({ initialAdminUserId: "99999999-9999-4999-8999-999999999999" }) },
    projectMcpActionDispatchAttempt: { groupBy: async () => [] },
    backgroundJob: { groupBy: async () => [] },
    automationRun: { groupBy: async () => [] },
    projectAction: { groupBy: async () => [] },
  } as unknown as PrismaClient;
}

test("system overview aggregates hosted calls once, recognizes only terminal unknowns, and keeps Shanghai windows", async () => {
  const queryLog: string[] = [];
  const overview = await getSystemOverview({ id: actorId, role: "admin" }, createDb({ queryLog }), now);
  const callSql = queryLog.find((sql) => sql.includes('WITH "platformCalls"')) ?? "";
  const failureSql = queryLog.find((sql) => sql.includes('WITH "platformFailures"')) ?? "";

  assert.match(callSql, /FROM "UnifiedQuestionAudit"/u);
  assert.match(callSql, /FROM "PersonalKnowledgeQaAudit"/u);
  assert.match(callSql, /call\."status"::text AS "status"/u, "UNION branches normalize enum status to text");
  assert.match(callSql, /INNER JOIN "PlatformTokenReservation"/u);
  assert.match(callSql, /"userId" = audit\."ownerUserId"/u);
  assert.match(callSql, /"personalKnowledgeQaChallengeId"/u);
  assert.match(callSql, /"providerConfigurationVersion" = audit\."providerConfigurationVersion"/u);
  assert.match(callSql, /"providerConnectionId" = audit\."providerConnectionId"/u);
  assert.match(callSql, /"modelId" = audit\."modelId"/u);
  assert.match(callSql, /"operation" = 'generateWithContext'/u);
  assert.match(callSql, /"routeSource" = 'platform_default'/u);
  assert.match(callSql, /"status" IN \('succeeded', 'failed', 'unknown'\)/u);
  assert.match(callSql, /COUNT\(\*\) FILTER \(WHERE "status" = 'unknown'\)/u);
  assert.match(callSql, /"completedAt" >=/u);
  assert.match(callSql, /"completedAt" </u);
  assert.match(callSql, /AT TIME ZONE /u);
  assert.equal((callSql.match(/AT TIME ZONE 'UTC' AT TIME ZONE /gu) ?? []).length, 3,
    "Prisma stores UTC timestamps without timezone, so all call sources must localize UTC before Shanghai bucketing");
  assert.doesNotMatch(callSql, /"createdAt"|"question"|"answer"|"evidenceManifest"|"credentialSecretFingerprint"/u);
  assert.match(failureSql, /FROM "UnifiedQuestionAudit"/u);
  assert.match(failureSql, /FROM "PersonalKnowledgeQaAudit"/u);
  assert.match(failureSql, /"billingMode" = 'platform'/u);
  assert.match(failureSql, /"payerKind" = 'platform_caller'/u);
  assert.match(failureSql, /"personalKnowledgeQaChallengeId"/u);
  assert.match(failureSql, /"completedAt" <=/u);
  assert.doesNotMatch(failureSql, /"question"|"answer"|"evidenceManifest"|"credentialSecretFingerprint"/u);

  assert.equal(overview.analytics.timeZone, "Asia/Shanghai");
  assert.equal(overview.analytics.today.date, "2026-09-03");
  assert.equal(overview.analytics.today.platformTokens, 56, "known platform, unified-question, and reservation-proven personal QA usage is aggregated once");
  assert.equal(overview.analytics.today.unknownCalls, 2, "unknown calls are counted by terminal status, not missing usage alone");
  assert.equal(overview.analytics.trends.days30.length, 30);
  assert.equal(overview.analytics.trends.days7.length, 7);
  assert.equal(overview.analytics.trends.days7[0]?.date, "2026-08-28");
  assert.deepEqual(overview.analytics.trends.days30.find((row) => row.date === "2026-09-02"), {
    date: "2026-09-02", newUsers: 0, platformTokens: 9, unknownCalls: 1, settledQuota: 0,
  });
  assert.equal(overview.analytics.today.settledQuota, 5);
  assert.equal(overview.failures.providerCalls.total, 3);
  assert.deepEqual(overview.failures.providerCalls.byCode.map((row) => row.code).sort(), [
    "PERSONAL_QA_FAILED", "PLATFORM_PROVIDER_FAILURE", "UNIFIED_QUESTION_FAILED",
  ]);
  assert.doesNotMatch(JSON.stringify({ analytics: overview.analytics, failures: overview.failures }), /ownerUserId|projectId|question|answer|evidenceManifest|credential/u);
});

test("overview marks a platform aggregate unavailable if any of its required sources cannot be read", async () => {
  const analyticsUnavailable = await getSystemOverview(
    { id: actorId, role: "admin" }, createDb({ analyticsFailure: true }), now,
  );
  assert.equal(analyticsUnavailable.analytics.today.platformTokens, null);
  assert.equal(analyticsUnavailable.analytics.today.unknownCalls, null);
  assert.equal(analyticsUnavailable.analytics.trends.days30[0]?.platformTokens, null);

  const failuresUnavailable = await getSystemOverview(
    { id: actorId, role: "admin" }, createDb({ failureFailure: true }), now,
  );
  assert.equal(failuresUnavailable.failures.providerCalls.total, null);
  assert.equal(failuresUnavailable.failures.providerCalls.evidence, "not_obtained");
  assert.equal(failuresUnavailable.failures.total, null);
});
