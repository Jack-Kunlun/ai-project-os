import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import {
  browserFileArguments, loadCheckPlan, resolveBrowserSelection,
  validateBrowserDiscovery, validateBrowserExecution, writeCheckReceipt,
} from "../scripts/ci-test-checks.mjs";
import { createRepositoryTestPlan } from "../scripts/ci-test-plan.mjs";

const repository = process.cwd();
const files = ["e2e/user-shell-navigation.spec.ts"];

function report({ expected = 1, skipped = 0, unexpected = 0, file = "user-shell-navigation.spec.ts" } = {}) {
  return {
    config: { rootDir: resolve(repository, "e2e") }, errors: [],
    suites: [{ file, specs: [{ file, tests: [{ results: [] }] }] }],
    stats: { expected, skipped, unexpected, flaky: 0 },
  };
}

test("Playwright filters match only the selected literal spec and reject option/path injection", () => {
  const patterns = browserFileArguments(files);
  assert.equal(new RegExp(patterns[0]).test(`${repository}/${files[0]}`), true);
  assert.equal(new RegExp(patterns[0]).test(`${repository}/e2e/user-shell-navigationXspecXts`), false);
  assert.throws(() => browserFileArguments([]), /EMPTY/u);
  for (const file of ["--pass-with-no-tests", "../e2e/evil.spec.ts", "e2e/../evil.spec.ts", "/tmp/evil.spec.ts"]) {
    assert.throws(() => browserFileArguments([file]), /INVALID/u);
  }
  assert.throws(() => browserFileArguments([files[0], files[0]]), /INVALID/u);
});

test("a CI browser run cannot silently use default discovery or a local selector override", () => {
  assert.throws(() => resolveBrowserSelection({ environment: { CI: "true" } }), /CI_BROWSER_PLAN_REQUIRED/u);
  assert.throws(() => resolveBrowserSelection({ environment: { GITHUB_ACTIONS: "true" }, args: ["--file", files[0]] }), /CI_BROWSER_PLAN_REQUIRED/u);
  assert.throws(() => resolveBrowserSelection({ environment: { CI_TEST_PLAN: "unused" }, args: ["--file", files[0]] }), /CI_BROWSER_SELECTION_OVERRIDE/u);
  const selected = resolveBrowserSelection({ environment: {}, args: ["--file", files[0]] });
  assert.equal(selected.mode, "selected");
  assert.deepEqual(selected.files, files);
  assert.throws(() => resolveBrowserSelection({ environment: {}, args: ["--file", "e2e/not-present.spec.ts"] }), /MISSING/u);
});

test("discovery verifies exact files and execution rejects empty, skipped-only, or failed suites", () => {
  const selection = { files };
  const discovery = validateBrowserDiscovery(selection, report());
  assert.deepEqual(discovery, { files, testCount: 1 });
  assert.throws(() => validateBrowserDiscovery(selection, { ...report(), suites: [] }), /MISMATCH/u);
  assert.throws(() => validateBrowserDiscovery(selection, report({ file: "unrelated.spec.ts" })), /MISMATCH/u);
  assert.throws(() => validateBrowserDiscovery(selection, { ...report(), errors: [{ message: "bad import" }] }), /INVALID/u);
  assert.throws(() => validateBrowserExecution(selection, discovery, report({ expected: 0, skipped: 1 })), /EMPTY_OR_FAILED/u);
  assert.throws(() => validateBrowserExecution(selection, discovery, report({ expected: 0, unexpected: 1 })), /EMPTY_OR_FAILED/u);
  assert.deepEqual(validateBrowserExecution(selection, discovery, report()), { files, testCount: 1, executedCount: 1, skippedCount: 0 });
});

