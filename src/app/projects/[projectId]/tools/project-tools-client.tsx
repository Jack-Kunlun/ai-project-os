"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { ProjectManagementParentLink } from "@/components/project-parent-link";
import { connectionErrorText, connectionFieldClass, readConnectionError } from "@/app/profile/connections/connection-ui";

type ProjectToolsClientProps = Readonly<{ username: string; projectId: string; isSystemAdmin: boolean }>;
type ConnectionOption = Readonly<{ id: string; name: string }>;
type Delegation = Readonly<{
  id: string;
  projectId: string;
  recordStatus: string;
  effectiveStatus: "eligible" | "ineligible";
  effectiveEligibility: Readonly<{ eligible: boolean; reason: string | null }>;
  evidenceState: string;
  version: number;
  expiresAt: string;
  proposedAt: string;
  ownerConfirmedAt: string | null;
  projectConfirmedAt: string | null;
  activatedAt: string | null;
  rejectedAt: string | null;
  revokedAt: string | null;
  expiredAt: string | null;
  owner: Readonly<{ displayName: string }> | null;
  projectConfirmedBy: Readonly<{ displayName: string }> | null;
  terminalReason: string | null;
  connection: Readonly<{ id: string; name: string }> | null;
  mcp: Readonly<{ transport: string; protocol: string; access: string; description: string }>;
  capabilities: Readonly<{ canOwnerConfirm: boolean; canProjectConfirm: boolean; canReject: boolean; canRevoke: boolean }>;
}>;
type DelegationPayload = Readonly<{
  connections: readonly ConnectionOption[];
  delegations: readonly Delegation[];
  capabilities: Readonly<{ canPropose: boolean }>;
}>;

type Tool = Readonly<{
  id: string;
  name: string | null;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: unknown;
  remoteTextTrust: "untrusted";
}>;
type Candidate = Readonly<{
  delegationId: string;
  toolDefinitionId: string;
  attestationId: string;
  delegationVersion: number;
  expiresAt: string | null;
  status: "eligible";
  effective: boolean;
  blockingAttestationId?: string;
  requiresRevocation?: boolean;
  tool: Tool;
}>;
type Grant = Readonly<{
  id: string;
  delegationId: string | null;
  toolDefinitionId: string;
  attestationId: string | null;
  status: "active" | "revoked";
  effective: boolean;
  effectiveReason?: string;
  reviewRequired?: boolean;
  grantVersion: number | null;
  toolName: string | null;
  tool: Tool;
  delegation: Readonly<{ id: string; status: string; version: number; expiresAt: string | null }> | null;
  attestation: Readonly<{ id: string; status: string | null; version: number | null; conclusion: string | null; riskLevel: string | null }> | null;
  acknowledgedAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
}>;
type GrantPayload = Readonly<{
  projectId: string;
  archived: boolean;
  grants: readonly Grant[];
  candidates: readonly Candidate[];
}>;

const delegationStatusLabels: Record<string, string> = {
  draft: "待连接所有者确认",
  ownerConfirmed: "待项目 Owner 确认",
  active: "已启用控制面授权",
  rejected: "已拒绝",
  revoked: "已撤销",
  expired: "已到期",
};

const eligibilityLabels: Record<string, string> = {
  EXPIRED: "委托已到期",
  PROJECT_ARCHIVED: "项目已归档",
  CONNECTION_EVIDENCE_DRIFT: "连接安全证据已变化",
  OWNER_MEMBERSHIP_DRIFT: "连接所有者成员资格已变化",
  PROJECT_OWNER_MEMBERSHIP_DRIFT: "项目 Owner 成员资格已变化",
  NOT_ACTIVE: "委托尚未生效",
};

