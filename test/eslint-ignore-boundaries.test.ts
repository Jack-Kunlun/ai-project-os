import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";

test("ESLint ignores only gitignored generated evidence roots and still sees source and tests", async () => {
  const eslint = new ESLint();
  for (const directory of [".data", ".migration-evidence", "coverage", "evidence", "playwright-report", "test-results"]) {
    assert.equal(await eslint.isPathIgnored(`${directory}/lint-probe.ts`), true, `${directory} must be ignored`);
  }
  for (const file of [
    "src/components/user-shell.tsx",
    "scripts/check-performance-budget.ts",
    "test/client-chunk-boundaries.test.ts",
    "e2e/user-appearance.spec.ts",
  ]) assert.equal(await eslint.isPathIgnored(file), false, `${file} must remain linted`);
});
