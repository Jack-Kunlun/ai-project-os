import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  measurePerformanceBudget,
  isApiRouteEntryStub,
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
    await mkdir(join(root, "static/chunks/app/api/projects/[projectId]"), { recursive: true });
    await mkdir(join(root, "static/chunks/app/projects/[projectId]"), { recursive: true });
    await mkdir(join(root, "static/css"), { recursive: true });
    await mkdir(join(root, "server/app/dashboard"), { recursive: true });
    await mkdir(join(root, "server/app/profile"), { recursive: true });
    await mkdir(join(root, "server/app/projects/[projectId]"), { recursive: true });
    const sharedSource = "shared".repeat(100);
    const routeSource = "route".repeat(80);
    const cssSource = ".layout{color:#123}".repeat(20);
    const routeCssSource = ".dashboard{color:#456}".repeat(12);
    const otherRouteCssSource = ".profile{color:#789}".repeat(9);
    const apiStubSource = Array.from({ length: 2_000 }, (_, index) => `api-route-${index}-${"x".repeat(40)}`).join("\n");
    const dynamicPageSource = "page".repeat(20);
    await writeFile(join(root, "static/chunks/shared.js"), sharedSource);
    await writeFile(join(root, "static/chunks/app/dashboard/page-test.js"), routeSource);
    await writeFile(join(root, "static/chunks/app/api/projects/[projectId]/route-test.js"), apiStubSource);
    await writeFile(join(root, "static/chunks/app/projects/[projectId]/route-page.js"), dynamicPageSource);
    await writeFile(join(root, "static/css/app.css"), cssSource);
    await writeFile(join(root, "static/css/dashboard.module.css"), routeCssSource);
    await writeFile(join(root, "static/css/profile.module.css"), otherRouteCssSource);
    await writeFile(join(root, "build-manifest.json"), JSON.stringify({
      rootMainFiles: ["static/chunks/shared.js"],
    }));
    await writeFile(
      join(root, "server/app/dashboard/page_client-reference-manifest.js"),
      `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/dashboard/page"]=${JSON.stringify({
        clientModules: {
          dashboard: { chunks: ["123", "static/chunks/app/dashboard/page-test.js"] },
        },
        entryCSSFiles: {
          "/app/src/app/layout": [{ inlined: false, path: "static\\css\\app.css" }],
          "/app/src/app/dashboard/page": [{ inlined: false, path: "static/css/dashboard.module.css" }],
        },
      })};`,
    );
    await writeFile(
      join(root, "server/app/profile/page_client-reference-manifest.js"),
      `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/profile/page"]=${JSON.stringify({
        clientModules: {},
        entryCSSFiles: {
          "/Users/fenglan/Documents/ChatGPT/AI Project OS/worktrees/usage-flow-guidance/src/app/layout": [
            { inlined: false, path: "static/css/app.css" },
          ],
          "/app/src/app/profile/page": [{ inlined: false, path: "static/css/profile.module.css" }],
        },
      })};`,
    );
    await writeFile(
      join(root, "server/app/projects/[projectId]/page_client-reference-manifest.js"),
      `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/projects/[projectId]/page"]=${JSON.stringify({
        clientModules: {},
        entryCSSFiles: { "C:\\worktree\\src\\app\\layout": [{ inlined: false, path: "static/css/app.css" }] },
      })};`,
    );

    const report = await measurePerformanceBudget(root, config);
    assert.ok(report.sharedJavaScriptGzipBytes > 0);
    assert.ok(report.criticalRoutes["/dashboard"] > report.sharedJavaScriptGzipBytes);
    assert.equal(report.largestJavaScriptAsset.path, "static/chunks/shared.js");
    assert.equal(report.globalCssGzipBytes, gzipSync(cssSource, { level: 9 }).byteLength);
    assert.ok(report.totalStaticClientGzipBytes > report.criticalRoutes["/dashboard"]);
    assert.equal(isApiRouteEntryStub("static/chunks/app/api/projects/[projectId]/route-test.js"), true);
    assert.equal(isApiRouteEntryStub("static\\chunks\\app\\api\\projects\\[projectId]\\route-test.js"), true);
    assert.equal(isApiRouteEntryStub("static/chunks/app/projects/[projectId]/route-page.js"), false);
    assert.equal(report.totalStaticClientGzipBytes, [sharedSource, routeSource, dynamicPageSource, cssSource, routeCssSource, otherRouteCssSource]
      .map((source) => gzipSync(source, { level: 9 }).byteLength)
      .reduce((sum, size) => sum + size, 0));
    assert.ok(gzipSync(apiStubSource, { level: 9 }).byteLength > report.totalStaticClientGzipBytes);
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

