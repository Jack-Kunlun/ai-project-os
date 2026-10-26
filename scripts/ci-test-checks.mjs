import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepositoryTestPlan, verifyRepositoryTestPlan } from "./ci-test-plan.mjs";
import { validateUnitExecution } from "./ci-unit-reporter.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const SPEC = /^e2e\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.spec\.tsx?$/u;
const MODES = new Set(["none", "selected", "full"]);

/** @typedef {Record<string, string | undefined>} CheckEnvironment */

function requireCheck(condition, code) {
  if (!condition) throw new Error(code);
}

function isCi(environment) {
  return environment.CI === "true" || environment.GITHUB_ACTIONS === "true";
}

function isSpecPath(file) {
  return typeof file === "string" && SPEC.test(file)
    && !file.split("/").some((segment) => segment === "." || segment === "..");
}

function head(repository) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
}

function requireCleanCheckInputs(repository) {
  try {
    execFileSync("git", ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"], { cwd: repository, stdio: "pipe" });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repository, encoding: "utf8" });
    requireCheck(untracked.length === 0, "CI_TEST_WORKTREE_DIRTY");
  } catch { throw new Error("CI_TEST_WORKTREE_DIRTY"); }
}

/** @param {string} path
 * @param {{ repository?: string, environment?: CheckEnvironment }} [options] */
export function loadCheckPlan(path, { repository = process.cwd(), environment = process.env } = {}) {
  let plan;
  try { plan = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("CI_TEST_PLAN_UNREADABLE"); }
  const expectedTarget = environment.CI_TEST_TARGET || head(repository);
  const expectedBase = environment.CI_TEST_BASE || plan.base;
  const expectedRisk = environment.CI_TEST_RISK || plan.risk;
  if (isCi(environment)) {
    requireCheck(Boolean(environment.CI_TEST_BASE && environment.CI_TEST_TARGET && environment.CI_TEST_RISK), "CI_TEST_PLAN_CONTEXT_REQUIRED");
  }
  requireCheck(SHA.test(expectedTarget) && head(repository) === expectedTarget, "CI_TEST_PLAN_HEAD_MISMATCH");
  if (isCi(environment)) requireCleanCheckInputs(repository);
  verifyRepositoryTestPlan(plan, repository, { expectedBase, expectedTarget, expectedRisk });
  for (const kind of ["unit", "browser"]) {
    if (plan[kind].files.length === 0) continue;
    const root = `${realpathSync(resolve(repository, kind === "unit" ? "test" : "e2e"))}${sep}`;
    requireCheck(plan[kind].files.every((file) => realpathSync(resolve(repository, file)).startsWith(root)), "CI_TEST_PLAN_FILE_OUTSIDE_ROOT");
  }
  return plan;
}

function output(values, environment = process.env) {
  if (environment.GITHUB_OUTPUT) {
    appendFileSync(environment.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** @param {string} path
 * @param {{ kind: string, plan: any, discovery?: any }} result
 * @param {CheckEnvironment} [environment] */
export function writeCheckReceipt(path, { kind, plan, discovery }, environment = process.env) {
  requireCheck(kind === "unit" || kind === "browser", "CI_CHECK_KIND_INVALID");
  const selection = plan[kind];
  requireCheck(selection && MODES.has(selection.mode), "CI_CHECK_SELECTION_INVALID");
  requireCheck(selection.mode === "none" || selection.files.length > 0, "CI_CHECK_SELECTION_EMPTY");
  if (kind === "browser" && selection.mode !== "none") {
    requireCheck(discovery?.testCount > 0 && discovery?.executedCount > 0
      && JSON.stringify(discovery.files) === JSON.stringify(selection.files), "CI_BROWSER_DISCOVERY_MISMATCH");
  }
  if (kind === "unit" && selection.mode === "selected") {
    requireCheck(discovery?.testCount > 0 && discovery?.executedCount > 0
      && JSON.stringify(discovery.files) === JSON.stringify(selection.files), "CI_UNIT_EXECUTION_MISMATCH");
  }
  const receipt = {
    schemaVersion: 1, kind, base: plan.base, target: plan.target,
    releaseEligible: environment.GITHUB_ACTIONS === "true",
    planFingerprint: plan.fingerprint, mode: selection.mode, files: selection.files,
    status: selection.mode === "none" ? "not-required" : "passed",
    ...(discovery ? { testCount: discovery.testCount, executedCount: discovery.executedCount, skippedCount: discovery.skippedCount } : {}),
  };
  if (isCi(environment)) requireCleanCheckInputs(process.cwd());
  const fingerprint = digest(receipt);
  writeFileSync(path, `${JSON.stringify({ ...receipt, fingerprint }, null, 2)}\n`, { mode: 0o600 });
  output({ receipt_fingerprint: fingerprint }, environment);
  console.log(`CI_CHECK_RECEIPT kind=${kind} mode=${selection.mode} files=${selection.files.length} plan=${plan.fingerprint} receipt=${fingerprint}`);
  return receipt;
}

function specFiles(repository) {
  const directory = resolve(repository, "e2e");
  const files = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const absolute = resolve(path, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const file = relative(repository, absolute).split(sep).join("/");
        if (isSpecPath(file)) files.push(file);
      }
    }
  };
  walk(directory);
  return files.sort();
}

export function browserFileArguments(files) {
  requireCheck(Array.isArray(files) && files.length > 0, "CI_BROWSER_SELECTION_EMPTY");
  requireCheck(files.every(isSpecPath)
    && new Set(files).size === files.length, "CI_BROWSER_FILE_INVALID");
  // Playwright treats positional arguments as regular expressions, not literal paths.
  return files.map((file) => `(?:^|/)${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`);
}

/** @param {{ repository?: string, environment?: CheckEnvironment, args?: string[] }} [options] */
export function resolveBrowserSelection({ repository = process.cwd(), environment = process.env, args = [] } = {}) {
  if (environment.CI_TEST_PLAN) {
    requireCheck(args.length === 0, "CI_BROWSER_SELECTION_OVERRIDE");
    const plan = loadCheckPlan(environment.CI_TEST_PLAN, { repository, environment });
    requireCheck(plan.browser.mode !== "none", "CI_BROWSER_NOT_REQUIRED");
    browserFileArguments(plan.browser.files);
    return { ...plan.browser, plan };
  }
  requireCheck(!isCi(environment), "CI_BROWSER_PLAN_REQUIRED");
  let files = specFiles(repository);
  let mode = "full";
  if (args.length > 0) {
    requireCheck(args.length % 2 === 0, "CI_BROWSER_LOCAL_ARGUMENT_INVALID");
    const requested = [];
    for (let index = 0; index < args.length; index += 2) {
      requireCheck(args[index] === "--file", "CI_BROWSER_LOCAL_ARGUMENT_INVALID");
      requested.push(args[index + 1]);
    }
    browserFileArguments(requested);
    requireCheck(requested.every((file) => files.includes(file)), "CI_BROWSER_FILE_MISSING");
    files = requested.sort();
    mode = "selected";
  }
  const root = `${realpathSync(resolve(repository, "e2e"))}${sep}`;
  requireCheck(files.length > 0 && files.every((file) => realpathSync(resolve(repository, file)).startsWith(root)), "CI_BROWSER_FILE_INVALID");
  return { mode, files, reason: "explicit-local-run", plan: null };
}

export function validateBrowserDiscovery(selection, report, repository = process.cwd()) {
  requireCheck(report && Array.isArray(report.suites) && Array.isArray(report.errors)
    && report.errors.length === 0, "CI_BROWSER_DISCOVERY_INVALID");
  const rootDir = report.config?.rootDir;
  requireCheck(typeof rootDir === "string" && resolve(rootDir) === resolve(repository, "e2e"), "CI_BROWSER_DISCOVERY_ROOT_INVALID");
  const discovered = new Set();
  let testCount = 0;
  const normalize = (file) => {
    requireCheck(typeof file === "string", "CI_BROWSER_DISCOVERY_FILE_INVALID");
    const absolute = isAbsolute(file) ? file : resolve(rootDir, file);
    const normalized = relative(repository, absolute).split(sep).join("/");
    requireCheck(isSpecPath(normalized), "CI_BROWSER_DISCOVERY_FILE_INVALID");
    return normalized;
  };
  const visit = (suite, parentFile) => {
    const file = suite.file || parentFile;
    for (const spec of suite.specs || []) {
      requireCheck(Array.isArray(spec.tests) && spec.tests.length > 0, "CI_BROWSER_DISCOVERY_EMPTY");
      discovered.add(normalize(spec.file || file));
      testCount += spec.tests.length;
    }
    for (const child of suite.suites || []) visit(child, file);
  };
  for (const suite of report.suites) visit(suite, null);
  const files = [...discovered].sort();
  requireCheck(testCount > 0 && JSON.stringify(files) === JSON.stringify([...selection.files].sort()), "CI_BROWSER_DISCOVERY_MISMATCH");
  return { files, testCount };
}

export function validateBrowserExecution(selection, expectedDiscovery, report, repository = process.cwd()) {
  const actual = validateBrowserDiscovery(selection, report, repository);
  requireCheck(actual.testCount === expectedDiscovery.testCount
    && JSON.stringify(actual.files) === JSON.stringify(expectedDiscovery.files), "CI_BROWSER_EXECUTION_MISMATCH");
  const stats = report.stats;
  requireCheck(stats && [stats.expected, stats.flaky, stats.skipped, stats.unexpected].every((value) => Number.isSafeInteger(value) && value >= 0)
    && stats.unexpected === 0 && stats.expected + stats.flaky > 0
    && stats.expected + stats.flaky + stats.skipped === actual.testCount, "CI_BROWSER_EXECUTION_EMPTY_OR_FAILED");
  return { ...actual, executedCount: stats.expected + stats.flaky, skippedCount: stats.skipped };
}

async function runCommand(command, args, repository, environment) {
  await new Promise((resolvePromise, reject) => {
    const childEnvironment = { ...environment };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(command, args, { cwd: repository, env: childEnvironment, stdio: "inherit" });
    const interrupt = () => child.kill("SIGTERM");
    process.once("SIGTERM", interrupt);
    process.once("SIGINT", interrupt);
    const cleanup = () => {
      process.removeListener("SIGTERM", interrupt);
      process.removeListener("SIGINT", interrupt);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code) => {
      cleanup();
      if (code === 0) resolvePromise();
      else reject(new Error("CI_UNIT_CHECK_FAILED"));
    });
  });
}

async function main() {
  const [operation, planPath, receiptPath, ...extra] = process.argv.slice(2);
  requireCheck(extra.length === 0 && typeof planPath === "string", "CI_TEST_CHECK_ARGUMENT_INVALID");
  const repository = process.cwd();
  if (operation === "plan") {
    requireCheck(!receiptPath && SHA.test(process.env.CI_TEST_TARGET || "")
      && head(repository) === process.env.CI_TEST_TARGET, "CI_TEST_PLAN_HEAD_MISMATCH");
    requireCheck(process.env.CI_TEST_BASE && process.env.CI_TEST_RISK, "CI_TEST_PLAN_CONTEXT_REQUIRED");
    if (isCi(process.env)) requireCleanCheckInputs(repository);
    const plan = createRepositoryTestPlan(repository, process.env.CI_TEST_BASE, process.env.CI_TEST_TARGET, { risk: process.env.CI_TEST_RISK });
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    output({ plan_fingerprint: plan.fingerprint, unit_mode: plan.unit.mode, browser_mode: plan.browser.mode });
    console.log(JSON.stringify(plan, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `\n### Applicable checks\n\nBase: \`${plan.base}\` · Target: \`${plan.target}\`\n\n| Check | Mode | Files | Reason |\n| --- | --- | ---: | --- |\n| Unit | ${plan.unit.mode} | ${plan.unit.files.length} | ${plan.unit.reason} |\n| Browser | ${plan.browser.mode} | ${plan.browser.files.length} | ${plan.browser.reason} |\n\nPlan: \`${plan.fingerprint}\`\n`);
    }
    return;
  }
  requireCheck(typeof receiptPath === "string" && (operation === "unit" || operation === "browser-none"), "CI_TEST_CHECK_ARGUMENT_INVALID");
  const plan = loadCheckPlan(planPath);
  if (operation === "browser-none") {
    requireCheck(plan.browser.mode === "none", "CI_BROWSER_CHECK_REQUIRED");
    writeCheckReceipt(receiptPath, { kind: "browser", plan });
    return;
  }
  requireCheck(MODES.has(plan.unit.mode), "CI_UNIT_SELECTION_INVALID");
  let execution;
  if (plan.unit.mode === "full") {
    requireCheck(plan.unit.files.length > 0, "CI_UNIT_SELECTION_EMPTY");
    await runCommand(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["test:coverage"], repository, process.env);
  } else if (plan.unit.mode === "selected") {
    requireCheck(plan.unit.files.length > 0
      && plan.unit.files.every((file) => /^test\/[A-Za-z0-9._-]+\.test\.ts$/u.test(file) && existsSync(resolve(repository, file))), "CI_UNIT_SELECTION_INVALID");
    const directory = mkdtempSync(join(tmpdir(), "ci-unit-check-"));
    const reportPath = join(directory, "execution.json");
    const reporter = fileURLToPath(new URL("./ci-unit-reporter.mjs", import.meta.url));
    try {
      await runCommand(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec",
        `--test-reporter=${reporter}`, "--test-reporter-destination=stdout",
        `--test-reporter-destination=${reportPath}`, "--", ...plan.unit.files], repository,
      { ...process.env, CI_UNIT_SELECTED_FILES: JSON.stringify(plan.unit.files) });
      let report;
      try { report = JSON.parse(readFileSync(reportPath, "utf8")); }
      catch { throw new Error("CI_UNIT_REPORT_UNREADABLE"); }
      execution = validateUnitExecution(plan.unit.files, report);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  writeCheckReceipt(receiptPath, { kind: "unit", plan, discovery: execution });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "CI_TEST_CHECK_FAILED");
    process.exitCode = 1;
  });
}
