"use client";

import { useEffect, useState } from "react";
import type { SystemOverview } from "@/lib/system-overview";

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? "管理总览加载失败";
  } catch {
    return "管理总览加载失败";
  }
}

function workerLabel(status: SystemOverview["service"]["worker"]["status"]): string {
  return { up: "运行中", starting: "启动中", degraded: "降级", stopping: "停止中", stale: "心跳过期", missing: "未发现" }[status];
}

export function AdminOverviewClient() {
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/system/overview", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(await readError(response));
      setOverview(await response.json() as SystemOverview);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "管理总览加载失败");
    });
    return () => controller.abort();
  }, []);

  return <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10">
    <section className="rounded-[2rem] bg-slate-950 px-7 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-10">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">System overview</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">管理员总览</h1>
      <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">这里只展示当前应用、数据库、Worker 和安全聚合计数，不包含邮箱、凭据、个人账本或连接详情。</p>
    </section>
    {error ? <p role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}
    <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="应用服务状态">
      <StatusCard label="应用服务状态" value={overview?.service.application === "up" ? "正常" : "读取中…"} detail={overview ? `版本 ${overview.service.version}` : "等待安全读取"} tone="emerald" />
      <StatusCard label="数据库" value={overview?.service.database === "up" ? "可用" : "读取中…"} detail="只读健康检查" tone="cyan" />
      <StatusCard label="Worker" value={overview ? workerLabel(overview.service.worker.status) : "读取中…"} detail={overview ? overview.service.worker.heartbeatAgeMs === null ? "暂无心跳" : `心跳 ${Math.round(overview.service.worker.heartbeatAgeMs / 1000)} 秒前` : "等待安全读取"} tone="violet" />
    </section>
    <section className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
      <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Safe counts</p><h2 className="mt-2 text-xl font-semibold">平台规模</h2><div className="mt-5 grid grid-cols-3 gap-3"><Count label="用户" value={overview?.counts.users} /><Count label="有效会员" value={overview?.counts.activeMemberships} /><Count label="已验证模型" value={overview?.counts.verifiedPlatformModels} /></div></div>
      <div className="rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Token ledger</p><h2 className="mt-2 text-xl font-semibold">平台 Token 总览</h2><p className="mt-2 text-xs leading-5 text-slate-500">只读聚合：累计发放、当前可用、预留 / 待对账占用和已确认消耗。</p><div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"><Count label="累计发放" value={overview?.tokens.issuedTokens} /><Count label="当前可用" value={overview?.tokens.availableTokens} /><Count label="预留 / 待对账占用" value={overview?.tokens.reservedTokens} /><Count label="已确认消耗" value={overview?.tokens.consumedTokens} /></div></div>
    </section>
  </div>;
}

function StatusCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: "emerald" | "cyan" | "violet" }) {
  const styles = { emerald: "bg-emerald-50 text-emerald-700", cyan: "bg-cyan-50 text-cyan-700", violet: "bg-violet-50 text-violet-700" } as const;
  return <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm"><p className="text-xs font-semibold text-slate-500">{label}</p><p className={`mt-3 inline-flex rounded-full px-3 py-1 text-sm font-semibold ${styles[tone]}`}>{value}</p><p className="mt-3 text-xs text-slate-500">{detail}</p></article>;
}

function Count({ label, value }: { label: string; value?: number }) {
  return <div className="rounded-2xl bg-slate-50 px-3 py-4"><p className="text-2xl font-semibold text-slate-900">{value ?? "—"}</p><p className="mt-1 text-[11px] text-slate-500">{label}</p></div>;
}