test("browser receipts require observed execution and bind the exact selected plan", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-check-receipt-"));
  try {
    const plan = { schemaVersion: 1, base: "a".repeat(40), target: "b".repeat(40), fingerprint: "c".repeat(64), browser: { mode: "selected", files } };
    const path = join(root, "receipt.json");
    assert.throws(() => writeCheckReceipt(path, { kind: "browser", plan, discovery: { files, testCount: 1 } }, {}), /MISMATCH/u);
    assert.equal(existsSync(path), false);
    writeCheckReceipt(path, { kind: "browser", plan, discovery: { files, testCount: 1, executedCount: 1, skippedCount: 0 } }, {});
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(receipt.target, plan.target);
    assert.equal(receipt.planFingerprint, plan.fingerprint);
    assert.deepEqual(receipt.files, files);
    assert.equal(receipt.executedCount, 1);
    assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the unit command executes a frozen selected test and never writes a receipt for a failing test", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-check-execution-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  try {
    for (const folder of ["test", "e2e", "scripts"]) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "node_modules\nplan.json\nreceipt.json\n");
    writeFileSync(join(root, "scripts/postgres-gate-contract.ts"), 'const gates = [{ id: "sample", file: "test/sample-postgres.test.ts" }];\n');
    writeFileSync(join(root, "test/ui-contract.test.ts"), 'import test from "node:test"; test("base", () => {});\n');
    writeFileSync(join(root, "e2e/fixture.spec.ts"), "export {};\n");
    git("init", "-q"); git("config", "user.name", "CI checks"); git("config", "user.email", "ci-checks@example.invalid");
    const base = commit();
    writeFileSync(join(root, "test/ui-contract.test.ts"), 'import test from "node:test"; import assert from "node:assert/strict"; test("selected behavior", () => assert.equal(2 + 2, 4));\n');
    const target = commit();
    symlinkSync(resolve(repository, "node_modules"), join(root, "node_modules"), "dir");
    const environment = { ...process.env, CI: "true", GITHUB_ACTIONS: "false", CI_TEST_BASE: base, CI_TEST_TARGET: target, CI_TEST_RISK: "low", GITHUB_OUTPUT: undefined, GITHUB_STEP_SUMMARY: undefined };
    const plan = createRepositoryTestPlan(root, base, target, { risk: "low" });
    assert.equal(plan.unit.mode, "selected");
    assert.deepEqual(plan.unit.files, ["test/ui-contract.test.ts"]);
    const planPath = join(root, "plan.json"), receiptPath = join(root, "receipt.json");
    writeFileSync(planPath, JSON.stringify(plan));
    const command = resolve(repository, "scripts/ci-test-checks.mjs");
    const result = spawnSync(process.execPath, [command, "unit", planPath, receiptPath], { cwd: root, env: environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.executedCount, 1);
    assert.throws(() => loadCheckPlan(planPath, { repository: root, environment: { ...environment, CI_TEST_TARGET: base } }), /HEAD_MISMATCH/u);

    writeFileSync(join(root, "test/ui-contract.test.ts"), 'import test from "node:test"; test("selected failure", () => { throw Error("fixture failure"); });\n');
    assert.throws(() => loadCheckPlan(planPath, { repository: root, environment }), /CI_TEST_WORKTREE_DIRTY/u);
    const failedTarget = commit();
    const failed = createRepositoryTestPlan(root, target, failedTarget, { risk: "low" });
    writeFileSync(planPath, JSON.stringify(failed));
    rmSync(receiptPath);
    const failure = spawnSync(process.execPath, [command, "unit", planPath, receiptPath], { cwd: root, env: { ...environment, CI_TEST_BASE: target, CI_TEST_TARGET: failedTarget }, encoding: "utf8" });
    assert.notEqual(failure.status, 0, `${failure.stdout}\n${failure.stderr}`);
    assert.match(failure.stderr, /CI_UNIT_CHECK_FAILED/u);
    assert.equal(existsSync(receiptPath), false);

    let previous = failedTarget;
    for (const source of ["export {};\n", 'import test from "node:test"; test.skip("skipped", () => {});\n']) {
      writeFileSync(join(root, "test/ui-contract.test.ts"), source);
      const emptyTarget = commit();
      const emptyPlan = createRepositoryTestPlan(root, previous, emptyTarget, { risk: "low" });
      writeFileSync(planPath, JSON.stringify(emptyPlan));
      const empty = spawnSync(process.execPath, [command, "unit", planPath, receiptPath], {
        cwd: root, env: { ...environment, CI_TEST_BASE: previous, CI_TEST_TARGET: emptyTarget }, encoding: "utf8",
      });
      assert.notEqual(empty.status, 0, `${empty.stdout}\n${empty.stderr}`);
      assert.match(empty.stderr, /CI_UNIT_EXECUTION_EMPTY_OR_FAILED/u);
      assert.equal(existsSync(receiptPath), false);
      previous = emptyTarget;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("browser image preparation errors fail before database connection instead of silently passing cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-browser-early-error-"));
  try {
    writeFileSync(join(root, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/run-browser-e2e.ts", "--file", files[0]], {
      cwd: repository, encoding: "utf8", timeout: 15_000,
      env: {
        ...process.env, CI: "false", GITHUB_ACTIONS: "false", NODE_TEST_CONTEXT: undefined,
        GITHUB_OUTPUT: undefined, GITHUB_STEP_SUMMARY: undefined, CI_TEST_PLAN: undefined, CI_TEST_RECEIPT: undefined,
        PATH: `${root}${delimiter}${process.env.PATH}`,
        RELEASE_IMAGES_MANIFEST: join(root, "missing-images.json"),
        POSTGRES_GATE_ADMIN_URL: "postgresql://ai_project_os_ci_cluster_admin:fixture@127.0.0.1:56432/postgres",
      },
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RELEASE_IMAGE_MANIFEST_UNREADABLE/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
