"use client";

import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { AdminPageHeader } from "@/components/admin-page-header";
import { ParentPageLink } from "@/components/parent-page-link";
import { safeResponseError } from "@/lib/safe-error-presentation";
import type {
  BackupOperationsSnapshot,
  BackupRunState,
  BackupRunTrigger,
  PublicRecoveryDrill,
  PublicBackupRun,
} from "@/lib/system-operations-types";
import { RECOVERY_DRILL_FRESHNESS_THRESHOLD_MS, RECOVERY_DRILL_RUNBOOK_HREF } from "@/lib/system-operations-types";

const stateMetadata: Record<BackupRunState, Readonly<{ label: string; tone: string; dot: string }>> = {
  running: { label: "执行中", tone: "bg-indigo-50 text-indigo-700", dot: "animate-pulse bg-indigo-500" },
  succeeded: { label: "成功", tone: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  failed: { label: "失败", tone: "bg-rose-50 text-rose-700", dot: "bg-rose-500" },
  skipped: { label: "已跳过", tone: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
};

const triggerLabels: Record<BackupRunTrigger, string> = {
  daily: "每日计划",
  manual: "手动演练",
  "pre-deploy": "部署前门禁",
};

const recoveryDrillStatusMetadata: Record<PublicRecoveryDrill["status"], Readonly<{ label: string; tone: string }>> = {
  verified: { label: "已验证", tone: "bg-emerald-50 text-emerald-700" },
  failed: { label: "失败", tone: "bg-rose-50 text-rose-700" },
};

const recoveryDrillCheckLabels: Record<keyof PublicRecoveryDrill["checks"], string> = {
  pgRestore: "pg_restore 可解析",
  migrationLedger: "迁移账本",
  securityCounts: "安全计数",
  masterKeyVolume: "凭据主密钥卷",
  uploadsManifest: "uploads 清单",
  serviceHealth: "应用 / Worker 健康",
};

const safeFailureMessages: Readonly<Record<string, string>> = {
  BACKUP_COS_SIZE_MISMATCH: "COS 对象元数据在校验窗口内仍不可用。",
  BACKUP_COS_STAT_FAILED: "COS 对象状态查询失败。",
  BACKUP_COS_CRC64_MISSING: "COS 对象缺少完整性元数据。",
  BACKUP_STACK_NOT_FOUND: "生产容器栈不存在。",
  BACKUP_STACK_SERVICE_INVALID: "生产服务实例数量不符合预期。",
  BACKUP_STACK_SERVICE_NOT_HEALTHY: "生产服务未处于健康状态。",
  BACKUP_WRITER_HEALTH_TIMEOUT: "应用写入者恢复健康超时。",
  BACKUP_INSUFFICIENT_SPACE: "服务器可用磁盘空间不足。",
  BACKUP_DEPLOYMENT_IN_PROGRESS: "部署锁在等待窗口内未释放。",
  BACKUP_ALREADY_RUNNING: "另一项备份任务仍在执行。",
  BACKUP_UNEXPECTED_FAILURE: "任务发生未分类的安全失败。",
};

function formatDate(value: string | null): string {
  if (value === null) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatDuration(value: number | null): string {
  if (value === null) return "执行中";
  if (value < 60) return `${value} 秒`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

function formatBytes(value: number | null): string {
  if (value === null) return "暂无";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function failureMessage(run: PublicBackupRun): string | null {
  if (run.errorCode === null) return null;
  return safeFailureMessages[run.errorCode] ?? "任务执行失败，请根据安全错误码检查服务器日志。";
}

export function SystemOperationsClient({
  username,
  initialSnapshot,
  adminMode = false,
}: {
  username: string;
  initialSnapshot: BackupOperationsSnapshot;
  adminMode?: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (showProgress = true) => {
    if (showProgress) setRefreshing(true);
    try {
      const response = await fetch("/api/system/operations/backups", { cache: "no-store" });
      if (!response.ok) throw new Error((await safeResponseError(response, "生产备份状态读取失败")).message);
      setSnapshot(await response.json() as BackupOperationsSnapshot);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "生产备份状态读取失败");
    } finally {
      if (showProgress) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(false), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const current = snapshot.current;
  const currentMeta = current ? stateMetadata[current.state] : null;
  const sourceNotice = snapshot.sourceStatus === "not_configured"
    ? "应用尚未挂载服务器的脱敏备份状态目录。完成生产安装与下一次部署后，这里会开始显示记录。"
    : snapshot.sourceStatus === "invalid"
      ? "服务器状态文件未通过格式或安全校验，原始内容不会展示。"
      : null;

  return (
    <OperationsFrame adminMode={adminMode} username={username}>
      <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
        {!adminMode ? <div className="mb-4"><ParentPageLink href="/profile" label="返回个人中心" /></div> : null}
        <AdminPageHeader title="生产备份与 COS 同步" description="查看每日、手动和部署前备份的脱敏执行状态；页面不能启动、删除或恢复备份，也不能访问 COS 密钥、age 私钥、Docker 或 systemd。" actions={<button type="button" onClick={() => void refresh()} disabled={refreshing} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60">{refreshing ? "刷新中…" : "刷新状态"}</button>} />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs"><span className="rounded-full bg-amber-50 px-3 py-1.5 font-semibold text-amber-700">仅初始超级管理员</span><span className="rounded-full bg-slate-100 px-3 py-1.5 font-semibold text-slate-600">只读</span></div>

        {error ? <div role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        {sourceNotice ? <div role="status" className={`mt-6 rounded-2xl border px-5 py-4 text-sm ${snapshot.sourceStatus === "invalid" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{sourceNotice}</div> : null}

        <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="备份任务概览">
          <Metric label="当前状态" value={currentMeta?.label ?? "暂无记录"} detail={current ? triggerLabels[current.trigger] : "等待首次状态发布"} />
          <Metric label="最近耗时" value={formatDuration(current?.durationSeconds ?? null)} detail={current?.completedAt ? `完成于 ${formatDate(current.completedAt)}` : "任务结束后记录"} />
          <Metric label="加密归档" value={formatBytes(current?.archiveBytes ?? null)} detail={current?.archiveSha256 ? `SHA-256 ${current.archiveSha256.slice(0, 12)}…` : "尚无已校验归档"} />
          <Metric label="下次计划" value={current?.nextRunAt ? formatDate(current.nextRunAt) : `${snapshot.schedule.localTime}–03:40`} detail={`每日随机延迟不超过 ${snapshot.schedule.randomizedDelayMinutes} 分钟`} />
        </section>

        <section className="mt-6 overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-6 py-6 sm:px-7">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Current run</p>
              <h2 className="mt-2 text-xl font-semibold">最近一次任务</h2>
            </div>
            {currentMeta ? <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${currentMeta.tone}`}><span className={`h-2.5 w-2.5 rounded-full ${currentMeta.dot}`} />{currentMeta.label}</span> : null}
          </div>
          {current ? <CurrentRun run={current} /> : <div className="px-6 py-14 text-center text-sm text-slate-500">服务器尚未发布备份任务状态。</div>}
        </section>

        <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Execution history</p>
              <h2 className="mt-2 text-xl font-semibold">最近执行记录</h2>
              <p className="mt-2 text-xs leading-5 text-slate-500">最多读取 30 条经过格式校验的脱敏状态，不读取原始 journal。</p>
            </div>
            <span className="text-xs text-slate-400">读取于 {formatDate(snapshot.readAt)}</span>
          </div>
          <div className="mt-5 space-y-3">
            {snapshot.history.length === 0 ? <div className="rounded-2xl bg-slate-50 px-5 py-10 text-center text-sm text-slate-500">还没有已完成的历史任务。</div> : snapshot.history.map((run) => <HistoryRun key={run.runId} run={run} />)}
          </div>
        </section>

        <RecoveryDrillPanel drill={snapshot.recoveryDrill} sourceStatus={snapshot.recoveryDrillSourceStatus} />

        <section className="mt-6 rounded-3xl border border-indigo-100 bg-indigo-50/70 px-6 py-5 text-sm leading-6 text-indigo-950">
          <h2 className="font-semibold">只读安全边界</h2>
          <p className="mt-1 text-indigo-800">备份服务只向专用目录原子写入状态、时间、对象路径、大小、校验摘要和安全错误码；应用仅以只读挂载读取该目录。任何控制操作仍必须在服务器受限流程中执行。</p>
        </section>
      </div>
    </OperationsFrame>
  );
}

function OperationsFrame({ adminMode, username, children }: { adminMode: boolean; username: string; children: React.ReactNode }) {
  if (adminMode) return <>{children}</>;
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AppHeader username={username} active="profile" /><AdminPageFrame active="operations" showSidebar={false}>{children}</AdminPageFrame></main>;
}

function recoveryDrillFreshness(completedAt: string, now = Date.now()): "fresh" | "stale" | "unknown" {
  const timestamp = Date.parse(completedAt);
  if (!Number.isFinite(timestamp) || timestamp > now) return "unknown";
  return now - timestamp <= RECOVERY_DRILL_FRESHNESS_THRESHOLD_MS ? "fresh" : "stale";
}

function RecoveryDrillPanel({ drill, sourceStatus }: { drill: PublicRecoveryDrill | null; sourceStatus: BackupOperationsSnapshot["recoveryDrillSourceStatus"] }) {
  const metadata = drill ? recoveryDrillStatusMetadata[drill.status] : null;
  const freshness = drill ? recoveryDrillFreshness(drill.completedAt) : "unknown";
  const checks = drill ? Object.entries(drill.checks) as Array<[keyof PublicRecoveryDrill["checks"], PublicRecoveryDrill["checks"][keyof PublicRecoveryDrill["checks"]]]> : [];
  return <section id="recovery-drill" className="mt-6 overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm" aria-labelledby="recovery-drill-title">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-6 py-6 sm:px-7">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Recovery drill</p>
        <h2 id="recovery-drill-title" className="mt-2 text-xl font-semibold">恢复演练证据</h2>
        <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-500">恢复演练与备份任务完全独立；备份成功不会推断可恢复。本机隔离演练不等同生产异地主机恢复。</p>
      </div>
      {metadata ? <span className={`inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold ${metadata.tone}`}>{metadata.label}</span> : <span className={`inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold ${sourceStatus === "invalid" ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{sourceStatus === "invalid" ? "读取失败" : "未取得"}</span>}
    </div>
    {drill === null ? <div className="px-6 py-10 text-sm text-slate-500 sm:px-7">{sourceStatus === "invalid" ? "恢复演练状态文件未通过安全校验，原始内容不会展示。" : "尚未取得独立恢复演练证据；不能以备份任务成功替代恢复验证。"}</div> : <>
      <div className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-4">
        <RunDetail label="环境" value={drill.environment === "local" ? "本机隔离" : "生产异地主机"} />
        <RunDetail label="作用域" value={drill.scope} mono />
        <RunDetail label="完成时间" value={formatDate(drill.completedAt)} />
        <RunDetail label="证据新鲜度" value={freshness === "fresh" ? "新鲜" : freshness === "stale" ? "陈旧" : "未知"} />
        <RunDetail label="演练 ID" value={drill.drillId} mono />
        <RunDetail label="持续时间" value={`${drill.durationSeconds} 秒`} />
        <RunDetail label="迁移数" value={String(drill.migrationCount)} />
        <RunDetail label="验证摘要 SHA-256" value={drill.validationSha256 ?? "尚未生成"} mono />
        <RunDetail label="源快照" value={drill.sourceArtifact?.name ?? "尚未绑定"} mono />
        <RunDetail label="源快照类型" value={drill.sourceArtifact?.kind ?? "尚未绑定"} mono />
        <RunDetail label="源快照 SHA-256" value={drill.sourceArtifact?.sha256 ?? "尚未绑定"} mono />
        <dl className="min-w-0 bg-white px-5 py-4 sm:col-span-2"><dt className="text-xs font-semibold text-slate-400">固定检查</dt><dd className="mt-2 grid gap-2 sm:grid-cols-2">{checks.map(([key, state]) => <span key={key} className={`rounded-lg px-3 py-2 text-xs font-semibold ${state === "passed" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{recoveryDrillCheckLabels[key]}：{state === "passed" ? "通过" : "失败"}</span>)}</dd></dl>
        {drill.errorCode ? <div className="bg-rose-50 px-5 py-4 sm:col-span-2 lg:col-span-4"><p className="text-xs font-semibold text-rose-800">{drill.errorCode}</p><p className="mt-1 text-xs text-rose-700">恢复演练未通过，安全错误码是唯一公开失败原因。</p></div> : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-6 py-5 sm:px-7"><p className="text-xs leading-5 text-slate-500">验证结果仅证明当前记录的固定检查；生产恢复仍需独立空主机、窗口和证据。</p><a href={RECOVERY_DRILL_RUNBOOK_HREF} className="inline-flex rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700">打开恢复演练 Runbook</a></div>
    </>}
  </section>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-2 break-words text-xl font-semibold tracking-tight">{value}</p><p className="mt-3 text-xs leading-5 text-slate-400">{detail}</p></article>;
}

function CurrentRun({ run }: { run: PublicBackupRun }) {
  const message = failureMessage(run);
  return <div className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-4"><RunDetail label="触发方式" value={`${triggerLabels[run.trigger]}${run.targetTag ? ` · ${run.targetTag}` : ""}`} /><RunDetail label="开始时间" value={formatDate(run.startedAt)} /><RunDetail label="完成时间" value={formatDate(run.completedAt)} /><RunDetail label="远端校验尝试" value={`${run.verificationAttempts} 次`} /><RunDetail label="备份集合" value={run.backupName ?? "尚未生成"} mono /><RunDetail label="清理本地旧备份" value={`${run.retentionRemoved} 份`} /><RunDetail label="SHA-256" value={run.archiveSha256 ?? "尚未生成"} mono /><RunDetail label="运行 ID" value={run.runId} mono />{run.archiveObject ? <dl className="bg-white px-5 py-4 sm:col-span-2 lg:col-span-4"><dt className="text-xs font-semibold text-slate-400">COS 对象</dt><dd className="mt-2 break-all font-mono text-xs leading-5 text-slate-600">{run.archiveObject}</dd></dl> : null}{message ? <div className="bg-rose-50 px-5 py-4 sm:col-span-2 lg:col-span-4"><p className="text-xs font-semibold text-rose-800">{run.errorCode}</p><p className="mt-1 text-sm text-rose-700">{message}</p></div> : null}</div>;
}

function RunDetail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <dl className="min-w-0 bg-white px-5 py-4"><dt className="text-xs font-semibold text-slate-400">{label}</dt><dd className={`mt-2 break-words text-sm text-slate-700 ${mono ? "font-mono text-xs" : "font-medium"}`}>{value}</dd></dl>;
}

function HistoryRun({ run }: { run: PublicBackupRun }) {
  const metadata = stateMetadata[run.state];
  const message = failureMessage(run);
  return <article className="rounded-2xl border border-slate-200 px-5 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-slate-800">{triggerLabels[run.trigger]}{run.targetTag ? ` · ${run.targetTag}` : ""}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${metadata.tone}`}>{metadata.label}</span></div><p className="mt-2 text-xs text-slate-500">{formatDate(run.startedAt)} · {formatDuration(run.durationSeconds)} · {formatBytes(run.archiveBytes)}</p></div><p className="font-mono text-[12px] text-slate-400">{run.runId}</p></div>{message ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700"><strong>{run.errorCode}</strong> · {message}</p> : null}</article>;
}
