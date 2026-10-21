"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UiText, useAppearance, type AppearanceLanguage } from "@/components/appearance-provider";
import { safeErrorPresentation, safeResponseError, type SafeErrorPresentation } from "@/lib/safe-error-presentation";
import type { ServerFilesystemMetric, ServerResourcesSnapshot } from "@/lib/server-resources-types";

const FIVE_GIBIBYTES = 5 * 1024 * 1024 * 1024;
type Translate = (text: string) => string;

function formatBytes(value: number | null, language: AppearanceLanguage, t: Translate): string {
  if (value === null) return t("不可读取");
  if (value < 1024) return `${new Intl.NumberFormat(language).format(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const fractionDigits = size >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(language, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(size)} ${units[index]}`;
}

function formatCount(value: number | null, language: AppearanceLanguage, t: Translate): string {
  return value === null ? t("不可读取") : new Intl.NumberFormat(language).format(value);
}

function formatTime(value: string, language: AppearanceLanguage): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
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

function reasonText(reason: string | null, t: Translate): string {
  switch (reason) {
    case "NOT_LINUX": return t("当前运行环境不是 Linux。");
    case "NOT_DOCKER": return t("未检测到 Docker 容器环境。");
    case "CGROUP_MAPPING_UNCERTAIN": return t("无法确认当前容器 cgroup 根目录映射。");
    case "SOURCE_UNAVAILABLE": return t("运行环境未提供该指标。");
    case "INVALID_SOURCE": return t("指标来源格式不符合预期。");
    case "OUT_OF_SAFE_RANGE": return t("容量超出安全数值范围，避免显示不精确结果。");
    default: return t("尚未取得指标。");
  }
}

function statusText(status: "normal" | "warning" | "danger" | "partial" | "unavailable", t: Translate): string {
  switch (status) {
    case "normal": return t("资源正常");
    case "warning": return t("注意");
    case "danger": return t("告警");
    case "partial": return t("部分可读");
    case "unavailable": return t("不可读取");
  }
}

export function ServerResourcesPanel() {
  const { language, t } = useAppearance();
  const [snapshot, setSnapshot] = useState<ServerResourcesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<SafeErrorPresentation | null>(null);
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
        setError(responseError);
        return;
      }
      const nextSnapshot = await response.json() as ServerResourcesSnapshot;
      if (!isCurrentRequest()) return;
      setSnapshot(nextSnapshot);
      hasSnapshot.current = true;
      setError(null);
    } catch {
      if (isCurrentRequest()) setError(safeErrorPresentation(null, "服务器资源读取失败"));
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
          <h2 id="server-resources-title" className="mt-2 text-xl font-semibold"><UiText text="服务器资源" /></h2>
          <p className="mt-2 max-w-4xl text-xs leading-5 text-slate-500"><UiText text="只读监控，每 30 秒更新一次。内存显示 Linux 内核报告值；磁盘只统计应用部署目录和上传存储目录各自所属的文件系统。" /></p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading || refreshing} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60">
          <UiText text={loading || refreshing ? "刷新中…" : "刷新"} />
        </button>
      </div>

      <div className="px-5 py-5 sm:px-7">
        {error ? <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{t(error.summary)} <UiText text="下一步：" />{t(error.nextStep)}{error.code ? <> (<UiText text="错误代码" />: {error.code})</> : null}{snapshot ? <> <UiText text="保留上次读取的数据" />{language === "en" ? " (" : "（"}{formatTime(snapshot.readAt, language)}{language === "en" ? "), " : "），"}<UiText text="当前数据可能已过期。" /></> : <> <UiText text="暂无可展示的读取结果。" /></>}</div> : null}
        {loading && snapshot === null ? <p role="status" className="py-8 text-center text-sm text-slate-500"><UiText text="正在读取服务器资源…" /></p> : null}
        {snapshot ? <>
          <p className="mb-4 text-xs text-slate-400"><UiText text="采集于" /> {formatTime(snapshot.readAt, language)}{refreshing ? <> · <UiText text="刷新中…" /></> : ""}</p>
          <div className="grid gap-4 xl:grid-cols-3">
            <MemoryCard snapshot={snapshot} language={language} t={t} />
            {snapshot.filesystems.map((filesystem) => <FilesystemCard key={filesystem.scope} filesystem={filesystem} language={language} t={t} />)}
          </div>
          <div className="mt-4 grid gap-3 rounded-2xl bg-slate-50 px-4 py-4 sm:grid-cols-2">
            <div>
              <div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold text-slate-500"><UiText text="Docker 容器内存" /></p>{snapshot.containerMemory.status === "available" ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${containerLevel ? toneClasses[containerLevel].badge : "bg-slate-100 text-slate-600"}`}>{snapshot.containerMemory.limitBytes === null ? t("未设置上限") : statusText(containerLevel ?? "normal", t)}</span> : null}</div>
              {snapshot.containerMemory.status === "available"
                ? <p className="mt-1 text-sm font-semibold text-slate-800"><UiText text="当前" /> {formatBytes(snapshot.containerMemory.currentBytes, language, t)} / {snapshot.containerMemory.limitBytes === null ? <UiText text="未设置上限" /> : <><UiText text="上限" /> {formatBytes(snapshot.containerMemory.limitBytes, language, t)}{snapshot.containerMemory.usedPercent === null ? <> · <UiText text="占用率不可计算" /></> : ` · ${snapshot.containerMemory.usedPercent.toFixed(1)}%`}</>}</p>
                : <p className="mt-1 text-xs text-slate-500"><UiText text="不可读取：" />{reasonText(snapshot.containerMemory.unavailableReason, t)}</p>}
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-500"><UiText text="应用进程 RSS" /></p>
              <p className="mt-1 text-sm font-semibold text-slate-800">{formatBytes(snapshot.applicationProcess.rssBytes, language, t)}</p>
              <p className="mt-1 text-xs text-slate-500"><UiText text="仅表示当前 Node.js 应用进程常驻内存，不代表主机或整个容器。" /></p>
            </div>
          </div>
          {snapshot.filesystemRelation === "same" ? <p role="note" className="mt-3 rounded-xl bg-indigo-50 px-4 py-3 text-xs leading-5 text-indigo-800"><UiText text="应用目录和上传目录位于同一文件系统；上方两张磁盘卡片显示的是同一容量，请勿相加。" /></p> : null}
          {snapshot.filesystemRelation === "different" ? <p role="note" className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600"><UiText text="应用目录和上传目录所属文件系统标识不同；采集不能确认它们是否共享底层物理存储，卡片容量请勿相加。" /></p> : null}
          {snapshot.filesystemRelation === "unknown" ? <p role="note" className="mt-3 text-xs leading-5 text-slate-500"><UiText text="无法确认两个目录是否位于同一文件系统；请分别查看状态，不要将容量相加。" /></p> : null}
          <p className="mt-3 text-xs leading-5 text-slate-400"><UiText text="80% 起提醒，90% 起告警；可用空间低于 5 GiB 时也会告警。该页面不扫描目录内容，不统计文件大小，也不提供清理操作。" /></p>
        </> : error && !loading ? null : null}
      </div>
    </section>
  );
}

