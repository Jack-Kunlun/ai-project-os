import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { planRepositoryImpact } from "./ci-impact-plan.mjs";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const RISKS = new Set(["low", "medium", "high"]);
const THIS_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_PATH = resolve(THIS_DIRECTORY, "../config/ci-test-coverage.json");
const POLICY_PATH = "config/ci-test-coverage.json";
const MAX_SNAPSHOT_BLOB_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_ENTRIES = 20_000;
const PUBLIC_PASSIVE_ASSET_PATH = /^public\/.*\.(?:avif|eot|gif|ico|jpe?g|otf|png|ttf|woff2?)$/iu;
const SELECTOR_PATHS = new Set([
  "scripts/ci-test-plan.mjs",
  "scripts/ci-test-checks.mjs",
  "scripts/ci-unit-reporter.mjs",
  "scripts/run-browser-e2e.ts",
  "scripts/ci-impact-plan.mjs",
  POLICY_PATH,
  "playwright.config.ts",
]);
const TEXT_EXTENSIONS = new Set([
  ".css", ".csv", ".html", ".js", ".json", ".jsonl", ".md", ".mjs", ".mts", ".py", ".sh", ".snap",
  ".sql", ".svg", ".text", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const TEST_FILE_PATTERN = /^test\/[A-Za-z0-9._-]+\.test\.ts$/u;
const SPEC_FILE_PATTERN = /^e2e\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.spec\.tsx?$/u;

function stableError(code) {
  return new Error(code);
}

function validRisk(risk) {
  return typeof risk === "string" && RISKS.has(risk);
}

function validRepoPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("-")) return false;
  if (path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) return false;
  return posix.normalize(path) === path && path.split("/").every((segment) => /^[A-Za-z0-9._@()\[\]-]+$/u.test(segment));
}

function runGit(repository, args, { maxBuffer = 16 * 1024 * 1024, encoding = "utf8", input } = {}) {
  return spawnSync("git", args, {
    cwd: repository,
    encoding,
    maxBuffer,
    input,
    windowsHide: true,
  });
}

function hasCommit(repository, revision) {
  if (!SHA_PATTERN.test(revision ?? "")) return false;
  const result = runGit(repository, ["cat-file", "-e", `${revision}^{commit}`], { maxBuffer: 1024 * 1024 });
  return result.status === 0;
}

function readChangedPaths(repository, base, target) {
  if (!SHA_PATTERN.test(base ?? "") || !SHA_PATTERN.test(target ?? "")
      || !hasCommit(repository, base) || !hasCommit(repository, target)) return null;
  const ancestry = runGit(repository, ["merge-base", "--is-ancestor", base, target], { maxBuffer: 1024 * 1024 });
  if (ancestry.status !== 0) return null;
  const diff = runGit(repository, ["diff", "--name-only", "-z", "--no-renames", base, target, "--"], {
    encoding: "buffer",
  });
  if (diff.status !== 0 || !Buffer.isBuffer(diff.stdout)) return null;
  const paths = diff.stdout.toString("utf8").split("\0").filter(Boolean);
  if (paths.some((path) => !validRepoPath(path))) return null;
  return [...new Set(paths)].sort();
}

