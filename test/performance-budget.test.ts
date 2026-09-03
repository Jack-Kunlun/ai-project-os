import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  measurePerformanceBudget,
  performanceBudgetFailures,
  type PerformanceBudgetConfig,
} from "../scripts/performance-budget";

const config: PerformanceBudgetConfig = {
  formatVersion: 1,
  budgets: {
    sharedJavaScriptGzipBytes: 10_000,
    largestJavaScriptAssetGzipBytes: 10_000,
    globalCssGzipBytes: 10_000,
    totalStaticClientGzipBytes: 10_000,
  },
  criticalRoutes: { "/dashboard": 10_000 },
};

test("performance budget measures shared, route, CSS, largest, and total gzip sizes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-performance-"));
  try {
    await mkdir(join(root, "static/chunks/app/dashboard"), { recursive: true });
    await mkdir(join(root, "static/css"), { recursive: true });
    await mkdir(join(root, "server/app/dashboard"), { recursive: true });
    await writeFile(join(root, "static/chunks/shared.js"), "shared".repeat(100));
    await writeFile(join(root, "static/chunks/app/dashboard/page-test.js"), "route".repeat(80));
    await writeFile(join(root, "static/css/app.css"), ".example{color:#123}".repeat(20));
    await writeFile(join(root, "build-manifest.json"), JSON.stringify({
      rootMainFiles: ["static/chunks/shared.js"],
    }));
    await writeFile(
      join(root, "server/app/dashboard/page_client-reference-manifest.js"),
      `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/dashboard/page"]=${JSON.stringify({
        clientModules: {
          dashboard: { chunks: ["123", "static/chunks/app/dashboard/page-test.js"] },
        },
      })};`,
    );

    const report = await measurePerformanceBudget(root, config);
    assert.ok(report.sharedJavaScriptGzipBytes > 0);
    assert.ok(report.criticalRoutes["/dashboard"] > report.sharedJavaScriptGzipBytes);
    assert.equal(report.largestJavaScriptAsset.path, "static/chunks/shared.js");
    assert.ok(report.globalCssGzipBytes > 0);
    assert.ok(report.totalStaticClientGzipBytes > report.criticalRoutes["/dashboard"]);
    assert.deepEqual(performanceBudgetFailures(report, config), []);

    const failures = performanceBudgetFailures(report, {
      ...config,
      budgets: { ...config.budgets, totalStaticClientGzipBytes: 1 },
      criticalRoutes: { "/dashboard": 1 },
    });
    assert.deepEqual(failures.map((failure) => failure.metric), [
      "all static client assets",
      "route /dashboard",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("performance budget fails closed when a critical route manifest is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-performance-missing-"));
  try {
    await mkdir(join(root, "static/chunks"), { recursive: true });
    await writeFile(join(root, "static/chunks/shared.js"), "shared");
    await writeFile(join(root, "build-manifest.json"), JSON.stringify({
      rootMainFiles: ["static/chunks/shared.js"],
    }));
    await assert.rejects(
      measurePerformanceBudget(root, config),
      /PERFORMANCE_ROUTE_MANIFEST_UNREADABLE:\/dashboard/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("performance budget is wired into production build and CI", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const runner = await readFile("scripts/run-performance-gate.ts", "utf8");
  const checkedConfig = JSON.parse(await readFile("config/performance-budgets.json", "utf8")) as PerformanceBudgetConfig;

  assert.equal(packageJson.scripts["performance:check"], "node --import tsx scripts/check-performance-budget.ts");
  assert.equal(packageJson.scripts["test:performance"], "node --import tsx scripts/run-performance-gate.ts");
  assert.match(runner, /127\.0\.0\.1:1\/performance_gate/u);
  assert.match(runner, /spawn\(command, \["build"\]/u);
  assert.ok(workflow.indexOf("pnpm performance:check") > workflow.indexOf("pnpm test:browser-e2e"));
  assert.equal(checkedConfig.budgets.sharedJavaScriptGzipBytes, 145 * 1024);
  assert.equal(checkedConfig.budgets.totalStaticClientGzipBytes, 550 * 1024);
  assert.deepEqual(Object.keys(checkedConfig.criticalRoutes), [
    "/setup",
    "/dashboard",
    "/projects",
    "/guide",
    "/connections/mcp",
  ]);
});
