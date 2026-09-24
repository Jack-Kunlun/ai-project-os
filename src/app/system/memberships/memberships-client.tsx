"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { AdminPageHeader } from "@/components/admin-page-header";

type Subscription = {
  id: string;
  userId: string;
  status: "active" | "revoked";
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  version: number;
  updatedAt: string;
};
type Item = {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "user";
  disabledAt: string | null;
  membershipSubscription: Subscription | null;
  membershipApplication: {
    id: string;
    status: "pending" | "fulfilled" | "rejected" | "withdrawn";
    statusVersion: number;
    submittedAt: string;
    fulfilledAt: string | null;
    rejectedAt: string | null;
    withdrawnAt: string | null;
  } | null;
};
type Action = "grant" | "extend" | "revoke";
type Preview = {
  action: Action;
  user: { id: string; username: string; disabledAt: string | null };
  current: { state: string; version: number; startsAt: string | null; expiresAt: string | null; status: "active" | "revoked" | null };
  target: { state: string; version: number; startsAt: string; expiresAt: string; status: "active" | "revoked"; revokedAt: string | null };
  dependencyStats: {
    nonTerminalPersonalDelegations: number;
    effectivePersonalRouteSelections: number;
    publishedPersonalIndexes: number;
    personalModelAutomationsAffected: number;
    platformAutomationImpact: "unaffected";
    gitMcpImpact: "unaffected";
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
  applicationId: string | null;
};

type ApplicationRejectPreview = {
  application: Item["membershipApplication"];
  preview: { id: string; applicationId: string; action: "reject"; requestKey: string; requestFingerprint: string; impactFingerprint: string; issuedAt: string; expiresAt: string; reason: string | null };
};

function newRequestKey(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `membership:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
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

function date(value: string | null): string {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value)) : "—";
}

function dateTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

function statusLabel(subscription: Subscription | null): string {
  if (subscription === null) return "非会员";
  return subscription.status === "active" && new Date(subscription.expiresAt) > new Date() ? "会员有效" : "已到期/撤销";
}

function applicationLabel(application: Item["membershipApplication"]): string {
  if (application === null) return "无申请";
  return application.status === "pending" ? "待处理" : application.status === "fulfilled" ? "已完成" : application.status === "rejected" ? "已拒绝" : "已撤回";
}

export function MembershipsClient({ username, adminMode = false }: { username: string; adminMode?: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/system/memberships?search=${encodeURIComponent(search)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "会员列表加载失败"));
      setItems((await response.json() as { items: Item[] }).items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "会员列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [search]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const content = <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
      <AdminPageHeader title="会员资格管理" description="每次变更都会先生成影响预览，再由管理员确认执行；不会修改用户角色、工作区角色或连接配置。" actions={!adminMode ? <Link href="/profile" className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600">返回个人中心</Link> : undefined} />
      <div className="mt-8 flex gap-4">
        <label className="min-w-0 flex-1">
          <span className="sr-only">搜索会员</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索用户名、邮箱或显示名称" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" />
        </label>
        <button type="button" onClick={() => void load()} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white">搜索</button>
      </div>
      <p className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-xs leading-6 text-indigo-800">Git / MCP 私有连接与平台自动化属于独立配置，不会因会员撤销被修改。个人模型配置会保留，但会员失效期间不可使用。</p>
      {error ? <div role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
      <section className="mt-6 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm" aria-labelledby="membership-list-title">
        <div className="border-b border-slate-100 px-5 py-5 sm:px-6">
          <h2 id="membership-list-title" className="text-lg font-semibold text-slate-900">会员资格列表</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">会员页面专门处理资格与申请；展开单行后进行授予、延期、撤销或拒绝，并保留原有预览确认流程。</p>
        </div>
        {loading ? <div className="px-6 py-12 text-center text-sm text-slate-500">读取中…</div> : items.length === 0 ? <div className="px-6 py-12 text-center text-sm text-slate-500">没有匹配的用户。</div> : <div className="overflow-x-auto">
          <table className="min-w-[860px] w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-3 sm:px-6">用户</th>
                <th scope="col" className="px-5 py-3">申请状态</th>
                <th scope="col" className="px-5 py-3">会员状态</th>
                <th scope="col" className="px-5 py-3">有效期 / 最近变更</th>
                <th scope="col" className="px-5 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((item) => {
                const expanded = expandedId === item.id;
                const subscription = item.membershipSubscription;
                return <Fragment key={item.id}>
                  <tr key={item.id} className={`transition hover:bg-indigo-50/50 ${expanded ? "bg-indigo-50/30" : ""}`}>
                    <td className="px-5 py-4 sm:px-6"><p className="font-semibold text-slate-900">{item.displayName || item.username}</p><p className="mt-1 text-xs text-slate-400">@{item.username}</p></td>
                    <td className="px-5 py-4"><span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-semibold ${item.membershipApplication?.status === "pending" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}`}>{applicationLabel(item.membershipApplication)}</span>{item.membershipApplication ? <p className="mt-1 text-xs text-slate-400">提交于 {date(item.membershipApplication.submittedAt)}</p> : null}</td>
                    <td className="px-5 py-4"><span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-semibold ${subscription?.status === "active" && new Date(subscription.expiresAt) > new Date() ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{statusLabel(subscription)}</span></td>
                    <td className="px-5 py-4 text-xs text-slate-600"><span>{subscription ? `至 ${date(subscription.expiresAt)}` : "尚未授予"}</span><span className="mt-1 block text-slate-400">{subscription ? `最近变更 ${date(subscription.updatedAt)}` : "—"}</span></td>
                    <td className="px-5 py-4 text-right"><button type="button" aria-expanded={expanded} aria-controls={`membership-management-${item.id}`} onClick={() => setExpandedId((current) => current === item.id ? null : item.id)} className="inline-flex rounded-lg px-2 py-1 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">{expanded ? "收起管理" : "管理资格"}</button></td>
                  </tr>
                  {expanded ? <tr key={`${item.id}-management`} id={`membership-management-${item.id}`}><td colSpan={5} className="bg-slate-50/70 p-4 sm:p-6"><MembershipCard item={item} onChanged={() => { setExpandedId(null); void load(); }} /></td></tr> : null}
                </Fragment>;
              })}
            </tbody>
          </table>
        </div>}
      </section>
    </div>;

  if (adminMode) return content;
  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="profile" /><AdminPageFrame active="memberships" showSidebar={false}>{content}</AdminPageFrame></main>;
}

