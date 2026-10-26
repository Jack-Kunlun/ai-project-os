import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const FULL_GATES = Object.freeze({
  database: "all",
  phoneAuth: true,
  oid10: true,
  browser: true,
  candidate: true,
  schemaValidation: true,
});

const DOMAIN_GATES = Object.freeze([
  {
    pattern: /(?:personal[-/]knowledge|knowledge[-/]personal)/iu,
    gates: ["personal-knowledge", "personal-knowledge-extraction", "personal-knowledge-qa", "personal-knowledge-semantic", "personal-knowledge-platform-semantic"],
  },
  {
    pattern: /(?:project[-/]asset|asset[-/]upload)/iu,
    gates: ["project-assets", "project-asset-upload"],
  },
  {
    pattern: /(?:repository[-/]memory|project[-/]git|github[-/]repository|delegated[-/]git)/iu,
    gates: ["github-ledger", "github-code-scan", "github-material-ledger", "github-material-sync", "repository-memory", "project-github-sync", "project-git-repository-delegation", "project-git-automation-run-ledger", "project-git-automation-read-context", "project-git-automation-material", "project-git-automation-execution", "project-delegated-git-runtime", "project-git-automation-upgrade"],
  },
  {
    pattern: /(?:mcp|action[-/]engine)/iu,
    gates: ["action-engine", "mcp-capabilities", "mcp-client-acceptance", "mcp-export-grants", "mcp-attestation-control-plane", "project-mcp-delegation", "project-mcp-grant-retention", "project-mcp-tool-grant", "project-mcp-action", "project-mcp-action-dispatch"],
  },
  {
    pattern: /(?:web[-/]ai|web[-/]source)/iu,
    gates: ["web-ai-workflow", "web-ai-confirmation", "web-ai-access", "web-ai-governance", "authenticated-web-source", "personal-web-ai-runtime"],
  },
  {
    pattern: /(?:automation|background[-/]job|worker[-/]health)/iu,
    gates: ["background-job-reconciliation", "automation-governance", "worker-health", "project-workflow"],
  },
  {
    pattern: /(?:project[-/]plan|project[-/]intelligence|project[-/]world)/iu,
    gates: ["project-plan", "project-intelligence", "project-world"],
  },
  {
    pattern: /(?:connection|provider[-/]probe|ai[-/]runtime)/iu,
    gates: ["ai-runtime", "connection-governance", "connection-configuration-edit", "personal-connection-probe", "platform-provider-probe", "project-ai-provider-delegation"],
  },
]);

const SENSITIVE_SOURCE_PATH = /^src\/(?:app\/admin\/|app\/(?:auth|login)\/|.*(?:auth|login|account|permission|authorization|role|entitlement|credits?|quotas?|billing|security|credential|secret|provider|grant|consent|approval|external|model|connection|mcp|action|oauth|oidc))/iu;
const VERSION_METADATA_PATHS = new Set(["package.json", "src/lib/version.ts"]);
const INFRA_PATH = /^(?:\.github\/|deploy\/|scripts\/(?:ci-|production-stable-|production-cache-maintenance\.mjs$|prepare-stable-|prepare-release-images|publish-release-images|release-image-manifest|run-local-release|run-browser-e2e|local-release-candidate|release-image|run-postgres-gates|postgres-gate-contract|run-phone-auth-postgres|run-database-principal-oid10-gate)|Dockerfile$|\.dockerignore$|docker-bake\.hcl$|compose(?:\.[^/]*)?\.ya?ml$|next\.config\.[^/]+$|config\/performance-budgets\.json$)/u;
const CLIENT_PATH = /^(?:src\/components\/.*\.(?:tsx?|css)$|src\/app\/.*(?:-client\.tsx|\.css)$|public\/.*\.svg$|e2e\/.*\.spec\.tsx?$)/u;
const PUBLIC_PASSIVE_ASSET_PATH = /^public\/.*\.(?:avif|eot|gif|ico|jpe?g|otf|png|ttf|woff2?)$/iu;
const BROWSER_INFRA_PATHS = new Set([
  ".github/workflows/ci.yml", "playwright.config.ts", "scripts/run-browser-e2e.ts",
  "scripts/ci-test-plan.mjs", "scripts/ci-test-checks.mjs", "scripts/ci-unit-reporter.mjs", "config/ci-test-coverage.json",
]);

