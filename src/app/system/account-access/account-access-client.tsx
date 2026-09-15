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

type MatrixPermission = "owner" | "edit" | "view";
type MatrixReason =
  | "account_disabled"
  | "account_enabled"
  | "system_admin_role"
  | "system_user_role"
  | "membership_active"
  | "membership_not_started"
  | "membership_expired"
  | "membership_revoked"
  | "membership_none"
  | "workspace_membership_confirmed"
  | "workspace_membership_pending"
  | "workspace_membership_revoked"
  | "workspace_membership_missing"
  | "workspace_role_not_elevated"
  | "project_inheritance_enabled"
  | "project_inheritance_disabled"
  | "direct_project_assignment_confirmed"
  | "direct_project_assignment_pending"
  | "direct_project_assignment_revoked"
  | "direct_project_assignment_missing"
  | "no_effective_project_permission";
type MatrixMembership = {
  role: "owner" | "admin" | "member" | "viewer" | "editor";
  accessState: "pending" | "confirmed";
  recordedAt: string;
};
type MatrixRevocation = {
  recordedAt: string;
  evidence: {
    kind: "membership_access_audit" | "membership_record";
    action: "confirmed" | "revoked" | "migration_quarantined" | "bootstrap_confirmed";
  };
};
type AccessMatrix = {
  asOf: string;
  subject: { id: string; username: string; displayName: string | null };
  system: {
    role: "admin" | "user";
    accountState: AccountAccessState;
    effective: boolean;
    reasons: MatrixReason[];
    source: { kind: "app_user" };
  };
  commercial: {
    tier: "member" | "free";
    lifecycle: "none" | "not_started" | "active" | "expired" | "revoked";
    entitlementEffective: boolean;
    startsAt: string | null;
    expiresAt: string | null;
    reasons: MatrixReason[];
    source: { kind: "none" } | { kind: "membership_subscription"; recordedAt: string };
  };
  workspaces: {
    items: Array<{
      id: string;
      name: string;
      slug: string;
      current: MatrixMembership | null;
      latestRevocation: MatrixRevocation | null;
      effective: boolean;
      reasons: MatrixReason[];
      provenance: { kind: "workspace_membership" | "none" };
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  };
  projects: {
    items: Array<{
      id: string;
      name: string;
      slug: string;
      workspaceId: string;
      workspaceName: string;
      inheritanceMode: "workspaceInherited" | "projectOnly";
      archivedAt: string | null;
      direct: MatrixMembership | null;
      latestDirectRevocation: MatrixRevocation | null;
      inheritedFromWorkspace: {
        role: "owner" | "admin" | "member" | "viewer" | null;
        accessState: "pending" | "confirmed" | "revoked" | null;
        recordedAt: string | null;
        effective: boolean;
        provenance: { kind: "workspace_inherited_owner_or_admin" | "workspace_membership" | "none" };
      } | null;
      grantedPermission: MatrixPermission | null;
      effectivePermission: MatrixPermission | null;
      reasons: MatrixReason[];
      provenance: { kind: "direct_project_assignment" | "workspace_inherited_owner_or_admin" | "direct_and_workspace_inherited" | "workspace_membership" | "none" };
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  };
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

const matrixReasonLabels: Record<MatrixReason, string> = {
  account_disabled: "账号已停用",
  account_enabled: "账号已启用",
  system_admin_role: "系统管理员角色",
  system_user_role: "普通用户角色",
  membership_active: "会员有效期内",
  membership_not_started: "会员尚未开始",
  membership_expired: "会员已过期",
  membership_revoked: "会员已撤销",
  membership_none: "没有会员订阅",
  workspace_membership_confirmed: "工作区关系已确认",
  workspace_membership_pending: "工作区关系待确认",
  workspace_membership_revoked: "工作区关系已撤销",
  workspace_membership_missing: "没有工作区关系",
  workspace_role_not_elevated: "工作区角色不产生项目权限",
  project_inheritance_enabled: "项目启用工作区继承",
  project_inheritance_disabled: "项目未启用工作区继承",
  direct_project_assignment_confirmed: "项目直接授权已确认",
  direct_project_assignment_pending: "项目直接授权待确认",
  direct_project_assignment_revoked: "项目直接授权已撤销",
  direct_project_assignment_missing: "没有项目直接授权",
  no_effective_project_permission: "当前没有有效项目权限",
};

function matrixReasonLabel(reason: MatrixReason): string {
  return matrixReasonLabels[reason];
}

function matrixRoleLabel(role: MatrixMembership["role"] | null): string {
  if (role === null) return "—";
  return role === "admin" ? "管理员" : role === "owner" ? "Owner" : role === "editor" ? "Editor" : role === "member" ? "成员" : "Viewer";
}

function matrixPermissionLabel(permission: MatrixPermission | null): string {
  if (permission === null) return "无";
  return permission === "owner" ? "Owner" : permission === "edit" ? "可编辑" : "可查看";
}

function matrixLifecycleLabel(lifecycle: AccessMatrix["commercial"]["lifecycle"]): string {
  return lifecycle === "none" ? "无订阅" : lifecycle === "not_started" ? "未开始" : lifecycle === "active" ? "有效" : lifecycle === "expired" ? "已过期" : "已撤销";
}

function matrixSourceLabel(kind: AccessMatrix["projects"]["items"][number]["provenance"]["kind"]): string {
  return kind === "direct_project_assignment"
    ? "项目直接授权"
    : kind === "workspace_inherited_owner_or_admin"
      ? "工作区 Owner/Admin 继承"
      : kind === "direct_and_workspace_inherited"
        ? "直接授权 + 工作区继承"
        : kind === "workspace_membership" ? "工作区关系（不产生项目权限）" : "无授权来源";
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
  const [matrix, setMatrix] = useState<AccessMatrix | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixLoadingMore, setMatrixLoadingMore] = useState<"workspaces" | "projects" | null>(null);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const requestKeyRef = useRef(newRequestKey());
  const matrixRequestVersionRef = useRef(0);
  const isSelf = item.username === currentUsername;
  const nextAction: Action = item.state === "enabled" ? "disable" : "restore";

  async function loadMatrix(kind: "initial" | "workspaces" | "projects"): Promise<void> {
    if (matrixLoading || matrixLoadingMore !== null) return;
    const workspaceCursor = kind === "workspaces" ? matrix?.workspaces.nextCursor : undefined;
    const projectCursor = kind === "projects" ? matrix?.projects.nextCursor : undefined;
    if ((kind === "workspaces" && (workspaceCursor === null || workspaceCursor === undefined))
      || (kind === "projects" && (projectCursor === null || projectCursor === undefined))) return;
    const requestVersion = matrixRequestVersionRef.current;
    if (kind === "initial") setMatrixLoading(true);
    else setMatrixLoadingMore(kind);
    setMatrixError(null);
    try {
      const params = new URLSearchParams({ pageSize: "20" });
      if (workspaceCursor) params.set("workspaceCursor", workspaceCursor);
      if (projectCursor) params.set("projectCursor", projectCursor);
      const response = await fetch(`/api/system/account-access/${item.id}?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "有效访问矩阵加载失败"));
      const next = await response.json() as AccessMatrix;
      if (requestVersion === matrixRequestVersionRef.current) setMatrix(next);
    } catch (cause) {
      if (requestVersion === matrixRequestVersionRef.current) setMatrixError(cause instanceof Error ? cause.message : "有效访问矩阵加载失败");
    } finally {
      if (requestVersion === matrixRequestVersionRef.current) {
        if (kind === "initial") setMatrixLoading(false);
        else setMatrixLoadingMore(null);
      }
    }
  }

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
      matrixRequestVersionRef.current += 1;
      setMatrix(null);
      setMatrixError(null);
      setMatrixLoading(false);
      setMatrixLoadingMore(null);
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
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={matrixLoading || matrixLoadingMore !== null}
            onClick={() => matrix === null ? void loadMatrix("initial") : setMatrix(null)}
            aria-expanded={matrix !== null}
            aria-controls={`effective-access-matrix-${item.id}`}
            className="min-h-11 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm font-semibold text-indigo-800 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {matrixLoading ? "读取矩阵…" : matrix === null ? "查看有效访问矩阵" : "收起有效访问矩阵"}
          </button>
          <button type="button" disabled={pending || isSelf} onClick={() => void requestPreview()} className={`min-h-11 rounded-xl px-4 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${nextAction === "disable" ? "bg-rose-600 hover:bg-rose-700" : "bg-indigo-600 hover:bg-indigo-700"}`}>
            {isSelf ? "当前账号" : nextAction === "disable" ? "停用账号" : "恢复账号"}
          </button>
        </div>
      </div>

      {matrixError ? <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{matrixError}</p> : null}
      {matrix ? <EffectiveAccessMatrixView matrix={matrix} loadingMore={matrixLoadingMore} onLoadMore={(kind) => void loadMatrix(kind)} /> : null}

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

function EffectiveAccessMatrixView({
  matrix,
  loadingMore,
  onLoadMore,
}: {
  matrix: AccessMatrix;
  loadingMore: "workspaces" | "projects" | null;
  onLoadMore: (kind: "workspaces" | "projects") => void;
}) {
  return (
    <section id={`effective-access-matrix-${matrix.subject.id}`} className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4" aria-label="有效访问矩阵">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-indigo-950">有效访问矩阵</h3>
          <p className="mt-1 text-xs leading-5 text-indigo-800">统一查看系统角色、会员资格、工作区关系和项目权限。本页结果测量于 {formatDate(matrix.asOf)}；继续读取时会替换为下一页独立测量结果，只显示安全的授权来源标签。</p>
        </div>
        <span className="rounded-full bg-white px-2.5 py-1 text-[12px] font-semibold text-indigo-700">只读审计视图</span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MatrixStat label="系统角色" value={matrix.system.role === "admin" ? "系统管理员" : "普通用户"} detail={matrix.system.effective ? "当前有效" : "账号已停用"} />
        <MatrixStat label="商业会员" value={matrix.commercial.tier === "member" ? "会员" : "普通账户"} detail={`${matrixLifecycleLabel(matrix.commercial.lifecycle)} · ${matrix.commercial.entitlementEffective ? "权益有效" : "权益无效"}`} />
        <MatrixStat label="工作区" value={`${matrix.workspaces.items.length} 个`} detail={matrix.workspaces.hasMore ? "当前页 · 查看下一页" : "已全部显示"} />
        <MatrixStat label="项目" value={`${matrix.projects.items.length} 个`} detail={matrix.projects.hasMore ? "当前页 · 查看下一页" : "已全部显示"} />
      </dl>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl bg-white p-4">
          <h4 className="text-sm font-semibold text-slate-900">系统与商业资格</h4>
          <div className="mt-3 space-y-3 text-xs leading-5 text-slate-600">
            <MatrixLine label="系统状态" value={matrix.system.effective ? "启用" : "停用"} />
            <MatrixLine label="系统来源" value="AppUser 账号记录" />
            <MatrixLine label="会员有效期" value={`${formatDate(matrix.commercial.startsAt)} 至 ${formatDate(matrix.commercial.expiresAt)}`} />
            <MatrixLine label="会员来源" value={matrix.commercial.source.kind === "none" ? "无订阅记录" : `会员订阅记录（${formatDate(matrix.commercial.source.recordedAt)}）`} />
          </div>
          <ReasonList reasons={[...matrix.system.reasons, ...matrix.commercial.reasons]} />
        </div>

        <div className="rounded-xl bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-slate-900">工作区关系</h4>
            <span className="text-xs text-slate-500">{matrix.workspaces.hasMore ? "结果已分页" : "已全部显示"}</span>
          </div>
          {matrix.workspaces.items.length === 0 ? <p className="mt-3 text-xs leading-5 text-slate-500">没有工作区关系。系统管理员角色不会自动获得工作区或项目权限。</p> : <div className="mt-3 space-y-3">
            {matrix.workspaces.items.map((workspace) => <div key={workspace.id} className="rounded-xl border border-slate-100 px-3 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold text-slate-900">{workspace.name}</p>
                  <p className="mt-1 break-words text-xs text-slate-500">{workspace.slug} · {workspace.current === null ? "无当前关系" : `${matrixRoleLabel(workspace.current.role)} · ${workspace.current.accessState === "confirmed" ? "已确认" : "待确认"}`}</p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${workspace.effective ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{workspace.effective ? "当前有效" : "当前无效"}</span>
              </div>
              {workspace.latestRevocation ? <p className="mt-2 text-xs text-slate-500">最近撤销证据：{workspace.latestRevocation.evidence.kind === "membership_access_audit" ? "访问审计记录" : "关系记录"} · {formatDate(workspace.latestRevocation.recordedAt)}</p> : null}
              <ReasonList reasons={workspace.reasons} />
            </div>)}
          </div>}
          {matrix.workspaces.hasMore ? <button type="button" onClick={() => onLoadMore("workspaces")} disabled={loadingMore !== null} className="mt-3 min-h-11 w-full rounded-xl border border-indigo-200 px-4 py-3 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50">{loadingMore === "workspaces" ? "读取下一页…" : "查看下一页工作区"}</button> : null}
        </div>
      </div>

      <div className="mt-3 rounded-xl bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-900">项目权限</h4>
          <span className="text-xs text-slate-500">{matrix.projects.hasMore ? "结果已分页" : "已全部显示"}</span>
        </div>
        {matrix.projects.items.length === 0 ? <p className="mt-3 text-xs leading-5 text-slate-500">没有直接或工作区关联的项目。</p> : <div className="mt-3 grid gap-3 md:grid-cols-2">
          {matrix.projects.items.map((project) => <div key={project.id} className="rounded-xl border border-slate-100 px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold text-slate-900">{project.name}</p>
                <p className="mt-1 break-words text-xs text-slate-500">{project.workspaceName} · {project.inheritanceMode === "workspaceInherited" ? "继承工作区权限" : "仅项目直接权限"}{project.archivedAt ? " · 已归档" : ""}</p>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${project.effectivePermission === null ? "bg-slate-100 text-slate-600" : "bg-emerald-50 text-emerald-700"}`}>{matrixPermissionLabel(project.effectivePermission)}</span>
            </div>
            <dl className="mt-3 space-y-2 text-xs leading-5 text-slate-600">
              <MatrixLine label="关系计算结果" value={matrixPermissionLabel(project.grantedPermission)} />
              <MatrixLine label="当前有效权限" value={matrixPermissionLabel(project.effectivePermission)} />
              <MatrixLine label="直接关系" value={project.direct === null ? "无当前关系" : `${matrixRoleLabel(project.direct.role)} · ${project.direct.accessState === "confirmed" ? "已确认" : "待确认"}`} />
              <MatrixLine label="继承关系" value={project.inheritedFromWorkspace === null ? "无工作区关系" : `${matrixRoleLabel(project.inheritedFromWorkspace.role)} · ${project.inheritedFromWorkspace.accessState === "confirmed" ? "已确认" : project.inheritedFromWorkspace.accessState === "pending" ? "待确认" : "已撤销"}`} />
              <MatrixLine label="授权来源" value={matrixSourceLabel(project.provenance.kind)} />
            </dl>
            {project.latestDirectRevocation ? <p className="mt-2 text-xs text-slate-500">最近直接授权撤销证据：{project.latestDirectRevocation.evidence.kind === "membership_access_audit" ? "访问审计记录" : "关系记录"} · {formatDate(project.latestDirectRevocation.recordedAt)}</p> : null}
            <ReasonList reasons={project.reasons} />
          </div>)}
        </div>}
        {matrix.projects.hasMore ? <button type="button" onClick={() => onLoadMore("projects")} disabled={loadingMore !== null} className="mt-3 min-h-11 w-full rounded-xl border border-indigo-200 px-4 py-3 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50">{loadingMore === "projects" ? "读取下一页…" : "查看下一页项目"}</button> : null}
      </div>
    </section>
  );
}

function MatrixStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-xl border border-slate-100 bg-white px-3 py-3"><dt className="text-[12px] text-slate-500">{label}</dt><dd className="mt-1 text-sm font-semibold text-slate-900">{value}</dd><p className="mt-1 text-xs text-slate-500">{detail}</p></div>;
}

function MatrixLine({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-wrap justify-between gap-2"><dt className="text-slate-500">{label}</dt><dd className="text-right font-medium text-slate-800">{value}</dd></div>;
}

function ReasonList({ reasons }: { reasons: MatrixReason[] }) {
  return <ul className="mt-3 flex flex-wrap gap-2" aria-label="状态解释">{reasons.map((reason, index) => <li key={`${reason}-${index}`} className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] text-slate-600">{matrixReasonLabel(reason)}</li>)}</ul>;
}
