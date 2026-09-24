"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { HelpTooltip } from "@/components/help-tooltip";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";
import {
  connectionButtonClass,
  connectionErrorText,
  connectionFieldClass,
  ConnectionRequestError,
  type ConnectionMessage,
  formatConnectionDate,
} from "../connection-ui";
import { ConnectionGovernancePanel, connectionBlockerText } from "../governance-panel";
import { ConnectionCreateDialog, ConnectionDialogActions } from "../connection-create-dialog";
import { ConnectionEditDialog } from "../connection-edit-dialog";
import {
  createDefaultMcpDraft,
  isActiveMcpAttestation,
  mcpStatusLabels,
  type McpConnection,
  type McpConnectionDraft,
} from "./mcp-connections-state";

const statusStyles: Record<McpConnection["status"], string> = {
  configured: "bg-amber-50 text-amber-700 ring-amber-200",
  verified: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-rose-50 text-rose-700 ring-rose-200",
  disabled: "bg-slate-100 text-slate-600 ring-slate-200",
};

type OwnerDelegation = Readonly<{
  id: string;
  projectId: string;
  recordStatus: "draft" | "ownerConfirmed" | "active" | "rejected" | "revoked" | "expired";
  effectiveStatus: "eligible" | "ineligible";
  effectiveEligibility: Readonly<{ eligible: boolean; reason: string | null }>;
  evidenceState: string;
  version: number;
  expiresAt: string;
  owner: Readonly<{ displayName: string }> | null;
  connection: Readonly<{ id: string; name: string }> | null;
  mcp: Readonly<{ transport: string; protocol: string; access: string; description: string }>;
  capabilities: Readonly<{ canOwnerConfirm: boolean; canProjectConfirm: boolean; canReject: boolean; canRevoke: boolean }>;
}>;
type OwnerDelegationPayload = Readonly<{ delegations: readonly OwnerDelegation[] }>;

const ownerDelegationStatusLabels: Record<OwnerDelegation["recordStatus"], string> = {
  draft: "待连接所有者确认",
  ownerConfirmed: "待项目 Owner 确认",
  active: "已启用控制面授权",
  rejected: "已拒绝（终态）",
  revoked: "已撤销（终态）",
  expired: "已到期（终态）",
};

const ownerDelegationReasonLabels: Record<string, string> = {
  EXPIRED: "委托已到期",
  CONNECTION_EVIDENCE_DRIFT: "连接安全证据已变化",
  OWNER_MEMBERSHIP_DRIFT: "所有者成员资格已变化",
  PROJECT_OWNER_MEMBERSHIP_DRIFT: "项目 Owner 成员资格已变化",
  PROJECT_ARCHIVED: "项目已归档",
  NOT_ACTIVE: "委托尚未生效",
};

async function readSafeConnectionError(response: Response, fallback: string): Promise<ConnectionRequestError> {
  const safe = await safeResponseError(response, fallback);
  return new ConnectionRequestError(safe.message, safe.code ?? "CONNECTION_REQUEST_FAILED", response.status);
}

