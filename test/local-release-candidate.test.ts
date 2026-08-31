import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertSafeCandidateIdentity,
  createCandidateIdentity,
  evaluateCandidateReadiness,
  parseComposePs,
  readCoherentVersion,
} from "../scripts/local-release-candidate";

test("candidate identity scopes every destructive target to one generated project", () => {
  const identity = createCandidateIdentity("m5abcdeffeed", "5.1.0");
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
    { Service: "migrate", State: "exited", Health: "", ExitCode: 0 },
    { Service: "app", State: "running", Health: "healthy", ExitCode: 0 },
    { Service: "worker", State: "running", Health: "healthy", ExitCode: 0 },
  ]));
  assert.equal(evaluateCandidateReadiness(entries).ready, true);

  const failedMigration = entries.map((entry) => entry.service === "migrate" ? { ...entry, exitCode: 1 } : entry);
  assert.match(evaluateCandidateReadiness(failedMigration).fatal ?? "", /migrate exited 1/u);
  const missingWorker = entries.filter((entry) => entry.service !== "worker");
  assert.equal(evaluateCandidateReadiness(missingWorker).ready, false);
});

test("release version must agree across package, application, and OCI metadata", async () => {
  const [packageJson, appVersion, dockerfile] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("src/lib/version.ts", "utf8"),
    readFile("Dockerfile", "utf8"),
  ]);
  assert.equal(readCoherentVersion(packageJson, appVersion, dockerfile), "5.1.0");
  assert.throws(
    () => readCoherentVersion(packageJson, 'export const APP_VERSION = "9.9.9";', dockerfile),
    /LOCAL_RELEASE_VERSION_MISMATCH/u,
  );
});

test("local release command is wired to CI without tag, push, or broad cleanup", async () => {
  const [packageJsonSource, workflow, runner, dockerfile] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile(".github/workflows/ci.yml", "utf8"),
    readFile("scripts/run-local-release.ts", "utf8"),
    readFile("Dockerfile", "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonSource) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts["release:local"], "node --import tsx scripts/run-local-release.ts");
  assert.match(workflow, /pnpm release:local/u);
  assert.match(runner, /LOCAL_RELEASE_WORKTREE_DIRTY/u);
  assert.match(runner, /restart", "postgres", "app", "worker/u);
  assert.match(runner, /verifyMigrations/u);
  assert.match(runner, /verifyImageLabels/u);
  assert.match(runner, /cleanupCandidate/u);
  assert.match(dockerfile, /FROM deps AS builder[\s\S]*ENV NEXT_TELEMETRY_DISABLED=1/u);
  assert.doesNotMatch(runner, /runProcess\("git",\s*\["(?:tag|push)"/u);
  assert.doesNotMatch(runner, /runProcess\("docker",\s*\["push"/u);
  assert.doesNotMatch(runner, /down\s+-v/u);
});
