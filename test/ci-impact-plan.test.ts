import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planCiImpact, planRepositoryImpact } from "../scripts/ci-impact-plan.mjs";

const gatesByFile = new Map([
  ["personal-knowledge-platform-semantic-postgres.test.ts", "personal-knowledge-platform-semantic"],
]);

test("impact planning selects cumulative PostgreSQL gates and client delivery checks", () => {
  const selected = planCiImpact([
    "test/personal-knowledge-platform-semantic-postgres.test.ts",
    "src/components/knowledge/search-client.tsx",
  ], { gatesByFile });

  assert.equal(selected.mode, "selected");
  assert.equal(selected.gateFilter, "personal-knowledge-platform-semantic");
  assert.equal(selected.browser, true);
  assert.equal(selected.candidate, true);
  assert.equal(selected.phoneAuth, false);
  assert.equal(selected.oid10, false);
});

test("impact planning treats release infrastructure as image checks without PostgreSQL gates", () => {
  const planned = planCiImpact([".github/workflows/ci.yml", "docker-bake.hcl"]);
  assert.equal(planned.mode, "none");
  assert.equal(planned.gateFilter, "none");
  assert.equal(planned.browser, false);
  assert.equal(planned.candidate, true);

  const dockerfile = planCiImpact(["Dockerfile"]);
  assert.equal(dockerfile.mode, "none");
  assert.equal(dockerfile.candidate, true);

  const sharedImagePlanner = planCiImpact(["scripts/local-release-images.ts"]);
  assert.equal(sharedImagePlanner.mode, "none");
  assert.equal(sharedImagePlanner.browser, true);
  assert.equal(sharedImagePlanner.candidate, true);

  const browserRunnerImpact = planCiImpact(["scripts/run-browser-e2e.ts"]);
  assert.equal(browserRunnerImpact.mode, "none");
  assert.equal(browserRunnerImpact.browser, true);
  assert.equal(browserRunnerImpact.candidate, true);
});

test("unknown source, authentication, permission, provider, and schema changes run full gates", () => {
  for (const path of [
    "src/lib/unmapped-service.ts",
    "src/app/profile/account/route.ts",
    "src/components/auth/login-client.tsx",
    "src/app/api/permissions/route.ts",
    "src/app/api/providers/route.ts",
    "prisma/schema.prisma",
    "src/lib/mcp/client.ts",
  ]) {
    const planned = planCiImpact([path], { gatesByFile });
    assert.equal(planned.mode, "full", path);
    assert.equal(planned.gateFilter, "all", path);
    assert.equal(planned.phoneAuth, true, path);
    assert.equal(planned.oid10, true, path);
    assert.equal(planned.browser, true, path);
    assert.equal(planned.candidate, true, path);
    assert.equal(planned.schemaValidation, true, path);
  }
});

test("unknown PostgreSQL tests, dependency locks, and unproven package edits fail closed", () => {
  for (const path of [
    "test/future-domain-postgres.test.ts",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
  ]) {
    assert.equal(planCiImpact([path], { gatesByFile }).mode, "full", path);
  }

  assert.equal(planCiImpact(["test/new-sensitive-provider.test.ts"], { gatesByFile }).mode, "full");
  assert.equal(planCiImpact(["src/app/unknown-route/page.tsx"], { gatesByFile }).mode, "full");
  for (const path of ["public/runtime.js", "public/config.json", "public/theme.css"]) {
    assert.equal(planCiImpact([path], { gatesByFile }).mode, "full", path);
  }
  assert.equal(planCiImpact(["public/brand/logo.png"], { gatesByFile }).mode, "none");
  assert.equal(planCiImpact(["public/brand/logo.svg"], { gatesByFile }).browser, true);
  assert.equal(planCiImpact([".github/workflows/ci.yml"], { baseKnown: false }).mode, "full");
});

test("version-only changes require all identity files and exact content normalization", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-project-os-impact-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "src/lib"), { recursive: true });
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, "scripts/run-browser-e2e.ts"), "// original browser runner\n");
    writeFileSync(join(root, "scripts/postgres-gate-contract.ts"), 'const gates = [{ id: "sample", file: "test/sample-postgres.test.ts" }];\n');
    writeFileSync(join(root, "package.json"), '{"name":"ai-project-os","version":"1.0.5"}\n');
    writeFileSync(join(root, "src/lib/version.ts"), 'export const APP_VERSION = "1.0.5" as const;\n');
    writeFileSync(join(root, ".github/workflows/ci.yml"), "name: CI\n");
    writeFileSync(join(root, "Dockerfile"), [
      "FROM node:24 AS base",
      'LABEL org.opencontainers.image.version="1.0.5"',
      "",
    ].join("\n"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "ci-impact@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "CI Impact Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: root });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    writeFileSync(join(root, "package.json"), '{"name":"ai-project-os","version":"1.0.6"}\n');
    writeFileSync(join(root, "src/lib/version.ts"), 'export const APP_VERSION = "1.0.6" as const;\n');
    writeFileSync(join(root, "Dockerfile"), [
      "FROM node:24 AS base",
      'LABEL org.opencontainers.image.version="1.0.6"',
      "",
    ].join("\n"));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "version"], { cwd: root });
    const target = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const planned = planRepositoryImpact(root, base, target);
    assert.equal(planned.mode, "none");
    assert.equal(planned.candidate, false);
    assert.match(planned.reason, /^version-only:/u);

    writeFileSync(join(root, "package.json"), '{"name":"ai-project-os","version":"1.0.7"}\n');
    writeFileSync(join(root, "src/lib/version.ts"), 'export const APP_VERSION = "1.0.7" as const;\n');
    writeFileSync(join(root, "Dockerfile"), [
      "FROM node:24 AS base",
      'ARG APP_VERSION="1.0.7"',
      "ARG APP_REVISION=unknown",
      'LABEL org.opencontainers.image.version="${APP_VERSION}"',
      "ENV BUILD_MODE=stable",
      "",
    ].join("\n"));
    writeFileSync(join(root, ".github/workflows/ci.yml"), "name: CI\n# changed release tooling\n");
    writeFileSync(join(root, "scripts/run-browser-e2e.ts"), "// updated browser runner\n");
    execFileSync("git", ["add", "package.json"], { cwd: root });
    execFileSync("git", ["add", "src/lib/version.ts", "Dockerfile", ".github/workflows/ci.yml", "scripts/run-browser-e2e.ts"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "version and CI tooling"], { cwd: root });
    const mixed = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const mixedPlan = planRepositoryImpact(root, target, mixed);
    assert.equal(mixedPlan.mode, "none", JSON.stringify(mixedPlan));
    assert.equal(mixedPlan.candidate, true);
    assert.equal(mixedPlan.browser, true);
    assert.match(mixedPlan.reason, /^version-only:/u);

    writeFileSync(join(root, "package.json"), '{"name":"ai-project-os","version":"1.0.8","private":true}\n');
    execFileSync("git", ["add", "package.json"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "unrelated package change"], { cwd: root });
    const unproven = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    assert.equal(planRepositoryImpact(root, mixed, unproven).mode, "full");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
