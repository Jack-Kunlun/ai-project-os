import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  createRepositoryTestPlan,
  createTestPlanForSnapshot,
  readRepositorySnapshot,
  verifyRepositoryTestPlan,
} from "../scripts/ci-test-plan.mjs";

const repository = process.cwd();
const policy = JSON.parse(readFileSync(new URL("../config/ci-test-coverage.json", import.meta.url), "utf8")) as {
  sharedShellPaths: string[];
  sharedShellBrowserSpecs: string[];
  sharedShellUnitTests: string[];
  globalPaths: string[];
  routeGroups: Array<{ browserSpecs: string[]; unitTests: string[] }>;
};
const testInventory = new Set([
  ...policy.sharedShellUnitTests,
  ...policy.routeGroups.flatMap((group) => group.unitTests),
  "test/release-version-identity.test.ts",
  "test/product-identity-contract.test.ts",
]);
const specInventory = new Set([
  ...policy.sharedShellBrowserSpecs,
  ...policy.routeGroups.flatMap((group) => group.browserSpecs),
]);

function coverageSnapshot({ omit = [] as string[] } = {}): Map<string, string> {
  const omitted = new Set(omit);
  const files = new Map<string, string>();
  for (const path of [...testInventory, ...specInventory]) {
    if (!omitted.has(path)) files.set(path, "export {};\n");
  }
  return files;
}

