import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertSafeCandidateIdentity,
  createCandidateIdentity,
  createPrebuiltComposeOverride,
  evaluateCandidateReadiness,
  parseComposePs,
  readCoherentVersion,
} from "../scripts/local-release-candidate";

test("prebuilt candidate Compose override removes inherited builds for every service", (context) => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "ai-project-os-compose-override-"));
  const basePath = join(temporaryDirectory, "compose.base.yaml");
  const overridePath = join(temporaryDirectory, "compose.override.yaml");
  try {
    writeFileSync(basePath, [
      "services:",
      ...["principal-bootstrap", "migrate", "reconcile", "app", "worker", "git-worker"].flatMap((name) => [
        `  ${name}:`,
        "    image: local/base:latest",
        "    build: .",
        ...(name === "app" ? ["    env_file:", "      - candidate.env"] : []),
      ]),
      "",
    ].join("\n"));
    const imageId = (digit: string) => `sha256:${digit.repeat(64)}`;
    const override = createPrebuiltComposeOverride({
      app: { ref: "local/app:current", id: imageId("a") },
      worker: { ref: "local/worker:current", id: imageId("b") },
      migrate: { ref: "local/migrate:current", id: imageId("c") },
    });
    writeFileSync(overridePath, override);

    const version = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
    if (version.error || version.status !== 0) {
      context.skip("Docker Compose is unavailable for the merge integration check");
      return;
    }
    const result = spawnSync("docker", [
      "compose", "--ansi", "never", "--project-directory", process.cwd(),
      "--file", basePath, "--file", overridePath, "config", "--format", "json",
    ], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const configured = JSON.parse(result.stdout) as { services: Record<string, Record<string, unknown>> };
    for (const service of ["principal-bootstrap", "migrate", "reconcile", "app", "worker", "git-worker"]) {
      assert.equal("build" in configured.services[service]!, false, service);
    }
    assert.equal("env_file" in configured.services.app!, false);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("candidate identity scopes every destructive target to one generated project", () => {
  const identity = createCandidateIdentity("m8abcdeffeed", "0.6.0-dev.8");
  assert.match(identity.projectName, /^ai-project-os-candidate-/u);
  assert.ok(Object.values(identity.volumes).every((value) => value.startsWith(identity.projectName)));
  assert.ok(Object.values(identity.images).every((value) => value.startsWith(identity.projectName)));
  assert.throws(
    () => assertSafeCandidateIdentity({ ...identity, volumes: { ...identity.volumes, postgres: "ai-project-os-pgdata" } }),
    /LOCAL_RELEASE_IDENTITY_UNSAFE/u,
  );
});

test("candidate readiness requires healthy runtime services and a successful migration", () => {
  const entries = parseComposePs(JSON.stringify([
    { Service: "postgres", State: "running", Health: "healthy", ExitCode: 0 },
    { Service: "principal-bootstrap", State: "exited", Health: "", ExitCode: 0 },
    { Service: "migrate", State: "exited", Health: "", ExitCode: 0 },
    { Service: "reconcile", State: "exited", Health: "", ExitCode: 0 },
    { Service: "app", State: "running", Health: "healthy", ExitCode: 0 },
    { Service: "worker", State: "running", Health: "healthy", ExitCode: 0 },
    { Service: "git-worker", State: "running", Health: "healthy", ExitCode: 0 },
  ]));
  assert.equal(evaluateCandidateReadiness(entries).ready, true);

  const failedMigration = entries.map((entry) => entry.service === "migrate" ? { ...entry, exitCode: 1 } : entry);
  assert.match(evaluateCandidateReadiness(failedMigration).fatal ?? "", /migrate exited 1/u);
  const failedBootstrap = entries.map((entry) => entry.service === "principal-bootstrap" ? { ...entry, exitCode: 1 } : entry);
  assert.match(evaluateCandidateReadiness(failedBootstrap).fatal ?? "", /principal-bootstrap exited 1/u);
  const failedReconcile = entries.map((entry) => entry.service === "reconcile" ? { ...entry, exitCode: 1 } : entry);
  assert.match(evaluateCandidateReadiness(failedReconcile).fatal ?? "", /reconcile exited 1/u);
  const missingWorker = entries.filter((entry) => entry.service !== "worker");
  assert.equal(evaluateCandidateReadiness(missingWorker).ready, false);
  const missingGitWorker = entries.filter((entry) => entry.service !== "git-worker");
  assert.equal(evaluateCandidateReadiness(missingGitWorker).ready, false);
});

test("release version must agree across package, application, and OCI metadata", async () => {
  const [packageJson, appVersion, dockerfile] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("src/lib/version.ts", "utf8"),
    readFile("Dockerfile", "utf8"),
  ]);
  const packageVersion = (JSON.parse(packageJson) as { version: string }).version;
  assert.equal(readCoherentVersion(packageJson, appVersion, dockerfile), packageVersion);
  assert.throws(
    () => readCoherentVersion(packageJson, 'export const APP_VERSION = "9.9.9";', dockerfile),
    /LOCAL_RELEASE_VERSION_MISMATCH/u,
  );
});

