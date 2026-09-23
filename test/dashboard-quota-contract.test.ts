import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { projectDashboardQuota } from "../src/lib/workspace-summary";

test("dashboard quota projection keeps zero valid and allowlists only platform credit fields", () => {
  const expiry = new Date("2026-10-01T00:00:00.000Z");
  const projected = projectDashboardQuota({
    availableTokens: 0,
    nextExpiryAt: expiry,
    reservedTokens: 99,
    providerName: "private-supplier",
    byokBalance: 1234,
  });

  assert.deepEqual(projected, {
    status: "available",
    unit: "platform_credit",
    availableCredits: 0,
    nextExpiryAt: expiry.toISOString(),
  });
  assert.equal("providerName" in projected, false);
  assert.equal("byokBalance" in projected, false);
});

test("dashboard quota projection fails closed for an unavailable or malformed advisory", () => {
  assert.deepEqual(projectDashboardQuota(null), { status: "unavailable", unit: "platform_credit" });
  assert.deepEqual(projectDashboardQuota({ availableTokens: -1, nextExpiryAt: null }), { status: "unavailable", unit: "platform_credit" });
  assert.deepEqual(projectDashboardQuota({ availableTokens: 4.5, nextExpiryAt: null }), { status: "unavailable", unit: "platform_credit" });
  assert.deepEqual(projectDashboardQuota({ availableTokens: 4, nextExpiryAt: "not-a-date" }), { status: "unavailable", unit: "platform_credit" });
});

test("dashboard reads the current caller advisory independently and keeps client states explicit", async () => {
  const [route, summary, client] = await Promise.all([
    readFile("src/app/api/dashboard/route.ts", "utf8"),
    readFile("src/lib/workspace-summary.ts", "utf8"),
    readFile("src/app/dashboard/dashboard-client.tsx", "utf8"),
  ]);

  assert.match(route, /getPlatformTokenAdvisory\(user\.id, db\)/u);
  assert.match(route, /\.catch\(\(\) => projectDashboardQuota\(null\)\)/u);
  assert.match(route, /quota,/u);
  assert.doesNotMatch(route, /providerName|byokBalance|credential|routeSnapshots|membership/u);
  assert.match(summary, /status: "available"/u);
  assert.match(summary, /status: "unavailable"/u);
  assert.match(summary, /availableCredits: number/u);
  assert.match(client, /正在读取额度/u);
  assert.match(client, /availableCredits === 0/u);
  assert.match(client, /暂时无法读取当前额度/u);
  assert.match(client, /实际执行前会再次核验额度/u);
  assert.match(client, /href="\/credits"/u);
  assert.match(client, /我的工作[\s\S]*项目动态/u);
  assert.match(client, /\/api\/personal\/knowledge\/overview/u);
  assert.match(client, /\/api\/me\/git-connections/u);
});
