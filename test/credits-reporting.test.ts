import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getCreditReportInTransaction, parseCreditReportQuery, resolveCreditReportQuery } from "../src/lib/credit-reporting";
import type { EntitlementDb } from "../src/lib/ai-entitlements";

test("credit report query defaults to a strict 30 day window and a valid IANA timezone", () => {
  const input = parseCreditReportQuery(new URLSearchParams("timezone=Asia%2FShanghai&page=2&pageSize=10"));
  assert.deepEqual({ range: input.range, timezone: input.timezone, page: input.page, pageSize: input.pageSize, kind: input.kind, operation: input.operation, scope: input.scope }, {
    range: "30d", timezone: "Asia/Shanghai", page: 2, pageSize: 10, kind: "all", operation: "all", scope: "all",
  });
  const query = resolveCreditReportQuery(input, new Date("2026-09-22T16:00:00.000Z"));
  assert.equal(query.window.fromDate, "2026-08-25");
  assert.equal(query.window.toDate, "2026-09-23");
  assert.equal(query.window.days.length, 30);
  assert.equal(query.window.from.toISOString(), "2026-08-24T16:00:00.000Z");
  assert.equal(query.window.to.toISOString(), "2026-09-23T16:00:00.000Z");
});

test("yearly token activity stays within the bounded report window", () => {
  const query = resolveCreditReportQuery(parseCreditReportQuery(new URLSearchParams("range=365d&timezone=Asia%2FShanghai")), new Date("2026-09-22T16:00:00.000Z"));
  assert.equal(query.window.days.length, 365);
  assert.equal(query.window.toDate, "2026-09-23");
  assert.equal(query.window.days[0], query.window.fromDate);
});

test("custom credit report windows include both local endpoints and reject malformed input", () => {
  const query = resolveCreditReportQuery(
    parseCreditReportQuery(new URLSearchParams("range=custom&from=2026-03-08&to=2026-03-10&timezone=America%2FLos_Angeles")),
    new Date("2026-09-22T00:00:00.000Z"),
  );
  assert.deepEqual(query.window.days, ["2026-03-08", "2026-03-09", "2026-03-10"]);
  assert.equal(query.window.from.toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(query.window.to.toISOString(), "2026-03-11T07:00:00.000Z");
  assert.throws(() => parseCreditReportQuery(new URLSearchParams("range=7d&from=2026-01-01")), /预设范围/u);
  assert.throws(() => parseCreditReportQuery(new URLSearchParams("range=custom&from=2026-02-30&to=2026-03-01")), /有效日期/u);
  assert.throws(() => parseCreditReportQuery(new URLSearchParams("range=7d&timezone=Not%2FAZone")), /时区无效/u);
  assert.throws(() => parseCreditReportQuery(new URLSearchParams("range=7d&unknown=value")), /不支持的查询参数/u);
  assert.equal(parseCreditReportQuery(new URLSearchParams("scope=personal")).scope, "personal");
  assert.equal(parseCreditReportQuery(new URLSearchParams("scope=project&projectId=00000000-0000-4000-8000-000000000001")).scope, "project");
  assert.throws(() => parseCreditReportQuery(new URLSearchParams("scope=project")), /项目范围需要 projectId/u);
  assert.throws(() => parseCreditReportQuery(new URLSearchParams("scope=personal&projectId=00000000-0000-4000-8000-000000000001")), /只能用于项目范围/u);
});

test("credit report keeps settled usage separate from balance delta and keeps profile free of quota detail", async () => {
  const [service, route, client, profile] = await Promise.all([
    readFile("src/lib/credit-reporting.ts", "utf8"),
    readFile("src/app/api/credits/route.ts", "utf8"),
    readFile("src/app/credits/credits-client.tsx", "utf8"),
    readFile("src/app/profile/profile-client.tsx", "utf8"),
  ]);
  assert.match(service, /settledTokens/u);
  assert.match(service, /balanceDelta: row\.amount/u);
  assert.match(service, /status: "settled"/u);
  assert.match(route, /REPEATABLE READ/u);
  assert.match(route, /SET TRANSACTION READ ONLY/u);
  assert.match(route, /requireApiSessionReadOnly/u);
  assert.ok(client.includes("/api/credits"));
  assert.match(client, /已结算使用来自 reservation allocation 的 settledTokens/u);
  assert.match(client, /后续版本/u);
  assert.match(client, /个人用量/u);
  assert.match(client, /项目用量/u);
  assert.match(client, /collected\[0\]\?\.id/u);
  assert.match(client, /<select value=\{projectId\}/u);
  assert.match(client, /fetch\(`\/api\/credits\?\$\{params\.toString\(\)\}`,[^\n]+signal/u);
  assert.match(client, /controller\.abort\(\)/u);
  assert.doesNotMatch(client, /输入项目 UUID/u);
  assert.doesNotMatch(profile, /PlatformCreditPanel|平台额度|额度总量|预留中/u);
});

test("credit report aggregates settled allocation credits while preserving a zero settle balance delta", async () => {
  const userId = "00000000-0000-4000-8000-000000000071";
  const projectId = "00000000-0000-4000-8000-000000000072";
  const settledAt = new Date("2026-09-10T08:00:00.000Z");
  const now = new Date("2026-09-12T00:00:00.000Z");
  const fakeDb = {
    platformTokenGrant: {
      findMany: async () => [{ id: "00000000-0000-4000-8000-000000000073", amount: 100, remainingTokens: 60, expiresAt: new Date("2026-10-01T00:00:00.000Z"), allocations: [{ grantId: "00000000-0000-4000-8000-000000000073", ordinal: 1, reservedTokens: 100, settledTokens: 40, releasedTokens: 60, reservation: { userId, grantId: "00000000-0000-4000-8000-000000000073", status: "settled" } }] }],
    },
    membershipSubscription: { findUnique: async () => null },
    platformDefaultAiRoute: { findMany: async () => [] },
    platformTokenReservation: {
      findMany: async ({ where }: { where: { status?: string } }) => where.status === "settled" ? [{ settledAt, rawSettledTokens: 25, allocations: [{ settledTokens: 40 }] }] : [],
    },
    platformTokenLedgerEntry: {
      count: async () => 1,
      findMany: async () => [{ id: "00000000-0000-4000-8000-000000000074", grantId: "00000000-0000-4000-8000-000000000073", entryKind: "settle", amount: 0, createdAt: settledAt, reservation: { status: "settled", operation: "generateWithContext", modelId: "gpt-test", webAiGrantProjectId: projectId, allocations: [{ grantId: "00000000-0000-4000-8000-000000000073", settledTokens: 40 }] }, grant: { expiresAt: new Date("2026-10-01T00:00:00.000Z"), revokedAt: null } }],
    },
    membershipApplication: { findMany: async () => [] },
    project: { findMany: async () => [{ id: projectId, name: "可见项目" }] },
  } as unknown as EntitlementDb;
  const query = resolveCreditReportQuery(parseCreditReportQuery(new URLSearchParams("range=custom&from=2026-09-10&to=2026-09-10&timezone=UTC")), now);
  const report = await getCreditReportInTransaction(userId, fakeDb, query, now);
  assert.equal(report.usage.settledCredits, 40);
  assert.equal(report.usage.daily[0]?.settledRawTokens, 25);
  assert.equal(report.usage.pendingCredits, 0);
  assert.equal(report.ledger.entries[0]?.settledCredits, 40);
  assert.equal(report.ledger.entries[0]?.balanceDelta, 0);
  assert.equal(report.ledger.entries[0]?.projectName, "可见项目");
});