const grantEffectiveReasonLabels: Record<string, string> = {
  project_archived: "项目已归档",
  delegation_missing: "连接委托已不存在",
  delegation_not_active: "连接委托已终止",
  delegation_expired: "连接委托已到期",
  connection_evidence_drift: "连接安全证据已变化",
  owner_membership_drift: "连接所有者成员资格已变化",
  project_owner_membership_drift: "项目 Owner 成员资格已变化",
  definition_drift: "工具定义已变化",
  attestation_missing: "V2 审核证据已不存在",
  attestation_invalid: "V2 审核证据已失效",
  attestation_drift: "V2 审核绑定已变化",
  review_required: "缺少不可变管理员审核",
  grant_revoked: "授权已撤销",
};

const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-xl px-3 py-2 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButtonClass = `${buttonClass} bg-indigo-600 text-white hover:bg-indigo-500`;
const quietButtonClass = `${buttonClass} border border-slate-200 text-slate-700 hover:bg-slate-50`;
const dangerButtonClass = `${buttonClass} border border-rose-200 text-rose-700 hover:bg-rose-50`;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  if (!response.ok) throw await readConnectionError(response, "项目 MCP 控制面请求失败");
  return await response.json() as T;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "暂无记录";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date) : "暂无记录";
}

function defaultExpiry(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60 * 1_000).toISOString().slice(0, 16);
}

function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "暂无声明";
  } catch {
    return "暂无声明";
  }
}

