import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("browser gate stays isolated and exercises the production server", async () => {
  const [packageJson, config, runner, smoke] = await Promise.all([
    read("package.json"),
    read("playwright.config.ts"),
    read("scripts/run-browser-e2e.ts"),
    read("e2e/smoke.spec.ts"),
  ]);
  const manifest = JSON.parse(packageJson) as {
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };

  assert.equal(manifest.scripts["test:browser-e2e"], "tsx scripts/run-browser-e2e.ts");
  assert.equal(manifest.devDependencies["@axe-core/playwright"], "4.13.0");
  assert.match(config, /workers:\s*1/u);
  assert.match(config, /BROWSER_E2E_BASE_URL_REQUIRED/u);
  assert.match(config, /parsed\.hostname !== "127\.0\.0\.1"/u);
  assert.match(runner, /validatePostgresGateAdminUrl/u);
  assert.match(runner, /ai_project_os_browser_e2e_test/u);
  assert.match(runner, /createServer/u);
  assert.match(runner, /hasLoopbackListener/u);
  assert.match(runner, /port: configuredPort \?\? 0/u);
  assert.match(runner, /\["build"\]/u);
  assert.match(runner, /\.next\/standalone\/server\.js/u);
  assert.match(runner, /\.next\/standalone\/\.next\/static/u);
  assert.match(runner, /DROP DATABASE IF EXISTS/u);
  assert.match(smoke, /content-security-policy/u);
  assert.match(smoke, /worker: \{ status: "up"/u);
  assert.match(smoke, /AxeBuilder/u);
  assert.match(smoke, /wcag22aa/u);
  assert.match(smoke, /expectNoAccessibilityViolations/u);
  assert.match(smoke, /expect\(browserErrors\)\.toEqual\(\[\]\)/u);
});

test("CI uses pinned least-privilege actions and runs all bounded gates", async () => {
  const workflow = await read(".github/workflows/ci.yml");

  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/u);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/u);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  assert.match(workflow, /pnpm test:coverage/u);
  assert.match(workflow, /pnpm test:postgres-gates/u);
  assert.match(workflow, /playwright install --with-deps chromium/u);
  assert.match(workflow, /pnpm test:browser-e2e/u);
  assert.doesNotMatch(workflow, /secrets\./u);
});

test("coverage gate measures all source TypeScript with explicit ratchet thresholds", async () => {
  const packageJson = JSON.parse(await read("package.json")) as {
    scripts: Record<string, string>;
  };
  const command = packageJson.scripts["test:coverage"];

  assert.match(command, /--experimental-test-coverage/u);
  assert.match(command, /--test-coverage-lines=60/u);
  assert.match(command, /--test-coverage-branches=78/u);
  assert.match(command, /--test-coverage-functions=67/u);
  assert.match(command, /--test-coverage-include=src\/\*\*\/\*\.ts/u);
  assert.match(command, /--test-coverage-include=src\/\*\*\/\*\.tsx/u);
});