function readPolicy(policyPath = DEFAULT_POLICY_PATH) {
  let value;
  try {
    value = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch {
    throw stableError("CI_TEST_PLAN_POLICY_UNREADABLE");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1
      || !Array.isArray(value.sharedShellPaths) || !Array.isArray(value.sharedShellBrowserSpecs)
      || !Array.isArray(value.sharedShellUnitTests) || !Array.isArray(value.globalPaths)
      || !Array.isArray(value.routeGroups)) {
    throw stableError("CI_TEST_PLAN_POLICY_INVALID");
  }
  const paths = [
    ...value.sharedShellPaths,
    ...value.sharedShellBrowserSpecs,
    ...value.sharedShellUnitTests,
    ...value.globalPaths,
  ];
  if (paths.some((path) => !validRepoPath(path))) throw stableError("CI_TEST_PLAN_POLICY_INVALID");
  for (const route of value.routeGroups) {
    if (!route || typeof route !== "object" || typeof route.prefix !== "string" || !route.prefix.startsWith("/")
        || !Array.isArray(route.browserSpecs) || !Array.isArray(route.unitTests)
        || (route.includeDescendants !== undefined && typeof route.includeDescendants !== "boolean")
        || [...route.browserSpecs, ...route.unitTests].some((path) => !validRepoPath(path))) {
      throw stableError("CI_TEST_PLAN_POLICY_INVALID");
    }
  }
  return value;
}

function isRelevantSnapshotPath(path) {
  if (path === POLICY_PATH || path === "scripts/ci-impact-plan.mjs" || path === "scripts/ci-test-plan.mjs") return true;
  if (!(path.startsWith("src/") || path.startsWith("public/") || path.startsWith("test/") || path.startsWith("e2e/"))) return false;
  return TEXT_EXTENSIONS.has(posix.extname(path).toLowerCase());
}

/** Read a bounded, text-only view of files that can participate in test planning from a frozen Git tree. */
export function readRepositorySnapshot(repository, revision) {
  if (!hasCommit(repository, revision)) throw stableError("CI_TEST_PLAN_REVISION_UNREADABLE");
  const listing = runGit(repository, ["ls-tree", "-r", "-z", revision], { encoding: "buffer" });
  if (listing.status !== 0 || !Buffer.isBuffer(listing.stdout)) throw stableError("CI_TEST_PLAN_TREE_UNREADABLE");
  const entries = [];
  for (const entry of listing.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw stableError("CI_TEST_PLAN_TREE_ENTRY_INVALID");
    const [mode, type, oid] = entry.slice(0, separator).split(" ");
    const path = entry.slice(separator + 1);
    if (!isRelevantSnapshotPath(path)) continue;
    if (!validRepoPath(path)) throw stableError("CI_TEST_PLAN_TREE_PATH_INVALID");
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw stableError("CI_TEST_PLAN_TREE_ENTRY_UNSUPPORTED");
    }
    if (!/^[a-f0-9]{40,64}$/u.test(oid ?? "")) throw stableError("CI_TEST_PLAN_TREE_ENTRY_INVALID");
    entries.push({ path, oid });
  }
  if (entries.length > MAX_SNAPSHOT_ENTRIES) throw stableError("CI_TEST_PLAN_ENTRY_COUNT_LIMIT");
  const requests = Buffer.from(entries.map(({ oid }) => `${oid}\n`).join(""), "ascii");
  const batch = runGit(repository, ["cat-file", "--batch"], {
    encoding: "buffer",
    input: requests,
    maxBuffer: MAX_SNAPSHOT_TOTAL_BYTES,
  });
  if (batch.error?.code === "ENOBUFS") throw stableError("CI_TEST_PLAN_TOTAL_SIZE_LIMIT");
  if (batch.status !== 0 || !Buffer.isBuffer(batch.stdout)) throw stableError("CI_TEST_PLAN_BATCH_READ_FAILED");
  const snapshot = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    const headerEnd = batch.stdout.indexOf(0x0a, offset);
    if (headerEnd < 0) throw stableError("CI_TEST_PLAN_BATCH_HEADER_INVALID");
    const header = batch.stdout.toString("ascii", offset, headerEnd);
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/u.exec(header);
    if (!match || match[1] !== entry.oid) throw stableError("CI_TEST_PLAN_BATCH_HEADER_INVALID");
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SNAPSHOT_BLOB_BYTES) {
      throw stableError("CI_TEST_PLAN_BLOB_SIZE_LIMIT");
    }
    totalBytes += size;
    if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) throw stableError("CI_TEST_PLAN_TOTAL_SIZE_LIMIT");
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= batch.stdout.length || batch.stdout[contentEnd] !== 0x0a) {
      throw stableError("CI_TEST_PLAN_BATCH_CONTENT_INVALID");
    }
    let content;
    try {
      content = decoder.decode(batch.stdout.subarray(contentStart, contentEnd));
    } catch {
      throw stableError("CI_TEST_PLAN_BLOB_ENCODING_INVALID");
    }
    snapshot.set(entry.path, content);
    offset = contentEnd + 1;
  }
  if (offset !== batch.stdout.length) throw stableError("CI_TEST_PLAN_BATCH_TRAILING_DATA");
  return snapshot;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function makePlan(base, target, risk, unit, browser) {
  const withoutFingerprint = { schemaVersion: 1, base, target, risk, unit, browser };
  return { ...withoutFingerprint, fingerprint: fingerprint(withoutFingerprint) };
}

