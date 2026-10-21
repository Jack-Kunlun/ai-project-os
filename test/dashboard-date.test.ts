import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatDashboardDate, formatDashboardGreetingDate } from "../src/lib/dashboard-date";

test("dashboard dates use the same Shanghai day in server and browser time zones", () => {
  const previousTimeZone = process.env.TZ;
  try {
    const snapshots = ["UTC", "Asia/Shanghai", "America/Los_Angeles"].map((timeZone) => {
      process.env.TZ = timeZone;
      return {
        beforeMidnight: formatDashboardGreetingDate("2026-10-21T15:59:59.000Z", "zh-CN"),
        afterMidnight: formatDashboardGreetingDate("2026-10-21T16:00:00.000Z", "zh-CN"),
        english: formatDashboardGreetingDate("2026-10-21T16:00:00.000Z", "en"),
        jobDate: formatDashboardDate("2026-10-21T16:00:00.000Z", "en"),
      };
    });
    assert.deepEqual(snapshots[0], snapshots[1]);
    assert.deepEqual(snapshots[0], snapshots[2]);
    assert.match(snapshots[0].beforeMidnight, /10月21日.*星期三/);
    assert.match(snapshots[0].afterMidnight, /10月22日.*星期四/);
    assert.match(snapshots[0].english, /Thursday, October 22/);
    assert.match(snapshots[0].jobDate, /Oct 22/);
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test("dashboard hydration reuses the server timestamp instead of reading a second clock", () => {
  const page = readFileSync(new URL("../src/app/dashboard/page.tsx", import.meta.url), "utf8");
  const client = readFileSync(new URL("../src/app/dashboard/dashboard-client.tsx", import.meta.url), "utf8");
  assert.match(page, /initialNow=\{new Date\(\)\.toISOString\(\)\}/);
  assert.match(client, /formatGreetingDate\(initialNow, language\)/);
  assert.doesNotMatch(client, /new Date\(\)/);
});
