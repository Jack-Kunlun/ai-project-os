import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("only model-calling app and worker receive the dedicated OpenAI proxy setting", () => {
  const compose = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
  const setting = "AI_PROJECT_OS_OPENAI_PROXY_URL";
  const blocks = [...compose.matchAll(/^  ([a-z][a-z0-9_-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:|^\S|$(?![\s\S]))/gm)];
  const receivers = blocks.filter((block) => block[2].includes(`${setting}:`)).map((block) => block[1]);
  assert.deepEqual(receivers, ["app", "worker"]);
  for (const name of receivers) {
    const body = blocks.find((block) => block[1] === name)?.[2] ?? "";
    assert.ok(body.includes(`${setting}: "\${${setting}:-}"`));
  }
  assert.doesNotMatch(compose, /^\s+(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NODE_USE_ENV_PROXY):/m);
});
