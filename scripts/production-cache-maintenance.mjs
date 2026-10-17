import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareStableVersions, healthyProductionPayload, validateSshHost } from "./production-stable-release.mjs";

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const VERSION = /^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PREFIX = "CACHE_MAINTENANCE_REPORT ";
const BUCKETS = ["privateReclaimable", "privateProtected", "sharedReclaimable", "sharedProtected"];

function requireValue(value, code) {
  if (!value) throw new Error(`CACHE_MAINTENANCE_${code}`);
}

export function sourceContext(env = process.env) {
  requireValue(env.GITHUB_REPOSITORY === "Jack-Kunlun/ai-project-os"
    && env.GITHUB_REF === "refs/heads/main" && SHA.test(env.GITHUB_SHA ?? ""), "MAIN_CONTEXT_INVALID");
  requireValue(["cache-inspect", "cache-clean"].includes(env.CACHE_MAINTENANCE_OPERATION), "OPERATION_INVALID");
  requireValue(VERSION.test(env.PRODUCTION_SOURCE_VERSION ?? "")
    && SHA.test(env.PRODUCTION_SOURCE_SHA ?? "") && VERSION.test(env.RELEASE_VERSION ?? ""), "SOURCE_INVALID");
  const transition = compareStableVersions(env.RELEASE_VERSION, env.PRODUCTION_SOURCE_VERSION);
  requireValue(transition > 0 || (transition === 0 && env.GITHUB_SHA === env.PRODUCTION_SOURCE_SHA), "TOOLING_VERSION_NOT_FORWARD");
  validateSshHost(env.PRODUCTION_SSH_HOST);
  return {
    tag: `v${env.PRODUCTION_SOURCE_VERSION}`, revision: env.PRODUCTION_SOURCE_SHA,
    version: env.PRODUCTION_SOURCE_VERSION, migrationCount: Number(env.SOURCE_MIGRATION_COUNT),
  };
}

function safeCount(value) { return Number.isSafeInteger(value) && value >= 0; }

function validateSummary(value) {
  requireValue(value?.builder === "default" && safeCount(value.recordCount)
    && value.recordCount <= 2048 && safeCount(value.sumRecordBytes)
    && typeof value.estimated === "boolean", "SUMMARY_INVALID");
  for (const bucket of BUCKETS) {
    requireValue(safeCount(value[`${bucket}Bytes`]) && safeCount(value[`${bucket}Count`]), "SUMMARY_INVALID");
  }
  requireValue(BUCKETS.reduce((sum, key) => sum + value[`${key}Bytes`], 0) === value.sumRecordBytes
    && BUCKETS.reduce((sum, key) => sum + value[`${key}Count`], 0) === value.recordCount, "SUMMARY_TOTAL_INVALID");
}

function validateImageIds(values) {
  return Array.isArray(values) && values.length > 0 && values.length <= 1024
    && new Set(values).size === values.length && values.every((value) => typeof value === "string" && IMAGE.test(value));
}

export function parseMaintenanceReport(log, operation, context, expectedPlanDigest) {
  requireValue(typeof log === "string" && Buffer.byteLength(log) <= 2 * 1024 * 1024, "LOG_INVALID");
  const lines = log.split(/\r?\n/u).filter((line) => line.startsWith(PREFIX));
  requireValue(lines.length === 1, "REPORT_COUNT_INVALID");
  let value;
  try { value = JSON.parse(lines[0].slice(PREFIX.length)); } catch { throw new Error("CACHE_MAINTENANCE_REPORT_JSON_INVALID"); }
  requireValue(value?.schema === 1 && value.operation === operation && value.tag === context.tag
    && value.revision === context.revision && DIGEST.test(value.planDigest ?? ""), "REPORT_IDENTITY_INVALID");
  const protection = value.protection;
  requireValue(protection && validateImageIds(protection.currentImageIds)
    && validateImageIds(protection.previousImageIds) && validateImageIds(protection.ownedImageIds)
    && protection.currentImageIds.every((id) => protection.ownedImageIds.includes(id))
    && protection.previousImageIds.every((id) => protection.ownedImageIds.includes(id))
    && protection.ownedImageCount === protection.ownedImageIds.length
    && protection.checkoutRevision === context.revision
    && protection.migrationCount === context.migrationCount
    && Number.isSafeInteger(context.migrationCount) && context.migrationCount >= 143
    && DIGEST.test(protection.migrationManifestSha256 ?? "")
    && DIGEST.test(protection.deploymentReceiptSha256 ?? "")
    && protection.planDigest === value.planDigest, "PROTECTION_INVALID");
  if (operation === "inspect") {
    validateSummary(value.summary);
    requireValue(Array.isArray(value.records) && value.records.length === value.summary.recordCount, "INVENTORY_INVALID");
  } else {
    requireValue(operation === "clean" && DIGEST.test(expectedPlanDigest ?? "")
      && value.planDigest === expectedPlanDigest && value.protectionVerified === true, "CLEAN_PLAN_INVALID");
    validateSummary(value.summaryBefore);
    validateSummary(value.summaryAfter);
    requireValue(["localHealth", "publicHealth", "database", "worker", "migrationLedger"]
      .every((key) => value.checks?.[key] === true), "HEALTH_CHECK_FAILED");
    requireValue(safeCount(value.availableBytesBefore) && safeCount(value.availableBytesAfter)
      && Number.isSafeInteger(value.netAvailableBytesDelta)
      && value.netAvailableBytesDelta === value.availableBytesAfter - value.availableBytesBefore, "DISK_DELTA_INVALID");
    requireValue(["prunedIds", "remainingIds", "newlyProtectedIds", "newlyAppearedIds", "changedIds", "vanishedIds"]
      .every((key) => Array.isArray(value[key]) && value[key].every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9_:-]{0,127}$/u.test(id))), "CLEAN_IDS_INVALID");
  }
  return value;
}

