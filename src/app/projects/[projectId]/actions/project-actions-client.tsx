"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useState } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { AppHeader } from "@/components/app-header";
import { ListPagination } from "@/components/list-pagination";
import { ProjectManagementParentLink } from "@/components/project-parent-link";

type CapabilityId = "project.repository.sync" | "project.web-source.sync" | "project.memory-quality.scan" | "project.mcp.read-tool.invoke";
type PolicyMode = "automatic" | "approvalRequired" | "denied";
type Capability = { id: CapabilityId; label: string; description: string; riskLevel: "low" | "medium" | "high"; defaultPolicy: PolicyMode; effect: "local" | "external-read" };
type Policy = { capability: CapabilityId; mode: PolicyMode; inherited: boolean; updatedAt: string | null; updatedBy: { username: string; displayName: string | null } | null };
type Audit = { id: string; event: string; details: unknown; createdAt: string; actor: { username: string; displayName: string | null } | null };
type Action = {
  id: string;
  capability: CapabilityId;
  riskLevel: "low" | "medium" | "high";
  status: "waitingApproval" | "queued" | "running" | "succeeded" | "failed" | "rejected" | "cancelled" | "expired";
  input: unknown;
  inputFingerprint: string;
  policyModeSnapshot: PolicyMode;
  approvalExpiresAt: string | null;
  attemptCount: number;
  result: unknown;
  resultImport: null | {
    id: string;
    resultFingerprint: string;
    contentFingerprint: string;
    createdAt: string;
    projectSource: { id: string; kind: "mcp"; ingestedAt: string };
    importedBy: { id: string; username: string; displayName: string | null };
  };
  failureCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  requestedBy: { id: string; username: string; displayName: string | null };
  approval: { decision: "approved" | "rejected"; note: string | null; decidedAt: string; decidedBy: { username: string; displayName: string | null } } | null;
  audits: Audit[];
  canCancel: boolean;
};
type Center = { catalog: Capability[]; policies: Policy[]; actions: Action[]; importableActions: Action[]; pagination: { page: number; pageSize: number; total: number; totalPages: number }; canManagePolicies: boolean; canApprove: boolean; canImportResults: boolean; archived: boolean };

const modeLabels: Record<PolicyMode, string> = { automatic: "自动执行", approvalRequired: "每次审批", denied: "禁止执行" };
const statusLabels: Record<Action["status"], string> = {
  waitingApproval: "等待审批", queued: "已排队", running: "执行中", succeeded: "已完成", failed: "失败", rejected: "已拒绝", cancelled: "已取消", expired: "已过期",
};
const auditLabels: Record<string, string> = {
  requested: "创建动作", queued: "进入队列", approvalRequested: "请求审批", approved: "批准", rejected: "拒绝", cancelled: "取消", claimed: "Worker 已领取", succeeded: "执行完成", failed: "执行失败", expired: "审批过期",
};

async function responseError(response: Response, fallback: string) {
  try { return (await response.json() as { error?: { message?: string } }).error?.message ?? fallback; }
  catch { return fallback; }
}

function displayUser(user: { username: string; displayName: string | null } | null) {
  return user?.displayName?.trim() || user?.username || "系统 Worker";
}

function badgeTone(status: Action["status"]) {
  if (status === "succeeded") return "bg-emerald-50 text-emerald-700";
  if (["failed", "rejected", "expired"].includes(status)) return "bg-rose-50 text-rose-700";
  if (status === "waitingApproval") return "bg-amber-50 text-amber-700";
  if (status === "running") return "bg-indigo-50 text-indigo-700";
  return "bg-slate-100 text-slate-600";
}

function mcpInput(value: unknown): { toolName: string; arguments: unknown } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return typeof input.toolName === "string" ? { toolName: input.toolName, arguments: input.arguments } : null;
}

function mcpResultFingerprint(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fingerprint = (value as Record<string, unknown>).resultFingerprint;
  return typeof fingerprint === "string" && /^[0-9a-f]{64}$/u.test(fingerprint) ? fingerprint : null;
}

