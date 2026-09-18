"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminPageHeader } from "@/components/admin-page-header";

type Summary = Readonly<{
  user: Readonly<{ id: string; username: string; displayName: string | null; state: "enabled" | "disabled"; disabledAt: string | null; accountAccessVersion: number }>;
  membership: Readonly<{ state: "none" | "active" | "expired" | "revoked"; status: "active" | "revoked" | null; startsAt: string | null; expiresAt: string | null; version: number }>;
  credits: Readonly<{ grantCount: number; activeGrantCount: number; availableTokens: number; reservedTokens: number; difference: string }>;
}>;

type Detail = Readonly<{
  summary: Summary;
  membershipApplication: Readonly<{
    id: string;
    status: "pending" | "fulfilled" | "rejected" | "withdrawn";
    statusVersion: number;
    submittedAt: string;
    fulfilledAt: string | null;
    rejectedAt: string | null;
    withdrawnAt: string | null;
  }> | null;
  records: Readonly<{
    account: readonly Readonly<{ event: string; version: number; occurredAt: string }>[];
    membership: readonly Readonly<{ event: string; status: string; version: number | null; occurredAt: string }>[];
    credits: readonly Readonly<{ event: string; status: string; version: number; amount: number; remainingTokens: number; occurredAt: string }>[];
  }>;
}>;

type AccountPreview = Readonly<{
  action: "disable" | "restore";
  user: Readonly<{ username: string; state: "enabled" | "disabled" }>;
  current: Readonly<{ accountAccessVersion: number; state: "enabled" | "disabled"; sessionCount: number }>;
  target: Readonly<{ accountAccessVersion: number; state: "enabled" | "disabled"; sessionCount: number }>;
  blockingCategories: readonly string[];
  canExecute: boolean;
  impactFingerprint: string;
  requestFingerprint: string;
  previewId: string;
  previewIssuedAt: string;
  previewExpiresAt: string;
}>;

type MembershipPreview = Readonly<{
  action: "grant" | "extend" | "revoke";
  current: Readonly<{ state: string; version: number }>;
  target: Readonly<{ state: string; version: number; startsAt: string; expiresAt: string }>;
  blockingCategories: readonly string[];
  canExecute: boolean;
  impactFingerprint: string;
  requestFingerprint: string;
  previewId: string;
  requestKey?: string;
  issuedAt: string;
  expiresAt: string;
  previewIssuedAt: string;
  previewExpiresAt: string;
  applicationId: string | null;
}>;

type ApplicationRejectPreview = Readonly<{
  preview: Readonly<{
    id: string;
    applicationId: string;
    action: "reject";
    requestKey: string;
    requestFingerprint: string;
    impactFingerprint: string;
    issuedAt: string;
    expiresAt: string;
  }>;
}>;