function fullPlan(base, target, risk, reason, snapshot) {
  const inventory = snapshot instanceof Map ? [...snapshot.keys()] : [];
  const unitFiles = inventory.filter(isUnitFile).sort();
  const browserFiles = inventory.filter(isBrowserSpec).sort();
  return makePlan(base, target, risk,
    { mode: "full", files: unitFiles, reason },
    { mode: "full", files: browserFiles, reason });
}

function none(reason) {
  return { mode: "none", files: [], reason };
}

function selected(files, reason) {
  return { mode: "selected", files: [...new Set(files)].sort(), reason };
}

function isUnitFile(path) {
  return TEST_FILE_PATTERN.test(path);
}

function isBrowserSpec(path) {
  return SPEC_FILE_PATTERN.test(path);
}

function getSnapshotContents(snapshot, beforeSnapshot) {
  const merged = new Map();
  for (const source of [beforeSnapshot, snapshot]) {
    if (!(source instanceof Map)) continue;
    for (const [path, content] of source) {
      if (validRepoPath(path) && typeof content === "string") merged.set(path, [...(merged.get(path) ?? []), content]);
    }
  }
  return merged;
}

function sourceExtension(path) {
  return [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".css"].includes(posix.extname(path).toLowerCase());
}

function possibleFileCandidates(path) {
  return [path, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".css"].map((extension) => `${path}${extension}`),
    ...["index.ts", "index.tsx", "index.js", "index.jsx", "index.css"].map((name) => posix.join(path, name))];
}

function resolveModulePath(importer, specifier, available, { cssUrl = false } = {}) {
  let base;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  } else if (specifier.startsWith("@/")) {
    base = posix.normalize(posix.join("src", specifier.slice(2)));
  } else if (cssUrl && specifier.startsWith("/")) {
    base = posix.normalize(posix.join("public", specifier.slice(1)));
  } else {
    return { local: false, path: null };
  }
  if (!validRepoPath(base)) return { local: true, path: null };
  for (const candidate of possibleFileCandidates(base)) {
    if (available.has(candidate)) return { local: true, path: candidate };
  }
  // Binary assets participate in CSS layout but are intentionally excluded from the text snapshots.
  if (/\.(?:avif|gif|ico|jpe?g|png|webp|woff2?|ttf|otf|eot)$/iu.test(base)) return { local: false, path: null };
  return { local: true, path: null };
}

function collectTypeScriptSpecifiers(path, content) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specifiers = [];
  const sourceStrings = [];
  let dynamicUnknown = false;
  const addModule = (node) => {
    if (ts.isStringLiteralLike(node)) specifiers.push(node.text);
    else dynamicUnknown = true;
  };
  const walk = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) addModule(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
        else dynamicUnknown = true;
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
        else dynamicUnknown = true;
      }
    }
    if (ts.isStringLiteralLike(node)) sourceStrings.push(node.text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { specifiers, sourceStrings, dynamicUnknown };
}

function dependenciesForFile(path, contents, available) {
  const dependencies = new Set();
  let dynamicUnknown = false;
  if (path.endsWith(".css")) {
    const content = contents.join("\n");
    for (const match of content.matchAll(/@import\s+(?:url\()?['"]?([^'"\s)]+)['"]?\)?/giu)) {
      const resolved = resolveModulePath(path, match[1] ?? "", available);
      if (resolved.path) dependencies.add(resolved.path);
      else if (resolved.local) dynamicUnknown = true;
    }
    for (const match of content.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/giu)) {
      const resolved = resolveModulePath(path, match[1] ?? "", available, { cssUrl: true });
      if (resolved.path) dependencies.add(resolved.path);
      else if (resolved.local) dynamicUnknown = true;
    }
    return { dependencies, dynamicUnknown };
  }
  if (!sourceExtension(path)) return { dependencies, dynamicUnknown };
  for (const content of contents) {
    const parsed = collectTypeScriptSpecifiers(path, content);
    dynamicUnknown ||= parsed.dynamicUnknown;
    for (const specifier of parsed.specifiers) {
      const resolved = resolveModulePath(path, specifier, available);
      if (resolved.path) dependencies.add(resolved.path);
      else if (resolved.local) dynamicUnknown = true;
    }
    if (path.startsWith("test/") && isUnitFile(path)) {
      for (const value of parsed.sourceStrings) {
        const candidate = value.replace(/^\.\//u, "");
        if ((candidate.startsWith("src/") || candidate.startsWith("test/")) && available.has(candidate)) dependencies.add(candidate);
      }
    }
  }
  return { dependencies, dynamicUnknown };
}

