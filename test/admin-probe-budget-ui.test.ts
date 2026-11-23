import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("provider testing has no budget dependency and old configuration links lead back to models", async () => {
  const [create, batch, navigation, legacy, endpoint] = await Promise.all([
    "src/app/settings/settings-client.tsx", "src/app/settings/platform-operation-assignments.tsx",
    "src/lib/admin-navigation.ts", "src/app/admin/operations/probes/page.tsx",
    "src/app/api/admin/platform-provider-probe/budget/route.ts",
  ].map((file) => readFile(file, "utf8")));
  for (const client of [create, batch, navigation]) assert.doesNotMatch(client, /platform-provider-probe\/budget|operations\/probes|batchBudgetProblem/u);
  assert.match(legacy, /requireSystemAdminPage/u);
  assert.match(legacy, /redirect\("\/admin\/models"\)/u);
  assert.match(endpoint, /PROBE_BUDGET_RETIRED/u);
  assert.match(endpoint, /410/u);
});
