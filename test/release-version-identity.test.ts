import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { APP_VERSION } from "../src/lib/version";

test("application package, public health and OCI image use the same release version", async () => {
  const [packageSource, dockerfile] = await Promise.all([readFile("package.json", "utf8"), readFile("Dockerfile", "utf8")]);
  const packageVersion = (JSON.parse(packageSource) as { version: string }).version;
  assert.equal(packageVersion, "0.7.16");
  assert.equal(APP_VERSION, packageVersion);
  const labels = [...dockerfile.matchAll(/org\.opencontainers\.image\.version="([^"]+)"/gu)];
  assert.equal(labels.length, 1);
  assert.equal(labels[0]?.[1], packageVersion);
});