export function McpConnectionsClient() {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [ownerDelegations, setOwnerDelegations] = useState<readonly OwnerDelegation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ownerDelegationsLoading, setOwnerDelegationsLoading] = useState(true);
  const [ownerDelegationsError, setOwnerDelegationsError] = useState<string | null>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/me/mcp-connections", { cache: "no-store" });
      if (!response.ok) throw await readSafeConnectionError(response, "个人 MCP 连接加载失败");
      const payload = await response.json() as { connections: McpConnection[] };
      setConnections(payload.connections);
      setLoadError(null);
    } catch (error) {
      setLoadError(connectionErrorText(error, "个人 MCP 连接加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOwnerDelegations = useCallback(async () => {
    setOwnerDelegationsLoading(true);
    try {
      const response = await fetch("/api/me/mcp-delegations", { cache: "no-store" });
      if (!response.ok) throw await readSafeConnectionError(response, "MCP 委托安全记录加载失败");
      const payload = await response.json() as OwnerDelegationPayload;
      setOwnerDelegations(payload.delegations);
      setOwnerDelegationsError(null);
    } catch (error) {
      setOwnerDelegationsError(connectionErrorText(error, "MCP 委托安全记录加载失败"));
    } finally {
      setOwnerDelegationsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
      void loadOwnerDelegations();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, loadOwnerDelegations]);

  return (
    <div className="mx-auto max-w-6xl px-5 pb-16 pt-7 sm:px-8 lg:px-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/personal/configuration" className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"><span aria-hidden="true">←</span> 返回个人工作区配置</Link>
        <span className="text-xs text-slate-400">个人工作区 / 我的连接 / MCP</span>
      </div>

      <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">My MCP connections</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">我的 MCP 连接</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">连接只属于当前账户。工具目录和安全摘要只读展示；重新发现、重信任、轮换凭据、停用、启用和删除都必须先完成治理预览与独立确认。</p>
          </div>
          <div className="rounded-2xl bg-violet-50 px-4 py-3 text-sm text-violet-950 lg:max-w-xs">
            <p className="font-semibold">当前使用边界</p>
            <p className="mt-1 text-xs leading-5">项目委托控制面已开放；远端动作、自动化和调用审批仍未开放。新建连接会先执行受限 DNS/地址安全解析，再完成 initialize 和 tools/list 只读测试。</p>
          </div>
        </div>
      </section>

      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-5 rounded-2xl px-4 py-3 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-700" : message.tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>{message.text}</p> : null}
      {loadError ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span>{loadError}</span><button type="button" onClick={() => void load()} className="min-h-10 font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500">重试</button></div> : null}

      <McpOwnerDelegationQueue delegations={ownerDelegations} loading={ownerDelegationsLoading} error={ownerDelegationsError} onReload={loadOwnerDelegations} onMessage={setMessage} />

      {createOpen ? <ConnectionCreateDialog title="添加 MCP 服务" onClose={() => setCreateOpen(false)}><McpCreateForm onCreated={(connection) => { setConnections((current) => [...current, connection]); setCreateOpen(false); setMessage({ tone: "success", text: "MCP 连接已保存。" }); }} /></ConnectionCreateDialog> : null}
      <div className="mt-6 min-w-0">
        <section className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-xl font-semibold">已有连接</h2><p className="mt-1 text-xs leading-5 text-slate-500">展示连接状态和工具安全摘要，不提供管理员审核或项目授权按钮。</p></div>
            <div className="flex items-center gap-3"><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{loading ? "读取中…" : `${connections.length} 个连接`}</span><button type="button" onClick={() => setCreateOpen(true)} className="min-h-10 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">添加服务</button></div>
          </div>
          {loading ? <div role="status" className="mt-5 space-y-3" aria-label="正在加载 MCP 连接"><div className="h-56 animate-pulse rounded-2xl bg-slate-100" /><div className="h-56 animate-pulse rounded-2xl bg-slate-100" /></div> : connections.length === 0 ? <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-9 text-center"><p className="text-sm font-semibold text-slate-700">还没有个人 MCP 连接</p><p className="mt-2 text-xs leading-5 text-slate-500">点击“添加服务”创建远程连接。先测试 initialize 和 tools/list，确认结果后再保存；不会调用工具。</p></div> : <div className="mt-5 space-y-4">{connections.map((connection) => <McpConnectionCard key={connection.id} connection={connection} onRemoved={() => { setConnections((current) => current.filter((item) => item.id !== connection.id)); setMessage({ tone: "success", text: "MCP 连接已删除。" }); }} onReload={load} />)}</div>}
        </section>
      </div>
    </div>
  );
}

function McpOwnerDelegationQueue({ delegations, loading, error, onReload, onMessage }: { delegations: readonly OwnerDelegation[]; loading: boolean; error: string | null; onReload: () => Promise<void>; onMessage: (message: ConnectionMessage) => void }) {
  return <section className="mt-6 rounded-3xl border border-amber-200/80 bg-amber-50/50 p-5 shadow-sm sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">Delegation safety</p><h2 className="mt-2 text-xl font-semibold text-slate-900">MCP 项目委托队列</h2><p className="mt-1 max-w-3xl text-xs leading-5 text-slate-600">这里列出你作为连接所有者的待确认、已确认、当前有效和终态记录。项目名称和项目标识不会在个人页面展示；没有项目访问权时仍只保留最小安全信息。</p></div><span className="rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-amber-800">{loading ? "读取中…" : `${delegations.length} 条`}</span></div>{error ? <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-xs text-rose-700"><span>{error}</span><button type="button" onClick={() => void onReload()} className="font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500">重试</button></div> : null}{loading ? <div className="mt-4 h-24 animate-pulse rounded-2xl bg-white/70" role="status" aria-label="正在加载 MCP 委托安全记录" /> : delegations.length === 0 && error === null ? <div className="mt-4 rounded-2xl border border-dashed border-amber-200 bg-white/60 px-5 py-7 text-center text-xs text-slate-600">当前没有 MCP 项目委托记录。</div> : <div className="mt-4 grid gap-3 lg:grid-cols-2">{delegations.map((delegation) => <McpOwnerDelegationCard key={delegation.id} delegation={delegation} onReload={onReload} onMessage={onMessage} />)}</div>}</section>;
}

function McpOwnerDelegationCard({ delegation, onReload, onMessage }: { delegation: OwnerDelegation; onReload: () => Promise<void>; onMessage: (message: ConnectionMessage) => void }) {
  const { confirm, dialog } = useAppConfirmDialog();
  const [pending, setPending] = useState<"owner-confirmation" | "rejection" | "revocation" | null>(null);
  const pendingRef = useRef<"owner-confirmation" | "rejection" | "revocation" | null>(null);
  const statusLabel = ownerDelegationStatusLabels[delegation.recordStatus];
  const reason = delegation.effectiveEligibility.reason ? ownerDelegationReasonLabels[delegation.effectiveEligibility.reason] ?? delegation.effectiveEligibility.reason : "当前证据有效";

  async function confirmOwner(): Promise<void> {
    const result = await confirm({ eyebrow: "连接所有者确认", title: "确认允许项目使用这条连接？", description: "你确认后，项目 Owner 仍需独立确认项目范围；个人凭据不会展示给项目成员。", confirmLabel: "确认连接使用", cancelLabel: "返回", inputLabel: "输入“确认”继续", requiredValue: "确认", inputPlaceholder: "确认" });
    if (!result.confirmed || pendingRef.current !== null) return;
    pendingRef.current = "owner-confirmation";
    setPending("owner-confirmation");
    try {
      const response = await fetch(`/api/projects/${delegation.projectId}/mcp-connection-delegations/${delegation.id}/owner-confirmation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: delegation.version, acknowledgeCredentialUse: true }) });
      if (!response.ok) throw await readSafeConnectionError(response, "连接所有者确认失败");
      onMessage({ tone: "success", text: "MCP 连接所有者确认已记录。" });
      await onReload();
    } catch (error) {
      onMessage({ tone: "error", text: connectionErrorText(error, "连接所有者确认失败") });
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  }

  async function terminal(action: "rejection" | "revocation"): Promise<void> {
    const result = await confirm({ eyebrow: action === "rejection" ? "拒绝 MCP 项目委托" : "撤销 MCP 项目委托", title: action === "rejection" ? "拒绝这项委托？" : "撤销这项委托？", description: action === "rejection" ? "拒绝会阻止这项尚未完成的委托继续确认。请填写原因。" : "撤销会停止后续项目使用；已经发出的外部请求不能撤回。请填写原因。", confirmLabel: action === "rejection" ? "确认拒绝" : "确认撤销", cancelLabel: "返回", tone: "danger", inputLabel: "原因", inputPlaceholder: "例如：项目范围需要调整", inputOptional: false, maxLength: 500 });
    if (!result.confirmed || pendingRef.current !== null) return;
    pendingRef.current = action;
    setPending(action);
    try {
      const response = await fetch(`/api/projects/${delegation.projectId}/mcp-connection-delegations/${delegation.id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: delegation.version, reason: result.value.trim() }) });
      if (!response.ok) throw await readSafeConnectionError(response, action === "rejection" ? "拒绝 MCP 委托失败" : "撤销 MCP 委托失败");
      onMessage({ tone: "success", text: action === "rejection" ? "MCP 委托已拒绝。" : "MCP 委托已撤销。" });
      await onReload();
    } catch (error) {
      onMessage({ tone: "error", text: connectionErrorText(error, action === "rejection" ? "拒绝 MCP 委托失败" : "撤销 MCP 委托失败") });
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  }

  return <article className="min-w-0 rounded-2xl border border-amber-200 bg-white p-4">{dialog}<div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-sm font-semibold text-slate-900">{delegation.connection?.name ?? "个人连接"}</h3><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] font-semibold text-slate-600">{statusLabel}</span></div><p className="mt-2 text-xs text-slate-500">范围：{delegation.mcp.access} · {delegation.mcp.protocol} · 版本 {delegation.version}</p></div><div className="shrink-0 text-right text-xs text-slate-400"><p>有效至 {formatConnectionDate(delegation.expiresAt)}</p><p className="mt-1">{reason}</p></div></div><p className="mt-3 text-xs leading-5 text-slate-600">{delegation.mcp.description}。项目名称与项目标识仅在项目授权页面按权限展示。</p><p className="mt-2 text-xs leading-5 text-slate-500">费用承担者为连接所有者；第三方费用由其与服务商约定，平台不代扣，也不计入项目平台额度。</p><div className="mt-4 flex flex-wrap gap-2">{delegation.capabilities.canOwnerConfirm ? <button type="button" onClick={() => void confirmOwner()} disabled={pending !== null} className={`${connectionButtonClass} bg-indigo-600 text-white hover:bg-indigo-500`}>{pending === "owner-confirmation" ? "处理中…" : "确认连接使用"}</button> : null}{delegation.capabilities.canReject ? <button type="button" onClick={() => void terminal("rejection")} disabled={pending !== null} className={`${connectionButtonClass} text-rose-700 hover:bg-rose-50`}>{pending === "rejection" ? "处理中…" : "拒绝委托"}</button> : null}{delegation.capabilities.canRevoke ? <button type="button" onClick={() => void terminal("revocation")} disabled={pending !== null} className={`${connectionButtonClass} text-rose-700 hover:bg-rose-50`}>{pending === "revocation" ? "处理中…" : "撤销委托"}</button> : null}</div></article>;
}

function McpCreateForm({ onCreated, editing, onEdited }: { onCreated?: (connection: McpConnection) => void; editing?: McpConnection; onEdited?: () => void }) {
  const { confirm, dialog } = useAppConfirmDialog();
  const [draft, setDraft] = useState<McpConnectionDraft>(() => editing ? { name: editing.name, endpointUrl: editing.endpointUrl, authKind: editing.authKind, bearerToken: "", allowPrivateNetwork: editing.allowPrivateNetwork } : createDefaultMcpDraft());
  const [pending, setPending] = useState<"testing" | "saving" | null>(null);
  const [testedProbe, setTestedProbe] = useState<Readonly<{ draftProbeId: string; createRequestKey: string; testedAt: string; protocolVersion: string | null; resultCount: number | null } | null>>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);

  function setValue<K extends keyof McpConnectionDraft>(key: K, value: McpConnectionDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setTestedProbe(null);
  }

  function buildDraftInput(createRequestKey: string) {
    return { name: draft.name, endpointUrl: draft.endpointUrl, authKind: draft.authKind, bearerToken: draft.authKind === "bearer" ? draft.bearerToken : null, allowPrivateNetwork: draft.allowPrivateNetwork, clientRequestKey: createRequestKey };
  }

  function editCandidate() {
    return { endpointUrl: draft.endpointUrl, authKind: draft.authKind, bearerToken: draft.authKind === "bearer" ? draft.bearerToken : null, allowPrivateNetwork: draft.allowPrivateNetwork };
  }

  async function testConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending !== null) return;
    setPending("testing"); setMessage(null);
    try {
      const createRequestKey = globalThis.crypto.randomUUID();
      const draftInput = buildDraftInput(createRequestKey);
      const probeResponse = await fetch(editing ? `/api/me/mcp-connections/${encodeURIComponent(editing.id)}/probe` : "/api/me/mcp-connections/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(editing ? { clientRequestKey: createRequestKey, expectedUpdatedAt: editing.updatedAt, candidate: editCandidate() } : draftInput) });
      if (!probeResponse.ok) throw await readSafeConnectionError(probeResponse, "MCP 连接测试失败");
      const probe = (await probeResponse.json() as { probe: { draftProbeId: string | null; createRequestKey: string; status: string; safeErrorCode: string | null; result: { protocolVersion: string | null; resultCount: number | null } } }).probe;
      if (probe.status !== "settled" || probe.draftProbeId === null || probe.createRequestKey !== createRequestKey) {
        throw new ConnectionRequestError(probe.safeErrorCode ? `MCP 连接测试失败：${probe.safeErrorCode}` : "MCP 连接测试未通过，请检查端点、认证和服务协议。", probe.safeErrorCode ?? "MCP_CONNECTION_PROBE_FAILED", 409);
      }
      setTestedProbe({ draftProbeId: probe.draftProbeId, createRequestKey, testedAt: new Date().toISOString(), protocolVersion: probe.result.protocolVersion, resultCount: probe.result.resultCount });
      setMessage({ tone: "success", text: "连接测试成功。请核对下方协议与工具数量，再点击“保存连接”。" });
    } catch (error) {
      setTestedProbe(null);
      setMessage({ tone: "error", text: connectionErrorText(error, "MCP 连接测试失败") });
    } finally { setPending(null); }
  }

  async function saveConnection() {
    if (pending !== null || testedProbe === null) return;
    setPending("saving"); setMessage(null);
    try {
      if (editing) {
        const candidate = editCandidate();
        const base = `/api/me/mcp-connections/${encodeURIComponent(editing.id)}/governance`;
        const intent = { action: "rediscover", reason: "编辑 MCP 连接地址或认证并重新发现", requestKey: crypto.randomUUID(), expectedUpdatedAt: editing.updatedAt, draftProbeId: testedProbe.draftProbeId, probeRequestKey: testedProbe.createRequestKey, candidate };
        const previewResponse = await fetch(`${base}/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intent) });
        if (!previewResponse.ok) throw await readSafeConnectionError(previewResponse, "连接影响预览失败");
        const preview = (await previewResponse.json() as { preview: { id: string; requestKey: string; requestFingerprint: string; impactFingerprint: string; blockers: string[]; canExecute: boolean } }).preview;
        if (!preview.canExecute) throw new ConnectionRequestError(`请先处理连接影响：${connectionBlockerText(preview.blockers)}`, "MCP_CONNECTION_IN_USE", 409);
        const approval = await confirm({ eyebrow: "连接配置变更", title: "保存已测试的新配置？", description: "旧项目委托和工具授权必须先撤销。保存会更新配置版本，之后需要在项目中重新授权并审核工具。", confirmLabel: "保存新配置", cancelLabel: "返回检查" });
        if (!approval.confirmed) return;
        const executeResponse = await fetch(`${base}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ previewId: preview.id, requestKey: preview.requestKey, requestFingerprint: preview.requestFingerprint, impactFingerprint: preview.impactFingerprint, expectedUpdatedAt: editing.updatedAt, draftProbeId: testedProbe.draftProbeId, probeRequestKey: testedProbe.createRequestKey, candidate }) });
        if (!executeResponse.ok) throw await readSafeConnectionError(executeResponse, "连接配置保存失败");
        onEdited?.();
        return;
      }
      const createInput = buildDraftInput(testedProbe.createRequestKey);
      const response = await fetch("/api/me/mcp-connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...createInput, clientRequestKey: undefined, draftProbeId: testedProbe.draftProbeId, createRequestKey: testedProbe.createRequestKey }) });
      if (!response.ok) throw await readSafeConnectionError(response, "MCP 连接保存失败");
      const connection = (await response.json() as { connection: McpConnection }).connection;
      onCreated?.(connection); setDraft(createDefaultMcpDraft()); setTestedProbe(null); setMessage({ tone: "success", text: "已完成 MCP initialize 和 tools/list 只读测试并加密保存。Token 输入框已清空；后续变更请在连接卡片中通过安全治理预览管理。" });
    } catch (error) { setMessage({ tone: "error", text: connectionErrorText(error, "MCP 连接保存失败") }); }
    finally { setPending(null); setDraft((current) => ({ ...current, bearerToken: "" })); setTestedProbe(null); }
  }

  return <><section className="h-fit min-w-0 rounded-3xl border border-slate-200 bg-white p-5 sm:p-6"><div className="flex items-center gap-2"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">{editing ? "Edit personal connection" : "New personal connection"}</p><HelpTooltip label="MCP 连接流程">填写端点和认证 → 测试 initialize 与 tools/list → 核对结果后保存 → 在项目中单独完成授权。</HelpTooltip></div><h2 className="mt-2 text-xl font-semibold">{editing ? "编辑 MCP 地址与认证" : "添加远程 MCP"}</h2><p className="mt-2 text-xs leading-5 text-slate-600">{editing ? "地址或认证变化必须重新输入完整 Token，先测试 initialize 和 tools/list，再查看授权影响。活动委托和工具授权需先撤销；保存后重新授权并审核工具。" : "只支持 Streamable HTTP；先测试 initialize 和 tools/list，确认协议与工具目录后再保存。"}</p><form id="mcp-create-form" onSubmit={testConnection} className="mt-5 space-y-3"><Field label="连接名称"><input className={connectionFieldClass} value={draft.name} onChange={(event) => setValue("name", event.target.value)} maxLength={80} placeholder="我的知识工具" disabled={editing !== undefined} required /></Field><Field label="Streamable HTTP 端点"><input type="url" className={connectionFieldClass} value={draft.endpointUrl} onChange={(event) => setValue("endpointUrl", event.target.value)} placeholder="https://tools.example.com/mcp" required /></Field><Field label="认证方式"><select className={connectionFieldClass} value={draft.authKind} onChange={(event) => setValue("authKind", event.target.value as "none" | "bearer")}><option value="bearer">Bearer Token</option><option value="none">无认证</option></select></Field>{draft.authKind === "bearer" ? <Field label="Bearer Token"><input type="password" autoComplete="new-password" className={connectionFieldClass} value={draft.bearerToken} onChange={(event) => setValue("bearerToken", event.target.value)} minLength={8} maxLength={4096} required /></Field> : null}<label className="mt-2 flex items-start gap-3 rounded-2xl bg-amber-50 p-4 text-xs leading-5 text-amber-900"><input type="checkbox" checked={draft.allowPrivateNetwork} onChange={(event) => setValue("allowPrivateNetwork", event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span><strong className="block">允许受信内网地址</strong><span>只对你明确管理的公司服务开启；云元数据地址始终禁止。</span></span></label>{testedProbe ? <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs leading-5 text-emerald-800"><p className="font-semibold">测试成功 · {formatConnectionDate(testedProbe.testedAt)}</p><p className="mt-1">协议：{testedProbe.protocolVersion ?? "已响应"} · 工具：{testedProbe.resultCount ?? 0} 个</p></div> : null}{message ? <p role={message.tone === "error" ? "alert" : "status"} className={`text-xs leading-5 ${message.tone === "error" ? "text-rose-700" : message.tone === "success" ? "text-emerald-700" : "text-slate-600"}`}>{message.text}</p> : null}<ConnectionDialogActions><div className="flex w-full flex-wrap gap-2"><button type="submit" form="mcp-create-form" disabled={pending !== null} className={`${connectionButtonClass} min-h-11 flex-1 bg-slate-950 px-4 text-sm text-white hover:bg-violet-700`}>{pending === "testing" ? "测试中…" : testedProbe ? "重新测试连接" : "测试连接"}</button>{testedProbe ? <button type="button" onClick={() => void saveConnection()} disabled={pending !== null} className={`${connectionButtonClass} min-h-11 flex-1 border border-slate-300 bg-white px-4 text-sm text-slate-800 hover:bg-violet-50`}>{pending === "saving" ? "保存中…" : editing ? "保存新配置" : "保存连接"}</button> : null}</div></ConnectionDialogActions></form><p className="mt-4 text-[12px] leading-5 text-slate-700">远端 annotations 只是未受信提示；个人页面不会自动执行工具，也不会代替平台审核。</p></section>{dialog}</>;
}

