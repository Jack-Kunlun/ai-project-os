import assert from "node:assert/strict";
import test from "node:test";
import { formatProjectPlanDate } from "../src/lib/project-plan-date";

test("date-only plan values keep the selected calendar day across display languages", () => {
  assert.equal(formatProjectPlanDate("2026-11-23T00:00:00.000Z", "zh-CN", "未设置"), "2026年11月23日");
  assert.equal(formatProjectPlanDate("2026-11-23T00:00:00.000Z", "en", "Not set"), "Nov 23, 2026");
  assert.equal(formatProjectPlanDate(null, "zh-CN", "未设置"), "未设置");
});
