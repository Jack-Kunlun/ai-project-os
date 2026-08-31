import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

export type PerformanceBudgetConfig = {
  formatVersion: 1;
  budgets: {
    sharedJavaScriptGzipBytes: number;
    largestJavaScriptAssetGzipBytes: number;
    globalCssGzipBytes: number;
    totalStaticClientGzipBytes: number;
  };
  criticalRoutes: Record<string, number>;
};

export type PerformanceBudgetReport = {
  sharedJavaScriptGzipBytes: number;
  largestJavaScriptAsset: { path: string; gzipBytes: number };
  globalCssGzipBytes: number;
  totalStaticClientGzipBytes: number;
  criticalRoutes: Record<string, number>;
};

export type PerformanceBudgetFailure = {
  metric: string;
  actualBytes: number;
  budgetBytes: number;
};

type BuildManifest = {
  rootMainFiles?: unknown;
};

type ClientReferenceManifest = {
  clientModules?: Record<string, { chunks?: unknown }>;
};

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`PERFORMANCE_BUDGET_INVALID:${name}`);
  }
  return Number(value);
}

export function validatePerformanceBudgetConfig(value: unknown): PerformanceBudgetConfig {
  if (!value || typeof value !== "object") throw new Error("PERFORMANCE_BUDGET_INVALID:root");
  const candidate = value as Partial<PerformanceBudgetConfig>;
  if (candidate.formatVersion !== 1) throw new Error("PERFORMANCE_BUDGET_INVALID:formatVersion");
  if (!candidate.budgets || typeof candidate.budgets !== "object") {
    throw new Error("PERFORMANCE_BUDGET_INVALID:budgets");
  }
  if (!candidate.criticalRoutes || typeof candidate.criticalRoutes !== "object") {
    throw new Error("PERFORMANCE_BUDGET_INVALID:criticalRoutes");
  }

  const routes = Object.entries(candidate.criticalRoutes);
  if (routes.length === 0) throw new Error("PERFORMANCE_BUDGET_INVALID:criticalRoutes.empty");
  for (const [route, budget] of routes) {
    if (!route.startsWith("/") || route.includes("..")) {
      throw new Error(`PERFORMANCE_BUDGET_INVALID:route:${route}`);
    }
    positiveInteger(budget, `criticalRoutes.${route}`);
  }

  positiveInteger(candidate.budgets.sharedJavaScriptGzipBytes, "budgets.sharedJavaScriptGzipBytes");
  positiveInteger(candidate.budgets.largestJavaScriptAssetGzipBytes, "budgets.largestJavaScriptAssetGzipBytes");
  positiveInteger(candidate.budgets.globalCssGzipBytes, "budgets.globalCssGzipBytes");
  positiveInteger(candidate.budgets.totalStaticClientGzipBytes, "budgets.totalStaticClientGzipBytes");
  return candidate as PerformanceBudgetConfig;
}

export async function loadPerformanceBudgetConfig(path: string): Promise<PerformanceBudgetConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`PERFORMANCE_BUDGET_CONFIG_UNREADABLE:${path}`, { cause: error });
  }
  return validatePerformanceBudgetConfig(parsed);
}

function parseClientReferenceManifest(source: string, path: string): ClientReferenceManifest {
  const match = source.match(/globalThis\.__RSC_MANIFEST\[[^\]]+\]=(\{[\s\S]*\});?\s*$/u);
  if (!match?.[1]) throw new Error(`PERFORMANCE_ROUTE_MANIFEST_INVALID:${path}`);
  try {
    return JSON.parse(match[1]) as ClientReferenceManifest;
  } catch (error) {
    throw new Error(`PERFORMANCE_ROUTE_MANIFEST_INVALID:${path}`, { cause: error });
  }
}

function assetPath(buildDir: string, manifestPath: string): string {
  if (!manifestPath.startsWith("static/")) {
    throw new Error(`PERFORMANCE_ASSET_PATH_INVALID:${manifestPath}`);
  }
  const staticRoot = resolve(buildDir, "static");
  const fullPath = resolve(buildDir, manifestPath);
  if (fullPath !== staticRoot && !fullPath.startsWith(`${staticRoot}${sep}`)) {
    throw new Error(`PERFORMANCE_ASSET_PATH_INVALID:${manifestPath}`);
  }
  return fullPath;
}

async function gzipSize(path: string): Promise<number> {
  try {
    return gzipSync(await readFile(path), { level: 9 }).byteLength;
  } catch (error) {
    throw new Error(`PERFORMANCE_ASSET_UNREADABLE:${path}`, { cause: error });
  }
}

async function sumManifestAssets(buildDir: string, assets: Iterable<string>): Promise<number> {
  const unique = [...new Set(assets)];
  const sizes = await Promise.all(unique.map((asset) => gzipSize(assetPath(buildDir, asset))));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function listFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`PERFORMANCE_BUILD_OUTPUT_UNREADABLE:${root}`, { cause: error });
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

function routeManifestPath(buildDir: string, route: string): string {
  const routeDirectory = route === "/" ? "" : route.slice(1);
  return resolve(buildDir, "server/app", routeDirectory, "page_client-reference-manifest.js");
}

