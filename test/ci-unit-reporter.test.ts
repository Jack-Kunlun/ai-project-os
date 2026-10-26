import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateUnitExecution } from "../scripts/ci-unit-reporter.mjs";

const repository = process.cwd();
const reporter = resolve(repository, "scripts/ci-unit-reporter.mjs");

function runSelection(fixtures: Record<string, string>, selectedFiles: string[]) {
  const root = mkdtempSync(join(tmpdir(), "ci-unit-reporter-"));
  mkdirSync(join(root, "test"));
  symlinkSync(resolve(repository, "node_modules"), join(root, "node_modules"), "dir");
  for (const [file, source] of Object.entries(fixtures)) writeFileSync(join(root, file), source);

  const reportPath = join(root, "unit-report.json");
  const environment: NodeJS.ProcessEnv = { ...process.env, CI_UNIT_SELECTED_FILES: JSON.stringify(selectedFiles) };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--test",
    `--test-reporter=${reporter}`,
    `--test-reporter-destination=${reportPath}`,
    "--", ...selectedFiles,
  ], { cwd: root, env: environment, encoding: "utf8" });
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  rmSync(root, { recursive: true, force: true });
  return { result, report };
}

test("the actual Node reporter inventories exact selected files and counts only executed tests", () => {
  const selectedFiles = ["test/second.test.ts", "test/first.test.ts"];
  const { result, report } = runSelection({
    "test/first.test.ts": [
      "import { describe, it } from 'node:test';",
      "describe('group', () => { it('executes', () => {}); });",
      "it('skips', { skip: true }, () => {});",
    ].join("\n"),
    "test/second.test.ts": [
      "import test from 'node:test';",
      "test('executes', () => {});",
      "test('todo', { todo: true }, () => {});",
    ].join("\n"),
  }, selectedFiles);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(validateUnitExecution(selectedFiles, report), {
    files: ["test/first.test.ts", "test/second.test.ts"],
    testCount: 4,
    executedCount: 2,
    skippedCount: 1,
    todoCount: 1,
  });
  assert.equal(report.files.find((entry: { file: string; suites: number }) => entry.file === "test/first.test.ts").suites, 1);
});

test("empty, skip-only, and todo-only files fail validation even when Node exits successfully", () => {
  const selections = [
    { source: "", code: "CI_UNIT_EXECUTION_EMPTY_OR_FAILED" },
    { source: "import test from 'node:test'; test('skipped', { skip: true }, () => {});", code: "CI_UNIT_EXECUTION_EMPTY_OR_FAILED" },
    { source: "import test from 'node:test'; test('todo', { todo: true }, () => {});", code: "CI_UNIT_EXECUTION_EMPTY_OR_FAILED" },
  ];

  for (const [index, selection] of selections.entries()) {
    const file = `test/empty-${index}.test.ts`;
    const { result, report } = runSelection({ [file]: selection.source }, [file]);
    assert.equal(result.status, 0, result.stderr);
    assert.throws(() => validateUnitExecution([file], report), new RegExp(selection.code, "u"));
    assert.match(report.validationError, new RegExp(selection.code, "u"));
  }
});

test("ordinary test failures remain failed Node runs and are rejected by the inventory validator", () => {
  const file = "test/failing.test.ts";
  const { result, report } = runSelection({
    [file]: "import test from 'node:test'; test('fails normally', () => { throw new Error('fixture failure'); });",
  }, [file]);

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.throws(() => validateUnitExecution([file], report), /CI_UNIT_EXECUTION_EMPTY_OR_FAILED/u);
  assert.equal(report.files[0].failed, 1);
});

test("the validator rejects missing, duplicate, and unexpected files", () => {
  const baseReport = {
    schemaVersion: 1,
    selectedFiles: ["test/one.test.ts"],
    files: [{ file: "test/one.test.ts", tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, suiteFailures: 0, fileFailure: false }],
    error: null,
  };

  assert.deepEqual(validateUnitExecution(["test/one.test.ts"], baseReport).files, ["test/one.test.ts"]);
  assert.throws(() => validateUnitExecution(["test/one.test.ts"], { ...baseReport, files: [] }), /CI_UNIT_DISCOVERY_MISMATCH/u);
  assert.throws(() => validateUnitExecution(["test/one.test.ts"], { ...baseReport, files: [...baseReport.files, ...baseReport.files] }), /CI_UNIT_REPORT_FILE_INVALID/u);
  assert.throws(() => validateUnitExecution(["test/one.test.ts"], { ...baseReport, files: [{ ...baseReport.files[0], file: "test/other.test.ts" }] }), /CI_UNIT_DISCOVERY_MISMATCH/u);
});