export function ProjectToolsClient({ username, projectId, isSystemAdmin }: ProjectToolsClientProps) {
  const [delegationState, setDelegationState] = useState<DelegationPayload | null>(null);
  const [grantState, setGrantState] = useState<GrantPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const pendingKeyRef = useRef<string | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();

  const load = useCallback(async ({ showLoading = true }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const [delegations, grants] = await Promise.all([
        requestJson<DelegationPayload>(`/api/projects/${projectId}/mcp-connection-delegations`),
        requestJson<GrantPayload>(`/api/projects/${projectId}/mcp-tool-grants`),
      ]);
      setDelegationState(delegations);
      setGrantState(grants);
      setLoadError(null);
    } catch (error) {
      setLoadError(connectionErrorText(error, "项目 MCP 控制面加载失败"));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load({ showLoading: true }), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function mutate(key: string, url: string, body: Record<string, unknown>, success: string, failure: string): Promise<void> {
    if (pendingKeyRef.current !== null) return;
    pendingKeyRef.current = key;
    setPendingKey(key);
    try {
      await requestJson<unknown>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      setMessage({ tone: "success", text: success });
      await load({ showLoading: false });
    } catch (error) {
      setMessage({ tone: "error", text: connectionErrorText(error, failure) });
    } finally {
      pendingKeyRef.current = null;
      setPendingKey(null);
    }
  }

  async function propose(mcpConnectionId: string, expiresAt: string): Promise<void> {
    if (pendingKeyRef.current !== null) return;
    const confirmation = await confirm({
      eyebrow: "创建项目委托",
      title: "提交只读 MCP 委托提案？",
      description: "提案只会进入控制面确认队列。连接所有者和项目 Owner 必须分别确认，远端动作仍不会被调用。",
      confirmLabel: "提交提案",
      cancelLabel: "返回",
      inputLabel: "输入“确认”继续",
      requiredValue: "确认",
      inputPlaceholder: "确认",
    });
    if (!confirmation.confirmed) return;
    await mutate("proposal", `/api/projects/${projectId}/mcp-connection-delegations`, { mcpConnectionId, expiresAt: new Date(expiresAt).toISOString() }, "委托提案已创建，请等待连接所有者确认。", "创建委托提案失败");
  }

  async function terminal(delegation: Delegation, action: "rejection" | "revocation"): Promise<void> {
    const result = await confirm({
      eyebrow: action === "rejection" ? "拒绝项目委托" : "撤销项目委托",
      title: action === "rejection" ? "拒绝这项委托？" : "撤销这项委托？",
      description: action === "rejection" ? "拒绝会阻止这项尚未完成的委托继续确认。请填写原因。" : "撤销会停止后续项目使用。已经发出的外部请求不能撤回。请填写原因。",
      confirmLabel: action === "rejection" ? "确认拒绝" : "确认撤销",
      cancelLabel: "返回",
      tone: "danger",
      inputLabel: "原因",
      inputPlaceholder: "例如：范围需要调整",
      inputOptional: false,
      maxLength: 500,
    });
    if (!result.confirmed) return;
    await mutate(`delegation:${action}:${delegation.id}`, `/api/projects/${projectId}/mcp-connection-delegations/${delegation.id}/${action}`, { expectedVersion: delegation.version, reason: result.value.trim() }, action === "rejection" ? "委托已拒绝。" : "委托已撤销。", action === "rejection" ? "拒绝委托失败" : "撤销委托失败");
  }

  async function confirmDelegation(delegation: Delegation, kind: "owner" | "project"): Promise<void> {
    const result = await confirm({
      eyebrow: kind === "owner" ? "连接所有者确认" : "项目 Owner 确认",
      title: kind === "owner" ? "确认允许项目使用这条连接？" : "确认项目范围与数据外发？",
      description: kind === "owner" ? "你确认后，项目 Owner 仍需独立确认项目范围；凭据不会展示给项目成员。" : "你确认后，当前 V2 审核工具才可以进入只读授权候选；远端动作调用仍保持冻结。",
      confirmLabel: kind === "owner" ? "确认连接使用" : "确认项目范围",
      cancelLabel: "返回",
      inputLabel: "输入“确认”继续",
      requiredValue: "确认",
      inputPlaceholder: "确认",
    });
    if (!result.confirmed) return;
    const path = kind === "owner" ? "owner-confirmation" : "project-confirmation";
    const body = kind === "owner"
      ? { expectedVersion: delegation.version, acknowledgeCredentialUse: true }
      : { expectedVersion: delegation.version, acknowledgeProjectScope: true, acknowledgeDataEgress: true };
    await mutate(`delegation:${kind}:${delegation.id}`, `/api/projects/${projectId}/mcp-connection-delegations/${delegation.id}/${path}`, body, kind === "owner" ? "连接所有者确认已记录。" : "项目 Owner 确认已记录。", kind === "owner" ? "连接所有者确认失败" : "项目 Owner 确认失败");
  }

  async function createGrant(candidate: Candidate): Promise<void> {
    if (!candidate.effective) return;
    const result = await confirm({
      eyebrow: "只读工具授权",
      title: `授权 ${candidate.tool.title || candidate.tool.name || "此工具"}？`,
      description: "这只创建当前 V2 审核工具的项目控制面授权，不会调用远端工具，也不会创建远端派发记录。",
      confirmLabel: "创建只读授权",
      cancelLabel: "返回",
      inputLabel: "输入“授权”继续",
      requiredValue: "授权",
      inputPlaceholder: "授权",
    });
    if (!result.confirmed) return;
    await mutate(`grant:create:${candidate.toolDefinitionId}`, `/api/projects/${projectId}/mcp-tool-grants`, {
      delegationId: candidate.delegationId,
      toolDefinitionId: candidate.toolDefinitionId,
      attestationId: candidate.attestationId,
      expectedDelegationVersion: candidate.delegationVersion,
      expectedAttestationVersion: 1,
      acknowledgeReadOnly: true,
    }, "只读工具授权已创建。", "创建工具授权失败");
  }

  async function revokeGrant(grant: Grant): Promise<void> {
    const result = await confirm({
      eyebrow: "撤销只读工具授权",
      title: `撤销 ${grant.tool.title || grant.tool.name || "此工具"}？`,
      description: "撤销只影响项目控制面授权；已发生的外部请求不能撤回。",
      confirmLabel: "确认撤销",
      cancelLabel: "返回",
      tone: "danger",
      inputLabel: "输入“撤销”继续",
      requiredValue: "撤销",
      inputPlaceholder: "撤销",
    });
    if (!result.confirmed) return;
    await mutate(`grant:revoke:${grant.id}`, `/api/projects/${projectId}/mcp-tool-grants/${grant.id}/revocation`, { expectedGrantVersion: grant.grantVersion ?? 1 }, "只读工具授权已撤销。", "撤销工具授权失败");
  }

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="tools" isSystemAdmin={isSystemAdmin} />
      {dialog}
      <div className="mx-auto max-w-7xl px-5 py-7 sm:px-8 lg:px-10">
        <div className="mb-5"><ProjectManagementParentLink projectId={projectId} /></div>
        <section className="grid gap-7 rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-6 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-8 sm:py-9 lg:grid-cols-[1.2fr_.8fr] lg:px-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Project capability grants</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">项目工具权限</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">仅管理连接委托和只读工具授权；远端动作、自动化、调用审批和派发仍未开放。当前页面消费既有项目授权 API，所有确认仍由服务端校验。</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/profile/connections/mcp" className="flex min-h-11 items-center justify-center rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-violet-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">管理个人 MCP 连接</Link>
              <Link href={`/projects/${projectId}/governance`} className="flex min-h-11 items-center justify-center rounded-xl border border-white/20 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">查看项目治理</Link>
            </div>
          </div>
          <div role="status" className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm leading-6 text-slate-300">
            <p className="font-semibold text-white">当前状态</p>
            <p className="mt-2">控制面开放；动作调用冻结</p>
            <p className="mt-3 text-xs leading-5 text-slate-400">这里只读管理委托和授权，不发现远端服务、不调用工具、不审批或派发动作。</p>
          </div>
        </section>

        <p className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-xs leading-5 text-indigo-950">费用承担者为连接所有者；第三方费用由其与服务商约定，平台不代扣，也不计入项目平台额度。</p>
        {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-5 rounded-2xl px-4 py-3 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{message.text}</p> : null}
        {loadError ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span>{loadError}</span><button type="button" onClick={() => void load({ showLoading: true })} className={quietButtonClass}>重试</button></div> : null}

        {loading ? <LoadingState /> : (
          <>
            <div className="mt-7 grid min-w-0 gap-6 lg:grid-cols-[minmax(280px,.78fr)_minmax(0,1.22fr)]">
              <ProposalPanel enabled={delegationState?.capabilities.canPropose === true && grantState?.archived !== true} connections={delegationState?.connections ?? []} pending={pendingKey === "proposal"} onSubmit={(connectionId, expiresAt) => void propose(connectionId, expiresAt)} />
              <DelegationList delegations={delegationState?.delegations ?? []} pendingKey={pendingKey} onConfirm={confirmDelegation} onTerminal={terminal} />
            </div>
            <GrantPanel state={grantState} pendingKey={pendingKey} onCreate={createGrant} onRevoke={revokeGrant} />
          </>
        )}
      </div>
    </main>
  );
}

function ProposalPanel({ enabled, connections, pending, onSubmit }: { enabled: boolean; connections: readonly ConnectionOption[]; pending: boolean; onSubmit: (connectionId: string, expiresAt: string) => void }) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [expiresAt, setExpiresAt] = useState(defaultExpiry);
  const selectedConnectionId = connectionId || connections[0]?.id || "";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedConnectionId !== "" && expiresAt !== "") onSubmit(selectedConnectionId, expiresAt);
  }

  return <section className="h-fit min-w-0 rounded-3xl border border-indigo-100 bg-indigo-50/50 p-5 shadow-sm sm:p-6"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">New delegation</p><h2 className="mt-2 text-xl font-semibold">提案只读 MCP 委托</h2><p className="mt-2 text-xs leading-5 text-slate-600">只能选择当前账户已验证的个人连接。提交后仍需连接所有者和项目 Owner 独立确认。</p>{!enabled ? <p className="mt-4 rounded-xl bg-slate-100 px-3 py-3 text-xs leading-5 text-slate-600">当前账户没有创建权限，或项目已归档。连接所有者确认和项目 Owner 确认仍由各自权限控制。</p> : connections.length === 0 ? <p className="mt-4 rounded-xl bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-900">当前没有可进入项目委托的合格个人 MCP 连接。新连接保存时仅执行受限 DNS/地址安全解析，不发起 MCP 协议请求或发送凭据；当前不能成为项目可委托连接，现场 MCP 验证入口尚未开放，请等待能力开放后再创建委托。</p> : <form onSubmit={submit} className="mt-5 space-y-3"><label className="block text-xs font-semibold text-slate-700">个人 MCP 连接<select className={connectionFieldClass} value={selectedConnectionId} onChange={(event) => setConnectionId(event.target.value)}>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label><label className="block text-xs font-semibold text-slate-700">有效期截止<input required type="datetime-local" className={connectionFieldClass} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label><div className="rounded-2xl bg-white/70 px-3 py-3 text-xs leading-5 text-slate-600"><p className="font-semibold text-slate-800">本期固定规则</p><p className="mt-1">仅控制面、只读；自动化、工具调用、审批和派发保持关闭。</p></div><button type="submit" disabled={pending || selectedConnectionId === ""} className={`${primaryButtonClass} min-h-11 w-full`}>{pending ? "提交中…" : "提交委托提案"}</button></form>}</section>;
}

