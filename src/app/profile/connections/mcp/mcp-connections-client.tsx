"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import {
  connectionButtonClass,
  connectionErrorText,
  connectionFieldClass,
  type ConnectionMessage,
  formatConnectionDate,
  isConnectionConflict,
  readConnectionError,
} from "../connection-ui";
import {
  createDefaultMcpDraft,
  isActiveMcpAttestation,
  mcpCredentialLabel,
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

export function McpConnectionsClient() {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return <div className="mx-auto max-w-6xl px-5 pb-16 pt-7 sm:px-8 lg:px-10"><div className="flex flex-wrap items-center justify-between gap-3"><Link href="/profile" className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"><span aria-hidden="true">←</span> 返回个人中心</Link><span className="text-xs text-slate-400">个人设置 / 我的连接 / MCP</span></div><section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7"><div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">My MCP connections</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">我的 MCP 连接</h1><p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">连接只属于当前账户。你可以发现远程 Streamable HTTP 服务的工具目录，并查看平台安全摘要；凭据、工具指纹和管理员审核细节不会在页面展示。</p></div><div className="rounded-2xl bg-violet-50 px-4 py-3 text-sm text-violet-950 lg:max-w-xs"><p className="font-semibold">当前使用边界</p><p className="mt-1 text-xs leading-5">项目委托开发中，当前连接不能用于项目/自动化。管理员审核与项目授权不在个人页面操作。</p></div></div></section>{message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-5 rounded-2xl px-4 py-3 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-700" : message.tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>{message.text}</p> : null}{loadError ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span>{loadError}</span><button type="button" onClick={() => void load()} className="min-h-10 font-semibold underline">重试</button></div> : null}<div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(280px,.78fr)_minmax(0,1.22fr)]"><McpCreateForm onCreated={(connection) => { setConnections((current) => [...current, connection]); setMessage({ tone: "success", text: "MCP 连接已保存。请在连接卡片中发现工具。" }); }} /><section className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">已有连接</h2><p className="mt-1 text-xs leading-5 text-slate-500">展示连接状态和工具安全摘要，不提供管理员审核或项目授权按钮。</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{loading ? "读取中…" : `${connections.length} 个连接`}</span></div>{loading ? <div className="mt-5 space-y-3" aria-label="正在加载 MCP 连接"><div className="h-56 animate-pulse rounded-2xl bg-slate-100" /><div className="h-56 animate-pulse rounded-2xl bg-slate-100" /></div> : connections.length === 0 ? <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-9 text-center"><p className="text-sm font-semibold text-slate-700">还没有个人 MCP 连接</p><p className="mt-2 text-xs leading-5 text-slate-500">从左侧添加一个远程服务，保存后发现当前工具目录。</p></div> : <div className="mt-5 space-y-4">{connections.map((connection) => <McpConnectionCard key={connection.id} connection={connection} onChanged={(next) => setConnections((current) => current.map((item) => item.id === next.id ? next : item))} onRemoved={(id) => { setConnections((current) => current.filter((item) => item.id !== id)); setMessage({ tone: "success", text: "MCP 连接已删除。" }); }} onReload={load} />)}</div>}</section></div></div>;
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
      onCreated(connection); setDraft(createDefaultMcpDraft()); setMessage({ tone: "success", text: "已加密保存。Token 输入框已清空，请在卡片中发现工具。" });
    } catch (error) { setMessage({ tone: "error", text: connectionErrorText(error, "MCP 连接保存失败") }); }
    finally { setPending(false); setDraft((current) => ({ ...current, bearerToken: "" })); }
  }

  return <section className="h-fit min-w-0 rounded-3xl border border-violet-100 bg-violet-50/40 p-5 shadow-sm sm:p-6"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">New personal connection</p><h2 className="mt-2 text-xl font-semibold">添加远程 MCP</h2><p className="mt-2 text-xs leading-5 text-slate-600">只支持 Streamable HTTP；普通用户也可以配置自己的连接。</p><form onSubmit={submit} className="mt-5 space-y-3"><Field label="连接名称"><input className={connectionFieldClass} value={draft.name} onChange={(event) => setValue("name", event.target.value)} maxLength={80} placeholder="我的知识工具" required /></Field><Field label="Streamable HTTP 端点"><input type="url" className={connectionFieldClass} value={draft.endpointUrl} onChange={(event) => setValue("endpointUrl", event.target.value)} placeholder="https://tools.example.com/mcp" required /></Field><Field label="认证方式"><select className={connectionFieldClass} value={draft.authKind} onChange={(event) => setValue("authKind", event.target.value as "none" | "bearer")}><option value="bearer">Bearer Token</option><option value="none">无认证</option></select></Field>{draft.authKind === "bearer" ? <Field label="Bearer Token"><input type="password" autoComplete="new-password" className={connectionFieldClass} value={draft.bearerToken} onChange={(event) => setValue("bearerToken", event.target.value)} minLength={8} maxLength={4096} required /></Field> : null}<label className="mt-2 flex items-start gap-3 rounded-2xl bg-amber-50 p-4 text-xs leading-5 text-amber-900"><input type="checkbox" checked={draft.allowPrivateNetwork} onChange={(event) => setValue("allowPrivateNetwork", event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span><strong className="block">允许受信内网地址</strong><span>只对你明确管理的公司服务开启；云元数据地址始终禁止。</span></span></label>{message ? <p role={message.tone === "error" ? "alert" : "status"} className={`text-xs leading-5 ${message.tone === "error" ? "text-rose-700" : "text-slate-600"}`}>{message.text}</p> : null}<button type="submit" disabled={pending} className={`${connectionButtonClass} min-h-11 w-full bg-slate-950 px-4 text-sm text-white hover:bg-violet-700`}>{pending ? "加密保存中…" : "加密保存连接"}</button></form><p className="mt-4 text-[11px] leading-5 text-slate-500">远端 annotations 只是未受信提示；个人页面不会自动执行工具，也不会代替平台审核。</p></section>;
}

