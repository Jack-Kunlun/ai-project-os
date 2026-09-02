"use client";

import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import type {
  BackupOperationsSnapshot,
  BackupRunState,
  BackupRunTrigger,
  PublicBackupRun,
} from "@/lib/system-operations-types";

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

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

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
}: {
  username: string;
  initialSnapshot: BackupOperationsSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (showProgress = true) => {
    if (showProgress) setRefreshing(true);
    try {
      const response = await fetch("/api/system/operations/backups", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "生产备份状态读取失败"));
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
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={username} active="profile" />
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10 lg:pt-10">
        <section className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-7 py-8 text-white shadow-2xl shadow-slate-950/15 sm:px-10 sm:py-10">
          <div className="absolute -right-16 -top-20 h-64 w-64 rounded-full bg-indigo-500/25 blur-3xl" />
          <div className="relative flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">System operations</p>
                <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold text-slate-200">仅初始超级管理员</span>
                <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-semibold text-slate-200">只读</span>
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">生产备份与 COS 同步</h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">查看每日、手动和部署前备份的脱敏执行状态。页面不能启动、删除或恢复备份，也不能访问 COS 密钥、age 私钥、Docker 或 systemd。</p>
            </div>
            <button type="button" onClick={() => void refresh()} disabled={refreshing} className="flex min-h-11 items-center justify-center rounded-xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-50 disabled:opacity-60">
              {refreshing ? "刷新中…" : "刷新状态"}
            </button>
          </div>
        </section>

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

        <section className="mt-6 rounded-3xl border border-indigo-100 bg-indigo-50/70 px-6 py-5 text-sm leading-6 text-indigo-950">
          <h2 className="font-semibold">只读安全边界</h2>
          <p className="mt-1 text-indigo-800">备份服务只向专用目录原子写入状态、时间、对象路径、大小、校验摘要和安全错误码；应用仅以只读挂载读取该目录。任何控制操作仍必须在服务器受限流程中执行。</p>
        </section>
      </div>
    </main>
  );
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
  return <article className="rounded-2xl border border-slate-200 px-5 py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-slate-800">{triggerLabels[run.trigger]}{run.targetTag ? ` · ${run.targetTag}` : ""}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${metadata.tone}`}>{metadata.label}</span></div><p className="mt-2 text-xs text-slate-500">{formatDate(run.startedAt)} · {formatDuration(run.durationSeconds)} · {formatBytes(run.archiveBytes)}</p></div><p className="font-mono text-[11px] text-slate-400">{run.runId}</p></div>{message ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700"><strong>{run.errorCode}</strong> · {message}</p> : null}</article>;
}
