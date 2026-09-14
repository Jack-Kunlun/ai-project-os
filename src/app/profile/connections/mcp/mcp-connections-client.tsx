"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import {
  connectionButtonClass,
  connectionErrorText,
  connectionFieldClass,
  type ConnectionMessage,
  formatConnectionDate,
  readConnectionError,
} from "../connection-ui";
import { ConnectionGovernancePanel } from "../governance-panel";
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

export function McpConnectionsClient() {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [ownerDelegations, setOwnerDelegations] = useState<readonly OwnerDelegation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ownerDelegationsLoading, setOwnerDelegationsLoading] = useState(true);
  const [ownerDelegationsError, setOwnerDelegationsError] = useState<string | null>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/me/mcp-connections", { cache: "no-store" });
      if (!response.ok) throw await readConnectionError(response, "个人 MCP 连接加载失败");
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
      if (!response.ok) throw await readConnectionError(response, "MCP 委托安全记录加载失败");
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
        <Link href="/profile" className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"><span aria-hidden="true">←</span> 返回个人中心</Link>
        <span className="text-xs text-slate-400">个人设置 / 我的连接 / MCP</span>
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
            <p className="mt-1 text-xs leading-5">项目委托控制面已开放；远端动作、自动化和调用审批仍未开放。保存时会执行受限 DNS/地址安全解析；不会发起 MCP 协议请求或向远端发送凭据，MCP 连通性仍未验证。</p>
          </div>
        </div>
      </section>

      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-5 rounded-2xl px-4 py-3 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-700" : message.tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>{message.text}</p> : null}
      {loadError ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span>{loadError}</span><button type="button" onClick={() => void load()} className="min-h-10 font-semibold underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500">重试</button></div> : null}

      <McpOwnerDelegationQueue delegations={ownerDelegations} loading={ownerDelegationsLoading} error={ownerDelegationsError} onReload={loadOwnerDelegations} onMessage={setMessage} />

      <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(280px,.78fr)_minmax(0,1.22fr)]">
        <McpCreateForm onCreated={(connection) => { setConnections((current) => [...current, connection]); setMessage({ tone: "success", text: "MCP 连接已保存。请在连接卡片中通过安全治理预览管理后续变更。" }); }} />
        <section className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-xl font-semibold">已有连接</h2><p className="mt-1 text-xs leading-5 text-slate-500">展示连接状态和工具安全摘要，不提供管理员审核或项目授权按钮。</p></div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{loading ? "读取中…" : `${connections.length} 个连接`}</span>
          </div>
          {loading ? <div role="status" className="mt-5 space-y-3" aria-label="正在加载 MCP 连接"><div className="h-56 animate-pulse rounded-2xl bg-slate-100" /><div className="h-56 animate-pulse rounded-2xl bg-slate-100" /></div> : connections.length === 0 ? <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-9 text-center"><p className="text-sm font-semibold text-slate-700">还没有个人 MCP 连接</p><p className="mt-2 text-xs leading-5 text-slate-500">从左侧添加一个远程服务。保存时会执行受限 DNS/地址安全解析；不会发起 MCP 协议请求或向远端发送凭据，MCP 连通性仍未验证。</p></div> : <div className="mt-5 space-y-4">{connections.map((connection) => <McpConnectionCard key={connection.id} connection={connection} onRemoved={() => { setConnections((current) => current.filter((item) => item.id !== connection.id)); setMessage({ tone: "success", text: "MCP 连接已删除。" }); }} onReload={load} />)}</div>}
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
      if (!response.ok) throw await readConnectionError(response, "连接所有者确认失败");
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
      if (!response.ok) throw await readConnectionError(response, action === "rejection" ? "拒绝 MCP 委托失败" : "撤销 MCP 委托失败");
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

function McpCreateForm({ onCreated }: { onCreated: (connection: McpConnection) => void }) {
  const [draft, setDraft] = useState<McpConnectionDraft>(() => createDefaultMcpDraft());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);

  function setValue<K extends keyof McpConnectionDraft>(key: K, value: McpConnectionDraft[K]) { setDraft((current) => ({ ...current, [key]: value })); }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/me/mcp-connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft.name, endpointUrl: draft.endpointUrl, authKind: draft.authKind, bearerToken: draft.authKind === "bearer" ? draft.bearerToken : null, allowPrivateNetwork: draft.allowPrivateNetwork }) });
      if (!response.ok) throw await readConnectionError(response, "MCP 连接保存失败");
      const connection = (await response.json() as { connection: McpConnection }).connection;
      onCreated(connection); setDraft(createDefaultMcpDraft()); setMessage({ tone: "success", text: "已加密保存。Token 输入框已清空；后续变更请在连接卡片中通过安全治理预览管理。保存时已执行受限 DNS/地址安全解析；未发起 MCP 协议请求或向远端发送凭据，MCP 连通性仍未验证。" });
    } catch (error) { setMessage({ tone: "error", text: connectionErrorText(error, "MCP 连接保存失败") }); }
    finally { setPending(false); setDraft((current) => ({ ...current, bearerToken: "" })); }
  }

  return <section className="h-fit min-w-0 rounded-3xl border border-violet-100 bg-violet-50/40 p-5 shadow-sm sm:p-6"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">New personal connection</p><h2 className="mt-2 text-xl font-semibold">添加远程 MCP</h2><p className="mt-2 text-xs leading-5 text-slate-600">只支持 Streamable HTTP；普通用户也可以配置自己的连接。</p><form onSubmit={submit} className="mt-5 space-y-3"><Field label="连接名称"><input className={connectionFieldClass} value={draft.name} onChange={(event) => setValue("name", event.target.value)} maxLength={80} placeholder="我的知识工具" required /></Field><Field label="Streamable HTTP 端点"><input type="url" className={connectionFieldClass} value={draft.endpointUrl} onChange={(event) => setValue("endpointUrl", event.target.value)} placeholder="https://tools.example.com/mcp" required /></Field><Field label="认证方式"><select className={connectionFieldClass} value={draft.authKind} onChange={(event) => setValue("authKind", event.target.value as "none" | "bearer")}><option value="bearer">Bearer Token</option><option value="none">无认证</option></select></Field>{draft.authKind === "bearer" ? <Field label="Bearer Token"><input type="password" autoComplete="new-password" className={connectionFieldClass} value={draft.bearerToken} onChange={(event) => setValue("bearerToken", event.target.value)} minLength={8} maxLength={4096} required /></Field> : null}<label className="mt-2 flex items-start gap-3 rounded-2xl bg-amber-50 p-4 text-xs leading-5 text-amber-900"><input type="checkbox" checked={draft.allowPrivateNetwork} onChange={(event) => setValue("allowPrivateNetwork", event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span><strong className="block">允许受信内网地址</strong><span>只对你明确管理的公司服务开启；云元数据地址始终禁止。</span></span></label>{message ? <p role={message.tone === "error" ? "alert" : "status"} className={`text-xs leading-5 ${message.tone === "error" ? "text-rose-700" : "text-slate-600"}`}>{message.text}</p> : null}<button type="submit" disabled={pending} className={`${connectionButtonClass} min-h-11 w-full bg-slate-950 px-4 text-sm text-white hover:bg-violet-700`}>{pending ? "加密保存中…" : "加密保存连接"}</button></form><p className="mt-4 text-[12px] leading-5 text-slate-700">远端 annotations 只是未受信提示；个人页面不会自动执行工具，也不会代替平台审核。</p></section>;
}

