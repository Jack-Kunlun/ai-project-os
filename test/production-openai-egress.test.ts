import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("production OpenAI egress installer contract", () => {
  const result = spawnSync("python3", ["-B", "test/production-openai-egress.py"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