function buildGraph(snapshot, beforeSnapshot) {
  const contents = getSnapshotContents(snapshot, beforeSnapshot);
  const available = new Set(contents.keys());
  const reverse = new Map();
  const dynamicUnknown = new Set();
  for (const [importer, versions] of contents) {
    const parsed = dependenciesForFile(importer, versions, available);
    if (parsed.dynamicUnknown) dynamicUnknown.add(importer);
    for (const dependency of parsed.dependencies) {
      if (!reverse.has(dependency)) reverse.set(dependency, new Set());
      reverse.get(dependency).add(importer);
    }
  }
  return { available, reverse, dynamicUnknown };
}

function routeFromPagePath(pagePath) {
  if (!pagePath.startsWith("src/app/") || !/(?:^|\/)page\.(?:tsx?|jsx?)$/u.test(pagePath.slice("src/app/".length))) return null;
  const relative = pagePath.slice("src/app/".length).replace(/(?:^|\/)page\.(?:tsx?|jsx?)$/u, "");
  if (!relative) return "/";
  const segments = relative.split("/");
  if (segments.some((segment) => segment.startsWith("@") || segment.startsWith("(..") || segment.startsWith("(.)"))) return null;
  const routeSegments = segments.filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")) && !/^\[.*\]$/u.test(segment));
  return routeSegments.length ? `/${routeSegments.join("/")}` : "/";
}

function isNextPagePath(path) {
  return path.startsWith("src/app/") && /(?:^|\/)page\.(?:tsx?|jsx?)$/u.test(path.slice("src/app/".length));
}

function isNextRouteEntry(path) {
  return path.startsWith("src/app/") && /(?:^|\/)\b(?:page|layout|route)\.(?:tsx?|jsx?)$/u.test(path.slice("src/app/".length));
}

function routeForPath(path, pagePaths) {
  const parents = [...pagePaths]
    .filter((pagePath) => path === pagePath || path.startsWith(`${posix.dirname(pagePath)}/`))
    .sort((left, right) => posix.dirname(right).length - posix.dirname(left).length);
  return parents.length ? routeFromPagePath(parents[0]) : null;
}

function routeGroupFor(route, policy) {
  return [...policy.routeGroups]
    .filter((group) => route === group.prefix
      || (group.includeDescendants === true && route.startsWith(`${group.prefix}/`)))
    .sort((left, right) => right.prefix.length - left.prefix.length)[0] ?? null;
}

function checkRegisteredFiles(paths, available, pattern) {
  return paths.every((path) => pattern(path) && available.has(path));
}

function browserAndUnitForUi(changedSourcePaths, graph, policy) {
  const pagePaths = [...graph.available].filter((path) => path.startsWith("src/app/") && /\/page\.(?:tsx?|jsx?)$/u.test(path));
  const routes = new Set();
  const routeSources = new Map();
  const queue = [...changedSourcePaths];
  const seen = new Set();
  while (queue.length) {
    const current = queue.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    // Specs import application code to exercise it; that relationship does not map app code to routes.
    if (current.startsWith("test/") || current.startsWith("e2e/")) continue;
    if (seen.size > 5000) return { error: `dependency-graph-limit:${current}` };
    if (graph.dynamicUnknown.has(current)) return { error: `unresolved-relevant-dependency:${current}` };
    const directRoute = routeFromPagePath(current);
    if (directRoute !== null) {
      routes.add(directRoute);
      routeSources.set(directRoute, current);
    }
    if (isNextPagePath(current)) continue;
    if (isNextRouteEntry(current)) return { error: `unmapped-route-boundary:${current}` };
    if (current.startsWith("src/app/") && !current.endsWith("/page.tsx") && !current.endsWith("/page.ts")) {
      const nearest = routeForPath(current, pagePaths);
      if (nearest !== null) {
        routes.add(nearest);
        routeSources.set(nearest, current);
      }
    }
    for (const importer of graph.reverse.get(current) ?? []) queue.push(importer);
  }
  if (routes.size === 0) return { error: `unmapped-client-route:${changedSourcePaths[0] ?? "unknown-source"}` };
  const browserFiles = new Set();
  const unitFiles = new Set();
  for (const route of routes) {
    const group = routeGroupFor(route, policy);
    if (!group) return { error: `unmapped-client-route:${routeSources.get(route) ?? route}` };
    for (const path of group.browserSpecs) browserFiles.add(path);
    for (const path of group.unitTests) unitFiles.add(path);
  }
  if (!checkRegisteredFiles([...browserFiles], graph.available, isBrowserSpec)
      || !checkRegisteredFiles([...unitFiles], graph.available, isUnitFile)) {
    return { error: "registered-coverage-file-missing" };
  }
  return { browserFiles: [...browserFiles], unitFiles: [...unitFiles] };
}

