import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const zeroSha = /^0{40}$/u;
const sha = /^[0-9a-f]{40}$/u;
const presentationOnly = [
  /^src\/(?:.+\/)?[^/]+\.css$/u,
  /^public\/(?:.+\/)?[^/]+\.(?:png|jpg|jpeg|webp|ico)$/u,
];

export function needsDatabaseGates(paths, versionOnly = false) {
  return needsCoverage(paths, versionOnly);
}

export function needsCoverage(paths, versionOnly = false) {
  return (paths.length === 0 && !versionOnly) || paths.some((path) => !presentationOnly.some((pattern) => pattern.test(path)));
}

export function isVersionOnlyPackageChange(before, after) {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return false;
  const oldVersion = before.version;
  const newVersion = after.version;
  const pattern = /^0\.6\.0-dev\.([1-9][0-9]*)$/u;
  const oldMatch = typeof oldVersion === "string" ? pattern.exec(oldVersion) : null;
  const newMatch = typeof newVersion === "string" ? pattern.exec(newVersion) : null;
  if (!oldMatch || !newMatch || BigInt(oldMatch[1]) < 8n || BigInt(newMatch[1]) > 999999n || BigInt(newMatch[1]) <= BigInt(oldMatch[1])) return false;
  const oldRest = { ...before };
  const newRest = { ...after };
  delete oldRest.version;
  delete newRest.version;
  return isDeepStrictEqual(oldRest, newRest);
}

function versionOnlyPackageChange(base, head) {
  try {
    const before = JSON.parse(execFileSync("git", ["show", `${base}:package.json`], { encoding: "utf8" }));
    const after = JSON.parse(execFileSync("git", ["show", `${head}:package.json`], { encoding: "utf8" }));
    return isVersionOnlyPackageChange(before, after);
  } catch {
    return false;
  }
}

export function changedPaths(base, head) {
  if (!sha.test(base) || !sha.test(head) || zeroSha.test(base) || base === head) {
    return null;
  }
  try {
    execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { stdio: "ignore" });
    execFileSync("git", ["cat-file", "-e", `${head}^{commit}`], { stdio: "ignore" });
    const diff = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, head], { encoding: "utf8" });
    return diff.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1]?.endsWith("ci-change-scope.mjs")) {
  const paths = changedPaths(process.env.CI_BASE_SHA ?? "", process.env.CI_HEAD_SHA ?? "");
  const versionOnly = paths?.includes("package.json") && versionOnlyPackageChange(process.env.CI_BASE_SHA, process.env.CI_HEAD_SHA);
  const effectivePaths = versionOnly ? paths.filter((path) => path !== "package.json") : paths;
  const database = effectivePaths === null || needsDatabaseGates(effectivePaths, versionOnly);
  const coverage = effectivePaths === null || needsCoverage(effectivePaths, versionOnly);
  const output = `database=${database}\ncoverage=${coverage}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, output);
  }
  process.stdout.write(`CI_CHANGE_SCOPE database=${database} coverage=${coverage} files=${paths?.length ?? "unknown"}\n`);
}