function MemoryCard({ snapshot, language, t }: { snapshot: ServerResourcesSnapshot; language: AppearanceLanguage; t: Translate }) {
  const memory = snapshot.linuxMemory;
  const level = tone(memory.usedPercent, memory.availableBytes, false);
  const classes = toneClasses[level];
  return (
    <article className="rounded-2xl border border-slate-200/80 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-500"><UiText text="Linux 内核报告内存" /></p>
          <p className="mt-2 text-2xl font-semibold tracking-tight">{memory.usedPercent === null ? t("不可读取") : `${memory.usedPercent.toFixed(1)}%`}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${classes.badge}`}>{memory.status === "available" ? statusText(level, t) : t("不可读取")}</span>
      </div>
      {memory.usedPercent !== null ? <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${classes.bar}`} style={{ width: `${Math.max(0, Math.min(100, memory.usedPercent))}%` }} /></div> : <p className="mt-4 text-xs text-slate-500">{reasonText(memory.unavailableReason, t)}</p>}
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
        <ResourceValue label={t("总量")} value={formatBytes(memory.totalBytes, language, t)} />
        <ResourceValue label={t("已用")} value={formatBytes(memory.usedBytes, language, t)} />
        <ResourceValue label={t("可用（MemAvailable）")} value={formatBytes(memory.availableBytes, language, t)} />
        <ResourceValue label={t("范围")} value={t("Linux 内核报告值")} />
      </dl>
    </article>
  );
}

function FilesystemCard({ filesystem, language, t }: { filesystem: ServerFilesystemMetric; language: AppearanceLanguage; t: Translate }) {
  const level = tone(filesystem.usedPercent, filesystem.availableBytes);
  const classes = toneClasses[level];
  const hasValues = filesystem.usedPercent !== null;
  const status = hasValues
    ? level === "normal" && filesystem.status === "partial" ? "partial" : level
    : filesystem.status === "partial" ? "partial" : "unavailable";
  return (
    <article className="rounded-2xl border border-slate-200/80 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-500">{filesystem.scope === "deployment-directory-filesystem" ? t("应用部署目录所属文件系统") : t("上传存储目录所属文件系统")}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight">{hasValues ? `${filesystem.usedPercent!.toFixed(1)}%` : t("不可读取")}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${classes.badge}`}>{statusText(status, t)}</span>
      </div>
      {hasValues ? <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${classes.bar}`} style={{ width: `${Math.max(0, Math.min(100, filesystem.usedPercent!))}%` }} /></div> : <p className="mt-4 text-xs text-slate-500">{reasonText(filesystem.unavailableReason, t)}</p>}
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
        <ResourceValue label={t("总量")} value={formatBytes(filesystem.totalBytes, language, t)} />
        <ResourceValue label={t("已用")} value={formatBytes(filesystem.usedBytes, language, t)} />
        <ResourceValue label={t("可用")} value={formatBytes(filesystem.availableBytes, language, t)} />
        <ResourceValue label={t("预留")} value={formatBytes(filesystem.reservedBytes, language, t)} />
        <ResourceValue label={t("inode 总数")} value={formatCount(filesystem.totalInodes, language, t)} />
        <ResourceValue label={t("inode 已用")} value={formatCount(filesystem.usedInodes, language, t)} />
        <ResourceValue label={t("inode 空闲")} value={formatCount(filesystem.availableInodes, language, t)} />
        <ResourceValue label={t("inode 预留")} value={formatCount(filesystem.reservedInodes, language, t)} />
      </dl>
    </article>
  );
}

function ResourceValue({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-slate-400">{label}</dt><dd className="mt-1 break-words font-semibold text-slate-700">{value}</dd></div>;
}
