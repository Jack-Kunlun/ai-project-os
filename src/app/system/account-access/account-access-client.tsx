"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { ParentPageLink } from "@/components/parent-page-link";

type AccountAccessState = "enabled" | "disabled";
type Action = "disable" | "restore";
type Item = {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "user";
  state: AccountAccessState;
  disabledAt: string | null;
  accountAccessVersion: number;
  sessionCount: number;
};
type Preview = {
  action: Action;
  user: {
    id: string;
    username: string;
    displayName: string | null;
    role: "admin" | "user";
    state: AccountAccessState;
  };
  current: {
    state: AccountAccessState;
    accountAccessVersion: number;
    disabledAt: string | null;
    sessionCount: number;
  };
  target: {
    state: AccountAccessState;
    accountAccessVersion: number;
    disabledAt: string | null;
    sessionCount: number;
  };
  blockingCategories: string[];
  canExecute: boolean;
  impactFingerprint: string;
  requestFingerprint: string;
  previewId: string;
  issuedAt: string;
  expiresAt: string;
  previewIssuedAt: string;
  previewExpiresAt: string;
};

function newRequestKey(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `account:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
  }
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function AccountAccessClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/system/account-access?search=${encodeURIComponent(search)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "账号列表加载失败"));
      setItems((await response.json() as { items: Item[] }).items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "账号列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f4f6fb] text-slate-950">
      <AppHeader username={username} active="admin" isSystemAdmin={isSystemAdmin} />
      <AdminPageFrame active="accountAccess">
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10 lg:pt-10">
        <div className="mb-5"><ParentPageLink href="/admin" label="返回管理总览" /></div>
        <section className="rounded-[2rem] bg-slate-950 px-7 py-8 text-white shadow-2xl shadow-slate-950/15 sm:px-10 sm:py-10">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">Account access</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">账号状态治理</h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">停用会立即撤销现有登录会话；恢复只允许新会话重新进入，旧会话不会复活。这里不删除会员、项目或用户自己的 Git / MCP / 模型配置。</p>
        </section>

        <section className="mt-6 rounded-3xl border border-indigo-100 bg-indigo-50/70 px-5 py-5 text-sm leading-6 text-indigo-950 sm:px-6">
          <h2 className="font-semibold">安全边界</h2>
          <p className="mt-1 text-indigo-800">每次操作都要先预览影响，再输入完整用户名确认。停用会阻断此后进入最终准入边界的调用；已经完成最终准入的单次外发仍按原授权收口。系统不会在预览或列表返回个人凭据、连接地址、连接名称或项目私有内容。</p>
        </section>

        <section className="mt-6 flex flex-wrap items-end gap-3 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6" aria-label="搜索账号">
          <label className="min-w-0 flex-1">
            <span className="mb-2 block text-xs font-semibold text-slate-500">查找用户</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户名或显示名称" className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" />
          </label>
          <button type="button" onClick={() => void load()} disabled={loading} className="min-h-11 rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50">{loading ? "读取中…" : "搜索"}</button>
        </section>

        {error ? <div role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        <section className="mt-6 space-y-4" aria-label="账号列表">
          {loading ? <div className="rounded-3xl border border-slate-200 bg-white px-6 py-14 text-center text-sm text-slate-500">读取账号状态…</div> : items.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-sm text-slate-500">没有匹配的用户。</div> : items.map((item) => <AccountCard key={item.id} item={item} currentUsername={username} onChanged={() => void load()} />)}
        </section>
      </div>
      </AdminPageFrame>
    </main>
  );
}

function AccountCard({ item, currentUsername, onChanged }: { item: Item; currentUsername: string; onChanged: () => void }) {
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmationUsername, setConfirmationUsername] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requestKeyRef = useRef(newRequestKey());
  const isSelf = item.username === currentUsername;
  const nextAction: Action = item.state === "enabled" ? "disable" : "restore";

  function changeReason(value: string): void {
    setReason(value);
    setPreview(null);
    setMessage(null);
    requestKeyRef.current = newRequestKey();
  }

  async function requestPreview(): Promise<void> {
    if (isSelf) {
      setMessage("不能治理当前登录的管理员账号");
      return;
    }
    if (reason.trim().length === 0) {
      setMessage("请先填写操作原因");
      return;
    }
    setPending(true);
    setMessage(null);
    requestKeyRef.current = newRequestKey();
    try {
      const response = await fetch(`/api/system/account-access/${item.id}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: nextAction, reason, expectedVersion: item.accountAccessVersion }),
      });
      if (!response.ok) throw new Error(await responseError(response, "账号影响预览失败"));
      const body = await response.json() as { preview: Preview };
      setPreview(body.preview);
      setConfirmationUsername("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "账号影响预览失败");
    } finally {
      setPending(false);
    }
  }

  async function executePreview(): Promise<void> {
    if (preview === null) return;
    if (!preview.canExecute) {
      setMessage("当前操作被安全规则阻断，请刷新状态后重试");
      return;
    }
    if (confirmationUsername !== item.username) {
      setMessage(`请输入当前用户名“${item.username}”完成确认`);
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/system/account-access/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: preview.action,
          reason,
          expectedVersion: preview.current.accountAccessVersion,
          expectedImpactFingerprint: preview.impactFingerprint,
          requestKey: requestKeyRef.current,
          requestFingerprint: preview.requestFingerprint,
          previewId: preview.previewId,
          previewIssuedAt: preview.previewIssuedAt,
          previewExpiresAt: preview.previewExpiresAt,
          confirmation: true,
          confirmationUsername,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "账号状态更新失败"));
      setPreview(null);
      setConfirmationUsername("");
      setReason("");
      onChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "账号状态更新失败");
      if (cause instanceof Error && /预览|状态|用户名|刷新/u.test(cause.message)) setPreview(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="max-w-full break-words text-lg font-semibold">{item.displayName || item.username}</h2>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] font-semibold text-slate-600">{item.role === "admin" ? "系统管理员" : "普通用户"}</span>
            <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${item.state === "enabled" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{item.state === "enabled" ? "已启用" : "已停用"}</span>
          </div>
          <p className="mt-2 break-words text-xs text-slate-500">@{item.username}</p>
          <p className="mt-2 text-xs text-slate-400">账号版本 {item.accountAccessVersion} · 会话记录 {item.sessionCount} 条{item.disabledAt ? ` · 停用于 ${formatDate(item.disabledAt)}` : ""}</p>
        </div>
        <button type="button" disabled={pending || isSelf} onClick={() => void requestPreview()} className={`min-h-11 shrink-0 rounded-xl px-4 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${nextAction === "disable" ? "bg-rose-600 hover:bg-rose-700" : "bg-indigo-600 hover:bg-indigo-700"}`}>
          {isSelf ? "当前账号" : nextAction === "disable" ? "停用账号" : "恢复账号"}
        </button>
      </div>

      {!isSelf ? <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <label className="min-w-0">
          <span className="mb-2 block text-xs font-semibold text-slate-500">操作原因（必填）</span>
          <textarea value={reason} onChange={(event) => changeReason(event.target.value)} rows={2} maxLength={500} placeholder={nextAction === "disable" ? "例如：长期未使用，按平台安全策略停用" : "例如：用户已完成身份核验，恢复访问"} className="w-full resize-y rounded-xl border border-slate-200 px-4 py-3 text-sm leading-6 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" />
        </label>
        <p className="text-xs leading-5 text-slate-400 lg:max-w-48">不会影响会员资格、项目资料或私有连接配置。</p>
      </div> : null}

      {preview ? <section className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4" aria-label="账号状态变更预览">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-indigo-950">执行前影响预览</h3>
            <p className="mt-1 text-xs leading-5 text-indigo-800">{preview.action === "disable" ? "现有未撤销会话会立即失效；已完成最终准入的单次外发仍可能按原授权收口。" : "恢复只允许新会话进入，旧会话和旧连接授权链不会复活。"}</p>
          </div>
          <span className="rounded-full bg-white px-2.5 py-1 text-[12px] font-semibold text-indigo-700">有效至 {formatDate(preview.expiresAt)}</span>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <PreviewStat label="当前版本" value={String(preview.current.accountAccessVersion)} />
          <PreviewStat label="变更后版本" value={String(preview.target.accountAccessVersion)} />
          <PreviewStat label="将撤销会话" value={String(preview.current.sessionCount)} />
        </dl>
        {preview.blockingCategories.length > 0 ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">平台必须保留至少一位启用的系统管理员，当前预览不能执行。</p> : <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="min-w-0">
            <span className="mb-2 block text-xs font-semibold text-indigo-900">输入用户名确认</span>
            <input value={confirmationUsername} onChange={(event) => setConfirmationUsername(event.target.value)} placeholder={item.username} autoComplete="off" className="w-full rounded-xl border border-indigo-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100" />
          </label>
          <button type="button" disabled={pending} onClick={() => void executePreview()} className="min-h-11 rounded-xl bg-indigo-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-800 disabled:opacity-50">确认{preview.action === "disable" ? "停用" : "恢复"}</button>
        </div>}
      </section> : null}
      {message ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{message}</p> : null}
    </article>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-white px-3 py-3"><dt className="text-[12px] text-slate-500">{label}</dt><dd className="mt-1 text-sm font-semibold text-slate-900">{value}</dd></div>;
}