function addFile(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string, message: string): string {
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function makeGitRepo(extraFiles: Record<string, string> = {}): { root: string; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ci-test-plan-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "ci-test-plan@example.invalid");
  git(root, "config", "user.name", "CI Test Plan");
  addFile(root, "scripts/postgres-gate-contract.ts", 'const gates = [{ id: "sample", file: "test/sample-postgres.test.ts" }];\n');
  addFile(root, "config/ci-test-coverage.json", readFileSync(new URL("../config/ci-test-coverage.json", import.meta.url), "utf8"));
  addFile(root, "package.json", '{"name":"fixture","version":"1.0.5"}\n');
  addFile(root, "src/lib/version.ts", 'export const APP_VERSION = "1.0.5" as const;\n');
  addFile(root, "Dockerfile", 'FROM node:24 AS base\nLABEL org.opencontainers.image.version="1.0.5"\n');
  for (const path of [...testInventory, ...specInventory]) addFile(root, path, "export {};\n");
  for (const [path, content] of Object.entries(extraFiles)) addFile(root, path, content);
  commit(root, "base");
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

function snapshotPlan(changes: string[], { impact = { mode: "none", browser: true }, risk = "medium", files = coverageSnapshot(), beforeFiles }: {
  impact?: { mode: "full" | "selected" | "none"; browser: boolean; reason?: string };
  risk?: "low" | "medium" | "high";
  files?: Map<string, string>;
  beforeFiles?: Map<string, string>;
} = {}) {
  return createTestPlanForSnapshot({
    base: "1".repeat(40),
    target: "2".repeat(40),
    risk,
    changedPaths: changes,
    files,
    beforeFiles,
    impact,
  });
}

test("shared shell changes select the exact three browser specs and four focused unit contracts", () => {
  const plan = snapshotPlan(["src/components/user-shell.tsx"]);
  assert.equal(plan.unit.mode, "selected");
  assert.deepEqual(plan.unit.files, [...policy.sharedShellUnitTests].sort());
  assert.equal(plan.browser.mode, "selected");
  assert.deepEqual(plan.browser.files, [...policy.sharedShellBrowserSpecs].sort());
  assert.equal(plan.browser.files.length, 3);
});

test("mixed shared-shell and local route changes union both browser groups", () => {
  const files = coverageSnapshot();
  files.set("src/components/user-shell.tsx", "export const shell = true;\n");
  files.set("src/app/personal/knowledge/page.tsx", 'import "@/components/knowledge-view";\nexport default function Page() { return null; }\n');
  files.set("src/components/knowledge-view.tsx", 'import "./knowledge-view.module.css";\nexport default function View() { return null; }\n');
  files.set("src/components/knowledge-view.module.css", ".card { color: black; }\n");
  files.set("src/app/(workspace)/projects/[projectId]/materials/page.tsx", 'import "./materials-client";\nexport default function Page() { return null; }\n');
  files.set("src/app/(workspace)/projects/[projectId]/materials/materials-client.tsx", "export default function MaterialsClient() { return null; }\n");
  const plan = snapshotPlan([
    "src/components/user-shell.tsx",
    "src/components/knowledge-view.module.css",
    "src/app/(workspace)/projects/[projectId]/materials/materials-client.tsx",
  ], { files });
  assert.equal(plan.browser.mode, "selected");
  assert.deepEqual(plan.browser.files, [
    "e2e/feedback-layout-parity.spec.ts",
    "e2e/knowledge-localization.spec.ts",
    "e2e/materials-request-race.spec.ts",
    "e2e/page-operations-and-import.spec.ts",
    "e2e/personal-knowledge-modal.spec.ts",
    "e2e/personal-project-search.spec.ts",
    "e2e/prototype-detail-lists.spec.ts",
    "e2e/short-page-scroll.spec.ts",
    "e2e/user-shell-navigation.spec.ts",
  ]);
});

test("selected unit tests do not expand their unrelated dynamic imports into browser coverage", () => {
  const files = coverageSnapshot();
  files.set("src/components/user-shell.tsx", "export const shell = true;\n");
  files.set("test/user-shell-forward-import.test.ts", 'const source = "src/components/user-shell.tsx";\nasync function load(path: string) { return import(path); }\nvoid source;\n');
  const plan = snapshotPlan(["src/components/user-shell.tsx"], { files });
  assert.equal(plan.unit.mode, "selected");
  assert.ok(plan.unit.files.includes("test/user-shell-forward-import.test.ts"));
  assert.equal(plan.browser.mode, "selected");
  assert.deepEqual(plan.browser.files, [...policy.sharedShellBrowserSpecs].sort());
});

test("route reverse dependencies follow aliases, re-exports, and relative CSS references", () => {
  const files = coverageSnapshot();
  files.set("src/app/personal/knowledge/page.tsx", 'import "@/components/knowledge-bridge";\nexport default function Page() { return null; }\n');
  files.set("src/components/knowledge-bridge.ts", 'export { default } from "./knowledge-view";\n');
  files.set("src/components/knowledge-view.tsx", 'import "./knowledge-view.module.css";\nexport default function View() { return null; }\n');
  files.set("src/components/knowledge-view.module.css", '@import "./knowledge-palette.css";\n.card { background-image: url("../../public/personal/knowledge-badge.svg"); }\n');
  files.set("src/components/knowledge-palette.css", ".card { color: blue; }\n");
  files.set("public/personal/knowledge-badge.svg", "<svg/>\n");
  const plan = snapshotPlan(["src/components/knowledge-view.module.css"], { files });
  assert.equal(plan.browser.mode, "selected");
  assert.deepEqual(plan.browser.files, [
    "e2e/knowledge-localization.spec.ts",
    "e2e/personal-knowledge-modal.spec.ts",
    "e2e/personal-project-search.spec.ts",
  ]);
  assert.equal(plan.unit.mode, "selected");
  assert.ok(plan.unit.files.includes("test/personal-knowledge-experience.test.ts"));
});

test("unit tests that read a source path by string are selected", () => {
  const files = coverageSnapshot();
  files.set("src/lib/project-flow.ts", "export const value = 1;\n");
  files.set("test/project-flow-reader.test.ts", 'const file = "src/lib/project-flow.ts";\nvoid file;\n');
  const plan = snapshotPlan(["src/lib/project-flow.ts"], {
    files,
    impact: { mode: "selected", browser: false },
  });
  assert.deepEqual(plan.unit.files, ["test/project-flow-reader.test.ts"]);
  assert.equal(plan.browser.mode, "none");
});

test("a changed unit fixture selects importing tests through the reverse dependency graph", () => {
  const files = coverageSnapshot();
  files.set("test/fixtures/navigation-fixture.ts", "export const fixture = true;\n");
  files.set("test/navigation-fixture-contract.test.ts", 'import { fixture } from "./fixtures/navigation-fixture";\nvoid fixture;\n');
  const plan = snapshotPlan(["test/fixtures/navigation-fixture.ts"], {
    files,
    impact: { mode: "none", browser: false },
  });
  assert.deepEqual(plan.unit.files, ["test/navigation-fixture-contract.test.ts"]);
});

test("a changed unit or browser test is included in its own selected plan", () => {
  const unit = snapshotPlan(["test/project-information-architecture.test.ts"], {
    impact: { mode: "none", browser: false },
  });
  assert.deepEqual(unit.unit.files, ["test/project-information-architecture.test.ts"]);
  const browser = snapshotPlan(["e2e/feedback-layout-parity.spec.ts"]);
  assert.deepEqual(browser.browser.files, ["e2e/feedback-layout-parity.spec.ts"]);
  const nestedTsxSpec = "e2e/user-shell/navigation-contract.spec.tsx";
  const files = coverageSnapshot();
  files.set(nestedTsxSpec, "test('navigation', () => {});\n");
  const nested = snapshotPlan([nestedTsxSpec], { files });
  assert.deepEqual(nested.browser.files, [nestedTsxSpec]);
  const full = snapshotPlan(["README.md"], {
    files,
    impact: { mode: "full", browser: true },
  });
  assert.equal(full.browser.mode, "full");
  assert.ok(full.browser.files.includes(nestedTsxSpec));
});

test("global, shared fixture, unknown route, and unsafe path inputs fail closed", () => {
  assert.ok(policy.globalPaths.includes("src/app/globals.css"));
  assert.equal(snapshotPlan(["src/app/globals.css"]).unit.mode, "full");
  for (const path of ["scripts/ci-test-checks.mjs", "scripts/ci-unit-reporter.mjs", "scripts/run-browser-e2e.ts"]) {
    const runnerPlan = snapshotPlan([path], { impact: { mode: "none", browser: false } });
    assert.equal(runnerPlan.unit.mode, "full", path);
    assert.equal(runnerPlan.browser.mode, "full", path);
  }
  const security = snapshotPlan(["src/app/admin/users/users-client.tsx"], {
    impact: { mode: "full", browser: true },
  });
  assert.equal(security.unit.mode, "full");
  assert.equal(security.browser.mode, "full");
  assert.equal(snapshotPlan(["e2e/support/browser-fixtures.ts"], {
    impact: { mode: "none", browser: false },
  }).browser.mode, "full");
  const unknown = coverageSnapshot();
  unknown.set("src/components/unmapped.tsx", "export {};\n");
  assert.equal(snapshotPlan(["src/components/unmapped.tsx"], { files: unknown }).browser.mode, "full");
  for (const routePath of [
    "src/app/projects/[projectId]/unmapped-feature/page.tsx",
    "src/app/personal/knowledge/graph/page.tsx",
  ]) {
    const routeFiles = coverageSnapshot();
    routeFiles.set(routePath, "export default function Page() { return null; }\n");
    const routePlan = snapshotPlan([routePath], { files: routeFiles });
    assert.equal(routePlan.browser.mode, "full", routePath);
    assert.ok(routePlan.browser.reason.includes(routePath), routePlan.browser.reason);
  }
  assert.equal(snapshotPlan(["src/components/../../outside.tsx"]).unit.mode, "full");
  assert.equal(snapshotPlan(["--grep=anything"]).browser.mode, "full");
});

test("proven passive public bitmap changes do not imply browser impact", () => {
  const plan = snapshotPlan(["public/brand.png"], {
    impact: { mode: "none", browser: false },
  });
  assert.equal(plan.unit.mode, "none");
  assert.equal(plan.browser.mode, "none");
});

test("a full browser fallback binds the inventory and an empty full inventory cannot verify", () => {
  const fallback = snapshotPlan(["README.md"], {
    impact: { mode: "none", browser: true },
  });
  assert.equal(fallback.browser.mode, "full");
  assert.deepEqual(fallback.browser.files, [...specInventory].sort());

  const noBrowserInventory = new Map([...testInventory].map((path) => [path, "export {};\n"]));
  const invalid = snapshotPlan(["README.md"], {
    files: noBrowserInventory,
    impact: { mode: "none", browser: true },
  });
  assert.equal(invalid.browser.mode, "full");
  assert.deepEqual(invalid.browser.files, []);
  assert.throws(() => verifyRepositoryTestPlan(invalid, repository), {
    message: "CI_TEST_PLAN_EMPTY_SELECTION",
  });
});

test("missing mapped specs and deleted changed specs require a full browser run", () => {
  const missingShellSpec = policy.sharedShellBrowserSpecs[0];
  const shellPlan = snapshotPlan(["src/components/user-shell.tsx"], {
    files: coverageSnapshot({ omit: [missingShellSpec] }),
  });
  assert.equal(shellPlan.browser.mode, "full");
  const deletedPlan = snapshotPlan(["e2e/feedback-layout-parity.spec.ts"], {
    files: coverageSnapshot({ omit: ["e2e/feedback-layout-parity.spec.ts"] }),
    beforeFiles: coverageSnapshot(),
  });
  assert.equal(deletedPlan.browser.mode, "full");
});

test("unknown bases and high risk preserve conservative full gates", () => {
  const unknownBase = createTestPlanForSnapshot({
    base: "unknown",
    target: "2".repeat(40),
    changedPaths: [],
    files: coverageSnapshot(),
    impact: { mode: "none", browser: false },
  });
  assert.equal(unknownBase.unit.mode, "full");
  assert.equal(unknownBase.browser.mode, "full");
  assert.deepEqual(unknownBase.unit.files, [...testInventory].sort());
  assert.deepEqual(unknownBase.browser.files, [...specInventory].sort());
  const high = snapshotPlan(["src/components/user-shell.tsx"], { risk: "high" });
  assert.equal(high.unit.mode, "full");
  assert.equal(high.browser.mode, "full");
  assert.deepEqual(high.unit.files, [...testInventory].sort());
  assert.deepEqual(high.browser.files, [...specInventory].sort());
  const highNoBrowserImpact = snapshotPlan(["docs/guide.md"], {
    risk: "high",
    impact: { mode: "none", browser: false },
  });
  assert.equal(highNoBrowserImpact.unit.mode, "full");
  assert.equal(highNoBrowserImpact.browser.mode, "none");
});

test("version identity normalization keeps identity checks when application UI also changes", () => {
  const fixture = makeGitRepo({
    "src/app/personal/knowledge/page.tsx": 'import "./knowledge-client";\nexport default function Page() { return null; }\n',
    "src/app/personal/knowledge/knowledge-client.tsx": "export default function KnowledgeClient() { return null; }\n",
  });
  try {
    const base = git(fixture.root, "rev-parse", "HEAD");
    addFile(fixture.root, "package.json", '{"name":"fixture","version":"1.0.6"}\n');
    addFile(fixture.root, "src/lib/version.ts", 'export const APP_VERSION = "1.0.6" as const;\n');
    addFile(fixture.root, "Dockerfile", 'FROM node:24 AS base\nLABEL org.opencontainers.image.version="1.0.6"\n');
    addFile(fixture.root, "src/app/personal/knowledge/knowledge-client.tsx", "export default function KnowledgeClient() { return <main>changed</main>; }\n");
    const target = commit(fixture.root, "coherent version and UI");
    const plan = createRepositoryTestPlan(fixture.root, base, target, { risk: "medium" });
    assert.equal(plan.unit.mode, "selected");
    assert.ok(plan.unit.files.includes("test/release-version-identity.test.ts"));
    assert.ok(plan.unit.files.includes("test/product-identity-contract.test.ts"));
    assert.equal(plan.browser.mode, "selected");
    assert.ok(plan.browser.files.includes("e2e/knowledge-localization.spec.ts"));
  } finally {
    fixture.close();
  }
});

test("repository planning resolves a local CSS module back to its routed browser specs", () => {
  const fixture = makeGitRepo({
    "src/app/personal/knowledge/page.tsx": 'import "@/components/knowledge-bridge";\nexport default function Page() { return null; }\n',
    "src/components/knowledge-bridge.ts": 'export { default } from "./knowledge-view";\n',
    "src/components/knowledge-view.tsx": 'import "./knowledge-view.module.css";\nexport default function View() { return null; }\n',
    "src/components/knowledge-view.module.css": ".card { color: black; }\n",
  });
  try {
    const base = git(fixture.root, "rev-parse", "HEAD");
    addFile(fixture.root, "src/components/knowledge-view.module.css", ".card { color: rebeccapurple; }\n");
    const target = commit(fixture.root, "knowledge component style");
    const plan = createRepositoryTestPlan(fixture.root, base, target, { risk: "medium" });
    assert.deepEqual(plan.browser.files, [
      "e2e/knowledge-localization.spec.ts",
      "e2e/personal-knowledge-modal.spec.ts",
      "e2e/personal-project-search.spec.ts",
    ]);
    assert.equal(plan.browser.mode, "selected");
    assert.ok(plan.unit.files.includes("test/personal-knowledge-experience.test.ts"));
  } finally {
    fixture.close();
  }
});

test("frozen Git snapshots preserve Next route groups and dynamic segments for route selection", () => {
  const pagePath = "src/app/(workspace)/projects/[projectId]/materials/page.tsx";
  const clientPath = "src/app/(workspace)/projects/[projectId]/materials/materials-client.tsx";
  const fixture = makeGitRepo({
    [pagePath]: 'import "./materials-client";\nexport default function Page() { return null; }\n',
    [clientPath]: "export default function MaterialsClient() { return null; }\n",
  });
  try {
    const base = git(fixture.root, "rev-parse", "HEAD");
    addFile(fixture.root, clientPath, "export default function MaterialsClient() { return <main>changed</main>; }\n");
    const target = commit(fixture.root, "dynamic materials route change");
    const snapshot = readRepositorySnapshot(fixture.root, target);
    assert.equal(snapshot.has(pagePath), true);
    const plan = createRepositoryTestPlan(fixture.root, base, target, { risk: "medium" });
    assert.deepEqual(plan.browser.files, [
      "e2e/materials-request-race.spec.ts",
      "e2e/page-operations-and-import.spec.ts",
      "e2e/prototype-detail-lists.spec.ts",
    ]);
    assert.ok(plan.unit.files.includes("test/project-materials-workspace.test.ts"));
  } finally {
    fixture.close();
  }
});

test("Git planning uses the cumulative frozen-tree diff and verifies canonical identity", () => {
  const fixture = makeGitRepo({
    "src/components/user-shell.tsx": "export const shell = 1;\n",
  });
  try {
    const base = git(fixture.root, "rev-parse", "HEAD");
    addFile(fixture.root, "README.md", "intermediate documentation change\n");
    commit(fixture.root, "intermediate docs");
    addFile(fixture.root, "src/components/user-shell.tsx", "export const shell = 2;\n");
    const target = commit(fixture.root, "shell change");
    addFile(fixture.root, "src/components/user-shell.tsx", "uncommitted worktree content\n");
    const snapshot = readRepositorySnapshot(fixture.root, target);
    assert.equal(snapshot.get("src/components/user-shell.tsx"), "export const shell = 2;\n");
    const plan = createRepositoryTestPlan(fixture.root, base, target, { risk: "medium" });
    assert.deepEqual(plan.browser.files, [...policy.sharedShellBrowserSpecs].sort());
    assert.equal(verifyRepositoryTestPlan(plan, fixture.root, {
      expectedBase: base,
      expectedTarget: target,
      expectedRisk: "medium",
    }), true);
  } finally {
    fixture.close();
  }
});

test("cat-file batch snapshots preserve exact UTF-8 contents for multiple blobs", () => {
  const fixture = makeGitRepo({
    "src/app/personal/knowledge/copy.tsx": "export const copy = '旧标题';\n",
    "src/components/knowledge.module.css": ".title { color: black; }\n",
    "e2e/nested/knowledge-copy.spec.tsx": "test('标题', async () => {});\n",
  });
  try {
    addFile(fixture.root, "src/app/personal/knowledge/copy.tsx", "export const copy = '知识与导航';\n");
    addFile(fixture.root, "src/components/knowledge.module.css", ".title { color: rebeccapurple; }\n");
    const target = commit(fixture.root, "UTF-8 batch fixture");
    const snapshot = readRepositorySnapshot(fixture.root, target);
    assert.equal(snapshot.get("src/app/personal/knowledge/copy.tsx"), "export const copy = '知识与导航';\n");
    assert.equal(snapshot.get("src/components/knowledge.module.css"), ".title { color: rebeccapurple; }\n");
    assert.equal(snapshot.get("e2e/nested/knowledge-copy.spec.tsx"), "test('标题', async () => {});\n");
  } finally {
    fixture.close();
  }
});

test("missing refs and target commits are never interpreted as empty diffs", () => {
  const fixture = makeGitRepo();
  try {
    const target = git(fixture.root, "rev-parse", "HEAD");
    const unknownBase = createRepositoryTestPlan(fixture.root, "unknown", target, { risk: "medium" });
    assert.equal(unknownBase.unit.mode, "full");
    assert.equal(unknownBase.browser.mode, "full");
    assert.equal(verifyRepositoryTestPlan(unknownBase, fixture.root, {
      expectedBase: "unknown",
      expectedTarget: target,
      expectedRisk: "medium",
    }), true);
    const highRiskDefault = createRepositoryTestPlan(fixture.root, target, target);
    assert.equal(highRiskDefault.risk, "high");
    assert.equal(highRiskDefault.unit.mode, "full");
    assert.ok(highRiskDefault.unit.files.length > 0);
    const missingBase = createRepositoryTestPlan(fixture.root, "f".repeat(40), target, { risk: "medium" });
    assert.equal(missingBase.unit.mode, "full");
    const missingTarget = createRepositoryTestPlan(fixture.root, target, "e".repeat(40), { risk: "medium" });
    assert.equal(missingTarget.browser.mode, "full");
  } finally {
    fixture.close();
  }
});

test("Git symlinks in test inventory fail snapshot reading and cannot produce a verifiable full plan", () => {
  const fixture = makeGitRepo();
  try {
    const base = git(fixture.root, "rev-parse", "HEAD");
    const symlinkPath = join(fixture.root, "test/symlinked-contract.test.ts");
    symlinkSync("../../outside.test.ts", symlinkPath);
    const target = commit(fixture.root, "symlinked unit test");
    assert.throws(() => readRepositorySnapshot(fixture.root, target), {
      message: "CI_TEST_PLAN_TREE_ENTRY_UNSUPPORTED",
    });
    const plan = createRepositoryTestPlan(fixture.root, base, target, { risk: "medium" });
    assert.equal(plan.unit.mode, "full");
    assert.deepEqual(plan.unit.files, []);
    assert.throws(() => verifyRepositoryTestPlan(plan, fixture.root), {
      message: "CI_TEST_PLAN_EMPTY_SELECTION",
    });
  } finally {
    fixture.close();
  }
});

test("plan verification rejects forged hashes, identities, empty selections, duplicates, and injected paths", () => {
  const fixture = makeGitRepo({ "src/components/user-shell.tsx": "export const shell = 1;\n" });
  try {
    const base = git(fixture.root, "rev-parse", "HEAD");
    addFile(fixture.root, "src/components/user-shell.tsx", "export const shell = 2;\n");
    const target = commit(fixture.root, "shell change");
    const plan = createRepositoryTestPlan(fixture.root, base, target, { risk: "medium" });
    assert.throws(() => verifyRepositoryTestPlan({ ...plan, fingerprint: "0".repeat(64) }, fixture.root), {
      message: "CI_TEST_PLAN_FINGERPRINT_INVALID",
    });
    assert.throws(() => verifyRepositoryTestPlan(plan, fixture.root, { expectedBase: "0".repeat(40) }), {
      message: "CI_TEST_PLAN_BASE_MISMATCH",
    });
    assert.throws(() => verifyRepositoryTestPlan(plan, fixture.root, { expectedTarget: "0".repeat(40) }), {
      message: "CI_TEST_PLAN_TARGET_MISMATCH",
    });
    assert.throws(() => verifyRepositoryTestPlan(plan, fixture.root, { expectedRisk: "low" }), {
      message: "CI_TEST_PLAN_RISK_MISMATCH",
    });
    const recalculateFingerprint = (candidate: typeof plan) => {
      const { fingerprint: _fingerprint, ...body } = candidate;
      void _fingerprint;
      const hash = createHashForTest(JSON.stringify(sortKeysForTest(body)));
      return { ...candidate, fingerprint: hash };
    };
    const empty = recalculateFingerprint({ ...plan, browser: { ...plan.browser, files: [] } });
    assert.throws(() => verifyRepositoryTestPlan(empty, fixture.root), { message: "CI_TEST_PLAN_EMPTY_SELECTION" });
    const duplicate = recalculateFingerprint({
      ...plan,
      browser: { ...plan.browser, files: [plan.browser.files[0]!, plan.browser.files[0]!] },
    });
    assert.throws(() => verifyRepositoryTestPlan(duplicate, fixture.root), { message: "CI_TEST_PLAN_PATH_INVALID" });
    const injected = recalculateFingerprint({
      ...plan,
      browser: { ...plan.browser, files: ["--grep=anything"] },
    });
    assert.throws(() => verifyRepositoryTestPlan(injected, fixture.root), { message: "CI_TEST_PLAN_PATH_INVALID" });
  } finally {
    fixture.close();
  }
});

function sortKeysForTest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysForTest);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeysForTest((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function createHashForTest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("coverage registry points to checked-in test and spec inventory", () => {
  for (const path of testInventory) assert.equal(existsSync(join(repository, path)), true, path);
  for (const path of specInventory) assert.equal(existsSync(join(repository, path)), true, path);
});