function DelegationList({ delegations, pendingKey, onConfirm, onTerminal }: { delegations: readonly Delegation[]; pendingKey: string | null; onConfirm: (delegation: Delegation, kind: "owner" | "project") => Promise<void>; onTerminal: (delegation: Delegation, action: "rejection" | "revocation") => Promise<void> }) {
  return <section className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Connection delegations</p><h2 className="mt-2 text-2xl font-semibold">连接委托</h2><p className="mt-1 text-sm leading-6 text-slate-500">状态由服务端基于当前成员资格、连接证据和有效期计算；不展示地址、凭据或原始指纹。</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{delegations.length} 条</span></div>{delegations.length === 0 ? <div className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-700">还没有连接委托</p><p className="mt-2 text-xs leading-5 text-slate-500">提交左侧提案后，等待连接所有者和项目 Owner 双确认。</p></div> : <div className="mt-6 space-y-4">{delegations.map((delegation) => <DelegationCard key={delegation.id} delegation={delegation} pending={pendingKey?.includes(delegation.id) === true} onConfirm={onConfirm} onTerminal={onTerminal} />)}</div>}</section>;
}

function DelegationCard({ delegation, pending, onConfirm, onTerminal }: { delegation: Delegation; pending: boolean; onConfirm: (delegation: Delegation, kind: "owner" | "project") => Promise<void>; onTerminal: (delegation: Delegation, action: "rejection" | "revocation") => Promise<void> }) {
  const statusLabel = delegationStatusLabels[delegation.recordStatus] ?? delegation.recordStatus;
  const eligibility = delegation.effectiveEligibility.reason ? eligibilityLabels[delegation.effectiveEligibility.reason] ?? delegation.effectiveEligibility.reason : "当前证据有效";
  return <article className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5"><div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-base font-semibold text-slate-900">{delegation.connection?.name ?? "个人连接（所有者确认后可见）"}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${delegation.effectiveStatus === "eligible" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{statusLabel}</span></div><p className="mt-2 text-xs text-slate-500">{delegation.mcp.protocol} · {delegation.mcp.access} · 版本 {delegation.version}</p></div><div className="shrink-0 text-right text-xs text-slate-400"><p>有效至 {formatDate(delegation.expiresAt)}</p><p className="mt-1">{eligibility}</p></div></div><dl className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-4"><div><dt className="text-slate-400">连接所有者</dt><dd className="mt-1 font-medium">{delegation.owner?.displayName ?? "已隐藏"}</dd></div><div><dt className="text-slate-400">范围</dt><dd className="mt-1 font-medium">{delegation.mcp.access} · {delegation.mcp.transport}</dd></div><div><dt className="text-slate-400">项目 Owner</dt><dd className="mt-1 font-medium">{delegation.projectConfirmedBy?.displayName ?? "等待确认"}</dd></div><div><dt className="text-slate-400">费用</dt><dd className="mt-1 font-medium">连接所有者承担</dd></div></dl><p className="mt-3 text-xs leading-5 text-slate-500">{delegation.mcp.description}。第三方费用由连接所有者与服务商约定，平台不代扣，也不计入项目平台额度。</p><div className="mt-4 flex flex-wrap gap-2">{delegation.capabilities.canOwnerConfirm ? <button type="button" onClick={() => void onConfirm(delegation, "owner")} disabled={pending} className={primaryButtonClass}>确认连接使用</button> : null}{delegation.capabilities.canProjectConfirm ? <button type="button" onClick={() => void onConfirm(delegation, "project")} disabled={pending} className={primaryButtonClass}>确认项目范围</button> : null}{delegation.capabilities.canReject ? <button type="button" onClick={() => void onTerminal(delegation, "rejection")} disabled={pending} className={dangerButtonClass}>拒绝</button> : null}{delegation.capabilities.canRevoke ? <button type="button" onClick={() => void onTerminal(delegation, "revocation")} disabled={pending} className={dangerButtonClass}>撤销</button> : null}</div>{delegation.terminalReason ? <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">终止原因：{delegation.terminalReason}</p> : null}</article>;
}

function GrantPanel({ state, pendingKey, onCreate, onRevoke }: { state: GrantPayload | null; pendingKey: string | null; onCreate: (candidate: Candidate) => Promise<void>; onRevoke: (grant: Grant) => Promise<void> }) {
  const activeGrants = state?.grants.filter((grant) => grant.status === "active" && grant.effective) ?? [];
  const ineffectiveActiveGrants = state?.grants.filter((grant) => grant.status === "active" && !grant.effective) ?? [];
  const historicalGrants = state?.grants.filter((grant) => grant.status !== "active") ?? [];
  return <section className="mt-7 min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Read-only tool grants</p><h2 className="mt-2 text-2xl font-semibold">V2 只读工具授权</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">这里只列出当前有效连接委托和 V2 审核候选。远端 schema 与 annotations 是不可信远端声明，仅供审核，不代表平台授权。</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{activeGrants.length} 个有效授权</span></div>{state?.archived ? <p className="mt-5 rounded-2xl bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">项目已归档，不能创建新的工具授权。</p> : null}<div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-2"><div><h3 className="text-sm font-semibold text-slate-900">可授权工具</h3>{state === null ? <p className="mt-4 rounded-2xl bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">正在读取工具候选…</p> : state.candidates.length === 0 ? <p className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">当前没有可授权的 V2 工具。</p> : <div className="mt-4 space-y-3">{state.candidates.map((candidate) => <CandidateCard key={`${candidate.delegationId}:${candidate.toolDefinitionId}`} candidate={candidate} pending={pendingKey?.includes(candidate.toolDefinitionId) === true} onCreate={onCreate} />)}</div>}</div><div><h3 className="text-sm font-semibold text-slate-900">当前与历史授权</h3>{activeGrants.length === 0 && ineffectiveActiveGrants.length === 0 && historicalGrants.length === 0 ? <p className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">还没有工具授权。</p> : <div className="mt-4 space-y-3">{[...activeGrants, ...ineffectiveActiveGrants, ...historicalGrants].map((grant) => <GrantCard key={grant.id} grant={grant} pending={pendingKey?.includes(grant.id) === true} onRevoke={onRevoke} />)}</div>}</div></div><p className="mt-6 rounded-2xl bg-slate-100 px-4 py-3 text-xs leading-5 text-slate-600">仅管理连接委托和只读工具授权；远端动作、自动化、调用审批、派发和结果导入仍未开放。</p></section>;
}

function CandidateCard({ candidate, pending, onCreate }: { candidate: Candidate; pending: boolean; onCreate: (candidate: Candidate) => Promise<void> }) {
  const title = candidate.tool.title || candidate.tool.name || "未命名工具";
  return <article className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/60 p-4"><div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h4 className="break-words text-sm font-semibold text-slate-900">{title}</h4><p className="mt-1 break-all font-mono text-[12px] text-slate-500">{candidate.tool.name ?? "匿名工具"}</p></div><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${candidate.effective ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{candidate.effective ? "当前 V2 有效" : "审核证据不可用"}</span></div>{candidate.tool.description ? <p className="mt-3 break-words text-xs leading-5 text-slate-600">{candidate.tool.description}</p> : null}<p className="mt-3 text-[12px] leading-5 text-slate-500">远端 schema/annotations：不可信远端声明，仅供审核。</p><details className="mt-3 rounded-xl bg-white p-3"><summary className="cursor-pointer text-[12px] font-semibold text-slate-700">查看净化 schema 与 annotations</summary><div className="mt-3 space-y-3"><SchemaBlock label="输入 schema" value={candidate.tool.inputSchema} /><SchemaBlock label="输出 schema" value={candidate.tool.outputSchema} /><SchemaBlock label="annotations" value={candidate.tool.annotations} /></div></details>{candidate.effective ? <button type="button" onClick={() => void onCreate(candidate)} disabled={pending} className={`${primaryButtonClass} mt-4 w-full`}>{pending ? "创建中…" : "创建只读工具授权"}</button> : <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">当前不能授权：需要管理员重新确认当前 V2 审核证据。</p>}</article>;
}

