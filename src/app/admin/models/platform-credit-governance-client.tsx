"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type Grant = Readonly<{
  id: string;
  userId: string;
  username: string;
  displayName: string | null;
  kind: "signup" | "manual";
  amount: number;
  remainingTokens: number;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  version: number;
  status: "active" | "expired" | "revoked";
  blockerCount: number;
}>;

type TargetUser = Readonly<{
  id: string;
  username: string;
  displayName: string | null;
  disabled: boolean;
  grantCount: number;
  activeGrantCount: number;
  availableTokens: number;
  reservedTokens: number;
  difference: "disabled" | "missing" | "available" | "exhausted" | "expired" | "revoked";
}>;

const differenceLabel: Readonly<Record<TargetUser["difference"], string>> = {
  disabled: "账号已停用",
  missing: "缺少额度",
  available: "额度可用",
  exhausted: "额度已用尽",
  expired: "额度已过期",
  revoked: "额度已撤销",
};

type Preview = Readonly<{
  previewId: string;
  action: "grant" | "revoke";
  target: Readonly<{ id: string; username: string; displayName: string | null; disabled: boolean }>;
  grant: Readonly<{ id: string | null; amount: number | null; expiresAt: string | null; remainingTokens: number | null; version: number }>;
  reclaimableTokens: number;
  blockerCount: number;
  blockingCategories: readonly string[];
  canExecute: boolean;
  expectedVersion: number;
  expectedRemainingTokens: number | null;
  impactFingerprint: string;
  requestFingerprint: string;
  requestKey: string;
  reason: string;
  issuedAt: string;
  expiresAt: string;
}>;