function McpConnectionCard({ connection, onRemoved, onReload }: { connection: McpConnection; onRemoved: () => void; onReload: () => Promise<void> }) {
  const activeTools = connection.toolDefinitions.filter((tool) => isActiveMcpAttestation(tool)).length;
  const [editing, setEditing] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);
  return <><article className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5"><div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-2"><h3 className="max-w-full break-words text-base font-semibold text-slate-900">{connection.name}</h3><button type="button" onClick={() => setEditing(true)} className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">编辑名称</button><button type="button" onClick={() => setEditingConfig(true)} className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">编辑地址与认证</button><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ring-1 ${statusStyles[connection.status]}`}>{mcpStatusLabels[connection.status]}</span></div><p className="mt-2 break-all text-xs text-slate-500">{connection.endpointUrl}</p></div><div className="shrink-0 text-right text-xs text-slate-400"><p>{connection.authKind === "none" ? "无凭据" : "Bearer（已加密）"}</p><p className="mt-1">更新于 {formatConnectionDate(connection.updatedAt)}</p></div></div><details className="mt-4 border-t border-slate-200 pt-3"><summary className="cursor-pointer text-xs font-semibold text-indigo-700">展开详情与管理</summary>{connection.lastErrorCode ? <p role="status" className="mt-3 break-words rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">最近错误：{connection.lastErrorCode}。请通过安全治理预览管理后续变更；重新发现会先执行 initialize 和 tools/list 只读测试，再继续影响预览；其他治理动作不会发起协议请求。</p> : null}<dl className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3"><div><dt className="text-slate-400">协议</dt><dd className="mt-1 font-medium">{connection.protocolVersion ?? "待发现"}</dd></div><div><dt className="text-slate-400">工具目录</dt><dd className="mt-1 font-medium">{connection.toolDefinitions.length} 个，当前 V2 审核 {activeTools} 个</dd></div><div><dt className="text-slate-400">最近发现</dt><dd className="mt-1 font-medium">{formatConnectionDate(connection.lastDiscoveredAt)}</dd></div></dl><div className="mt-4"><ScopeEvidenceCard title="个人 MCP 连接边界" evidence={{ scope: "个人连接", owner: "当前账户", payer: "第三方费用由连接所有者承担或按其与服务商约定", affectedProjects: "尚未取得项目委托证据；仅按项目权限与明确委托判断，不展示项目标识或数量", latestSuccess: connection.lastDiscoveredAt ? `最近发现（不是调用成功）：${formatConnectionDate(connection.lastDiscoveredAt)}` : "尚未完成工具发现（不是调用成功）" }} /></div>{connection.toolDefinitions.length > 0 ? <details className="mt-4 rounded-xl bg-white p-4"><summary className="cursor-pointer text-xs font-semibold text-slate-700">查看工具安全摘要（只读展示）</summary><div className="mt-3 space-y-2">{connection.toolDefinitions.map((tool) => { const attested = isActiveMcpAttestation(tool); return <div key={tool.id} className="min-w-0 rounded-xl border border-slate-100 px-3 py-3 text-xs"><div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="break-words font-semibold text-slate-800">{tool.title || tool.name}</p><p className="mt-1 break-all font-mono text-[10px] text-slate-400">{tool.name}</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${attested ? "bg-emerald-50 text-emerald-700" : tool.remoteReadOnlyHint ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700"}`}>{attested ? "当前 V2 已审核" : tool.remoteReadOnlyHint ? "仅远端声明" : "声明不足"}</span></div>{tool.description ? <p className="mt-2 break-words leading-5 text-slate-500">{tool.description}</p> : null}<p className="mt-2 text-[12px] leading-5 text-slate-400">远端声明不具备授权资格；管理员审核与项目授权由平台流程负责。</p></div>; })}</div></details> : null}<p className="mt-3 text-xs leading-5 text-slate-500">费用承担者为连接所有者；第三方费用由其与服务商约定，平台不代扣，也不计入项目平台额度。</p><ConnectionGovernancePanel key={`${connection.id}:${connection.updatedAt}`} kind="mcp" connection={{ id: connection.id, name: connection.name, status: connection.status, updatedAt: connection.updatedAt, authKind: connection.authKind, recoveryState: connection.recoveryState }} onReload={onReload} onRemoved={onRemoved} />{connection.status === "disabled" ? <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">连接已停用；重新启用后必须重新发现。重新发现会先执行 initialize 和 tools/list 只读测试，再继续影响预览；其他治理动作不会发起协议请求。</p> : null}</details></article>{editing ? <ConnectionEditDialog kind="mcp" connection={connection} onClose={() => setEditing(false)} onSaved={() => void onReload()} /> : null}{editingConfig ? <ConnectionCreateDialog title="编辑 MCP 地址与认证" onClose={() => setEditingConfig(false)}><McpCreateForm editing={connection} onEdited={() => { setEditingConfig(false); void onReload(); }} /></ConnectionCreateDialog> : null}</>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const help = label.includes("地址") || label.includes("端点")
    ? "Streamable HTTP 端点示例：https://mcp.example.com/mcp。请替换成你的服务端点；测试只做协议握手和工具目录读取，不调用工具。"
    : label.includes("Bearer") || label.includes("Token")
      ? "从自己的 MCP 服务取得只读 Bearer Token；这里没有可直接使用的示例凭据。"
      : label.includes("认证")
        ? "仅选择当前支持的无认证或 Bearer 方式。连接测试成功不代表工具获得项目授权。"
        : null;
  return <div className="relative min-w-0"><label className="block min-w-0 text-xs font-semibold text-slate-700">{label}{children}</label>{help ? <span className="absolute right-0 top-0"><HelpTooltip label={label}>{help}</HelpTooltip></span> : null}</div>;
}
