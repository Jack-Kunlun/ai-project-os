"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Summary = Readonly<{
  user: Readonly<{
    id: string;
    username: string;
    displayName: string | null;
    state: "enabled" | "disabled";
    disabledAt: string | null;
    accountAccessVersion: number;
  }>;
  membership: Readonly<{
    state: "none" | "active" | "expired" | "revoked";
    expiresAt: string | null;
    version: number;
  }>;
  credits: Readonly<{
    grantCount: number;
    activeGrantCount: number;
    availableTokens: number;
    reservedTokens: number;
    difference: "disabled" | "missing" | "available" | "exhausted" | "expired" | "revoked";
  }>;
}>;

type ListPayload = Readonly<{
  items: readonly Summary[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}>;

const membershipLabels: Record<Summary["membership"]["state"], string> = {
  none: "非会员",
  active: "会员有效",
  expired: "会员已到期",
  revoked: "会员已撤销",
};

const creditLabels: Record<Summary["credits"]["difference"], string> = {
  disabled: "账号已停用",
  missing: "缺少额度",
  available: "额度可用",
  exhausted: "额度已用尽",
  expired: "额度已过期",
  revoked: "额度已撤销",
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function date(value: string | null): string {
  return value === null ? "—" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}

export function AdminUsersClient({ username }: { username: string }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<ListPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (search.trim()) params.set("search", search.trim());
      const response = await fetch(`/api/admin/users?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "用户列表加载失败"));
      setPayload(await response.json() as ListPayload);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "用户列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return <main className="min-h-screen min-w-0 w-full max-w-[calc(100vw-2rem)] bg-[#f5f7fb] text-slate-950">
    <div className="mx-auto min-w-0 max-w-6xl px-6 pb-16 pt-8 sm:px-10 lg:px-12">
      <header className="rounded-[2rem] bg-slate-950 px-7 py-8 text-white shadow-2xl shadow-slate-950/15 sm:px-10 sm:py-10">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">User operations</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">用户运营</h1>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">以单个普通用户为上下文处理账号状态、会员和额度。平台管理员只看到运营摘要，不进入用户的业务空间。</p>
        <p className="mt-5 text-xs text-slate-400">当前管理员：{username}</p>
      </header>

      <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="admin-users-search-title">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-60 flex-1 text-xs font-semibold text-slate-600">
            <span id="admin-users-search-title">搜索普通用户</span>
            <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="用户名或显示名称" maxLength={160} className="edit-field" />
          </label>
          <button type="button" onClick={() => void load()} disabled={loading} className="rounded-xl border border-slate-200 px-4 py-3 text-xs font-semibold text-slate-700 disabled:opacity-50">刷新</button>
        </div>
      </section>

      {error ? <p role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}
      <section className="mt-6 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm" aria-labelledby="admin-users-list-title">
        <div className="border-b border-slate-100 px-5 py-5 sm:px-6">
          <h2 id="admin-users-list-title" className="text-lg font-semibold text-slate-900">普通用户</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">列表只显示运营所需状态摘要；打开详情后再执行需要预览确认的变更。</p>
        </div>
        {loading ? <div className="px-6 py-12 text-center text-sm text-slate-500">读取中…</div> : payload?.items.length === 0 ? <div className="px-6 py-12 text-center text-sm text-slate-500">没有匹配的普通用户。</div> : <div className="divide-y divide-slate-100">
          {payload?.items.map((item) => <Link key={item.user.id} href={`/admin/users/${item.user.id}`} className="block px-5 py-5 transition hover:bg-indigo-50/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 sm:px-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="basis-full min-w-0 sm:flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="truncate font-semibold text-slate-900">{item.user.displayName ?? item.user.username}</h3>
                  <span className="text-xs text-slate-400">{item.user.username}</span>
                  <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${item.user.state === "enabled" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{item.user.state === "enabled" ? "已启用" : "已停用"}</span>
                </div>
                <p className="mt-2 text-xs text-slate-500">账号版本 {item.user.accountAccessVersion} · {item.user.state === "disabled" ? `停用于 ${date(item.user.disabledAt)}` : "当前可登录"}</p>
              </div>
              <span className="text-xs font-semibold text-indigo-700">查看运营详情 →</span>
            </div>
            <div className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-2">
              <div className="rounded-2xl bg-slate-50 px-4 py-3"><span className="font-semibold text-slate-800">会员</span><span className="ml-3">{membershipLabels[item.membership.state]}{item.membership.expiresAt ? ` · 至 ${date(item.membership.expiresAt)}` : ""}</span></div>
              <div className="rounded-2xl bg-slate-50 px-4 py-3"><span className="font-semibold text-slate-800">额度</span><span className="ml-3">{creditLabels[item.credits.difference]} · 可用 {item.credits.availableTokens.toLocaleString()} · 预留 {item.credits.reservedTokens.toLocaleString()}</span></div>
            </div>
          </Link>)}
        </div>}
        <div className="flex items-center justify-between border-t border-slate-100 px-5 py-4 text-xs text-slate-500 sm:px-6">
          <span>第 {payload?.page ?? page} 页</span>
          <div className="flex gap-2"><button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={loading || page === 1} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold text-slate-700 disabled:opacity-50">上一页</button><button type="button" onClick={() => setPage((value) => value + 1)} disabled={loading || !payload?.hasNextPage} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold text-slate-700 disabled:opacity-50">下一页</button></div>
        </div>
      </section>
    </div>
  </main>;
}