function unitTestsDirectlyUsingSources(paths, graph, snapshot) {
  const queue = paths.flatMap((path) => [...(graph.reverse.get(path) ?? [])]
    .filter((importer) => importer.startsWith("test/")));
  const seen = new Set();
  const tests = new Set();
  while (queue.length) {
    const current = queue.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (isUnitFile(current)) {
      if (snapshot.has(current)) tests.add(current);
      continue;
    }
    if (current.startsWith("test/")) {
      for (const importer of graph.reverse.get(current) ?? []) {
        if (importer.startsWith("test/")) queue.push(importer);
      }
    }
  }
  return tests;
}

function allRelevantTestFiles(snapshot) {
  return [...snapshot.keys()].filter((path) => isUnitFile(path) || isBrowserSpec(path)).sort();
}

function inventoryFor(snapshot, predicate) {
  return [...snapshot.keys()].filter(predicate).sort();
}

function planSnapshot({ base, target, risk, changedPaths, files, beforeFiles, impact }, policy) {
  const fail = (reason) => fullPlan(base, target, risk, reason, files instanceof Map ? files : undefined);
  if (base === "unknown") return fail("unknown-base");
  if (!SHA_PATTERN.test(base ?? "")) return fullPlan(String(base ?? "unknown"), target, risk, "unknown-base", files);
  if (!SHA_PATTERN.test(target ?? "")) return fail("invalid-target");
  if (!(files instanceof Map) || !(beforeFiles === undefined || beforeFiles instanceof Map)
      || !Array.isArray(changedPaths) || !impact || !["full", "selected", "none"].includes(impact.mode)
      || typeof impact.browser !== "boolean") return fail("snapshot-input-invalid");
  if (changedPaths.some((path) => !validRepoPath(path))) return fail("unknown-changed-path");
  const targetInventory = new Set(files.keys());
  if ([...targetInventory].some((path) => !validRepoPath(path) || typeof files.get(path) !== "string")) {
    return fail("snapshot-path-invalid");
  }
  if (beforeFiles && [...beforeFiles].some(([path, content]) => !validRepoPath(path) || typeof content !== "string")) {
    return fail("before-snapshot-path-invalid");
  }
  if (impact.mode === "full") return fail("impact-full");

  const snapshot = files;
  const beforeSnapshot = beforeFiles ?? new Map();
  const changed = [...new Set(changedPaths)].sort();
  if (changed.some((path) => SELECTOR_PATHS.has(path) || path.startsWith(".github/workflows/"))) {
    return fail("ci-policy-or-workflow-change");
  }
  if (changed.some((path) => path === "playwright.config.ts" || path.startsWith("e2e/support/"))) {
    return fail("browser-runner-or-shared-fixture-change");
  }
  if (changed.some((path) => policy.globalPaths.includes(path))) return fail("global-layout-change");

  const policyShellPaths = new Set(policy.sharedShellPaths);
  const shellChanges = changed.filter((path) => policyShellPaths.has(path));
  const directUnitTests = new Set();
  const directBrowserSpecs = new Set();
  for (const path of changed) {
    if (isUnitFile(path)) {
      if (!snapshot.has(path)) return fail("changed-unit-test-missing");
      directUnitTests.add(path);
    }
    if (isBrowserSpec(path)) {
      if (!snapshot.has(path)) return fail("changed-browser-spec-missing");
      directBrowserSpecs.add(path);
    }
    if (path.startsWith("e2e/") && !isBrowserSpec(path)) return fail("shared-browser-support-change");
  }

  const graph = buildGraph(snapshot, beforeSnapshot);
  const relatedUnit = new Set(directUnitTests);
  const versionOnly = typeof impact.reason === "string" && impact.reason.startsWith("version-only:");
  const shellPathSet = new Set(policy.sharedShellPaths);
  const changedDependencyPaths = changed.filter((path) =>
    (path.startsWith("src/") || path.startsWith("public/")
      || (path.startsWith("test/") && !isUnitFile(path)))
      && !(versionOnly && path === "src/lib/version.ts"));
  const changedSourcePaths = changedDependencyPaths.filter((path) => path.startsWith("src/") || path.startsWith("public/"));
  const hasUiSourceChange = changedSourcePaths.some((path) => !PUBLIC_PASSIVE_ASSET_PATH.test(path));
  for (const path of unitTestsDirectlyUsingSources(shellChanges, graph, snapshot)) relatedUnit.add(path);
  const dependencyPathsForAnalysis = changedDependencyPaths.filter((path) => !shellPathSet.has(path));
  for (const sourcePath of dependencyPathsForAnalysis) {
    const queue = [sourcePath];
    const seen = new Set();
    const sourceUnitTests = new Set();
    while (queue.length) {
      const current = queue.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      if (isUnitFile(current)) {
        if (snapshot.has(current)) {
          relatedUnit.add(current);
          sourceUnitTests.add(current);
        }
        continue;
      }
      if (current.startsWith("e2e/")) continue;
      if (isNextRouteEntry(current)) continue;
      if (current.startsWith("test/")) {
        for (const importer of graph.reverse.get(current) ?? []) queue.push(importer);
        continue;
      }
      if (seen.size > 5000) return fail(`dependency-graph-limit:${current}`);
      if (graph.dynamicUnknown.has(current)) return fail(`unresolved-relevant-dependency:${current}`);
      for (const importer of graph.reverse.get(current) ?? []) queue.push(importer);
    }
    if (sourcePath.startsWith("test/") && !isUnitFile(sourcePath) && sourceUnitTests.size === 0) {
      return fail("unmapped-unit-support-change");
    }
  }

  if (risk === "high") {
    const unitPlan = { mode: "full", files: inventoryFor(snapshot, isUnitFile), reason: "high-risk-full-unit-suite" };
    let browserPlan;
    if (!impact.browser && directBrowserSpecs.size === 0) browserPlan = none("no-browser-impact");
    else browserPlan = { mode: "full", files: inventoryFor(snapshot, isBrowserSpec), reason: "high-risk-browser-impact" };
    return makePlan(base, target, risk, unitPlan, browserPlan);
  }

  const nonShellSourcePaths = changedSourcePaths.filter((path) => !shellPathSet.has(path));
  if (impact.browser && nonShellSourcePaths.length > 0) {
    const uiCoverage = browserAndUnitForUi(nonShellSourcePaths, graph, policy);
    if (uiCoverage.error) return fail(uiCoverage.error);
    for (const path of uiCoverage.unitFiles) relatedUnit.add(path);
    for (const path of uiCoverage.browserFiles) directBrowserSpecs.add(path);
  }

  if (shellChanges.length > 0) {
    if (!checkRegisteredFiles(policy.sharedShellBrowserSpecs, snapshot, isBrowserSpec)
        || !checkRegisteredFiles(policy.sharedShellUnitTests, snapshot, isUnitFile)) {
      return fail("shared-shell-coverage-file-missing");
    }
    for (const path of policy.sharedShellBrowserSpecs) directBrowserSpecs.add(path);
    for (const path of policy.sharedShellUnitTests) relatedUnit.add(path);
  }

  if (hasUiSourceChange && !impact.browser && impact.mode !== "selected" && !versionOnly) {
    return fail("client-impact-classification-mismatch");
  }
  if (impact.mode === "selected" && relatedUnit.size === 0 && changed.length > 0) {
    return fail("selected-impact-without-unit-coverage");
  }
  if (impact.browser && hasUiSourceChange && directBrowserSpecs.size === 0) {
    return fail("browser-impact-without-route-coverage");
  }

  let unitPlan;
  const versionIdentityContracts = ["test/release-version-identity.test.ts", "test/product-identity-contract.test.ts"];
  if (versionOnly) {
    if (!checkRegisteredFiles(versionIdentityContracts, snapshot, isUnitFile)) return fail("version-identity-contract-missing");
    for (const path of versionIdentityContracts) relatedUnit.add(path);
  }
  if (relatedUnit.size > 0) {
    const hasOtherUnitCoverage = [...relatedUnit].some((path) => !versionIdentityContracts.includes(path));
    const reason = versionOnly && !hasOtherUnitCoverage
      ? "version-identity-contracts"
      : versionOnly ? "selected-related-unit-tests-and-version-identity" : "selected-related-unit-tests";
    unitPlan = selected([...relatedUnit], reason);
  }
  else unitPlan = none(changed.length === 0 ? "no-change" : "no-affected-unit-tests");

  let browserPlan;
  if (directBrowserSpecs.size > 0) browserPlan = selected([...directBrowserSpecs], shellChanges.length > 0 ? "shared-shell-route-contracts" : "selected-routed-browser-specs");
  else if (impact.browser) browserPlan = {
    mode: "full",
    files: inventoryFor(snapshot, isBrowserSpec),
    reason: "browser-impact-unmapped",
  };
  else browserPlan = none(changed.length === 0 ? "no-change" : "no-browser-impact");

  const legalTargetFiles = allRelevantTestFiles(snapshot);
  for (const section of [unitPlan, browserPlan]) {
    if (section.mode === "selected" && section.files.some((path) => !legalTargetFiles.includes(path))) {
      return fail("selected-test-outside-target-inventory");
    }
  }
  return makePlan(base, target, risk, unitPlan, browserPlan);
}