function McpConnectionCard({ connection, onRemoved, onReload }: { connection: McpConnection; onRemoved: () => void; onReload: () => Promise<void> }) {
  const activeTools = connection.toolDefinitions.filter((tool) => isActiveMcpAttestation(tool)).length;
  return <article className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5"><div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-2"><h3 className="max-w-full break-words text-base font-semibold text-slate-900">{connection.name}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ring-1 ${statusStyles[connection.status]}`}>{mcpStatusLabels[connection.status]}</span></div><p className="mt-2 break-all text-xs text-slate-500">{connection.endpointUrl}</p></div><div className="shrink-0 text-right text-xs text-slate-400"><p>{connection.authKind === "none" ? "无凭据" : "Bearer（已加密）"}</p><p className="mt-1">更新于 {formatConnectionDate(connection.updatedAt)}</p></div></div>{connection.lastErrorCode ? <p role="status" className="mt-3 break-words rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">最近错误：{connection.lastErrorCode}。请通过安全治理预览管理后续变更；治理动作不会发起 MCP 协议请求或向远端发送凭据，MCP 连通性仍未验证。</p> : null}<dl className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3"><div><dt className="text-slate-400">协议</dt><dd className="mt-1 font-medium">{connection.protocolVersion ?? "待发现"}</dd></div><div><dt className="text-slate-400">工具目录</dt><dd className="mt-1 font-medium">{connection.toolDefinitions.length} 个，当前 V2 审核 {activeTools} 个</dd></div><div><dt className="text-slate-400">最近发现</dt><dd className="mt-1 font-medium">{formatConnectionDate(connection.lastDiscoveredAt)}</dd></div></dl>{connection.toolDefinitions.length > 0 ? <details className="mt-4 rounded-xl bg-white p-4"><summary className="cursor-pointer text-xs font-semibold text-slate-700">查看工具安全摘要（只读展示）</summary><div className="mt-3 space-y-2">{connection.toolDefinitions.map((tool) => { const attested = isActiveMcpAttestation(tool); return <div key={tool.id} className="min-w-0 rounded-xl border border-slate-100 px-3 py-3 text-xs"><div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="break-words font-semibold text-slate-800">{tool.title || tool.name}</p><p className="mt-1 break-all font-mono text-[10px] text-slate-400">{tool.name}</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${attested ? "bg-emerald-50 text-emerald-700" : tool.remoteReadOnlyHint ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700"}`}>{attested ? "当前 V2 已审核" : tool.remoteReadOnlyHint ? "仅远端声明" : "声明不足"}</span></div>{tool.description ? <p className="mt-2 break-words leading-5 text-slate-500">{tool.description}</p> : null}<p className="mt-2 text-[12px] leading-5 text-slate-400">远端声明不具备授权资格；管理员审核与项目授权由平台流程负责。</p></div>; })}</div></details> : null}<p className="mt-3 text-xs leading-5 text-slate-500">费用承担者为连接所有者；第三方费用由其与服务商约定，平台不代扣，也不计入项目平台额度。</p><ConnectionGovernancePanel key={`${connection.id}:${connection.updatedAt}`} kind="mcp" connection={{ id: connection.id, name: connection.name, status: connection.status, updatedAt: connection.updatedAt, authKind: connection.authKind, recoveryState: connection.recoveryState }} onReload={onReload} onRemoved={onRemoved} />{connection.status === "disabled" ? <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">连接已停用；重新启用后必须重新发现。治理动作不会发起 MCP 协议请求或向远端发送凭据，MCP 连通性仍未验证。</p> : null}</article>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-0 text-xs font-semibold text-slate-700">{label}{children}</label>;
}
