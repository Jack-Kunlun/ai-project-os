import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("automatic release cleanup protects retained images and business resources offline", () => {
  const result = spawnSync("python3", ["-B", "test/production-release-maintenance.py"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 11 tests/u);
});