function writeEnv(values) {
  requireValue(typeof process.env.GITHUB_ENV === "string" && process.env.GITHUB_ENV.length > 0, "ENV_FILE_REQUIRED");
  appendFileSync(process.env.GITHUB_ENV, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function writeSummary(report) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const summary = report.operation === "inspect" ? report.summary : report.summaryAfter;
  const gb = (bytes) => (bytes / 1_000_000_000).toFixed(3);
  const lines = [`### 生产缓存${report.operation === "inspect" ? "检查" : "清理"}`, "",
    `运行版本：${report.tag} / ${report.revision}`, "",
    "| 缓存记录分类 | 数量 | 记录标称大小（GB） |", "| --- | ---: | ---: |"];
  for (const bucket of BUCKETS) lines.push(`| ${bucket} | ${summary[`${bucket}Count`]} | ${gb(summary[`${bucket}Bytes`])} |`);
  lines.push("", `记录大小之和：${gb(summary.sumRecordBytes)} GB；此值不等于可释放的物理磁盘空间。`);
  if (report.operation === "clean") {
    lines.push(`删除缓存记录：${report.prunedIds.length}；文件系统可用空间净变化：${report.netAvailableBytesDelta} bytes。`,
      `当前镜像 ${report.protection.currentImageIds.length} 个、上一版镜像 ${report.protection.previousImageIds.length} 个；保护校验通过。`);
  }
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n\n`);
}

async function main(args) {
  const context = sourceContext();
  if (args.length === 1 && args[0] === "prepare") {
    writeEnv({ CACHE_CURRENT_TAG: context.tag, CACHE_CURRENT_REVISION: context.revision });
    console.log(`CACHE_MAINTENANCE_SOURCE_VERIFIED tag=${context.tag} revision=${context.revision}`);
    return;
  }
  if (args.length === 2 && args[0] === "health") {
    const response = await fetch("https://ai-project-os.com/api/health", { redirect: "error", signal: AbortSignal.timeout(20_000) });
    requireValue(response.status === 200, "PUBLIC_HEALTH_HTTP_INVALID");
    const payload = await response.json();
    healthyProductionPayload(payload, context.version);
    writeFileSync(args[1], `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    console.log(`CACHE_MAINTENANCE_PUBLIC_HEALTH_OK version=${context.version}`);
    return;
  }
  requireValue(args.length === 3 && ["parse-inspect", "parse-clean"].includes(args[0]), "ARGUMENTS_INVALID");
  const operation = args[0] === "parse-inspect" ? "inspect" : "clean";
  const log = readFileSync(args[1], "utf8");
  const report = parseMaintenanceReport(log, operation, context, process.env.CACHE_PLAN_DIGEST);
  writeFileSync(args[2], `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (operation === "inspect") writeEnv({ CACHE_PLAN_DIGEST: report.planDigest });
  writeSummary(report);
  console.log(`CACHE_MAINTENANCE_REPORT_VERIFIED operation=${operation} tag=${context.tag} revision=${context.revision}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const code = /^CACHE_MAINTENANCE_[A-Z0-9_]+$/u.test(error?.message ?? "") ? error.message : "CACHE_MAINTENANCE_FAILED";
    console.error(code);
    process.exitCode = 1;
  });
}