function date(value: string | null): string {
  return value === null ? "—" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function newRequestKey(prefix: string): string {
  try {
    return `${prefix}:${globalThis.crypto.randomUUID()}`;
  } catch {
    return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
  }
}

const adminInputClass = "mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-normal outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function AdminUserDetailClient({ userId }: { userId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accountPreview, setAccountPreview] = useState<AccountPreview | null>(null);
  const [membershipPreview, setMembershipPreview] = useState<MembershipPreview | null>(null);
  const [rejectPreview, setRejectPreview] = useState<ApplicationRejectPreview | null>(null);
  const [reason, setReason] = useState("");
  const [applicationReason, setApplicationReason] = useState("");
  const [membershipNote, setMembershipNote] = useState("");
  const [days, setDays] = useState("30");
  const [confirmationUsername, setConfirmationUsername] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/users/${userId}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "用户运营详情加载失败"));
      setDetail(await response.json() as Detail);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "用户运营详情加载失败");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const summary = detail?.summary ?? null;
  const nextAccountAction = summary?.user.state === "disabled" ? "restore" : "disable";
  const membershipAction = useMemo<"grant" | "extend" | "revoke">(() => {
    if (summary?.membership.state === "active") return "extend";
    return "grant";
  }, [summary?.membership.state]);

  async function previewAccount(): Promise<void> {
    if (summary === null) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/system/account-access/${userId}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: nextAccountAction, reason: reason.trim(), expectedVersion: summary.user.accountAccessVersion }),
      });
      if (!response.ok) throw new Error(await readError(response, "账号状态预览失败"));
      setAccountPreview((await response.json() as { preview: AccountPreview }).preview);
      setConfirmationUsername("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "账号状态预览失败");
    } finally {
      setPending(false);
    }
  }

  async function executeAccount(): Promise<void> {
    if (accountPreview === null || summary === null) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/system/account-access/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: accountPreview.action,
          reason: reason.trim(),
          expectedVersion: accountPreview.current.accountAccessVersion,
          expectedImpactFingerprint: accountPreview.impactFingerprint,
          requestKey: newRequestKey("account"),
          requestFingerprint: accountPreview.requestFingerprint,
          previewId: accountPreview.previewId,
          previewIssuedAt: accountPreview.previewIssuedAt,
          previewExpiresAt: accountPreview.previewExpiresAt,
          confirmation: true,
          confirmationUsername,
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "账号状态变更失败"));
      setAccountPreview(null);
      setReason("");
      await load();
      setMessage(accountPreview.action === "disable" ? "账号已停用。" : "账号已恢复。 ");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "账号状态变更失败");
    } finally {
      setPending(false);
    }
  }

  async function previewMembership(): Promise<void> {
    if (summary === null) return;
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
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
          userId,
          action: membershipAction,
          days: value,
          note: membershipNote.trim() || null,
          expectedVersion: summary.membership.version,
          applicationId: membershipAction === "grant" && detail?.membershipApplication?.status === "pending"
            ? detail.membershipApplication.id
            : undefined,
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "会员变更预览失败"));
      setMembershipPreview((await response.json() as { preview: MembershipPreview }).preview);
      setConfirmationUsername("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "会员变更预览失败");
    } finally {
      setPending(false);
    }
  }

  async function previewRejectApplication(): Promise<void> {
    const application = detail?.membershipApplication;
    if (application === undefined || application === null || application.status !== "pending") return;
    if (applicationReason.trim().length === 0) {
      setMessage("拒绝会员申请必须填写原因");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/system/membership-applications/reject/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ applicationId: application.id, requestKey: newRequestKey("membership-reject"), reason: applicationReason.trim() }),
      });
      if (!response.ok) throw new Error(await readError(response, "拒绝申请预览失败"));
      const body = await response.json() as ApplicationRejectPreview;
      setRejectPreview(body);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "拒绝申请预览失败");
    } finally {
      setPending(false);
    }
  }

  async function executeRejectApplication(): Promise<void> {
    if (rejectPreview === null) return;
    setPending(true);
    setMessage(null);
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
      if (!response.ok) throw new Error(await readError(response, "拒绝申请失败"));
      setRejectPreview(null);
      setApplicationReason("");
      await load();
      setMessage("会员申请已拒绝。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "拒绝申请失败");
    } finally {
      setPending(false);
    }
  }

  async function previewRevokeMembership(): Promise<void> {
    if (summary === null || reason.trim().length === 0) {
      setMessage("撤销会员必须填写原因");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/system/memberships/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, action: "revoke", reason: reason.trim(), expectedVersion: summary.membership.version }),
      });
      if (!response.ok) throw new Error(await readError(response, "会员撤销预览失败"));
      setMembershipPreview((await response.json() as { preview: MembershipPreview }).preview);
      setConfirmationUsername("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "会员撤销预览失败");
    } finally {
      setPending(false);
    }
  }

  async function executeMembership(): Promise<void> {
    if (membershipPreview === null || summary === null) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/system/memberships/${userId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: membershipPreview.action,
          days: membershipPreview.action === "revoke" ? undefined : Number(days),
          note: membershipPreview.action === "revoke" ? undefined : membershipNote.trim() || null,
          reason: membershipPreview.action === "revoke" ? reason.trim() : undefined,
          expectedVersion: membershipPreview.current.version,
          expectedImpactFingerprint: membershipPreview.impactFingerprint,
          requestKey: newRequestKey("membership"),
          requestFingerprint: membershipPreview.requestFingerprint,
          previewId: membershipPreview.previewId,
          previewIssuedAt: membershipPreview.previewIssuedAt,
          previewExpiresAt: membershipPreview.previewExpiresAt,
          confirmation: true,
          confirmationUsername: membershipPreview.action === "revoke" ? confirmationUsername : undefined,
          applicationId: membershipPreview.applicationId ?? undefined,
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "会员变更失败"));
      setMembershipPreview(null);
      setMembershipNote("");
      if (membershipPreview.action === "revoke") setReason("");
      await load();
      setMessage("会员状态已更新。 ");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "会员变更失败");
    } finally {
      setPending(false);
    }
  }

  if (loading && detail === null) return <div className="w-full px-4 py-8 text-sm text-slate-500 sm:px-5 lg:px-6">读取中…</div>;
  if (error || summary === null || detail === null) return <div className="w-full px-4 py-8 sm:px-5 lg:px-6"><p role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error ?? "普通用户不存在"}</p><Link href="/admin/users" className="mt-5 inline-flex text-sm font-semibold text-indigo-700">返回用户运营</Link></div>;

  return <div className="w-full px-4 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title={summary.user.displayName ?? summary.user.username} description={`${summary.user.username} · 统一处理账号状态、会员和额度；危险变更会先预览并在执行前重新校验。`} actions={<span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${summary.user.state === "enabled" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{summary.user.state === "enabled" ? "账号已启用" : "账号已停用"}</span>} />

    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" aria-labelledby="account-section-title">
        <div className="flex items-start justify-between gap-4"><div><h2 id="account-section-title" className="text-lg font-semibold">账号状态</h2><p className="mt-1 text-xs text-slate-500">{summary.user.state === "disabled" ? `停用于 ${date(summary.user.disabledAt)}` : "当前可登录"}</p></div><button type="button" onClick={() => void previewAccount()} disabled={pending || reason.trim().length === 0} className={`rounded-xl px-3 py-2 text-xs font-semibold text-white disabled:opacity-50 ${nextAccountAction === "disable" ? "bg-rose-700" : "bg-indigo-700"}`}>{nextAccountAction === "disable" ? "预览停用" : "预览恢复"}</button></div>
        <label className="mt-5 block text-xs font-semibold text-slate-600">操作原因<input value={reason} onChange={(event) => { setReason(event.target.value); setAccountPreview(null); }} maxLength={500} placeholder="填写本次运营操作原因" className={adminInputClass} /></label>
        {accountPreview ? <div role="region" aria-label="账号状态变更预览" className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50 p-4"><p className="text-xs leading-5 text-indigo-950">预览：{accountPreview.current.state === "enabled" ? "启用" : "停用"} → {accountPreview.target.state}；现有会话 {accountPreview.current.sessionCount} → {accountPreview.target.sessionCount}。</p><label className="mt-3 block text-xs font-semibold text-indigo-950">输入用户名确认<input value={confirmationUsername} onChange={(event) => setConfirmationUsername(event.target.value)} maxLength={64} className={adminInputClass} /></label><button type="button" onClick={() => void executeAccount()} disabled={pending || !accountPreview.canExecute || confirmationUsername !== summary.user.username} className="mt-3 rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">确认并执行</button></div> : null}
        <RecordList records={detail.records.account.map((record) => ({ label: record.event, value: date(record.occurredAt) }))} empty="暂无账号变更记录" />
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" aria-labelledby="membership-section-title">
        <div className="flex items-start justify-between gap-4"><div><h2 id="membership-section-title" className="text-lg font-semibold">会员状态</h2><p className="mt-1 text-xs text-slate-500">{summary.membership.state === "active" ? `有效期至 ${date(summary.membership.expiresAt)}` : "当前没有有效会员"}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-[12px] font-semibold text-slate-600">{summary.membership.state === "active" ? "有效" : summary.membership.state === "none" ? "未开通" : "已结束"}</span></div>
        {detail.membershipApplication ? <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-xs leading-5 text-indigo-950"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">会员申请：{detail.membershipApplication.status === "pending" ? "待处理" : detail.membershipApplication.status === "fulfilled" ? "已完成" : detail.membershipApplication.status === "rejected" ? "已拒绝" : "已撤回"}</span><span>提交于 {date(detail.membershipApplication.submittedAt)}</span></div>{detail.membershipApplication.status === "fulfilled" ? <p className="mt-1">完成于 {date(detail.membershipApplication.fulfilledAt)}</p> : null}{detail.membershipApplication.status === "rejected" ? <p className="mt-1">拒绝于 {date(detail.membershipApplication.rejectedAt)}</p> : null}{detail.membershipApplication.status === "withdrawn" ? <p className="mt-1">撤回于 {date(detail.membershipApplication.withdrawnAt)}</p> : null}{detail.membershipApplication.status === "pending" ? <><label className="mt-3 block text-xs font-semibold text-indigo-950">拒绝原因<input value={applicationReason} onChange={(event) => { setApplicationReason(event.target.value); setRejectPreview(null); }} maxLength={500} placeholder="填写拒绝原因" className={adminInputClass} /></label><button type="button" disabled={pending} onClick={() => void previewRejectApplication()} className="mt-3 rounded-xl border border-indigo-200 bg-white px-3 py-2 font-semibold text-indigo-700 disabled:opacity-50">预览拒绝申请</button></> : null}</div> : null}
        <div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-600">天数<input type="number" min={1} max={3650} value={days} onChange={(event) => setDays(event.target.value)} className={adminInputClass} /></label><label className="text-xs font-semibold text-slate-600">备注<input value={membershipNote} onChange={(event) => setMembershipNote(event.target.value)} maxLength={500} className={adminInputClass} /></label></div>
        <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => void previewMembership()} disabled={pending} className="rounded-xl bg-indigo-700 px-3 py-2.5 text-xs font-semibold text-white disabled:opacity-50">预览{membershipAction === "extend" ? "延期" : "授予"}</button>{summary.membership.state === "active" ? <button type="button" onClick={() => void previewRevokeMembership()} disabled={pending} className="rounded-xl border border-rose-200 px-3 py-2.5 text-xs font-semibold text-rose-700 disabled:opacity-50">预览撤销</button> : null}</div>
        {membershipPreview ? <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50 p-4"><p className="text-xs leading-5 text-indigo-950">预览：{membershipPreview.current.state} → {membershipPreview.target.state}，有效期至 {date(membershipPreview.target.expiresAt)}。</p>{membershipPreview.blockingCategories.length > 0 ? <p className="mt-2 text-xs text-rose-700">当前存在待处理阻塞项，请先完成依赖处理后重新预览。</p> : null}{membershipPreview.action === "revoke" ? <label className="mt-3 block text-xs font-semibold text-indigo-950">输入用户名确认<input value={confirmationUsername} onChange={(event) => setConfirmationUsername(event.target.value)} maxLength={64} className={adminInputClass} /></label> : null}<button type="button" onClick={() => void executeMembership()} disabled={pending || !membershipPreview.canExecute || (membershipPreview.action === "revoke" && confirmationUsername !== summary.user.username)} className="mt-3 rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">确认并执行</button></div> : null}
        {rejectPreview ? <div className="mt-4 rounded-2xl border border-rose-100 bg-rose-50 p-4" role="dialog" aria-label="拒绝会员申请确认"><p className="text-sm font-semibold text-rose-950">确认拒绝会员申请</p><p className="mt-2 text-xs leading-5 text-rose-800">该预览有效至 {date(rejectPreview.preview.expiresAt)}，确认后申请状态将变为已拒绝。</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={pending} onClick={() => setRejectPreview(null)} className="rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-800">取消</button><button type="button" disabled={pending} onClick={() => void executeRejectApplication()} className="rounded-xl bg-rose-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">确认并执行</button></div></div> : null}
        <RecordList records={detail.records.membership.map((record) => ({ label: record.event, value: `${record.status} · ${date(record.occurredAt)}` }))} empty="暂无会员变更记录" />
      </section>
    </div>

    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm" aria-labelledby="credits-summary-title"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 id="credits-summary-title" className="text-lg font-semibold">额度摘要</h2><p className="mt-1 text-xs text-slate-500">{summary.credits.difference} · {summary.credits.activeGrantCount} 条有效记录 · 可用 {summary.credits.availableTokens.toLocaleString()} · 预留 {summary.credits.reservedTokens.toLocaleString()}</p></div><Link href={`/admin/credits?userId=${encodeURIComponent(userId)}`} className="rounded-xl bg-indigo-700 px-3 py-2.5 text-xs font-semibold text-white">进入额度操作</Link></div><RecordList records={detail.records.credits.map((record) => ({ label: record.event, value: `${record.status} · ${record.amount.toLocaleString()} / ${record.remainingTokens.toLocaleString()} · ${date(record.occurredAt)}` }))} empty="暂无额度变更记录" /></section>
    {message ? <p role="status" className="mt-4 rounded-2xl bg-slate-100 px-4 py-3 text-xs leading-5 text-slate-700">{message}</p> : null}
  </div>;
}

function RecordList({ records, empty }: { records: readonly Readonly<{ label: string; value: string }>[]; empty: string }) {
  return <div className="mt-5 border-t border-slate-100 pt-4"><h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">最近记录</h3>{records.length === 0 ? <p className="mt-3 text-xs text-slate-500">{empty}</p> : <div className="mt-2 divide-y divide-slate-100">{records.slice(0, 5).map((record, index) => <div key={`${record.label}-${index}`} className="flex items-center justify-between gap-3 py-2 text-xs"><span className="font-medium text-slate-700">{record.label}</span><span className="text-right text-slate-500">{record.value}</span></div>)}</div>}</div>;
}