test("performance budget fails closed when a root layout stylesheet is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-performance-layout-missing-"));
  try {
    await mkdir(join(root, "static/chunks"), { recursive: true });
    await mkdir(join(root, "server/app/dashboard"), { recursive: true });
    await writeFile(join(root, "static/chunks/shared.js"), "shared");
    await writeFile(join(root, "build-manifest.json"), JSON.stringify({ rootMainFiles: ["static/chunks/shared.js"] }));
    await writeFile(
      join(root, "server/app/dashboard/page_client-reference-manifest.js"),
      `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/dashboard/page"]=${JSON.stringify({
        clientModules: {},
        entryCSSFiles: { "/app/src/app/(admin)/layout": [{ inlined: false, path: "static/css/admin.css" }] },
      })};`,
    );

    await assert.rejects(measurePerformanceBudget(root, config), /PERFORMANCE_LAYOUT_CSS_MISSING:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("performance budget fails closed when multiple root layout manifest keys match", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-performance-layout-ambiguous-"));
  try {
    await mkdir(join(root, "static/chunks"), { recursive: true });
    await mkdir(join(root, "static/css"), { recursive: true });
    await mkdir(join(root, "server/app/dashboard"), { recursive: true });
    await writeFile(join(root, "static/chunks/shared.js"), "shared");
    await writeFile(join(root, "static/css/app.css"), ".layout{}");
    await writeFile(join(root, "build-manifest.json"), JSON.stringify({ rootMainFiles: ["static/chunks/shared.js"] }));
    await writeFile(
      join(root, "server/app/dashboard/page_client-reference-manifest.js"),
      `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/dashboard/page"]=${JSON.stringify({
        clientModules: {},
        entryCSSFiles: {
          "/app/src/app/layout": [{ inlined: false, path: "static/css/app.css" }],
          "/Users/fenglan/Documents/ChatGPT/AI Project OS/worktrees/copy/src/app/layout": [
            { inlined: false, path: "static/css/app.css" },
          ],
        },
      })};`,
    );

    await assert.rejects(measurePerformanceBudget(root, config), /PERFORMANCE_LAYOUT_CSS_ENTRY_AMBIGUOUS:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("performance budget rejects malformed root layout manifest keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-performance-layout-key-invalid-"));
  try {
    await mkdir(join(root, "static/chunks"), { recursive: true });
    await mkdir(join(root, "server/app/dashboard"), { recursive: true });
    await writeFile(join(root, "static/chunks/shared.js"), "shared");
    await writeFile(join(root, "build-manifest.json"), JSON.stringify({ rootMainFiles: ["static/chunks/shared.js"] }));
    await writeFile(
      join(root, "server/app/dashboard/page_client-reference-manifest.js"),
      `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/dashboard/page"]=${JSON.stringify({
        clientModules: {},
        entryCSSFiles: {
          "/app/src/app/../src/app/layout": [{ inlined: false, path: "static/css/app.css" }],
        },
      })};`,
    );

    await assert.rejects(measurePerformanceBudget(root, config), /PERFORMANCE_LAYOUT_CSS_ENTRY_INVALID:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("performance budget fails closed when a route CSS manifest is malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-performance-manifest-invalid-"));
  try {
    await mkdir(join(root, "static/chunks"), { recursive: true });
    await mkdir(join(root, "server/app/dashboard"), { recursive: true });
    await writeFile(join(root, "static/chunks/shared.js"), "shared");
    await writeFile(join(root, "build-manifest.json"), JSON.stringify({ rootMainFiles: ["static/chunks/shared.js"] }));
    await writeFile(join(root, "server/app/dashboard/page_client-reference-manifest.js"), "globalThis.__RSC_MANIFEST = invalid;");

    await assert.rejects(measurePerformanceBudget(root, config), /PERFORMANCE_ROUTE_MANIFEST_INVALID:/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("performance budget rejects an unsafe root layout stylesheet path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-performance-layout-invalid-"));
  try {
    await mkdir(join(root, "static/chunks"), { recursive: true });
    await mkdir(join(root, "server/app/dashboard"), { recursive: true });
    await writeFile(join(root, "static/chunks/shared.js"), "shared");
    await writeFile(join(root, "build-manifest.json"), JSON.stringify({ rootMainFiles: ["static/chunks/shared.js"] }));
    await writeFile(
      join(root, "server/app/dashboard/page_client-reference-manifest.js"),
      `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST["/dashboard/page"]=${JSON.stringify({
        clientModules: {},
        entryCSSFiles: { "/app/src/app/layout": [{ inlined: false, path: "static/css/../../outside.css" }] },
      })};`,
    );

    await assert.rejects(measurePerformanceBudget(root, config), /PERFORMANCE_ASSET_PATH_INVALID:/u);
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
  assert.ok(workflow.indexOf("pnpm performance:check") > workflow.indexOf("Export the already-built Next.js output"));
  assert.ok(workflow.indexOf("Export the already-built Next.js output") > workflow.indexOf("Verify immutable IDs for the built images"));
  assert.equal(checkedConfig.budgets.sharedJavaScriptGzipBytes, 145 * 1024);
  assert.equal(checkedConfig.budgets.globalCssGzipBytes, 15.25 * 1024);
  assert.equal(checkedConfig.budgets.totalStaticClientGzipBytes, 860 * 1024);
  assert.deepEqual(Object.keys(checkedConfig.criticalRoutes), [
    "/setup",
    "/dashboard",
    "/personal/projects",
    "/guide",
    "/connections/mcp",
    "/system/account-access",
    "/personal",
    "/personal/knowledge",
    "/personal/knowledge/graph",
    "/login",
    "/register",
    "/admin/sms",
    "/ask",
  ]);
  assert.equal(checkedConfig.criticalRoutes["/system/account-access"], 155 * 1024);
  assert.equal(checkedConfig.criticalRoutes["/personal/projects"], 165 * 1024);
  assert.equal(checkedConfig.criticalRoutes["/ask"], 180 * 1024);
  assert.equal(checkedConfig.criticalRoutes["/personal/knowledge/graph"], 185 * 1024);
});
