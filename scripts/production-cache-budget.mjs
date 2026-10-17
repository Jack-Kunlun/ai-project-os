import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseMaintenanceReport, sourceContext } from "./production-cache-maintenance.mjs";

export const CACHE_TARGET_BYTES = 2_000_000_000;
const PREFIX = "CACHE_MAINTENANCE_REPORT ";
const BUCKETS = ["privateReclaimable", "privateProtected", "sharedReclaimable", "sharedProtected"];
const TYPES = ["internal", "frontend", "source.local", "source.git.checkout", "source.http", "source.image", "exec.cachemount", "regular"];
const REASONS = {
  "builder-in-use": "BuildKit 标记不可回收（正在使用），保留",
  "shared-image-layer": "与镜像共享；缓存元数据大小不能视为可释放的镜像层空间",
  "appeared-after-plan": "检查后新出现，未纳入冻结计划",
  "changed-since-plan": "检查后内容或属性变化，保留至下次核对",
  "engine-retained-after-prune": "已按 ID 请求清理，但引擎仍保留",
  "within-budget": "已在目标内，无需继续清理",
  "inspection-only": "本次仅检查，未请求清理",
  "cleanup-incomplete": "清理未完成或未选择此记录，等待重新核对",
};

function requireValue(value, code) {
  if (!value) throw new Error(`CACHE_MAINTENANCE_${code}`);
}

