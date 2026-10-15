import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { APP_VERSION } from "../src/lib/version";

test("application package, public health and OCI image use the same release version", async () => {
  const [packageSource, dockerfile, releaseNotes] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("Dockerfile", "utf8"),
    readFile("docs/releases/v1.0.1.md", "utf8"),
  ]);
  const packageVersion = (JSON.parse(packageSource) as { version: string }).version;
  assert.equal(packageVersion, "1.0.1");
  assert.equal(APP_VERSION, packageVersion);
  const labels = [...dockerfile.matchAll(/org\.opencontainers\.image\.version="([^"]+)"/gu)];
  assert.equal(labels.length, 1);
  assert.equal(labels[0]?.[1], packageVersion);
  assert.match(releaseNotes, /^# v1\.0\.1 — 账号与个人知识修复/u);
  assert.match(releaseNotes, /线上状态以公网 `\/api\/health` 和生产发布回执为准/u);
  assert.match(releaseNotes, /ai-project-os-v101-deploy\.py/u);
});
