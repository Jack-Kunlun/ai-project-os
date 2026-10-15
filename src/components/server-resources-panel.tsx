"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { safeResponseError } from "@/lib/safe-error-presentation";
import type { ServerFilesystemMetric, ServerResourcesSnapshot } from "@/lib/server-resources-types";

const FIVE_GIBIBYTES = 5 * 1024 * 1024 * 1024;

function formatBytes(value: number | null): string {
  if (value === null) return "不可读取";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatCount(value: number | null): string {
  return value === null ? "不可读取" : new Intl.NumberFormat("zh-CN").format(value);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function tone(percent: number | null, availableBytes: number | null, warnForLowSpace = true): "normal" | "warning" | "danger" {
  if (warnForLowSpace && availableBytes !== null && availableBytes < FIVE_GIBIBYTES) return "danger";
  if (percent !== null && percent >= 90) return "danger";
  if (percent !== null && percent >= 80) return "warning";
  return "normal";
}

const toneClasses = {
  normal: { badge: "bg-emerald-50 text-emerald-700", bar: "bg-emerald-500" },
  warning: { badge: "bg-amber-50 text-amber-800", bar: "bg-amber-500" },
  danger: { badge: "bg-rose-50 text-rose-700", bar: "bg-rose-500" },
} as const;

function reasonText(reason: string | null): string {
  switch (reason) {
    case "NOT_LINUX": return "当前运行环境不是 Linux。";
    case "NOT_DOCKER": return "未检测到 Docker 容器环境。";
    case "CGROUP_MAPPING_UNCERTAIN": return "无法确认当前容器 cgroup 根目录映射。";
    case "SOURCE_UNAVAILABLE": return "运行环境未提供该指标。";
    case "INVALID_SOURCE": return "指标来源格式不符合预期。";
    case "OUT_OF_SAFE_RANGE": return "容量超出安全数值范围，避免显示不精确结果。";
    default: return "尚未取得指标。";
  }
}

export function ServerResourcesPanel() {
  const [snapshot, setSnapshot] = useState<ServerResourcesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const hasSnapshot = useRef(false);
  const mounted = useRef(false);
  const activeController = useRef<AbortController | null>(null);
  const containerLevel = snapshot?.containerMemory.status === "available"
    ? tone(snapshot.containerMemory.usedPercent, null, false)
    : null;

  const refresh = useCallback(async (showProgress = true) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    activeController.current = controller;
    const isCurrentRequest = () => mounted.current && activeController.current === controller && !controller.signal.aborted;
    if (showProgress) {
      if (!hasSnapshot.current) setLoading(true);
      else setRefreshing(true);
    }
    try {
      const response = await fetch("/api/system/operations/resources", { cache: "no-store", signal: controller.signal });
      if (!isCurrentRequest()) return;
      if (!response.ok) {
        const responseError = await safeResponseError(response, "服务器资源读取失败");
        if (!isCurrentRequest()) return;
        throw new Error(responseError.message);
      }
      const nextSnapshot = await response.json() as ServerResourcesSnapshot;
      if (!isCurrentRequest()) return;
      setSnapshot(nextSnapshot);
      hasSnapshot.current = true;
      setError(null);
    } catch (cause) {
      if (isCurrentRequest()) setError(cause instanceof Error ? cause.message : "服务器资源读取失败");
    } finally {
      if (activeController.current === controller) {
        activeController.current = null;
        inFlight.current = false;
        if (mounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const initialTimer = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(false);
    }, 30_000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refresh(false);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      mounted.current = false;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      activeController.current?.abort();
      activeController.current = null;
      inFlight.current = false;
    };
  }, [refresh]);

  return (
    <section className="mb-7 overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm" aria-labelledby="server-resources-title">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 px-5 py-5 sm:px-7">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Server resources</p>
          <h2 id="server-resources-title" className="mt-2 text-xl font-semibold">服务器资源</h2>
          <p className="mt-2 max-w-4xl text-xs leading-5 text-slate-500">只读监控，每 30 秒更新一次。内存显示 Linux 内核报告值；磁盘只统计应用部署目录和上传存储目录各自所属的文件系统。</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading || refreshing} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60">
          {loading || refreshing ? "刷新中…" : "刷新资源"}
        </button>
      </div>

      <div className="px-5 py-5 sm:px-7">
        {error ? <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}{snapshot ? ` 保留上次读取的数据（${formatTime(snapshot.readAt)}），当前数据可能已过期。` : " 暂无可展示的读取结果。"}</div> : null}
        {loading && snapshot === null ? <p role="status" className="py-8 text-center text-sm text-slate-500">正在读取服务器资源…</p> : null}
        {snapshot ? <>
          <p className="mb-4 text-xs text-slate-400">采集于 {formatTime(snapshot.readAt)}{refreshing ? " · 正在刷新" : ""}</p>
          <div className="grid gap-4 xl:grid-cols-3">
            <MemoryCard snapshot={snapshot} />
            {snapshot.filesystems.map((filesystem) => <FilesystemCard key={filesystem.scope} filesystem={filesystem} />)}
          </div>
          <div className="mt-4 grid gap-3 rounded-2xl bg-slate-50 px-4 py-4 sm:grid-cols-2">
            <div>
              <div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold text-slate-500">Docker 容器内存</p>{snapshot.containerMemory.status === "available" ? <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${containerLevel ? toneClasses[containerLevel].badge : "bg-slate-100 text-slate-600"}`}>{snapshot.containerMemory.limitBytes === null ? "未设置上限" : containerLevel === "danger" ? "告警" : containerLevel === "warning" ? "注意" : "正常"}</span> : null}</div>
              {snapshot.containerMemory.status === "available"
                ? <p className="mt-1 text-sm font-semibold text-slate-800">当前 {formatBytes(snapshot.containerMemory.currentBytes)} / {snapshot.containerMemory.limitBytes === null ? "未设置上限" : `上限 ${formatBytes(snapshot.containerMemory.limitBytes)}${snapshot.containerMemory.usedPercent === null ? " · 占用率不可计算" : ` · ${snapshot.containerMemory.usedPercent.toFixed(1)}%`}`}</p>
                : <p className="mt-1 text-xs text-slate-500">不可读取：{reasonText(snapshot.containerMemory.unavailableReason)}</p>}
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500">应用进程 RSS</p>
              <p className="mt-1 text-sm font-semibold text-slate-800">{formatBytes(snapshot.applicationProcess.rssBytes)}</p>
              <p className="mt-1 text-xs text-slate-500">仅表示当前 Node.js 应用进程常驻内存，不代表主机或整个容器。</p>
            </div>
          </div>
          {snapshot.filesystemRelation === "same" ? <p role="note" className="mt-3 rounded-xl bg-indigo-50 px-4 py-3 text-xs leading-5 text-indigo-800">应用目录和上传目录位于同一文件系统；上方两张磁盘卡片显示的是同一容量，请勿相加。</p> : null}
          {snapshot.filesystemRelation === "different" ? <p role="note" className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">应用目录和上传目录所属文件系统标识不同；采集不能确认它们是否共享底层物理存储，卡片容量请勿相加。</p> : null}
          {snapshot.filesystemRelation === "unknown" ? <p role="note" className="mt-3 text-xs leading-5 text-slate-500">无法确认两个目录是否位于同一文件系统；请分别查看状态，不要将容量相加。</p> : null}
          <p className="mt-3 text-xs leading-5 text-slate-400">80% 起提醒，90% 起告警；可用空间低于 5 GiB 时也会告警。该页面不扫描目录内容，不统计文件大小，也不提供清理操作。</p>
        </> : error && !loading ? null : null}
      </div>
    </section>
  );
}

function MemoryCard({ snapshot }: { snapshot: ServerResourcesSnapshot }) {
  const memory = snapshot.linuxMemory;
  const level = tone(memory.usedPercent, memory.availableBytes, false);
  const classes = toneClasses[level];
  return (
    <article className="rounded-2xl border border-slate-200/80 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-500">Linux 内核报告内存</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight">{memory.usedPercent === null ? "不可读取" : `${memory.usedPercent.toFixed(1)}%`}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${classes.badge}`}>{memory.status === "available" ? level === "normal" ? "正常" : level === "warning" ? "注意" : "告警" : "不可读取"}</span>
      </div>
      {memory.usedPercent !== null ? <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${classes.bar}`} style={{ width: `${Math.max(0, Math.min(100, memory.usedPercent))}%` }} /></div> : <p className="mt-4 text-xs text-slate-500">{reasonText(memory.unavailableReason)}</p>}
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
        <ResourceValue label="总量" value={formatBytes(memory.totalBytes)} />
        <ResourceValue label="已用" value={formatBytes(memory.usedBytes)} />
        <ResourceValue label="可用（MemAvailable）" value={formatBytes(memory.availableBytes)} />
        <ResourceValue label="范围" value="Linux 内核报告值" />
      </dl>
    </article>
  );
}

function FilesystemCard({ filesystem }: { filesystem: ServerFilesystemMetric }) {
  const level = tone(filesystem.usedPercent, filesystem.availableBytes);
  const classes = toneClasses[level];
  const hasValues = filesystem.usedPercent !== null;
  return (
    <article className="rounded-2xl border border-slate-200/80 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-500">{filesystem.label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight">{hasValues ? `${filesystem.usedPercent!.toFixed(1)}%` : "不可读取"}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${classes.badge}`}>{hasValues ? level === "danger" ? "告警" : level === "warning" ? "注意" : filesystem.status === "partial" ? "部分可读" : "正常" : filesystem.status === "partial" ? "部分可读" : "不可读取"}</span>
      </div>
      {hasValues ? <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${classes.bar}`} style={{ width: `${Math.max(0, Math.min(100, filesystem.usedPercent!))}%` }} /></div> : <p className="mt-4 text-xs text-slate-500">{reasonText(filesystem.unavailableReason)}</p>}
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
        <ResourceValue label="总量" value={formatBytes(filesystem.totalBytes)} />
        <ResourceValue label="已用" value={formatBytes(filesystem.usedBytes)} />
        <ResourceValue label="可用" value={formatBytes(filesystem.availableBytes)} />
        <ResourceValue label="预留" value={formatBytes(filesystem.reservedBytes)} />
        <ResourceValue label="inode 总数" value={formatCount(filesystem.totalInodes)} />
        <ResourceValue label="inode 已用" value={formatCount(filesystem.usedInodes)} />
        <ResourceValue label="inode 空闲" value={formatCount(filesystem.availableInodes)} />
        <ResourceValue label="inode 预留" value={formatCount(filesystem.reservedInodes)} />
      </dl>
    </article>
  );
}

function ResourceValue({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-slate-400">{label}</dt><dd className="mt-1 break-words font-semibold text-slate-700">{value}</dd></div>;
}