function formatDate(value: string | null): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function newRequestKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function PlatformCreditGovernancePanel({ focusUserId }: { focusUserId?: string } = {}) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [users, setUsers] = useState<TargetUser[]>([]);
  const [grantPage, setGrantPage] = useState(1);
  const [userPage, setUserPage] = useState(1);
  const [grantsHasNextPage, setGrantsHasNextPage] = useState(false);
  const [usersHasNextPage, setUsersHasNextPage] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState(focusUserId ?? "");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState("");
  const [confirmationUsername, setConfirmationUsername] = useState("");
  const [grantAmount, setGrantAmount] = useState("500000");
  const [grantExpiresAt, setGrantExpiresAt] = useState(() => new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 16));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ grantPage: String(grantPage), grantPageSize: "10", userPage: String(userPage), userPageSize: "10" });
      if (focusUserId !== undefined) params.set("userId", focusUserId);
      if (search.trim()) params.set("search", search.trim());
      const response = await fetch(`/api/admin/credits/grants?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "平台额度读取失败"));
      const payload = await response.json() as {
        grants: Grant[];
        users: TargetUser[];
        grantsHasNextPage?: boolean;
        usersHasNextPage?: boolean;
      };
      setGrants(payload.grants);
      setUsers(payload.users);
      setGrantsHasNextPage(payload.grantsHasNextPage === true);
      setUsersHasNextPage(payload.usersHasNextPage === true);
      setSelectedUserId((current) => focusUserId ?? (payload.users.some((user) => user.id === current && !user.disabled)
        ? current
        : payload.users.find((user) => !user.disabled)?.id ?? ""));
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "平台额度读取失败");
    } finally {
      setLoading(false);
    }
  }, [focusUserId, grantPage, search, userPage]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectedUser = useMemo(() => users.find((user) => user.id === selectedUserId), [selectedUserId, users]);

  async function previewGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedUser === undefined || selectedUser.disabled) {
      setMessage("请先搜索并选择一个可用用户。");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/credits/grants/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "grant", userId: selectedUser.id, amount: Number(grantAmount), expiresAt: new Date(grantExpiresAt).toISOString(), requestKey: newRequestKey("grant"), reason }),
      });
      if (!response.ok) throw new Error(await readError(response, "平台额度补发预览失败"));
      const payload = await response.json() as { preview: Preview };
      setPreview(payload.preview);
      setConfirmationUsername("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "平台额度补发预览失败");
    } finally {
      setPending(false);
    }
  }

  async function previewRevoke(grant: Grant) {
    if (grant.kind !== "manual" || grant.status === "revoked") return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/credits/grants/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke", grantId: grant.id, requestKey: newRequestKey("revoke"), reason }),
      });
      if (!response.ok) throw new Error(await readError(response, "平台额度撤销预览失败"));
      const payload = await response.json() as { preview: Preview };
      setPreview(payload.preview);
      setConfirmationUsername("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "平台额度撤销预览失败");
    } finally {
      setPending(false);
    }
  }

  async function executePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preview === null) return;
    setPending(true);
    setMessage(null);
    try {
      const body = {
        action: preview.action,
        userId: preview.target.id,
        grantId: preview.grant.id,
        amount: preview.action === "grant" ? preview.grant.amount : null,
        expiresAt: preview.action === "grant" ? preview.grant.expiresAt : null,
        previewId: preview.previewId,
        expectedVersion: preview.expectedVersion,
        expectedRemainingTokens: preview.expectedRemainingTokens,
        impactFingerprint: preview.impactFingerprint,
        requestFingerprint: preview.requestFingerprint,
        requestKey: preview.requestKey,
        reason: preview.reason,
        previewIssuedAt: preview.issuedAt,
        previewExpiresAt: preview.expiresAt,
        confirmation: true,
        confirmationUsername,
      };
      const response = await fetch("/api/admin/credits/grants/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readError(response, "平台额度变更执行失败"));
      setPreview(null);
      setReason("");
      setConfirmationUsername("");
      await load();
      setMessage(preview.action === "grant" ? "平台额度已补发。" : "平台额度已撤销。 ");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "平台额度变更执行失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8" aria-labelledby="platform-credit-governance-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Platform credits</p>
          <h2 id="platform-credit-governance-title" className="mt-2 text-2xl font-semibold">平台额度治理</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">人工补发和撤销都必须先生成预览，再输入目标用户名确认。撤销只回收当前可用余额，不修改已结算额度。</p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{loading ? "读取中…" : `${grants.length} 条记录`}</span>
      </div>

      {focusUserId === undefined ? <div className="mt-6 flex flex-wrap items-end gap-3">
        <label className="min-w-56 flex-1 text-xs font-medium text-slate-600">搜索用户<input value={search} onChange={(event) => { setSearch(event.target.value); setGrantPage(1); setUserPage(1); }} placeholder="用户名或显示名" maxLength={160} className="edit-field" /></label>
        <button type="button" onClick={() => void load()} disabled={pending} className="rounded-xl border border-slate-200 px-4 py-3 text-xs font-semibold text-slate-700 disabled:opacity-50">刷新</button>
      </div> : null}

      {focusUserId === undefined ? <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-100">
        <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-800">逐用户额度差异</h3>
          <p className="mt-1 text-xs text-slate-500">包含尚无额度、已用尽、已过期、已撤销和停用账号；活动预留单独列示。</p>
        </div>
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr><th className="px-4 py-3 font-semibold">用户</th><th className="px-4 py-3 font-semibold">差异状态</th><th className="px-4 py-3 font-semibold">额度记录</th><th className="px-4 py-3 font-semibold">可用 / 预留</th></tr></thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {users.map((user) => <tr key={user.id}>
              <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-800">{user.username}{user.displayName ? <span className="ml-2 font-normal text-slate-400">{user.displayName}</span> : null}</td>
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{differenceLabel[user.difference]}</td>
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{user.activeGrantCount} 活动 / {user.grantCount} 总计</td>
              <td className="whitespace-nowrap px-4 py-3 text-slate-600">{user.availableTokens.toLocaleString()} / {user.reservedTokens.toLocaleString()}</td>
            </tr>)}
            {!loading && users.length === 0 ? <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500">暂无匹配用户。</td></tr> : null}
          </tbody>
        </table>
        <div className="flex items-center justify-between border-t border-slate-100 bg-white px-4 py-3 text-xs text-slate-500">
          <span>用户第 {userPage} 页</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setUserPage((page) => Math.max(1, page - 1))} disabled={loading || userPage === 1} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold text-slate-700 disabled:opacity-50">上一页</button>
            <button type="button" onClick={() => setUserPage((page) => page + 1)} disabled={loading || !usersHasNextPage} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold text-slate-700 disabled:opacity-50">下一页</button>
          </div>
        </div>
      </div> : null}

      <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-100">
        <div className="border-b border-slate-100 bg-slate-50 px-4 py-3"><h3 className="text-sm font-semibold text-slate-800">额度记录</h3></div>
        <table className="min-w-full text-left text-xs">
          <thead className="bg-slate-50 text-slate-500"><tr><th className="px-4 py-3 font-semibold">用户</th><th className="px-4 py-3 font-semibold">类型</th><th className="px-4 py-3 font-semibold">额度 / 剩余</th><th className="px-4 py-3 font-semibold">状态 / 到期</th><th className="px-4 py-3 font-semibold">操作</th></tr></thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {grants.map((grant) => (
              <tr key={grant.id}>
                <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-800">{grant.username}{grant.displayName ? <span className="ml-2 font-normal text-slate-400">{grant.displayName}</span> : null}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{grant.kind === "manual" ? "人工补发" : "新注册赠送"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{grant.amount.toLocaleString()} / {grant.remainingTokens.toLocaleString()}</td>
                <td className="whitespace-nowrap px-4 py-3 text-slate-600">{grant.status === "active" ? "可用" : grant.status === "expired" ? "已过期" : "已撤销"} · {formatDate(grant.expiresAt)}</td>
                <td className="whitespace-nowrap px-4 py-3">{grant.kind === "manual" && grant.status !== "revoked" ? <button type="button" disabled={pending} onClick={() => void previewRevoke(grant)} className="rounded-lg border border-rose-200 px-3 py-2 font-semibold text-rose-700 disabled:opacity-50">预览撤销</button> : <span className="text-slate-400">不可撤销</span>}</td>
              </tr>
            ))}
            {!loading && grants.length === 0 ? <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-500">暂无平台额度记录。</td></tr> : null}
          </tbody>
        </table>
        <div className="flex items-center justify-between border-t border-slate-100 bg-white px-4 py-3 text-xs text-slate-500">
          <span>额度记录第 {grantPage} 页</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setGrantPage((page) => Math.max(1, page - 1))} disabled={loading || grantPage === 1} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold text-slate-700 disabled:opacity-50">上一页</button>
            <button type="button" onClick={() => setGrantPage((page) => page + 1)} disabled={loading || !grantsHasNextPage} className="rounded-lg border border-slate-200 px-3 py-2 font-semibold text-slate-700 disabled:opacity-50">下一页</button>
          </div>
        </div>
      </div>

      <form onSubmit={previewGrant} className="mt-6 grid gap-4 border-t border-slate-100 pt-6 sm:grid-cols-4">
        {focusUserId === undefined ? <label className="text-xs font-medium text-slate-600 sm:col-span-4">补发目标<select value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)} required className="edit-field"><option value="">请选择搜索结果中的用户</option>{users.map((user) => <option key={user.id} value={user.id} disabled={user.disabled}>{user.username}{user.displayName ? ` · ${user.displayName}` : ""}{user.disabled ? " · 已停用" : ""}</option>)}</select></label> : <p className="text-xs font-medium text-slate-600 sm:col-span-4">当前用户：{selectedUser?.username ?? "读取中…"}</p>}
        <label className="text-xs font-medium text-slate-600">补发额度<input type="number" min={1} max={10_000_000} value={grantAmount} onChange={(event) => setGrantAmount(event.target.value)} required className="edit-field" /></label>
        <label className="text-xs font-medium text-slate-600">到期时间<input type="datetime-local" value={grantExpiresAt} onChange={(event) => setGrantExpiresAt(event.target.value)} required className="edit-field" /></label>
        <label className="text-xs font-medium text-slate-600 sm:col-span-2">原因（必填）<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required className="edit-field" /></label>
        <div className="sm:col-span-4 flex items-center justify-between gap-4"><p className="text-xs text-slate-500">搜索会覆盖尚无额度记录的本地用户；执行前仍会再次校验目标状态与用户角色。</p><button disabled={pending || selectedUser === undefined || selectedUser.disabled} className="rounded-xl bg-indigo-600 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50">{pending ? "处理中…" : "预览补发"}</button></div>
      </form>

      {preview ? <form onSubmit={executePreview} className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50/60 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="font-semibold text-slate-900">确认{preview.action === "grant" ? "补发" : "撤销"}平台额度</h3><p className="mt-2 text-xs leading-5 text-slate-600">目标：{preview.target.username}；{preview.action === "grant" ? `补发 ${preview.grant.amount?.toLocaleString() ?? "—"}，到期 ${formatDate(preview.grant.expiresAt)}` : `可回收 ${preview.reclaimableTokens.toLocaleString()}，阻塞预留 ${preview.blockerCount} 笔`}。预览有效至 {formatDate(preview.expiresAt)}。</p></div><button type="button" onClick={() => setPreview(null)} className="text-xs font-semibold text-slate-500">取消</button></div>
        {preview.blockerCount > 0 ? <p className="mt-3 text-xs text-rose-700">当前存在活动预留，撤销会被拒绝；请先完成账务核对。</p> : null}
        <label className="mt-4 block text-xs font-medium text-slate-600">输入目标用户名确认<input value={confirmationUsername} onChange={(event) => setConfirmationUsername(event.target.value)} maxLength={64} required className="edit-field" /></label>
        <button disabled={pending || !preview.canExecute} className="mt-4 rounded-xl bg-slate-950 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50">{pending ? "处理中…" : "确认并执行"}</button>
      </form> : null}
      {message ? <p role="status" className="mt-4 text-xs leading-5 text-slate-600">{message}</p> : null}
    </section>
  );
}