function MembershipCard({ item, onChanged }: { item: Item; onChanged: () => void }) {
  const subscription = item.membershipSubscription;
  const [days, setDays] = useState("30");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rejectPreview, setRejectPreview] = useState<ApplicationRejectPreview | null>(null);
  const [confirmationUsername, setConfirmationUsername] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requestKeyRef = useRef(newRequestKey());
  const lastActionRef = useRef<Action | null>(null);

  function rotateRequestKey(): void {
    requestKeyRef.current = newRequestKey();
    setPreview(null);
  }

  function changedDays(value: string): void {
    setDays(value);
    rotateRequestKey();
  }

  function changedNote(value: string): void {
    setNote(value);
    rotateRequestKey();
  }

  function changedReason(value: string): void {
    setReason(value);
    rotateRequestKey();
  }

  async function requestPreview(action: Action): Promise<void> {
    if (lastActionRef.current !== action) {
      requestKeyRef.current = newRequestKey();
      lastActionRef.current = action;
    }
    if (action === "revoke" && reason.trim().length === 0) {
      setMessage("撤销会员必须填写原因");
      return;
    }
    const numericDays = Number(days);
    if (action !== "revoke" && (!Number.isInteger(numericDays) || numericDays < 1 || numericDays > 3650)) {
      setMessage("会员天数必须是 1 到 3650 之间的整数");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/system/memberships/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: item.id,
          action,
          days: action === "revoke" ? undefined : numericDays,
          note: action === "revoke" ? undefined : note || null,
          reason: action === "revoke" ? reason : undefined,
          expectedVersion: subscription?.version ?? 0,
          applicationId: action === "grant" && item.membershipApplication?.status === "pending" ? item.membershipApplication.id : undefined,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "会员影响预览失败"));
      const body = await response.json() as { preview: Preview };
      setPreview(body.preview);
      setConfirmationUsername("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "会员影响预览失败");
    } finally {
      setPending(false);
    }
  }

  async function executePreview(): Promise<void> {
    if (preview === null) return;
    if (preview.blockingCategories.length > 0 || !preview.canExecute) {
      setMessage("请先解除预览中列出的个人模型依赖，再重新预览");
      return;
    }
    if (preview.action === "revoke" && confirmationUsername !== item.username) {
      setMessage(`请输入当前用户名“${item.username}”完成撤销确认`);
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/system/memberships/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: preview.action,
          days: preview.action === "revoke" ? undefined : Number(days),
          note: preview.action === "revoke" ? undefined : note || null,
          reason: preview.action === "revoke" ? reason : undefined,
          expectedVersion: preview.current.version,
          expectedImpactFingerprint: preview.impactFingerprint,
          requestKey: requestKeyRef.current,
          requestFingerprint: preview.requestFingerprint,
          previewId: preview.previewId,
          previewIssuedAt: preview.previewIssuedAt,
          previewExpiresAt: preview.previewExpiresAt,
          confirmation: true,
          confirmationUsername: preview.action === "revoke" ? confirmationUsername : undefined,
          applicationId: preview.applicationId ?? undefined,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "会员状态更新失败"));
      setPreview(null);
      // A successful mutation consumes this request key. The next preview is
      // a new intent even when it uses the same action (for example, two
      // consecutive extensions), so it must receive a fresh key.
      requestKeyRef.current = newRequestKey();
      lastActionRef.current = null;
      onChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "会员状态更新失败");
      if (cause instanceof Error && /预览|状态不允许|刷新后重试/u.test(cause.message)) setPreview(null);
    } finally {
      setPending(false);
    }
  }

  async function requestRejectPreview(): Promise<void> {
    const application = item.membershipApplication;
    if (application === null || application.status !== "pending") return;
    if (reason.trim().length === 0) { setMessage("拒绝会员申请必须填写原因"); return; }
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/system/membership-applications/reject/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ applicationId: application.id, requestKey: newRequestKey(), reason }) });
      if (!response.ok) throw new Error(await responseError(response, "拒绝申请预览失败"));
      setRejectPreview(await response.json() as ApplicationRejectPreview);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "拒绝申请预览失败"); }
    finally { setPending(false); }
  }

  async function executeRejectPreview(): Promise<void> {
    if (rejectPreview === null) return;
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/system/membership-applications/reject/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          applicationId: rejectPreview.preview.applicationId,
          requestKey: rejectPreview.preview.requestKey,
          requestFingerprint: rejectPreview.preview.requestFingerprint,
          impactFingerprint: rejectPreview.preview.impactFingerprint,
          previewId: rejectPreview.preview.id,
          previewIssuedAt: rejectPreview.preview.issuedAt,
          previewExpiresAt: rejectPreview.preview.expiresAt,
          confirmation: true,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "拒绝申请失败"));
      setRejectPreview(null); onChanged();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "拒绝申请失败"); }
    finally { setPending(false); }
  }

  const canGrant = subscription === null || subscription.status !== "active" || new Date(subscription.expiresAt) <= new Date();
  const action = canGrant ? "grant" : "extend";
  return <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{item.displayName || item.username}</h2>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] font-semibold text-slate-600">{item.role === "admin" ? "系统管理员" : "普通用户"}</span>
          <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${subscription?.status === "active" && new Date(subscription.expiresAt) > new Date() ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{statusLabel(subscription)}</span>
        </div>
        <p className="mt-2 text-xs text-slate-500">@{item.username}</p>
        <p className="mt-2 text-xs text-slate-400">{subscription ? `到期：${date(subscription.expiresAt)} · 版本 ${subscription.version}` : "尚未授予会员资格"}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label>
          <span className="sr-only">会员天数</span>
          <input type="number" min={1} max={3650} value={days} onChange={(event) => changedDays(event.target.value)} className="w-20 rounded-xl border border-slate-200 px-3 py-2 text-xs" />
        </label>
        <button type="button" disabled={pending} onClick={() => void requestPreview(action)} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">预览{action === "extend" ? "延期" : "授予"}</button>
        {subscription && subscription.status === "active" && new Date(subscription.expiresAt) > new Date() ? <button type="button" disabled={pending} onClick={() => void requestPreview("revoke")} className="rounded-xl border border-rose-200 px-4 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50">预览撤销</button> : null}
      </div>
    </div>
    {item.membershipApplication ? <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-xs leading-5 text-indigo-900"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">会员申请：{item.membershipApplication.status === "pending" ? "待处理" : item.membershipApplication.status === "fulfilled" ? "已完成" : item.membershipApplication.status === "rejected" ? "已拒绝" : "已撤回"}</span><span>提交于 {date(item.membershipApplication.submittedAt)}</span></div>{item.membershipApplication.status === "pending" ? <button type="button" disabled={pending} onClick={() => void requestRejectPreview()} className="mt-3 rounded-xl border border-indigo-200 bg-white px-3 py-2 font-semibold text-indigo-700 disabled:opacity-50">预览拒绝申请</button> : null}</div> : null}
    <label className="mt-4 block">
      <span className="mb-2 block text-xs font-semibold text-slate-500">授予 / 延期备注</span>
      <input value={note} onChange={(event) => changedNote(event.target.value)} placeholder="可选，仅用于审计" maxLength={500} className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-xs outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" />
    </label>
    <label className="mt-4 block">
      <span className="mb-2 block text-xs font-semibold text-slate-500">撤销原因</span>
      <textarea value={reason} onChange={(event) => changedReason(event.target.value)} placeholder="仅在撤销时必填" maxLength={500} rows={3} className="w-full resize-y rounded-xl border border-slate-200 px-3 py-2.5 text-xs outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" />
    </label>
    {preview ? <div className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50 p-5" role="dialog" aria-label="会员变更确认">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-indigo-950">确认{preview.action === "revoke" ? "撤销" : preview.action === "extend" ? "延期" : "授予"}会员</h3>
          <p className="mt-2 text-xs leading-6 text-indigo-900">当前状态：{preview.current.state}（版本 {preview.current.version}） → {preview.target.state}（版本 {preview.target.version}）</p>
          <p className="text-xs leading-6 text-indigo-900">有效期：{date(preview.target.startsAt)} 至 {date(preview.target.expiresAt)}</p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-indigo-700">预览有效至 {dateTime(preview.previewExpiresAt)}</span>
      </div>
      <div className="mt-3 rounded-xl border border-indigo-100 bg-white/70 p-3 text-xs leading-6 text-indigo-900">
        <p className="font-semibold">个人模型依赖摘要</p>
        <p>未终态个人委托 {preview.dependencyStats.nonTerminalPersonalDelegations} 项 · 有效个人路由 {preview.dependencyStats.effectivePersonalRouteSelections} 项 · 已发布个人索引 {preview.dependencyStats.publishedPersonalIndexes} 项</p>
      </div>
      <p className="mt-3 text-xs leading-6 text-indigo-900">个人模型自动化影响 {preview.dependencyStats.personalModelAutomationsAffected} 项；平台自动化、Git 与 MCP 配置不受影响。</p>
      {preview.blockingCategories.length > 0 ? <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-800">检测到未解除的个人模型依赖，当前只能关闭确认；解除依赖后请重新预览。</p> : null}
      {preview.action === "revoke" && preview.canExecute ? <label className="mt-4 block"><span className="mb-2 block text-xs font-semibold text-indigo-950">输入当前用户名确认撤销</span><input value={confirmationUsername} onChange={(event) => setConfirmationUsername(event.target.value)} placeholder={item.username} className="w-full rounded-xl border border-indigo-200 bg-white px-3 py-2.5 text-xs outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100" /></label> : null}
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <button type="button" disabled={pending} onClick={() => setPreview(null)} className="rounded-xl border border-indigo-200 bg-white px-4 py-2.5 text-xs font-semibold text-indigo-800 disabled:opacity-50">返回修改</button>
        <button type="button" disabled={pending || !preview.canExecute} onClick={() => void executePreview()} className="rounded-xl bg-indigo-700 px-4 py-2.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">确认并执行</button>
      </div>
    </div> : null}
    {rejectPreview ? <div className="mt-5 rounded-2xl border border-rose-100 bg-rose-50 p-5" role="dialog" aria-label="拒绝会员申请确认"><p className="text-sm font-semibold text-rose-950">确认拒绝会员申请</p><p className="mt-2 text-xs leading-6 text-rose-800">该预览有效至 {dateTime(rejectPreview.preview.expiresAt)}，确认后申请将进入终态。</p><div className="mt-4 flex flex-wrap justify-end gap-3"><button type="button" disabled={pending} onClick={() => setRejectPreview(null)} className="rounded-xl border border-rose-200 bg-white px-4 py-2.5 text-xs font-semibold text-rose-800">取消</button><button type="button" disabled={pending} onClick={() => void executeRejectPreview()} className="rounded-xl bg-rose-700 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">确认并执行</button></div></div> : null}
    {message ? <p role="alert" className="mt-4 text-xs leading-6 text-rose-600">{message}</p> : null}
  </article>;
}
