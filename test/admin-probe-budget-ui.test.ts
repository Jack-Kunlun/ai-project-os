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
  assert.match(settingsClient, /模型测试次数不足/u);
  assert.match(settingsClient, /\/admin\/operations\/probes/u);
  const batchClient = await readFile("src/app/settings/platform-operation-assignments.tsx", "utf8");
  assert.match(batchClient, /batchBudgetProblem\(currentBudget, operations.length\)/u);
  assert.match(batchClient, /PlatformProbeBudgetClient compact disabled=\{busy\}/u);
  assert.match(budgetClient, /form=\{formId\}/u, "allowance save action is in the panel footer");
  assert.match(budgetClient, /pendingRef.current/u, "duplicate save submits cannot create two periods");
  assert.doesNotMatch(settingsClient, /安全错误码：\$\{check\.attempt\.safeErrorCode\}/u);
});