/** Plan impacted unit and browser checks from caller-provided frozen snapshots. */
export function createTestPlanForSnapshot(input) {
  const base = typeof input?.base === "string" ? input.base : "unknown";
  const target = typeof input?.target === "string" ? input.target : "";
  const risk = input?.risk ?? "high";
  const safeRisk = validRisk(risk) ? risk : "high";
  if (!validRisk(risk)) return fullPlan(base, target, safeRisk, "invalid-risk", input?.files);
  let policy;
  try {
    policy = readPolicy(input?.policyPath ?? DEFAULT_POLICY_PATH);
  } catch {
    return fullPlan(base, target, safeRisk, "test-coverage-policy-unreadable", input?.files);
  }
  return planSnapshot({
    base,
    target,
    risk: safeRisk,
    changedPaths: input?.changedPaths,
    files: input?.files,
    beforeFiles: input?.beforeFiles,
    impact: input?.impact,
  }, policy);
}

/** Create a canonical plan for a base..target Git diff. */
export function createRepositoryTestPlan(repository, base, target, { risk = "high" } = {}) {
  const safeBase = base === "unknown" ? "unknown" : base;
  if (!SHA_PATTERN.test(target ?? "") || !hasCommit(repository, target)) {
    return fullPlan(String(safeBase ?? "unknown"), String(target ?? ""), validRisk(risk) ? risk : "high", "target-commit-unreadable");
  }
  let files;
  try {
    files = readRepositorySnapshot(repository, target);
  } catch {
    return fullPlan(String(safeBase ?? "unknown"), target, validRisk(risk) ? risk : "high", "git-snapshot-unreadable");
  }
  const safeRisk = validRisk(risk) ? risk : "high";
  if (!validRisk(risk)) return fullPlan(String(safeBase ?? "unknown"), target, safeRisk, "invalid-risk", files);
  if (safeBase === "unknown") return fullPlan("unknown", target, risk, "unknown-base", files);
  if (!SHA_PATTERN.test(safeBase) || !hasCommit(repository, safeBase)) return fullPlan(String(safeBase ?? "unknown"), target, risk, "base-commit-unreadable", files);
  const changedPaths = readChangedPaths(repository, safeBase, target);
  if (!changedPaths) return fullPlan(safeBase, target, risk, "base-target-diff-unreadable", files);
  let impact;
  try {
    impact = planRepositoryImpact(repository, safeBase, target);
  } catch {
    return fullPlan(safeBase, target, risk, "impact-planner-error", files);
  }
  if (!impact || !["full", "selected", "none"].includes(impact.mode) || typeof impact.browser !== "boolean") {
    return fullPlan(safeBase, target, risk, "impact-planner-invalid", files);
  }
  let beforeFiles;
  try {
    beforeFiles = readRepositorySnapshot(repository, safeBase);
  } catch {
    return fullPlan(safeBase, target, risk, "git-snapshot-unreadable", files);
  }
  return createTestPlanForSnapshot({ base: safeBase, target, risk, changedPaths, files, beforeFiles, impact });
}

function exactObjectKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function validatePlanShape(plan) {
  if (!exactObjectKeys(plan, ["schemaVersion", "base", "target", "risk", "unit", "browser", "fingerprint"])) {
    throw stableError("CI_TEST_PLAN_SCHEMA_INVALID");
  }
  if (plan.schemaVersion !== 1 || !(plan.base === "unknown" || SHA_PATTERN.test(plan.base ?? ""))
      || !SHA_PATTERN.test(plan.target ?? "") || !validRisk(plan.risk) || !FINGERPRINT_PATTERN.test(plan.fingerprint ?? "")) {
    throw stableError("CI_TEST_PLAN_IDENTITY_INVALID");
  }
  for (const name of ["unit", "browser"]) {
    const section = plan[name];
    if (!exactObjectKeys(section, ["mode", "files", "reason"]) || !["none", "selected", "full"].includes(section.mode)
        || !Array.isArray(section.files) || typeof section.reason !== "string" || section.reason.length === 0) {
      throw stableError("CI_TEST_PLAN_SECTION_INVALID");
    }
    if (section.files.some((path) => !validRepoPath(path)) || new Set(section.files).size !== section.files.length) {
      throw stableError("CI_TEST_PLAN_PATH_INVALID");
    }
    if (canonicalJson(section.files) !== canonicalJson([...section.files].sort())) throw stableError("CI_TEST_PLAN_ORDER_INVALID");
    if (section.mode !== "none" && section.files.length === 0) throw stableError("CI_TEST_PLAN_EMPTY_SELECTION");
    if (section.mode === "none" && section.files.length !== 0) throw stableError("CI_TEST_PLAN_SECTION_INVALID");
    if (section.mode !== "none" && section.files.some((path) => name === "unit" ? !isUnitFile(path) : !isBrowserSpec(path))) {
      throw stableError("CI_TEST_PLAN_PATH_INVALID");
    }
  }
}