test("local release command is wired to CI without tag, push, or broad cleanup", async () => {
  const [packageJsonSource, workflow, runner, dockerfile, candidateHelpers] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile(".github/workflows/ci.yml", "utf8"),
    readFile("scripts/run-local-release.ts", "utf8"),
    readFile("Dockerfile", "utf8"),
    readFile("scripts/local-release-candidate.ts", "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonSource) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts["release:local"], "node --import tsx scripts/run-local-release.ts");
  assert.match(candidateHelpers, /env_file: !reset \[\]/u);
  assert.match(candidateHelpers, /build: !reset null/u);
  assert.equal([...candidateHelpers.matchAll(/build: !reset null/gu)].length, 6);
  assert.match(candidateHelpers, /AI_PROJECT_OS_EMAIL_AUTH_ENABLED: "false"/u);
  assert.match(workflow, /pnpm release:local/u);
  assert.match(runner, /prepareReleaseImagesForCheck\(version, revision\)/u);
  assert.match(runner, /manifest\.images\.app\.id/u);
  assert.match(runner, /manifest\.images\.worker\.id/u);
  assert.match(runner, /"--no-build"/u);
  assert.match(runner, /createPrebuiltComposeOverride\(imageManifest\.images\)/u);
  assert.doesNotMatch(runner, /docker",\s*\["build"/u);
  assert.match(runner, /LOCAL_RELEASE_WORKTREE_DIRTY/u);
  assert.match(runner, /restart", "postgres", "app", "worker", "git-worker/u);
  assert.match(runner, /verifyMigrations/u);
  assert.match(runner, /verifyImageLabels/u);
  assert.match(runner, /seedBusinessFixture/u);
  assert.match(runner, /readBusinessSnapshot/u);
  assert.match(runner, /LOCAL_RELEASE_BUSINESS_SNAPSHOT_MISMATCH/u);
  assert.match(runner, /businessDataPersistence: "ok"/u);
  assert.match(runner, /readWorkerRuntime/u);
  assert.match(runner, /beforeWorker\.instanceIdHash === afterWorker\.instanceIdHash/u);
  assert.match(runner, /LOCAL_RELEASE_WORKER_INSTANCE_NOT_REPLACED/u);
  assert.match(runner, /afterWorker\.startedEpochMs < beforeWorker\.startedEpochMs/u);
  assert.match(runner, /LOCAL_RELEASE_WORKER_STARTED_AT_REGRESSED/u);
  assert.doesNotMatch(runner, /beforeWorker\.instanceIdHash === afterWorker\.instanceIdHash\s*&&/u);
  assert.match(runner, /ai_project_os_runtime/u);
  assert.match(runner, /membershipInheritanceMode[\s\S]*workspace_inherited/u);
  assert.match(runner, /contentText: sourceContent/u);
  assert.doesNotMatch(runner, /sourceContent\s*=\s*["'`][^"'`]*https?:/u);
  assert.doesNotMatch(runner, /externalRef:\s*["'`]/u);
  assert.doesNotMatch(runner, /automationRules?\.create|backgroundJobs?\.create/u);
  assert.match(runner, /cleanupCandidate/u);
  assert.match(runner, /ai_project_os_entitlement_writer/u);
  assert.match(runner, /const gitAutomationWorkerPassword = `git_automation_\$\{randomBytes\(24\)\.toString\("hex"\)\}`/u);
  assert.match(runner, /POSTGRES_GIT_AUTOMATION_WORKER_PASSWORD=\$\{gitAutomationWorkerPassword\}/u);
  assert.match(runner, /finally \{[\s\S]*await rm\(temporaryDirectory, \{ recursive: true, force: true \}\)/u);
  assert.match(runner, /"-q",\s*"-At"/u);
  assert.match(runner, /createPasswordRecord/u);
  assert.match(runner, /个人工作区/u);
  assert.doesNotMatch(runner, /DEFAULT_WORKSPACE_ID/u);
  assert.doesNotMatch(runner, /api\/admin\/onboarding\/complete/u);
  assert.match(dockerfile, /FROM deps AS builder[\s\S]*ENV NEXT_TELEMETRY_DISABLED=1/u);
  assert.doesNotMatch(runner, /runProcess\("git",\s*\["(?:tag|push)"/u);
  assert.doesNotMatch(runner, /runProcess\("docker",\s*\["push"/u);
  assert.doesNotMatch(runner, /down\s+-v/u);
});

test("v0.5 candidate fixture creates a personal workspace without default-owner onboarding", async () => {
  const [schema, bootstrapMigration, ownerlessMigration, runner] = await Promise.all([
    readFile("prisma/schema.prisma", "utf8"),
    readFile("prisma/migrations/20260917010000_add_platform_bootstrap/migration.sql", "utf8"),
    readFile("prisma/migrations/20260920010000_remove_default_workspace_owner_bootstrap/migration.sql", "utf8"),
    readFile("scripts/run-local-release.ts", "utf8"),
  ]);
  const workspaceModel = schema.match(/model Workspace \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.doesNotMatch(workspaceModel, /initialAdminOnboardingCompletedAt/u);
  assert.match(bootstrapMigration, /initialOwnerUserId.*IS NULL[\s\S]*initialOwnerCreatedAt.*IS NULL[\s\S]*adminOnboardingCompletedAt.*IS NULL/u);
  assert.match(ownerlessMigration, /DROP COLUMN "initialOwnerUserId"/u);
  assert.match(ownerlessMigration, /"workspaceId" DROP DEFAULT/u);
  assert.doesNotMatch(schema, /initialOwnerUserId|initialOwnerCreatedAt|adminOnboardingCompletedAt/u);
  assert.match(bootstrapMigration, /DROP TRIGGER IF EXISTS "Workspace_first_admin_onboarding_completion_guard"/u);
  assert.match(bootstrapMigration, /DROP FUNCTION IF EXISTS "first_admin_onboarding_completion_guard"/u);
  assert.match(bootstrapMigration, /DROP COLUMN IF EXISTS "initialAdminOnboardingCompletedAt"/u);
  assert.match(runner, /role", "user", "AppUser"/u);
  assert.match(runner, /ownerUsername/iu);
  assert.match(runner, /workspaceId = randomUUID\(\)/u);
  assert.match(runner, /accountAccessVersion[\s\S]*createdAt[\s\S]*updatedAt/u);
  assert.match(runner, /Workspace.*createdAt.*updatedAt/u);
  assert.match(runner, /WorkspaceMembership.*createdAt.*updatedAt/u);
  assert.match(runner, /WorkspaceMembership/u);
  assert.match(runner, /MembershipAccessAudit/u);
  assert.doesNotMatch(runner, /api\/admin\/onboarding\/complete/u);
  assert.doesNotMatch(runner, /默认工作区/u);
  assert.match(runner, /api\/auth\/login/u);
});