function validatedInspect(value, context) {
  const report = parseMaintenanceReport(PREFIX + JSON.stringify(value), "inspect", context);
  const summary = Object.fromEntries(BUCKETS.flatMap((bucket) => [[`${bucket}Bytes`, 0], [`${bucket}Count`, 0]]));
  const ids = new Set();
  for (const item of report.records) {
    requireValue(item && typeof item.id === "string" && /^[a-z0-9][a-z0-9_:-]{0,127}$/u.test(item.id)
      && !ids.has(item.id) && TYPES.includes(item.type)
      && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0
      && ["estimated", "shared", "reclaimable", "mutable", "eligible"].every((key) => typeof item[key] === "boolean")
      && item.eligible === item.reclaimable
      && item.bucket === `${item.shared ? "shared" : "private"}${item.reclaimable ? "Reclaimable" : "Protected"}`,
    "BUDGET_RECORD_INVALID");
    ids.add(item.id);
    summary[`${item.bucket}Bytes`] += item.sizeBytes;
    summary[`${item.bucket}Count`] += 1;
  }
  requireValue(Object.entries(summary).every(([key, value]) => value === report.summary[key])
    && report.summary.estimated === report.records.some((item) => item.estimated), "BUDGET_INVENTORY_MISMATCH");
  const p = report.protection;
  requireValue([p.containerCount, p.volumeCount].every((value) => Number.isSafeInteger(value) && value > 0)
    && [p.containerSnapshotSha256, p.volumeSnapshotSha256, p.postgresId, p.previousRevision]
      .every((value, index) => new RegExp(`^[a-f0-9]{${index === 3 ? 40 : 64}}$`, "u").test(value ?? ""))
    && /^v[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(p.previousTag ?? "")
    && p.configHashes && !Array.isArray(p.configHashes) && Object.keys(p.configHashes).length > 0
    && Object.values(p.configHashes).every((value) => /^[a-f0-9]{64}$/u.test(value)), "BUDGET_PROTECTION_INVALID");
  return report;
}

function stableProtection(protection) {
  const rest = { ...protection };
  delete rest.planDigest;
  return rest;
}

export function buildCacheBudgetReport(initial, final, cleaned, context, mode = "release") {
  initial = validatedInspect(initial, context);
  final = validatedInspect(final, context);
  requireValue(isDeepStrictEqual(stableProtection(initial.protection), stableProtection(final.protection)), "BUDGET_PROTECTION_DRIFT");
  if (cleaned) {
    cleaned = parseMaintenanceReport(PREFIX + JSON.stringify(cleaned), "clean", context, initial.planDigest);
    requireValue(isDeepStrictEqual(stableProtection(initial.protection), stableProtection(cleaned.protection)), "BUDGET_PROTECTION_DRIFT");
  }
  const beforeIds = new Set(initial.records.map((item) => item.id));
  const retainedRecords = final.records.map((item) => {
    const reasons = [];
    if (!item.reclaimable) reasons.push("builder-in-use");
    else if (!beforeIds.has(item.id)) reasons.push("appeared-after-plan");
    else if (cleaned?.changedIds.includes(item.id)) reasons.push("changed-since-plan");
    else if (cleaned?.remainingIds.includes(item.id)) reasons.push("engine-retained-after-prune");
    else if (mode === "inspect") reasons.push("inspection-only");
    else if (!cleaned && initial.summary.sumRecordBytes <= CACHE_TARGET_BYTES) reasons.push("within-budget");
    else reasons.push("cleanup-incomplete");
    if (item.shared) reasons.push("shared-image-layer");
    return { id: item.id, type: item.type, sizeBytes: item.sizeBytes, estimated: item.estimated,
      shared: item.shared, reclaimable: item.reclaimable, mutable: item.mutable, reasons };
  });
  const bytes = final.summary.sumRecordBytes;
  const targetMet = final.summary.estimated ? null : bytes <= CACHE_TARGET_BYTES;
  return {
    schema: 1, operation: "cache-budget", tag: context.tag, revision: context.revision,
    targetBytes: CACHE_TARGET_BYTES, targetMet,
    status: targetMet === null ? "estimated" : targetMet ? "met" : "exceeded",
    withinNominalTarget: bytes <= CACHE_TARGET_BYTES, measuredAt: new Date().toISOString(),
    summaryBefore: initial.summary, summaryAfter: final.summary,
    protectedBytes: final.summary.privateProtectedBytes + final.summary.sharedProtectedBytes,
    reclaimableBytes: final.summary.privateReclaimableBytes + final.summary.sharedReclaimableBytes,
    cleanupAttempted: Boolean(cleaned), prunedIds: cleaned?.prunedIds ?? [],
    netAvailableBytesDelta: cleaned?.netAvailableBytesDelta ?? null,
    protectionVerified: true, protection: final.protection, retainedRecords,
    measurement: "default builder cache record sizes; shared layers may also belong to retained images; not physical reclaimable disk bytes",
  };
}

function failureCode(error) {
  return /^CACHE_MAINTENANCE_[A-Z0-9_]+$/u.test(error?.message ?? "") ? error.message : "CACHE_MAINTENANCE_BUDGET_FAILED";
}

export function parseCacheFailure(log, context, planDigest) {
  const lines = log.split(/\r?\n/u).filter((line) => line.startsWith("CACHE_MAINTENANCE_FAILURE "));
  requireValue(lines.length === 1, "BUDGET_FAILURE_REPORT_INVALID");
  const value = JSON.parse(lines[0].slice("CACHE_MAINTENANCE_FAILURE ".length));
  requireValue(value?.schema === 1 && value.operation === "clean" && value.status === "FAILED"
    && value.tag === context.tag && value.revision === context.revision && value.planDigest === planDigest
    && /^[a-f0-9]{64}$/u.test(planDigest ?? "") && /^[a-f0-9]{40}$/u.test(value.toolingRevision ?? "")
    && Number.isSafeInteger(value.completedAt) && value.completedAt > 0 && value.protectionVerified === false
    && /^STABLE_[A-Z0-9_]+$/u.test(value.failureCode ?? "")
    && Array.isArray(value.attemptedIds) && value.attemptedIds.length <= 2048
    && new Set(value.attemptedIds).size === value.attemptedIds.length
    && value.attemptedIds.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9_:-]{0,127}$/u.test(id)),
  "BUDGET_FAILURE_REPORT_INVALID");
  return { schema: 1, operation: "clean", status: "FAILED", tag: value.tag, revision: value.revision,
    planDigest: value.planDigest, toolingRevision: value.toolingRevision, completedAt: value.completedAt,
    attemptedIds: value.attemptedIds, failureCode: value.failureCode, protectionVerified: false };
}

