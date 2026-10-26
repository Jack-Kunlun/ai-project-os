import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_PATTERN = /^test\/[A-Za-z0-9._-]+\.test\.ts$/u;
const COUNT_NAMES = ["tests", "passed", "failed", "cancelled", "skipped", "todo", "suites", "suiteFailures"];

function requireCheck(condition, code) {
  if (!condition) throw new Error(code);
}

function normalizeRunnerPath(file, repository) {
  requireCheck(typeof file === "string" && file.length > 0, "CI_UNIT_REPORT_FILE_INVALID");
  const rawPath = file.startsWith("file:") ? fileURLToPath(file) : file;
  const repositoryPath = realpathSync(repository);
  const absolutePath = realpathSync(isAbsolute(rawPath) ? rawPath : resolve(repositoryPath, rawPath));
  const repositoryRelativePath = relative(repositoryPath, absolutePath);
  const normalizedPath = repositoryRelativePath.split(sep).join("/");
  requireCheck(FILE_PATTERN.test(normalizedPath), "CI_UNIT_REPORT_FILE_INVALID");
  return normalizedPath;
}

function readSelection(value, repository) {
  requireCheck(typeof value === "string", "CI_UNIT_SELECTION_INVALID");
  let arguments_;
  try { arguments_ = JSON.parse(value); }
  catch { throw new Error("CI_UNIT_SELECTION_INVALID"); }
  requireCheck(Array.isArray(arguments_) && arguments_.length > 0
    && arguments_.every((file) => typeof file === "string" && file.length > 0), "CI_UNIT_SELECTION_INVALID");
  const filesByArgument = arguments_.map((file) => normalizeRunnerPath(file, repository));
  requireCheck(new Set(filesByArgument).size === filesByArgument.length, "CI_UNIT_SELECTION_INVALID");
  return { arguments: arguments_, filesByArgument, files: [...filesByArgument].sort() };
}

function validateFileList(files, code) {
  requireCheck(Array.isArray(files) && files.length > 0, code);
  const normalized = files.map((file) => {
    requireCheck(typeof file === "string" && FILE_PATTERN.test(file), code);
    return file;
  }).sort();
  requireCheck(new Set(normalized).size === normalized.length, code);
  return normalized;
}

function sameFiles(left, right) {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

function emptyCounts() {
  return { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, suiteFailures: 0, fileFailure: false };
}

/**
 * Validate the machine-readable inventory emitted by this reporter.
 * Only test result events count as tests: file wrappers and suites do not,
 * and skipped or todo cases do not satisfy the executed-test requirement.
 */
export function validateUnitExecution(expectedFiles, report) {
  const expected = validateFileList(expectedFiles, "CI_UNIT_SELECTION_INVALID");
  requireCheck(report && report.schemaVersion === 1 && report.error === null, "CI_UNIT_REPORT_INVALID");
  const reportedSelection = validateFileList(report.selectedFiles, "CI_UNIT_REPORT_INVALID");
  requireCheck(sameFiles(expected, reportedSelection), "CI_UNIT_SELECTION_MISMATCH");

  requireCheck(Array.isArray(report.files), "CI_UNIT_REPORT_INVALID");
  const actual = report.files.map((entry) => {
    requireCheck(entry && typeof entry === "object", "CI_UNIT_REPORT_INVALID");
    requireCheck(typeof entry.file === "string" && FILE_PATTERN.test(entry.file), "CI_UNIT_REPORT_FILE_INVALID");
    const counts = Object.fromEntries(COUNT_NAMES.map((name) => [name, entry[name]]));
    requireCheck(COUNT_NAMES.every((name) => Number.isSafeInteger(counts[name]) && counts[name] >= 0), "CI_UNIT_REPORT_COUNTS_INVALID");
    requireCheck(counts.tests === counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo, "CI_UNIT_REPORT_COUNTS_INVALID");
    requireCheck(typeof entry.fileFailure === "boolean", "CI_UNIT_REPORT_INVALID");
    return { ...entry, ...counts };
  }).sort((left, right) => left.file.localeCompare(right.file));
  requireCheck(actual.length > 0, "CI_UNIT_DISCOVERY_MISMATCH");
  const actualFiles = validateFileList(actual.map((entry) => entry.file), "CI_UNIT_REPORT_FILE_INVALID");
  requireCheck(sameFiles(expected, actualFiles), "CI_UNIT_DISCOVERY_MISMATCH");
  requireCheck(actual.every((entry) => !entry.fileFailure && entry.tests > 0 && entry.passed > 0
    && entry.failed === 0 && entry.cancelled === 0 && entry.suiteFailures === 0), "CI_UNIT_EXECUTION_EMPTY_OR_FAILED");

  return {
    files: actualFiles,
    testCount: actual.reduce((sum, entry) => sum + entry.tests, 0),
    executedCount: actual.reduce((sum, entry) => sum + entry.passed, 0),
    skippedCount: actual.reduce((sum, entry) => sum + entry.skipped, 0),
    todoCount: actual.reduce((sum, entry) => sum + entry.todo, 0),
  };
}

function newFileRecord(file) {
  return { file, ...emptyCounts() };
}

function isFileWrapper(data, file, selection) {
  if (data.nesting !== 0 || data.parentId !== 0 || data.line !== 1 || data.column !== 1) return false;
  const index = selection.arguments.indexOf(data.name);
  return index >= 0 && selection.filesByArgument[index] === file;
}

export default async function* ciUnitReporter(source) {
  const repository = process.cwd();
  let selection = { arguments: [], filesByArgument: [], files: [] };
  let reportError = null;
  const records = new Map();

  try {
    selection = readSelection(process.env.CI_UNIT_SELECTED_FILES, repository);
    for (const file of selection.files) records.set(file, newFileRecord(file));
  } catch (error) {
    reportError = error instanceof Error ? error.message : "CI_UNIT_SELECTION_INVALID";
  }

  try {
    for await (const event of source) {
      if (event?.type !== "test:pass" && event?.type !== "test:fail") continue;
      const data = event.data;
      if (typeof data?.file !== "string") {
        reportError ||= "CI_UNIT_REPORT_FILE_INVALID";
        continue;
      }

      const file = normalizeRunnerPath(data.file, repository);
      let record = records.get(file);
      if (!record) {
        record = newFileRecord(file);
        records.set(file, record);
      }
      if (isFileWrapper(data, file, selection)) {
        if (event.type === "test:fail") record.fileFailure = true;
        continue;
      }

      if (data.details?.type === "suite") {
        record.suites += 1;
        if (event.type === "test:fail") record.suiteFailures += 1;
        continue;
      }
      if (data.details?.type !== "test") {
        reportError ||= "CI_UNIT_REPORT_EVENT_INVALID";
        continue;
      }

      record.tests += 1;
      if (event.type === "test:fail") record.failed += 1;
      else if (data.skip) record.skipped += 1;
      else if (data.todo) record.todo += 1;
      else record.passed += 1;
    }
  } catch (error) {
    reportError ||= error instanceof Error ? error.message : "CI_UNIT_REPORT_INVALID";
  }

  const report = {
    schemaVersion: 1,
    selectedFiles: selection.files,
    files: [...records.values()].sort((left, right) => left.file.localeCompare(right.file)),
    error: reportError,
  };
  try { validateUnitExecution(selection.files, report); }
  catch (error) { report.validationError = error instanceof Error ? error.message : "CI_UNIT_REPORT_INVALID"; }
  yield `${JSON.stringify(report, null, 2)}\n`;
}
