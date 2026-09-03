"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { AdminShell } from "@/components/admin-shell";

type Subscription = { id: string; userId: string; status: "active" | "revoked"; startsAt: string; expiresAt: string; revokedAt: string | null; note: string | null; version: number; updatedAt: string };
type Item = { id: string; username: string; displayName: string | null; email: string | null; role: "admin" | "member"; disabledAt: string | null; membershipSubscription: Subscription | null };

async function responseError(response: Response, fallback: string) {
  try { const body = await response.json() as { error?: { message?: string } }; return body.error?.message ?? fallback; } catch { return fallback; }
}

function date(value: string | null): string { return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value)) : "—"; }

export function MembershipsClient({ username, adminMode = false }: { username: string; adminMode?: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/system/memberships?search=${encodeURIComponent(search)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "会员列表加载失败"));
      setItems((await response.json() as { items: Item[] }).items);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "会员列表加载失败"); }
    finally { setLoading(false); }
  }, [search]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active={adminMode ? "admin" : "profile"} isSystemAdmin={adminMode} />{adminMode ? <AdminShell active="memberships" /> : null}<div className="mx-auto max-w-6xl px-6 py-9 sm:px-10 lg:px-12"><div className="flex flex-wrap items-end justify-between gap-5"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Membership operations</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">会员资格管理</h1><p className="mt-3 max-w-2xl text-sm leading-7 text-slate-500">仅人工授予、延期或撤销会员资格，不会修改用户或工作区角色。</p></div><Link href={adminMode ? "/admin" : "/profile"} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600">返回{adminMode ? "管理总览" : "个人中心"}</Link></div><div className="mt-7 flex gap-3"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户名、邮箱或显示名称" className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /><button type="button" onClick={() => void load()} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white">搜索</button></div>{error ? <div role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}<section className="mt-6 space-y-3">{loading ? <div className="rounded-3xl border border-slate-200 bg-white p-10 text-sm text-slate-500">读取中…</div> : items.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">没有匹配的用户。</div> : items.map((item) => <MembershipCard key={item.id} item={item} onChanged={() => void load()} />)}</section></div></main>;
}

function MembershipCard({ item, onChanged }: { item: Item; onChanged: () => void }) {
  const subscription = item.membershipSubscription;
  const [days, setDays] = useState("30");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function update(action: "grant" | "revoke") {
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/system/memberships/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(action === "grant" ? { action, days: Number(days), note: note || null, expectedVersion: subscription?.version ?? null } : { action, expectedVersion: subscription?.version ?? null }) });
      if (!response.ok) throw new Error(await responseError(response, "会员状态更新失败"));
      onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "会员状态更新失败"); }
    finally { setPending(false); }
  }
  return <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold">{item.displayName || item.username}</h2><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{item.role}</span>{subscription ? <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${subscription.status === "active" && new Date(subscription.expiresAt) > new Date() ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{subscription.status === "active" && new Date(subscription.expiresAt) > new Date() ? "会员有效" : "已到期/撤销"}</span> : <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500">非会员</span>}</div><p className="mt-2 text-xs text-slate-500">@{item.username}{item.email ? ` · ${item.email}` : ""}</p><p className="mt-2 text-xs text-slate-400">{subscription ? `到期：${date(subscription.expiresAt)} · 版本 ${subscription.version}` : "尚未授予会员资格"}</p></div><div className="flex flex-wrap items-center gap-2"><input type="number" min={1} max={3650} value={days} onChange={(event) => setDays(event.target.value)} className="w-20 rounded-xl border border-slate-200 px-3 py-2 text-xs" aria-label="会员天数" /><button type="button" disabled={pending} onClick={() => void update("grant")} className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{subscription ? "延期" : "授予"}</button>{subscription ? <button type="button" disabled={pending} onClick={() => void update("revoke")} className="rounded-xl border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50">撤销</button> : null}</div></div><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="审计备注（可选）" maxLength={500} className="mt-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs" />{message ? <p role="alert" className="mt-3 text-xs text-rose-600">{message}</p> : null}</article>;
}