function GrantCard({ grant, pending, onRevoke }: { grant: Grant; pending: boolean; onRevoke: (grant: Grant) => Promise<void> }) {
  const title = grant.tool.title || grant.tool.name || grant.toolName || "未命名工具";
  const statusLabel = grant.status !== "active" ? "已撤销" : grant.effective ? "当前有效" : "需要治理处理";
  const attestationLabel = grant.effective ? "当前 V2 有效" : grant.reviewRequired ? "缺少不可变审核" : "需复核";
  const effectiveReason = grant.effectiveReason ? grantEffectiveReasonLabels[grant.effectiveReason] ?? "当前治理证据不可用" : null;
  return <article className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4"><div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h4 className="break-words text-sm font-semibold text-slate-900">{title}</h4><p className="mt-1 text-xs text-slate-500">{statusLabel} · 认证状态：{attestationLabel} · 版本 {grant.grantVersion ?? 1}</p></div><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${grant.effective ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{grant.effective ? "只读有效" : "不可用于授权"}</span></div>{grant.tool.description ? <p className="mt-3 break-words text-xs leading-5 text-slate-600">{grant.tool.description}</p> : null}<p className="mt-3 text-[12px] leading-5 text-slate-500">委托有效至 {formatDate(grant.delegation?.expiresAt)} · 创建于 {formatDate(grant.createdAt)}</p>{grant.status === "active" && !grant.effective ? <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-900">此历史授权不会计入有效额度；{effectiveReason ?? "当前治理证据不可用"}。请先撤销，再由管理员审核后重新创建。</p> : null}{grant.status === "active" ? <button type="button" onClick={() => void onRevoke(grant)} disabled={pending} className={`${dangerButtonClass} mt-4`}>{pending ? "撤销中…" : "撤销工具授权"}</button> : grant.revokedAt ? <p className="mt-3 text-[12px] text-slate-500">撤销于 {formatDate(grant.revokedAt)}</p> : null}</article>;
}

function SchemaBlock({ label, value }: { label: string; value: unknown }) {
  return <div><p className="text-[12px] font-semibold text-slate-600">{label}</p><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-[12px] leading-5 text-slate-500">{jsonPreview(value)}</pre></div>;
}

function LoadingState() {
  return <div className="mt-7 grid gap-6 lg:grid-cols-2" role="status" aria-label="正在加载项目 MCP 控制面"><div className="h-80 animate-pulse rounded-3xl bg-slate-200" /><div className="h-80 animate-pulse rounded-3xl bg-slate-200" /></div>;
}