/** Validate structure, identity, fingerprint, repository inventory, and canonical recomputation. */
export function verifyRepositoryTestPlan(plan, repository, { expectedBase, expectedTarget, expectedRisk } = {}) {
  validatePlanShape(plan);
  if (expectedBase !== undefined && expectedBase !== plan.base) throw stableError("CI_TEST_PLAN_BASE_MISMATCH");
  if (expectedTarget !== undefined && expectedTarget !== plan.target) throw stableError("CI_TEST_PLAN_TARGET_MISMATCH");
  if (expectedRisk !== undefined && !validRisk(expectedRisk)) throw stableError("CI_TEST_PLAN_EXPECTED_RISK_INVALID");
  if (expectedRisk !== undefined && expectedRisk !== plan.risk) throw stableError("CI_TEST_PLAN_RISK_MISMATCH");
  const { fingerprint: submittedFingerprint, ...withoutFingerprint } = plan;
  if (fingerprint(withoutFingerprint) !== submittedFingerprint) throw stableError("CI_TEST_PLAN_FINGERPRINT_INVALID");
  let canonical;
  try {
    canonical = createRepositoryTestPlan(repository, plan.base, plan.target, { risk: expectedRisk ?? plan.risk });
  } catch {
    throw stableError("CI_TEST_PLAN_RECOMPUTE_FAILED");
  }
  if (canonicalJson(canonical) !== canonicalJson(plan)) throw stableError("CI_TEST_PLAN_CANONICAL_MISMATCH");
  return true;
}
