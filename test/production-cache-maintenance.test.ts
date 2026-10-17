import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("stable production cache maintenance guards pass offline", () => {
  const result = spawnSync(
    "python3",
    [path.join(process.cwd(), "test/production-cache-maintenance.py")],
    { encoding: "utf8", timeout: 30_000 },
  );

  assert.equal(result.error, undefined, result.error?.message);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /Ran 16 tests/u);
  assert.match(output, /OK/u);
});