function failClosed(reason) {
  return {
    mode: "full",
    gateFilter: FULL_GATES.database,
    phoneAuth: FULL_GATES.phoneAuth,
    oid10: FULL_GATES.oid10,
    browser: FULL_GATES.browser,
    candidate: FULL_GATES.candidate,
    schemaValidation: FULL_GATES.schemaValidation,
    reason,
  };
}

function postgresGateFiles(repository) {
  const source = readFileSync(`${repository}/scripts/postgres-gate-contract.ts`, "utf8");
  const gates = new Map();
  for (const match of source.matchAll(/\{ id: "([a-z0-9-]+)", file: "([^"]+\.test\.ts)"/gu)) {
    gates.set(match[2], match[1]);
  }
  if (gates.size === 0) throw new Error("CI_IMPACT_POSTGRES_REGISTRY_UNREADABLE");
  return gates;
}

function testGateForPath(path, gatesByFile) {
  if (gatesByFile.has(path)) return gatesByFile.get(path);
  const file = path.replace(/^test\//u, "");
  if (gatesByFile.has(file)) return gatesByFile.get(file);
  if (/^test\/(?:phone-auth-postgres|sms-provider-admin-postgres|sms-provider-adapters-postgres|account-closure-postgres|graphic-captcha-postgres|account-security-postgres|email-auth-postgres)\.test\.ts$/u.test(path)) {
    return "phone-auth";
  }
  if (path === "scripts/run-database-principal-oid10-gate.ts" || path === "test/database-principal-oid10.test.ts") {
    return "database-principal-oid10";
  }
  return null;
}

export function planCiImpact(paths, { baseKnown = true, gatesByFile = new Map() } = {}) {
  if (!baseKnown || !Array.isArray(paths) || paths.some((path) => typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\\"))) {
    return failClosed("unknown-base-or-path");
  }
  if (paths.length === 0) {
    return { mode: "none", gateFilter: "none", phoneAuth: false, oid10: false, browser: false, candidate: false, schemaValidation: false, reason: "no-change" };
  }

  if (paths.some((path) => path.startsWith("prisma/")
      || (SENSITIVE_SOURCE_PATH.test(path) && !/^src\/.*\.css$/u.test(path)))) {
    return failClosed("security-account-or-schema-change");
  }

  const selected = new Set();
  let browser = false;
  let candidate = false;
  let schemaValidation = false;
  let hasApplicationSource = false;
  let phoneAuth = false;
  let oid10 = false;

  for (const path of paths) {
    const gateForTest = testGateForPath(path, gatesByFile);
    if (gateForTest === "phone-auth") {
      phoneAuth = true;
      continue;
    }
    if (gateForTest === "database-principal-oid10") {
      oid10 = true;
      continue;
    }
    if (gateForTest !== null) {
      selected.add(gateForTest);
      continue;
    }
    if (/^test\//u.test(path)) {
      // Test files without a registered gate still run in the default suite.
      // This existing file reads SQL/CI text and runs unconditionally in that
      // suite; principal implementation or migration changes still fail full above.
      if (path === "test/database-principal-contract.test.ts") continue;
      if (/-(?:api-)?postgres\.test\.ts$/iu.test(path)) return failClosed(`unmapped-postgres-test:${path}`);
      if (/(?:auth|account|permission|authorization|entitlement|credit|quota|billing|security|provider|database-principal|mcp|action)/iu.test(path)) {
        return failClosed(`unmapped-sensitive-test:${path}`);
      }
      continue;
    }
    if (CLIENT_PATH.test(path)) {
      hasApplicationSource = true;
      browser = true;
      continue;
    }
    if (BROWSER_INFRA_PATHS.has(path)) {
      browser = true;
      candidate = true;
      continue;
    }
    if (path === "scripts/local-release-images.ts") {
      browser = true;
      candidate = true;
      continue;
    }
    if (path === "scripts/run-local-release.ts" || path === "scripts/local-release-candidate.ts") {
      candidate = true;
      continue;
    }
    if (path.startsWith("src/app/api/") || path.startsWith("src/lib/")) {
      const domain = DOMAIN_GATES.find((entry) => entry.pattern.test(path));
      if (!domain) return failClosed(`unmapped-server-source:${path}`);
      for (const gate of domain.gates) selected.add(gate);
      hasApplicationSource = true;
      browser = true;
      candidate = true;
      continue;
    }
    if (path.startsWith("src/")) return failClosed(`unmapped-application-source:${path}`);
    if (VERSION_METADATA_PATHS.has(path)) return failClosed(`version-metadata-content-unverified:${path}`);
    if (INFRA_PATH.test(path)) {
      candidate = true;
      if (path.startsWith("prisma/")) schemaValidation = true;
      continue;
    }
    if (path.startsWith("e2e/")) {
      browser = true;
      continue;
    }
    if (PUBLIC_PASSIVE_ASSET_PATH.test(path) || path.startsWith("docs/")
        || path === "README.md" || path === "CHANGELOG.md" || path === "AGENTS.md") continue;
    return failClosed(`unclassified-path:${path}`);
  }

  if (selected.size === 0) {
    return {
      mode: "none",
      gateFilter: "none",
      phoneAuth,
      oid10,
      browser,
      candidate,
      schemaValidation,
      reason: hasApplicationSource ? "mapped-client-only-change" : "no-database-impact",
    };
  }
  const ordered = [...selected].sort();
  return {
    mode: "selected",
    gateFilter: ordered.join(","),
    phoneAuth,
    oid10,
    browser,
    candidate: candidate || hasApplicationSource,
    schemaValidation,
    reason: "mapped-domain-gates",
  };
}

export function readChangedPaths(repository, base, target) {
  if (!SHA_PATTERN.test(base ?? "") || !SHA_PATTERN.test(target ?? "")) {
    return { known: false, paths: [] };
  }
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", base, target], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (ancestry.status !== 0) return { known: false, paths: [] };
  const diff = spawnSync("git", ["diff", "--name-only", "-z", "--no-renames", base, target, "--"], {
    cwd: repository,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (diff.status !== 0 || !Buffer.isBuffer(diff.stdout)) return { known: false, paths: [] };
  const entries = diff.stdout.toString("utf8").split("\0").filter(Boolean);
  if (entries.some((path) => Buffer.from(path, "utf8").toString("utf8") !== path)) return { known: false, paths: [] };
  return { known: true, paths: entries };
}

export function planRepositoryImpact(repository, base, target) {
  try {
    const changed = readChangedPaths(repository, base, target);
    const gatesByFile = postgresGateFiles(repository);
    if (!changed.known) return failClosed("unknown-base-or-path");
    const changedPaths = new Set(changed.paths);
    const changedPackage = changedPaths.has("package.json");
    const changedSourceVersion = changedPaths.has("src/lib/version.ts");
    const changedDockerfile = changedPaths.has("Dockerfile");

    if (!changedPackage && !changedSourceVersion) {
      if (changedDockerfile && !coherentIdentityVersions(repository, base, target)) {
        return failClosed("version-metadata-content-unverified");
      }
      return planCiImpact(changed.paths, { baseKnown: true, gatesByFile });
    }

    if (!changedPackage || !changedSourceVersion || !changedDockerfile) {
      return failClosed("version-metadata-content-unverified");
    }

    const packageTransition = versionOnlyTransition(repository, base, target, "package.json");
    const sourceTransition = versionOnlyTransition(repository, base, target, "src/lib/version.ts");
    const beforeVersions = identityVersions(repository, base);
    const afterVersions = identityVersions(repository, target);
    if (!packageTransition || !sourceTransition
        || packageTransition.before !== sourceTransition.before
        || packageTransition.after !== sourceTransition.after
        || !versionsAgree(beforeVersions)
        || !versionsAgree(afterVersions)
        || beforeVersions.package !== packageTransition.before
        || afterVersions.package !== packageTransition.after) {
      return failClosed("version-metadata-content-unverified");
    }

    const dockerTransition = versionOnlyTransition(repository, base, target, "Dockerfile");
    const pureDockerVersionChange = dockerTransition !== null
      && dockerTransition.before === packageTransition.before
      && dockerTransition.after === packageTransition.after;
    const remaining = changed.paths.filter((path) =>
      path !== "package.json"
        && path !== "src/lib/version.ts"
        && !(path === "Dockerfile" && pureDockerVersionChange));
    const other = planCiImpact(remaining, { baseKnown: true, gatesByFile });
    if (other.mode === "full") return other;
    return {
      ...other,
      candidate: remaining.length === 0 ? false : other.candidate,
      reason: `version-only:${other.reason}`,
    };
  } catch {
    return failClosed("impact-planner-error");
  }
}

const VERSION_PATTERN = /^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function versionNormalized(path, content) {
  if (path === "package.json") {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || typeof parsed.version !== "string" || !VERSION_PATTERN.test(parsed.version)) return null;
    const normalized = { ...parsed };
    delete normalized.version;
    return { version: parsed.version, normalized: JSON.stringify(sortJson(normalized)) };
  }

  if (path === "src/lib/version.ts") {
    const matches = [...content.matchAll(/(APP_VERSION\s*=\s*")([^"\r\n]+)("\s+as\s+const;)/gu)];
    if (matches.length !== 1 || !VERSION_PATTERN.test(matches[0]?.[2] ?? "")) return null;
    const match = matches[0];
    if (!match) return null;
    const prefix = match[1] ?? "";
    const version = match[2] ?? "";
    const suffix = match[3] ?? "";
    const start = match.index ?? 0;
    return {
      version,
      normalized: `${content.slice(0, start + prefix.length)}<VERSION>${content.slice(start + match[0].length - suffix.length)}`,
    };
  }

  if (path === "Dockerfile") {
    // Production 1.0.5 used a literal OCI label. Recognize its identity while
    // still treating the move to build arguments as an infrastructure change.
    const literal = [...content.matchAll(/org\.opencontainers\.image\.version="([^"]+)"/gu)];
    if (literal.length !== 1) return null;
    const entry = literal[0];
    if (entry && VERSION_PATTERN.test(entry[1] ?? "")) {
      const version = entry[1];
      const start = (entry.index ?? 0) + entry[0].indexOf(version);
      return { version, normalized: `${content.slice(0, start)}<VERSION>${content.slice(start + version.length)}` };
    }
    const argument = [...content.matchAll(/^ARG APP_VERSION="([^"]+)"$/gmu)];
    const labels = [...content.matchAll(/org\.opencontainers\.image\.version="\$\{APP_VERSION\}"/gu)];
    if (argument.length !== 1 || labels.length !== 1 || !VERSION_PATTERN.test(argument[0]?.[1] ?? "")) return null;
    const value = argument[0];
    if (!value) return null;
    const version = value[1] ?? "";
    const start = value.index ?? 0;
    const valueStart = start + value[0].indexOf(version);
    return {
      version,
      normalized: `${content.slice(0, valueStart)}<VERSION>${content.slice(valueStart + version.length)}`,
    };
  }
  return null;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

function gitText(repository, revision, path) {
  const result = spawnSync("git", ["show", `${revision}:${path}`], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") throw new Error("CI_IMPACT_VERSION_BLOB_UNREADABLE");
  return result.stdout;
}

function versionOnlyTransition(repository, base, target, path) {
  const before = versionNormalized(path, gitText(repository, base, path));
  const after = versionNormalized(path, gitText(repository, target, path));
  if (!before || !after || before.version === after.version || before.normalized !== after.normalized) return null;
  return { before: before.version, after: after.version };
}

function identityVersions(repository, revision) {
  const packageVersion = versionNormalized("package.json", gitText(repository, revision, "package.json"))?.version ?? null;
  const sourceVersion = versionNormalized("src/lib/version.ts", gitText(repository, revision, "src/lib/version.ts"))?.version ?? null;
  const dockerVersion = versionNormalized("Dockerfile", gitText(repository, revision, "Dockerfile"))?.version ?? null;
  return { package: packageVersion, source: sourceVersion, docker: dockerVersion };
}

function versionsAgree(versions) {
  return versions.package !== null
    && versions.package === versions.source
    && versions.package === versions.docker;
}

function coherentIdentityVersions(repository, base, target) {
  const before = identityVersions(repository, base);
  const after = identityVersions(repository, target);
  if (!versionsAgree(before) || !versionsAgree(after)) return false;
  return before.package === after.package;
}