// All effects are awaited in order. A failed cleanup still gets a final read, but cannot produce a verified result.
export async function runCacheBudgetMaintenance({ inspect, clean, context, mode = "release" }) {
  let initial; let cleaned; let final; let failure;
  try {
    requireValue(["release", "inspect", "clean"].includes(mode), "BUDGET_MODE_INVALID");
    initial = validatedInspect(await inspect("inspect"), context);
    const shouldClean = mode === "clean" || (mode === "release" && initial.summary.sumRecordBytes > CACHE_TARGET_BYTES);
    if (shouldClean && initial.records.some((item) => item.eligible)) {
      cleaned = await clean(initial.planDigest);
      parseMaintenanceReport(PREFIX + JSON.stringify(cleaned), "clean", context, initial.planDigest);
    }
  } catch (error) { failure = failureCode(error); }
  try { final = validatedInspect(await inspect("final"), context); }
  catch (error) { failure ??= failureCode(error); }
  try {
    if (failure) throw new Error(failure);
    return buildCacheBudgetReport(initial, final, cleaned, context, mode);
  } catch (error) {
    return { schema: 1, operation: "cache-budget", tag: context.tag, revision: context.revision,
      targetBytes: CACHE_TARGET_BYTES, targetMet: null, status: "unverified", protectionVerified: false,
      failureCode: failureCode(error), summaryAfter: final?.summary ?? null,
      measuredAt: new Date().toISOString() };
  }
}

export function budgetSummary(report) {
  const lines = ["### 发布后缓存目标验收", "", `版本：${report.tag} / ${report.revision}`,
    `目标：${CACHE_TARGET_BYTES} bytes（2 GB）；结果：${report.status}；targetMet=${report.targetMet}。`];
  if (!report.protectionVerified) return [...lines, `验收未完成：${report.failureCode}；不能确认目标或资源保护。`, ""].join("\n");
  lines.push(`实测记录大小之和：${report.summaryAfter.sumRecordBytes} bytes；估算：${report.summaryAfter.estimated}。`,
    `不可回收：${report.protectedBytes} bytes；仍可回收：${report.reclaimableBytes} bytes。`,
    `当前镜像 ${report.protection.currentImageIds.length} 个；上一版 ${report.protection.previousTag} 镜像 ${report.protection.previousImageIds.length} 个；数据卷 ${report.protection.volumeCount} 个；数据库账本 ${report.protection.migrationCount} 条。`,
    `实际删除缓存记录 ${report.prunedIds.length} 个；文件系统可用空间净变化 ${report.netAvailableBytesDelta ?? "未执行清理"} bytes。`,
    "缓存记录之和不等于可释放的物理磁盘空间；共享镜像层仍由保留镜像持有。数据卷、数据库、用户文件、备份不在删除范围内。",
    "", "| 缓存分类 | 数量 | bytes |", "| --- | ---: | ---: |");
  for (const bucket of BUCKETS) lines.push(`| ${bucket} | ${report.summaryAfter[`${bucket}Count`]} | ${report.summaryAfter[`${bucket}Bytes`]} |`);
  lines.push("", "| 保留缓存 ID | bytes | 原因 |", "| --- | ---: | --- |");
  for (const item of report.retainedRecords) lines.push(`| ${item.id} | ${item.sizeBytes} | ${item.reasons.map((reason) => REASONS[reason]).join("；")} |`);
  lines.push("", "共享标记无法证明具体属于哪个镜像；当前及上一版镜像身份、容器、数据卷、配置和数据库账本分别核验。", "");
  return lines.join("\n");
}

