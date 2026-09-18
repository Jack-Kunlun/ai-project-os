import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { getSystemOverview } from "../src/lib/system-overview";

const actorId = "33333333-3333-4333-8333-333333333333";

test("system overview analytics uses Shanghai days, preserves zeros, and separates unknown usage", async () => {
  const now = new Date("2026-09-03T00:00:00.000Z");
  let providerCallSql = "";
  const db = {
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join("") ?? "";
      if (sql.includes('FROM "AppUser"')) return [{ date: "2026-09-03", value: BigInt(2) }];
      if (sql.includes('FROM "ProviderCallAudit"')) {
        providerCallSql = sql;
        return [{ date: "2026-09-03", tokens: BigInt(7), unknownCalls: BigInt(1) }];
      }
      if (sql.includes('FROM "PlatformTokenReservation"')) return [{ date: "2026-09-03", value: BigInt(5) }];
      if (sql.includes('attestation')) return [{ count: BigInt(0) }];
      return [{ ok: 1 }];
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
    providerCallAudit: { groupBy: async () => [] },
    projectMcpActionDispatchAttempt: { groupBy: async () => [] },
    backgroundJob: { groupBy: async () => [] },
    automationRun: { groupBy: async () => [] },
    projectAction: { groupBy: async () => [] },
  } as unknown as PrismaClient;

  const overview = await getSystemOverview({ id: actorId, role: "admin" }, db, now);
  assert.match(providerCallSql, /"completedAt"/u);
  assert.match(providerCallSql, /"completedAt" IS NOT NULL/u);
  assert.doesNotMatch(providerCallSql, /"createdAt"/u);
  assert.equal(overview.analytics.timeZone, "Asia/Shanghai");
  assert.deepEqual(overview.analytics.today, {
    date: "2026-09-03",
    newUsers: 2,
    platformTokens: 7,
    unknownCalls: 1,
    settledQuota: 5,
    activeMemberships: 3,
  });
  assert.equal(overview.analytics.trends.days7.length, 7);
  assert.equal(overview.analytics.trends.days30.length, 30);
  assert.deepEqual(overview.analytics.trends.days7[0], {
    date: "2026-08-28",
    newUsers: 0,
    platformTokens: 0,
    unknownCalls: 0,
    settledQuota: 0,
  });
});
