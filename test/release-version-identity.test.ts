import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { APP_VERSION } from "../src/lib/version";

test("application package, public health and OCI image use the same release version", async () => {
  const [packageSource, dockerfile] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("Dockerfile", "utf8"),
  ]);
  const packageVersion = (JSON.parse(packageSource) as { version: string }).version;
  assert.match(packageVersion, /^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
  const releaseNotes = await readFile(`docs/releases/v${packageVersion}.md`, "utf8");
  assert.equal(APP_VERSION, packageVersion);
  const labels = [...dockerfile.matchAll(/org\.opencontainers\.image\.version="([^"]+)"/gu)];
  assert.equal(labels.length, 1);
  if (labels[0]?.[1] === "${APP_VERSION}") {
    assert.equal(dockerfile.match(/^ARG APP_VERSION="([^"]+)"$/mu)?.[1], packageVersion);
  } else {
    assert.equal(labels[0]?.[1], packageVersion);
  }
  assert.ok(releaseNotes.startsWith(`# v${packageVersion} `));
});
