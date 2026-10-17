import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("stable production historical image maintenance guards pass offline", () => {
  const result = spawnSync(
    "python3",
    [path.join(process.cwd(), "test/production-image-maintenance.py")],
    { encoding: "utf8", timeout: 45_000 },
  );

  assert.equal(result.error, undefined, result.error?.message);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /Ran 24 tests/u);
  assert.match(output, /OK/u);
});