async function routeJavaScriptAssets(buildDir: string, route: string): Promise<string[]> {
  const path = routeManifestPath(buildDir, route);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`PERFORMANCE_ROUTE_MANIFEST_UNREADABLE:${route}:${path}`, { cause: error });
  }
  const manifest = parseClientReferenceManifest(source, path);
  const assets: string[] = [];
  for (const clientModule of Object.values(manifest.clientModules ?? {})) {
    if (!Array.isArray(clientModule.chunks)) continue;
    for (const chunk of clientModule.chunks) {
      if (typeof chunk === "string" && chunk.startsWith("static/") && chunk.endsWith(".js")) {
        assets.push(chunk);
      }
    }
  }
  return [...new Set(assets)];
}

export async function measurePerformanceBudget(
  buildDirectory: string,
  config: PerformanceBudgetConfig,
): Promise<PerformanceBudgetReport> {
  const buildDir = resolve(buildDirectory);
  let manifest: BuildManifest;
  try {
    manifest = JSON.parse(await readFile(resolve(buildDir, "build-manifest.json"), "utf8")) as BuildManifest;
  } catch (error) {
    throw new Error(`PERFORMANCE_BUILD_MANIFEST_UNREADABLE:${buildDir}`, { cause: error });
  }
  if (!Array.isArray(manifest.rootMainFiles) || !manifest.rootMainFiles.every((entry) => typeof entry === "string")) {
    throw new Error("PERFORMANCE_BUILD_MANIFEST_INVALID:rootMainFiles");
  }
  const sharedJavaScript = manifest.rootMainFiles as string[];
  const sharedJavaScriptGzipBytes = await sumManifestAssets(buildDir, sharedJavaScript);

  const staticRoot = resolve(buildDir, "static");
  const staticFiles = (await listFiles(staticRoot)).filter((path) => [".css", ".js"].includes(extname(path)));
  if (staticFiles.length === 0) throw new Error(`PERFORMANCE_STATIC_ASSETS_MISSING:${staticRoot}`);
  const measuredAssets = await Promise.all(staticFiles.map(async (path) => ({
    path: `static/${relative(staticRoot, path).split(sep).join("/")}`,
    extension: extname(path),
    gzipBytes: await gzipSize(path),
  })));
  const javascriptAssets = measuredAssets.filter((asset) => asset.extension === ".js");
  if (javascriptAssets.length === 0) throw new Error(`PERFORMANCE_JAVASCRIPT_ASSETS_MISSING:${staticRoot}`);
  const largestJavaScriptAsset = javascriptAssets.reduce((largest, asset) =>
    asset.gzipBytes > largest.gzipBytes ? asset : largest,
  );

  const criticalRoutes: Record<string, number> = {};
  for (const route of Object.keys(config.criticalRoutes)) {
    const routeAssets = await routeJavaScriptAssets(buildDir, route);
    criticalRoutes[route] = await sumManifestAssets(buildDir, [...sharedJavaScript, ...routeAssets]);
  }

  return {
    sharedJavaScriptGzipBytes,
    largestJavaScriptAsset: {
      path: largestJavaScriptAsset.path,
      gzipBytes: largestJavaScriptAsset.gzipBytes,
    },
    globalCssGzipBytes: measuredAssets
      .filter((asset) => asset.extension === ".css")
      .reduce((sum, asset) => sum + asset.gzipBytes, 0),
    totalStaticClientGzipBytes: measuredAssets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    criticalRoutes,
  };
}

export function performanceBudgetFailures(
  report: PerformanceBudgetReport,
  config: PerformanceBudgetConfig,
): PerformanceBudgetFailure[] {
  const candidates: Array<[string, number, number]> = [
    ["shared JavaScript", report.sharedJavaScriptGzipBytes, config.budgets.sharedJavaScriptGzipBytes],
    ["largest JavaScript asset", report.largestJavaScriptAsset.gzipBytes, config.budgets.largestJavaScriptAssetGzipBytes],
    ["global CSS", report.globalCssGzipBytes, config.budgets.globalCssGzipBytes],
    ["all static client assets", report.totalStaticClientGzipBytes, config.budgets.totalStaticClientGzipBytes],
    ...Object.entries(config.criticalRoutes).map(([route, budget]) => [
      `route ${route}`,
      report.criticalRoutes[route] ?? Number.POSITIVE_INFINITY,
      budget,
    ] as [string, number, number]),
  ];
  return candidates
    .filter(([, actual, budget]) => actual > budget)
    .map(([metric, actualBytes, budgetBytes]) => ({ metric, actualBytes, budgetBytes }));
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function formatPerformanceBudgetReport(
  report: PerformanceBudgetReport,
  config: PerformanceBudgetConfig,
): string {
  const rows: Array<[string, number, number]> = [
    ["shared JavaScript", report.sharedJavaScriptGzipBytes, config.budgets.sharedJavaScriptGzipBytes],
    [`largest JavaScript asset (${report.largestJavaScriptAsset.path})`, report.largestJavaScriptAsset.gzipBytes, config.budgets.largestJavaScriptAssetGzipBytes],
    ["global CSS", report.globalCssGzipBytes, config.budgets.globalCssGzipBytes],
    ["all static client assets", report.totalStaticClientGzipBytes, config.budgets.totalStaticClientGzipBytes],
    ...Object.entries(config.criticalRoutes).map(([route, budget]) => [
      `route ${route}`,
      report.criticalRoutes[route] ?? Number.POSITIVE_INFINITY,
      budget,
    ] as [string, number, number]),
  ];
  return rows.map(([metric, actual, budget]) =>
    `${actual <= budget ? "PASS" : "FAIL"} ${metric}: ${kib(actual)} / ${kib(budget)}`,
  ).join("\n");
}
