import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupCommand,
  ProjectSnapshotDemoError,
  isProjectSnapshotDemo,
  isExactDemoProjectTarget,
  parseBaseUrl,
  parseCleanupArgs,
  parseSeedArgs,
  recovery,
  type DemoProjectIdentity,
} from "../scripts/project-snapshot-demo-contract";
import {
  PROJECT_SNAPSHOT_DEMO_DESCRIPTION,
  PROJECT_SNAPSHOT_DEMO_MARKER,
  PROJECT_SNAPSHOT_DEMO_PROJECT_NAME,
  PROJECT_SNAPSHOT_DEMO_SLUG_PREFIX,
} from "./fixtures/project-snapshot-demo";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const slug = `${PROJECT_SNAPSHOT_DEMO_SLUG_PREFIX}-abcdef123456`;
const otherSlug = `${PROJECT_SNAPSHOT_DEMO_SLUG_PREFIX}-fedcba654321`;

function demoProject(overrides: Partial<DemoProjectIdentity> = {}): DemoProjectIdentity {
  return {
    id: projectId,
    slug,
    name: PROJECT_SNAPSHOT_DEMO_PROJECT_NAME,
    description: PROJECT_SNAPSHOT_DEMO_DESCRIPTION,
    ...overrides,
  };
}

function captureContractError(action: () => unknown): ProjectSnapshotDemoError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ProjectSnapshotDemoError);
  assert.equal(caught.code, "INVALID_ARGUMENTS");
  return caught;
}

test("base URL accepts only root loopback HTTP(S) origins", () => {
  for (const value of [
    "http://localhost:3000",
    "https://localhost:3443/",
    "http://127.0.0.1:3000/",
    "https://[::1]:3443",
  ]) {
    assert.equal(parseBaseUrl(value), new URL(value).origin);
  }
  assert.equal(parseSeedArgs([]).baseUrl, "http://localhost:3000");
});

test("base URL rejects remote, credential, query, fragment, path, and non-http origins", () => {
  for (const value of [
    "https://example.com",
    "http://user:password@localhost:3000",
    "http://localhost:3000?token=secret",
    "http://localhost:3000?",
    "http://localhost:3000/#fragment",
    "http://localhost:3000/#",
    "http://localhost:3000/app",
    "http://localhost:3000/.",
    "http://localhost:3000/..",
    "http://localhost:3000/foo/..",
    "http://localhost:3000/%2e",
    "http://localhost:3000//",
    "http://localhost:3000\\foo",
    "http://[::1]:3000\\foo",
    "ftp://localhost:3000",
  ]) {
    captureContractError(() => parseBaseUrl(value));
  }
});

test("CLI argument parsers reject invalid and duplicate parameters without echoing values", () => {
  captureContractError(() => parseSeedArgs(["--base-url", "http://localhost:3000", "--base-url", "http://localhost:3001"]));

  const credentialUrl = "http://user:password@localhost:3000";
  const credentialError = captureContractError(() => parseBaseUrl(credentialUrl));
  for (const marker of [credentialUrl, "password"]) {
    assert.equal(credentialError.message.includes(marker), false);
  }

  const unknownOptionUrl = "https://example.com/?token=secret";
  const unknownOptionError = captureContractError(() => parseSeedArgs(["--unknown", unknownOptionUrl]));
  for (const marker of [unknownOptionUrl, "token", "secret"]) {
    assert.equal(unknownOptionError.message.includes(marker), false);
  }

  captureContractError(() => parseCleanupArgs([]));
  captureContractError(() => parseCleanupArgs(["--project-id", "invalid", "--slug", slug]));
  captureContractError(() => parseCleanupArgs(["--project-id", projectId, "--slug", "invalid-slug"]));
  captureContractError(() => parseCleanupArgs(["--project-id", projectId, "--project-id", otherProjectId, "--slug", slug]));
  captureContractError(() => parseCleanupArgs(["--project-id", projectId, "--slug", slug, "--slug", otherSlug]));

  assert.deepEqual(parseCleanupArgs(["--project-id", projectId, "--slug", slug]), { projectId, slug });
});

test("cleanup target predicate requires exact id, slug, name, description, and marker", () => {
  const target = demoProject();
  assert.equal(isProjectSnapshotDemo(target), true);
  assert.equal(isExactDemoProjectTarget(target, projectId, slug), true);
  assert.equal(isExactDemoProjectTarget({ ...target, id: otherProjectId }, projectId, slug), false);
  assert.equal(isExactDemoProjectTarget({ ...target, slug: otherSlug }, projectId, slug), false);
  assert.equal(isExactDemoProjectTarget({ ...target, name: "Other project" }, projectId, slug), false);
  assert.equal(isExactDemoProjectTarget({ ...target, description: `${PROJECT_SNAPSHOT_DEMO_DESCRIPTION} changed` }, projectId, slug), false);
  assert.equal(
    isExactDemoProjectTarget(
      { ...target, description: PROJECT_SNAPSHOT_DEMO_DESCRIPTION.replace(PROJECT_SNAPSHOT_DEMO_MARKER, "OTHER_MARKER") },
      projectId,
      slug,
    ),
    false,
  );
  assert.equal(isProjectSnapshotDemo({ ...target, description: null }), false);
});

test("recovery command preserves exact cleanup parameters", () => {
  const command = `pnpm project-snapshot:demo -- cleanup --project-id ${projectId} --slug ${slug}`;
  assert.equal(cleanupCommand(projectId, slug), command);
  assert.deepEqual(recovery(projectId, slug), { projectId, slug, command });
});
