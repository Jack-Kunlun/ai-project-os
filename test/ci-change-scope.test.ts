import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isVersionOnlyPackageChange, needsCoverage, needsDatabaseGates } from "../scripts/ci-change-scope.mjs";

test("styles and static images skip database gates", () => {
  assert.equal(needsDatabaseGates(["src/app/globals.css"]), false);
  assert.equal(needsDatabaseGates(["src/app/dashboard/dashboard.module.css"]), false);
  assert.equal(needsDatabaseGates(["src/app/globals.css", "public/brand/logo.png"]), false);
});

test("presentation-only changes skip coverage while client code keeps every gate", () => {
  assert.equal(needsCoverage(["src/app/globals.css", "public/brand/logo.png"]), false);
  assert.equal(needsCoverage(["src/app/dashboard/dashboard.module.css"]), false);
  assert.equal(needsCoverage(["src/app/dashboard/dashboard-client.tsx"]), true);
  assert.equal(needsDatabaseGates(["src/app/admin/models/platform-credit-governance-client.tsx"]), true);
  assert.equal(needsCoverage([]), true);
});

test("only a forward 0.6 package version bump can share the presentation path", () => {
  const base = { name: "ai-project-os", version: "0.6.0-dev.8", scripts: { build: "next build" } };
  assert.equal(isVersionOnlyPackageChange(base, { ...base, version: "0.6.0-dev.9" }), true);
  assert.equal(needsDatabaseGates([], true), false);
  assert.equal(needsCoverage([], true), false);
  assert.equal(isVersionOnlyPackageChange(base, { ...base, version: "0.6.0-dev.8" }), false);
  assert.equal(isVersionOnlyPackageChange(base, { ...base, version: "0.6.0-dev.9", scripts: { build: "echo skip" } }), false);
  assert.equal(isVersionOnlyPackageChange(base, { ...base, version: "0.7.0-dev.1" }), false);
  assert.equal(isVersionOnlyPackageChange(base, { ...base, version: "0.6.0-dev.18446744073709551625" }), false);
});

test("server, schema, tests and unknown changes require database gates", () => {
  for (const path of ["src/app/dashboard/page.tsx", "src/app/api/health/route.ts", "src/lib/auth.ts", "prisma/schema.prisma", "test/account.test.ts", "public/brand/logo.svg", ".github/workflows/ci.yml"]) {
    assert.equal(needsDatabaseGates(["src/app/globals.css", path]), true, path);
  }
  assert.equal(needsDatabaseGates([]), true);
});

test("CI command accepts only a real version-only package diff and detects renamed code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-project-os-ci-scope-"));
  const script = path.resolve("scripts/ci-change-scope.mjs");
  const output = path.join(root, "scope-output");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const classify = async (base: string, head: string) => {
    await writeFile(output, "");
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI_BASE_SHA: base, CI_HEAD_SHA: head, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    return readFile(output, "utf8");
  };
  try {
    git("init", "-q");
    git("config", "user.name", "CI Test");
    git("config", "user.email", "ci-test@example.invalid");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.6.0-dev.8", scripts: { build: "next build" } }));
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.6.0-dev.9", scripts: { build: "next build" } }));
    git("add", ".");
    git("commit", "-qm", "version");
    const version = git("rev-parse", "HEAD");
    assert.equal(await classify(base, version), "database=false\ncoverage=false\n");

    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.6.0-dev.10", scripts: { build: "echo changed" } }));
    git("add", "package.json");
    git("commit", "-qm", "script");
    const scriptChange = git("rev-parse", "HEAD");
    assert.equal(await classify(version, scriptChange), "database=true\ncoverage=true\n");

    await mkdir(path.join(root, "src/lib"), { recursive: true });
    await mkdir(path.join(root, "src/app"), { recursive: true });
    await writeFile(path.join(root, "src/lib/auth.ts"), "export const value = 1;\n");
    git("add", "src/lib/auth.ts");
    git("commit", "-qm", "source");
    const source = git("rev-parse", "HEAD");
    await rename(path.join(root, "src/lib/auth.ts"), path.join(root, "src/app/style.css"));
    git("add", "-u", "src/lib/auth.ts");
    git("add", "src/app/style.css");
    git("commit", "-qm", "rename");
    assert.equal(await classify(source, git("rev-parse", "HEAD")), "database=true\ncoverage=true\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