function saveReport(directory, report) {
  writeFileSync(resolve(directory, "budget.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const markdown = budgetSummary(report);
  writeFileSync(resolve(directory, "budget.md"), markdown, { mode: 0o600, flag: "wx" });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
  if (report.status !== "met") console.log(`::warning::CACHE_BUDGET_${report.status.toUpperCase()} target_bytes=${CACHE_TARGET_BYTES}; see budget.json and budget.md`);
  console.log(`CACHE_BUDGET_RESULT status=${report.status} target_met=${report.targetMet} bytes=${report.summaryAfter?.sumRecordBytes ?? "unknown"}`);
  if (report.status === "unverified") process.exitCode = 1;
}

function gateway(directory, identityDirectory, context) {
  function command(operation, digest, name) {
    const remote = operation === "inspect"
      ? `inspect-cache ${context.tag} ${context.revision} CONFIRM_CACHE_INSPECT`
      : `clean-cache ${context.tag} ${context.revision} ${digest}`;
    const result = spawnSync("ssh", ["-i", resolve(identityDirectory, "id_ed25519"),
      "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${resolve(identityDirectory, "known_hosts")}`,
      "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=45",
      `ai-project-os-actions@${process.env.PRODUCTION_SSH_HOST}`, remote],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: operation === "inspect" ? 180_000 : 900_000 });
    // Do not persist SSH stderr or raw provider/cache descriptions in artifacts.
    if (operation === "clean" && (result.status !== 0 || result.error)) {
      try {
        const failure = parseCacheFailure(result.stdout ?? "", context, digest);
        writeFileSync(resolve(directory, "clean-failure.json"), `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      } catch { /* Untrusted or incomplete stdout must not enter artifacts. */ }
    }
    requireValue(result.status === 0 && !result.error, "BUDGET_GATEWAY_FAILED");
    const value = parseMaintenanceReport(result.stdout, operation, context, digest);
    writeFileSync(resolve(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return value;
  }
  return { inspect: (name) => command("inspect", undefined, name), clean: (digest) => command("clean", digest, "clean") };
}

async function main(args) {
  requireValue(args.length === 1 && ["post-release", "maintenance-report"].includes(args[0]), "BUDGET_ARGUMENT_INVALID");
  const context = sourceContext();
  requireValue(typeof process.env.RUNNER_TEMP === "string" && process.env.RUNNER_TEMP.startsWith("/"), "BUDGET_TEMP_INVALID");
  const postRelease = args[0] === "post-release";
  const directory = resolve(process.env.RUNNER_TEMP, postRelease ? "release-cache-maintenance" : "cache-maintenance");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const client = gateway(directory, resolve(process.env.RUNNER_TEMP,
    postRelease ? "ai-project-os-stable-ssh" : "cache-maintenance-ssh"), context);
  if (postRelease) {
    requireValue(process.env.CACHE_MAINTENANCE_OPERATION === "cache-clean"
      && process.env.PRODUCTION_SOURCE_SHA === process.env.GITHUB_SHA
      && process.env.PRODUCTION_SOURCE_VERSION === process.env.RELEASE_VERSION, "BUDGET_RELEASE_CONTEXT_INVALID");
    saveReport(directory, await runCacheBudgetMaintenance({ ...client, context }));
  } else {
    let report;
    try {
      requireValue(["cache-inspect", "cache-clean"].includes(process.env.CACHE_MAINTENANCE_OPERATION), "OPERATION_INVALID");
      const initial = JSON.parse(readFileSync(resolve(directory, "inspect.json"), "utf8"));
      const cleaned = process.env.CACHE_MAINTENANCE_OPERATION === "cache-clean"
        ? JSON.parse(readFileSync(resolve(directory, "clean.json"), "utf8")) : undefined;
      report = buildCacheBudgetReport(initial, client.inspect("final"), cleaned, context,
        process.env.CACHE_MAINTENANCE_OPERATION === "cache-inspect" ? "inspect" : "clean");
    } catch (error) {
      report = { schema: 1, operation: "cache-budget", tag: context.tag, revision: context.revision,
        targetBytes: CACHE_TARGET_BYTES, targetMet: null, status: "unverified", protectionVerified: false,
        failureCode: failureCode(error), summaryAfter: null, measuredAt: new Date().toISOString() };
    }
    saveReport(directory, report);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(failureCode(error)); process.exitCode = 1; });
}
