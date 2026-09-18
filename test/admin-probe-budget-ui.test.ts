import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("platform probe UI uses local immediate datetime values and preflights budget before model tests", async () => {
  const [budgetClient, settingsClient] = await Promise.all([
    readFile("src/app/admin/operations/probes/platform-probe-budget-client.tsx", "utf8"),
    readFile("src/app/settings/settings-client.tsx", "utf8"),
  ]);
  assert.match(budgetClient, /formatDateTimeLocal/u);
  assert.match(budgetClient, /new Date\(\)\)/u);
  assert.doesNotMatch(budgetClient, /Date\.now\(\) \+ 60_000/u);
  assert.match(budgetClient, /parsedStartsAt\.toISOString\(\)/u);
  assert.match(budgetClient, /parsedExpiresAt\.toISOString\(\)/u);
  assert.match(settingsClient, /api\/admin\/platform-provider-probe\/budget/u);
  assert.match(settingsClient, /可用单位不足/u);
  assert.match(settingsClient, /\/admin\/operations\/probes/u);
  assert.doesNotMatch(settingsClient, /安全错误码：\$\{check\.attempt\.safeErrorCode\}/u);
});