function McpConnectionCard({ connection, onChanged, onRemoved, onReload }: { connection: McpConnection; onChanged: (connection: McpConnection) => void; onRemoved: (id: string) => void; onReload: () => Promise<void> }) {
  const { confirm, dialog } = useAppConfirmDialog();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(connection.name);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);

  function closeEdit() { setEditing(false); setName(connection.name); setToken(""); }

  async function failAndRefresh(error: unknown, fallback: string) {
    if (isConnectionConflict(error)) {
      await onReload(); setMessage({ tone: "error", text: "连接状态已刷新，请重新打开编辑或重试。" }); closeEdit();
    } else setMessage({ tone: "error", text: connectionErrorText(error, fallback) });
  }

  async function update(body: Record<string, unknown>, key: string, success: string): Promise<McpConnection | null> {
    setPending(key); setMessage(null);
    try {
      const response = await fetch(`/api/me/mcp-connections/${connection.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, expectedUpdatedAt: connection.updatedAt }) });
      if (!response.ok) throw await readConnectionError(response, "MCP 连接更新失败");
      const next = (await response.json() as { connection: McpConnection }).connection;
      onChanged(next); setMessage({ tone: "success", text: success }); return next;
    } catch (error) { await failAndRefresh(error, "MCP 连接更新失败"); return null; }
    finally { setPending(null); }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = await update({ name, ...(token ? { bearerToken: token } : {}) }, "edit", token ? "名称与 Token 已更新，请重新发现工具。" : "连接名称已更新。");
    setToken(""); if (next) closeEdit();
  }

  async function discover() {
    setPending("discover"); setMessage({ tone: "info", text: "正在向远程服务发现工具目录，当前不会执行工具。" });
    try {
      const response = await fetch(`/api/me/mcp-connections/${connection.id}/discover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: connection.updatedAt }) });
      if (!response.ok) throw await readConnectionError(response, "MCP 工具发现失败");
      const payload = await response.json() as { connection: McpConnection; discoveredCount: number; eligibleCount: number; rejectedCount: number };
      onChanged(payload.connection); setMessage({ tone: "success", text: `发现 ${payload.discoveredCount} 个工具；${payload.eligibleCount} 个具备只读提示，拒绝 ${payload.rejectedCount} 个不兼容定义。` });
    } catch (error) { await failAndRefresh(error, "MCP 工具发现失败"); }
    finally { setPending(null); }
  }

  async function toggle() { await update({ enabled: connection.status === "disabled" }, "toggle", connection.status === "disabled" ? "连接已重新启用，请重新发现工具。" : "连接已停用；项目授权（当前未开放）不会使用它。"); }

  async function trustNetwork() { await update({ trustCurrentNetwork: true }, "trust", "当前解析地址已重新确认，请重新发现工具。 "); }

  async function remove() {
    let current = connection;
    if (current.status !== "disabled" || current.disabledAt === null) {
      const disabled = await update({ enabled: false }, "disable-before-delete", "连接已停用，请继续确认删除。");
      if (!disabled) return;
      current = disabled;
    }
    const result = await confirm({ eyebrow: "Delete personal MCP connection", title: `删除“${current.name}”？`, description: "删除会移除工具快照、连接和加密凭据，且不可恢复；如果未来存在项目授权或历史审计引用，服务端会拒绝删除。", inputLabel: `输入连接名称“${current.name}”以确认`, inputPlaceholder: current.name, requiredValue: current.name, confirmLabel: "确认删除", tone: "danger", maxLength: 80 });
    if (!result.confirmed) return;
    setPending("delete"); setMessage(null);
    try {
      const response = await fetch(`/api/me/mcp-connections/${current.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationName: result.value, expectedUpdatedAt: current.updatedAt }) });
      if (!response.ok) throw await readConnectionError(response, "MCP 连接删除失败");
      onRemoved(current.id);
    } catch (error) { await failAndRefresh(error, "MCP 连接删除失败"); }
    finally { setPending(null); }
  }

  const activeTools = connection.toolDefinitions.filter((tool) => isActiveMcpAttestation(tool)).length;
  return <article className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5">{dialog}<div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-2"><h3 className="max-w-full break-words text-base font-semibold text-slate-900">{connection.name}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${statusStyles[connection.status]}`}>{mcpStatusLabels[connection.status]}</span></div><p className="mt-2 break-all text-xs text-slate-500">{connection.endpointUrl}</p></div><div className="shrink-0 text-right text-xs text-slate-400"><p>{connection.authKind === "none" ? "无凭据" : `Bearer ${mcpCredentialLabel(connection)}`}</p><p className="mt-1">更新于 {formatConnectionDate(connection.updatedAt)}</p></div></div>{connection.lastErrorCode ? <p role="status" className="mt-3 break-words rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">最近错误：{connection.lastErrorCode}。确认网络或轮换凭据后请重新发现。</p> : null}<dl className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3"><div><dt className="text-slate-400">协议</dt><dd className="mt-1 font-medium">{connection.protocolVersion ?? "待发现"}</dd></div><div><dt className="text-slate-400">工具目录</dt><dd className="mt-1 font-medium">{connection.toolDefinitions.length} 个，平台已审核 {activeTools} 个</dd></div><div><dt className="text-slate-400">最近发现</dt><dd className="mt-1 font-medium">{formatConnectionDate(connection.lastDiscoveredAt)}</dd></div></dl>{connection.toolDefinitions.length > 0 ? <details className="mt-4 rounded-xl bg-white p-4"><summary className="cursor-pointer text-xs font-semibold text-slate-700">查看工具安全摘要（只读展示）</summary><div className="mt-3 space-y-2">{connection.toolDefinitions.map((tool) => { const attested = isActiveMcpAttestation(tool); return <div key={tool.id} className="min-w-0 rounded-xl border border-slate-100 px-3 py-3 text-xs"><div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="break-words font-semibold text-slate-800">{tool.title || tool.name}</p><p className="mt-1 break-all font-mono text-[10px] text-slate-400">{tool.name}</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${attested ? "bg-emerald-50 text-emerald-700" : tool.remoteReadOnlyHint ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700"}`}>{attested ? "平台已审核" : tool.remoteReadOnlyHint ? "待平台审核" : "不满足只读提示"}</span></div>{tool.description ? <p className="mt-2 break-words leading-5 text-slate-500">{tool.description}</p> : null}<p className="mt-2 text-[11px] leading-5 text-slate-400">管理员审核与项目授权由平台流程负责，你无需在此操作。</p></div>; })}</div></details> : null}{editing ? <form onSubmit={saveEdit} className="mt-4 grid gap-3 rounded-xl border border-violet-100 bg-white p-4 sm:grid-cols-2"><Field label="连接名称"><input className={connectionFieldClass} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /></Field><Field label="轮换 Bearer Token（可选）"><input type="password" autoComplete="new-password" className={connectionFieldClass} value={token} onChange={(event) => setToken(event.target.value)} minLength={8} maxLength={4096} placeholder="留空表示不修改" /></Field><div className="flex flex-wrap gap-2 sm:col-span-2"><button type="submit" disabled={pending !== null} className={`${connectionButtonClass} bg-violet-600 text-white hover:bg-violet-500`}>{pending === "edit" ? "保存中…" : "保存修改"}</button><button type="button" onClick={closeEdit} className={`${connectionButtonClass} border border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}>取消</button></div></form> : null}{message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-3 text-xs leading-5 ${message.tone === "error" ? "text-rose-700" : message.tone === "success" ? "text-emerald-700" : "text-slate-600"}`}>{message.text}</p> : null}<div className="mt-4 flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap gap-2"><button type="button" onClick={() => { setName(connection.name); setToken(""); setEditing((current) => !current); }} disabled={pending !== null} className={`${connectionButtonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}>{editing ? "关闭编辑" : "编辑配置"}</button></div><div className="flex flex-wrap gap-2">{connection.status !== "disabled" ? <><button type="button" onClick={() => void trustNetwork()} disabled={pending !== null} className={`${connectionButtonClass} text-amber-700 hover:bg-amber-50`}>{pending === "trust" ? "确认中…" : "重新确认网络"}</button><button type="button" onClick={() => void discover()} disabled={pending !== null} className={`${connectionButtonClass} bg-violet-600 text-white hover:bg-violet-500`}>{pending === "discover" ? "发现中…" : "发现工具"}</button><button type="button" onClick={() => void toggle()} disabled={pending !== null} className={`${connectionButtonClass} text-rose-700 hover:bg-rose-50`}>{pending === "toggle" ? "处理中…" : "停用"}</button></> : <button type="button" onClick={() => void toggle()} disabled={pending !== null} className={`${connectionButtonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}>{pending === "toggle" ? "处理中…" : "重新启用"}</button>}<button type="button" onClick={() => void remove()} disabled={pending !== null} className={`${connectionButtonClass} text-rose-700 hover:bg-rose-50`}>{pending === "delete" ? "删除中…" : "删除"}</button></div></div>{connection.status === "disabled" ? <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">连接已停用；重新启用后需要重新发现工具。删除需要保持停用并输入准确名称。</p> : null}</article>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-0 text-xs font-semibold text-slate-700">{label}{children}</label>;
}