type ProjectActionsClientProps = { username: string; projectId: string };

export function ProjectActionsClient(props: ProjectActionsClientProps) {
  const { confirm, dialog } = useAppConfirmDialog();
  return <>{dialog}<ProjectActionsContent {...props} confirm={confirm} /></>;
}

function ProjectActionsContent({ username, projectId, confirm }: ProjectActionsClientProps & { confirm: ReturnType<typeof useAppConfirmDialog>["confirm"] }) {
  const [center, setCenter] = useState<Center | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [capabilityFilter, setCapabilityFilter] = useState<"all" | CapabilityId>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | Action["status"]>("all");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: "20", capability: capabilityFilter, status: statusFilter, ...(deferredSearch.trim() ? { search: deferredSearch.trim() } : {}) });
      const response = await fetch(`/api/projects/${projectId}/actions?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "动作中心加载失败"));
      setCenter(await response.json() as Center); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "动作中心加载失败"); }
  }, [capabilityFilter, deferredSearch, page, projectId, statusFilter]);

  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);

  async function requestAction(capability: Capability) {
    setPendingKey(`request:${capability.id}`); setMessage(null); setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: capability.id, input: {}, clientRequestId: crypto.randomUUID() }) });
      if (!response.ok) throw new Error(await responseError(response, "动作创建失败"));
      const action = (await response.json() as { action: Action }).action;
      setMessage(action.status === "waitingApproval" ? "动作已创建并通知项目 Owner 审批。" : "动作已进入 Worker 队列。");
      if (page === 1) await reload(); else setPage(1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "动作创建失败"); }
    finally { setPendingKey(null); }
  }

  async function updatePolicy(policy: Policy, mode: PolicyMode) {
    const capability = center?.catalog.find((entry) => entry.id === policy.capability);
    if (mode === "automatic" && capability?.effect === "external-read") {
      const confirmation = await confirm({
        eyebrow: "Automation policy",
        title: "开启外部只读动作自动执行",
        description: "之后创建的该类动作将跳过逐次审批，并访问外部只读来源。已有动作不受影响。",
        confirmLabel: "更新项目策略",
        tone: "warning",
      });
      if (!confirmation.confirmed) return;
    }
    setPendingKey(`policy:${policy.capability}`); setMessage(null); setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/action-policies/${encodeURIComponent(policy.capability)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, expectedUpdatedAt: policy.updatedAt }) });
      if (!response.ok) throw new Error(await responseError(response, "策略更新失败"));
      setMessage("动作策略已更新，后续新动作会使用该策略快照。已有动作不受影响。"); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "策略更新失败"); }
    finally { setPendingKey(null); }
  }

  async function decide(action: Action, decision: "approved" | "rejected") {
    let note: string | null = null;
    if (decision === "rejected") {
      const confirmation = await confirm({
        eyebrow: "Action review",
        title: "拒绝这个动作",
        description: "动作不会执行，拒绝结果与原因会保留在审计记录中。",
        inputLabel: "拒绝原因（可选）",
        inputOptional: true,
        maxLength: 500,
        confirmLabel: "确认拒绝",
        tone: "danger",
      });
      if (!confirmation.confirmed) return;
      note = confirmation.value;
    }
    setPendingKey(`decision:${action.id}`); setMessage(null); setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/actions/${action.id}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, expectedUpdatedAt: action.updatedAt, expectedFingerprint: action.inputFingerprint, note: note?.trim() || null }) });
      if (!response.ok) throw new Error(await responseError(response, decision === "approved" ? "动作批准失败" : "动作拒绝失败"));
      setMessage(decision === "approved" ? "动作已批准并进入 Worker 队列。" : "动作已拒绝，不会执行。"); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "动作审批失败"); }
    finally { setPendingKey(null); }
  }

  async function cancel(action: Action) {
    const confirmation = await confirm({
      eyebrow: "Action lifecycle",
      title: "取消尚未执行的动作",
      description: "取消结果会保留在审计记录中。",
      confirmLabel: "取消动作",
      tone: "danger",
    });
    if (!confirmation.confirmed) return;
    setPendingKey(`cancel:${action.id}`); setMessage(null); setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/actions/${action.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: action.updatedAt }) });
      if (!response.ok) throw new Error(await responseError(response, "动作取消失败"));
      setMessage("动作已取消。"); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "动作取消失败"); }
    finally { setPendingKey(null); }
  }

  async function importResult(action: Action) {
    const resultFingerprint = mcpResultFingerprint(action.result);
    if (resultFingerprint === null) {
      setError("动作结果缺少有效指纹，不能纳入项目资料。");
      return;
    }
    const confirmation = await confirm({
      eyebrow: "Reviewed intake",
      title: "将 MCP 结果固化为项目资料",
      description: "导入后仍是未确认来源，不会自动进入事实或语义索引。",
      confirmLabel: "固化为项目资料",
      tone: "warning",
    });
    if (!confirmation.confirmed) return;
    setPendingKey(`import:${action.id}`); setMessage(null); setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/actions/${action.id}/result-import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedUpdatedAt: action.updatedAt,
          expectedInputFingerprint: action.inputFingerprint,
          expectedResultFingerprint: resultFingerprint,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "动作结果导入失败"));
      setMessage("MCP 结果已固化为项目资料。需要先审核并重建索引，才会参与后续语义检索与智能体调查。");
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "动作结果导入失败"); }
    finally { setPendingKey(null); }
  }

  const policyByCapability = new Map(center?.policies.map((policy) => [policy.capability, policy]) ?? []);
  const catalogById = new Map(center?.catalog.map((capability) => [capability.id, capability]) ?? []);

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
    <AppHeader username={username} active="projects" projectId={projectId} projectSection="actions" />
    <div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12">
      <div className="mb-5"><ProjectManagementParentLink projectId={projectId} /></div>
      <section className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-violet-950 px-8 py-10 text-white shadow-xl shadow-slate-950/10">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Controlled action engine</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-5"><div><h1 className="text-4xl font-semibold tracking-[-0.04em]">动作与审批</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">每个动作先固定能力、输入指纹和策略快照，再由 Owner 审批或按项目策略自动排队。Worker 只执行内置白名单能力，完整状态变化写入不可变审计。</p></div><button type="button" onClick={() => void reload()} className="flex min-h-11 items-center justify-center rounded-xl border border-white/20 bg-white/10 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/15">刷新状态</button></div>
      </section>
      {center?.archived ? <p className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">项目已归档，不能创建或审批动作；未执行动作已在归档时取消。</p> : null}
      {message ? <p role="status" className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm text-indigo-700">{message}</p> : null}
      {error ? <p role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}

      <section className="mt-9"><div className="mb-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Capability registry</p><h2 className="mt-2 text-2xl font-semibold">可执行能力</h2><p className="mt-2 text-sm text-slate-500">本版仅开放现有只读外部同步和本地治理能力，不包含代码写入、Shell、合并或部署。</p></div>
        <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-4">{center?.catalog.map((capability) => { const policy = policyByCapability.get(capability.id)!; const busy = pendingKey === `request:${capability.id}` || pendingKey === `policy:${capability.id}`; const allowedModes = capability.id === "project.mcp.read-tool.invoke" ? (["approvalRequired", "denied"] as const) : (["automatic", "approvalRequired", "denied"] as const); return <article key={capability.id} className="flex min-h-[20rem] flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-start justify-between gap-3"><span className={`rounded-full px-3 py-1 text-[11px] font-semibold ${capability.riskLevel === "low" ? "bg-emerald-50 text-emerald-700" : capability.riskLevel === "high" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700"}`}>{capability.riskLevel === "low" ? "低风险" : capability.riskLevel === "high" ? "高风险" : "中风险"}</span><span className="text-[11px] font-medium text-slate-400">{capability.effect === "local" ? "仅本地" : "只读外部访问"}</span></div><h3 className="mt-5 text-xl font-semibold">{capability.label}</h3><p className="mt-3 flex-1 text-sm leading-6 text-slate-600">{capability.description}</p><div className="mt-5 rounded-2xl bg-slate-50 p-4"><div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold text-slate-500">项目策略</span>{policy.inherited ? <span className="text-[10px] text-slate-400">使用安全默认值</span> : null}</div>{center.canManagePolicies ? <select aria-label={`${capability.label}策略`} value={policy.mode} disabled={busy || center.archived} onChange={(event) => void updatePolicy(policy, event.target.value as PolicyMode)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 disabled:opacity-50">{allowedModes.map((value) => <option key={value} value={value}>{modeLabels[value]}</option>)}</select> : <p className="mt-2 text-sm font-semibold text-slate-700">{modeLabels[policy.mode]}</p>}</div>{capability.id === "project.mcp.read-tool.invoke" ? <Link href={`/projects/${projectId}/tools`} className="mt-5 flex min-h-11 w-full items-center justify-center rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700">选择已授权工具</Link> : <button type="button" onClick={() => void requestAction(capability)} disabled={busy || policy.mode === "denied" || center.archived} className="mt-5 flex min-h-11 w-full items-center justify-center rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-40">{pendingKey === `request:${capability.id}` ? "创建中…" : policy.mode === "denied" ? "项目策略已禁止" : policy.mode === "approvalRequired" ? "创建并请求审批" : "创建并进入队列"}</button>}</article>; }) ?? <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500 lg:col-span-2 xl:col-span-4">正在读取能力注册表…</div>}</div>
      </section>

      <section className="mt-10"><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Action ledger</p><h2 className="mt-2 text-2xl font-semibold">动作记录</h2></div><span className="text-xs text-slate-400">{center ? `${center.pagination.total} 条` : "读取中…"}</span></div><div className="mb-5 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-[minmax(0,1fr)_180px_180px]"><label><span className="sr-only">搜索动作记录</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索申请人或错误代码" className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /></label><label><span className="sr-only">按动作能力筛选</span><select value={capabilityFilter} onChange={(event) => { setCapabilityFilter(event.target.value as "all" | CapabilityId); setPage(1); }} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-600"><option value="all">全部能力</option>{center?.catalog.map((capability) => <option key={capability.id} value={capability.id}>{capability.label}</option>)}</select></label><label><span className="sr-only">按动作状态筛选</span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as "all" | Action["status"]); setPage(1); }} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-600"><option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><div className="space-y-4">{center && center.actions.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">还没有动作。可以先运行一次“检查记忆质量”验证完整闭环。</div> : center?.actions.map((action) => { const capability = catalogById.get(action.capability); const busy = pendingKey?.endsWith(action.id) ?? false; const toolCall = action.capability === "project.mcp.read-tool.invoke" ? mcpInput(action.input) : null; return <article key={action.id} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-semibold">{toolCall ? `${capability?.label ?? action.capability} · ${toolCall.toolName}` : capability?.label ?? action.capability}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${badgeTone(action.status)}`}>{statusLabels[action.status]}</span></div><p className="mt-2 text-xs text-slate-500">申请人：{displayUser(action.requestedBy)} · {new Date(action.createdAt).toLocaleString("zh-CN")}</p></div><div className="text-right"><p className="font-mono text-[11px] text-slate-400" title={action.inputFingerprint}>指纹 {action.inputFingerprint.slice(0, 12)}…</p><p className="mt-1 text-[11px] text-slate-400">策略快照：{modeLabels[action.policyModeSnapshot]}</p></div></div>{toolCall ? <details open={action.status === "waitingApproval"} className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4"><summary className="cursor-pointer text-xs font-semibold text-amber-900">核对 MCP 调用参数</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-amber-900">{JSON.stringify(toolCall.arguments, null, 2)}</pre></details> : null}{action.failureCode ? <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 font-mono text-xs text-rose-700">{action.failureCode}</p> : null}{action.result && action.status === "succeeded" ? <details className="mt-4 rounded-2xl bg-emerald-50 p-4"><summary className="cursor-pointer text-xs font-semibold text-emerald-800">查看执行结果</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-emerald-950">{JSON.stringify(action.result, null, 2)}</pre></details> : null}{action.approval ? <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600">{action.approval.decision === "approved" ? "已批准" : "已拒绝"} · {displayUser(action.approval.decidedBy)} · {new Date(action.approval.decidedAt).toLocaleString("zh-CN")}{action.approval.note ? ` · ${action.approval.note}` : ""}</p> : action.status === "waitingApproval" && action.approvalExpiresAt ? <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-700">审批有效期至 {new Date(action.approvalExpiresAt).toLocaleString("zh-CN")}。审批会同时核对当前版本和输入指纹。</p> : null}<div className="mt-5 grid gap-4 lg:grid-cols-[1fr_auto]"><div className="flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-slate-500">{action.audits.slice(0, 6).map((audit) => <span key={audit.id}><strong className="font-semibold text-slate-700">{auditLabels[audit.event] ?? audit.event}</strong> · {displayUser(audit.actor)} · {new Date(audit.createdAt).toLocaleString("zh-CN")}</span>)}</div><div className="flex flex-wrap justify-end gap-2">{center.canApprove && action.status === "waitingApproval" ? <><button type="button" onClick={() => void decide(action, "rejected")} disabled={busy} className="flex min-h-10 items-center justify-center rounded-xl border border-rose-200 px-4 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">拒绝</button><button type="button" onClick={() => void decide(action, "approved")} disabled={busy} className="flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">批准并排队</button></> : null}{action.canCancel ? <button type="button" onClick={() => void cancel(action)} disabled={busy} className="flex min-h-10 items-center justify-center rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100 disabled:opacity-50">取消动作</button> : null}</div></div></article>; })}</div>{center ? <ListPagination {...center.pagination} onPageChange={setPage} disabled={pendingKey !== null} /> : null}</section>
      <section className="mt-10 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-500">Reviewed intake</p>
            <h2 className="mt-2 text-2xl font-semibold">MCP 结果纳入项目资料</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">只有成功结果可以由 Editor 或 Owner 手动固化。导入会锁定动作、输入与结果指纹，但不会自动生成事实、重建索引或触发智能体。</p>
          </div>
          <Link href={`/projects/${projectId}/materials`} className="flex min-h-10 items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:border-indigo-300 hover:text-indigo-700">查看项目资料</Link>
        </div>
        <div className="mt-5 space-y-3">
          {(center?.importableActions ?? []).map((action) => {
            const input = mcpInput(action.input);
            const fingerprint = mcpResultFingerprint(action.result);
            const busy = pendingKey === `import:${action.id}`;
            return <div key={action.id} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">
              <div>
                <p className="text-sm font-semibold text-slate-800">{input?.toolName ?? "MCP 只读工具"}</p>
                <p className="mt-1 font-mono text-[11px] text-slate-400">结果 {fingerprint?.slice(0, 12) ?? "无有效指纹"}…</p>
                {action.resultImport ? <p className="mt-2 text-xs text-emerald-700">已由 {displayUser(action.resultImport.importedBy)} 导入 · {new Date(action.resultImport.createdAt).toLocaleString("zh-CN")}</p> : <p className="mt-2 text-xs text-amber-700">等待人工确认是否作为未审核项目资料保留</p>}
              </div>
              {action.resultImport ? <span className="flex min-h-10 items-center justify-center rounded-xl bg-emerald-100 px-4 py-2 text-xs font-semibold text-emerald-700">已固化</span> : <button type="button" onClick={() => void importResult(action)} disabled={!center?.canImportResults || center.archived || fingerprint === null || busy} className="flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40">{busy ? "导入中…" : "导入为项目资料"}</button>}
            </div>;
          })}
          {center && center.importableActions.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-10 text-center text-sm text-slate-500">还没有可导入的 MCP 成功结果。</div> : null}
        </div>
      </section>
    </div>
  </main>;
}
