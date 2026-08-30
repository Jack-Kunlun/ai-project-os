"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { ConnectionTabs } from "@/components/connection-tabs";

type ToolDefinition = {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  remoteReadOnlyHint: boolean;
  definitionFingerprint: string;
  discoveredAt: string;
  attestations: Array<{
    id: string;
    definitionFingerprint: string;
    networkFingerprint: string;
    credentialFingerprint: string;
    attestedAt: string;
    audits: Array<{ event: "attested" | "revoked" }>;
  }>;
};

type Connection = {
  id: string;
  name: string;
  endpointUrl: string;
  authKind: "none" | "bearer";
  allowPrivateNetwork: boolean;
  protocolVersion: string | null;
  catalogFingerprint: string | null;
  status: "configured" | "verified" | "error" | "disabled";
  lastDiscoveredAt: string | null;
  lastErrorCode: string | null;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
  credential: { maskedSuffix: string; rotatedAt: string | null; updatedAt: string } | null;
  toolDefinitions: ToolDefinition[];
};

const statusLabels = { configured: "待发现", verified: "已验证", error: "发现失败", disabled: "已停用" } as const;
const statusTones = {
  configured: "bg-amber-50 text-amber-700 ring-amber-200",
  verified: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-rose-50 text-rose-700 ring-rose-200",
  disabled: "bg-slate-100 text-slate-500 ring-slate-200",
} as const;

async function responseError(response: Response, fallback: string) {
  try { return (await response.json() as { error?: { message?: string } }).error?.message ?? fallback; }
  catch { return fallback; }
}

function activeAttestation(tool: ToolDefinition) {
  const latest = tool.attestations[0];
  return latest !== undefined
    && latest.definitionFingerprint === tool.definitionFingerprint
    && latest.audits.some((audit) => audit.event === "attested")
    && !latest.audits.some((audit) => audit.event === "revoked")
    ? latest
    : null;
}

export function McpConnectionsClient({ username }: { username: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/settings/mcp-connections", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "MCP 连接加载失败"));
      setConnections((await response.json() as { connections: Connection[] }).connections);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "MCP 连接加载失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="connections" />
      <div className="mx-auto max-w-7xl px-6 py-10 sm:px-10 lg:px-12">
        <section className="grid gap-8 rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-7 py-9 text-white shadow-xl shadow-slate-950/10 lg:grid-cols-[1.2fr_.8fr] lg:px-10">
          <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Controlled capability connections</p><h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em]">MCP 只读工具连接</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">管理员在页面登记远程 Streamable HTTP 服务并发现工具。工具声明先固化为快照，只有明确声明只读且非破坏性的定义才能由项目 Owner 授权。</p></div>
          <div className="grid grid-cols-2 gap-3 text-xs">{["仅远程 HTTPS / 受信内网", "Bearer 凭据加密", "工具定义追加式快照", "调用必须逐次审批"].map((item) => <div key={item} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-slate-200">{item}</div>)}</div>
        </section>
        <ConnectionTabs active="mcp" />
        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900"><strong>安全边界：</strong>服务端的 <code>readOnlyHint</code> 只是未受信声明。本系统还要求 <code>destructiveHint=false</code>、管理员验证、Owner 明确授权和每次审批；远端服务本身仍必须由你信任并使用只读凭据。当前不支持 stdio、本地进程、旧式 HTTP+SSE 或执行中继续索取输入。</div>
        {error ? <p role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}
        <div className="mt-8 grid gap-7 xl:grid-cols-[.82fr_1.18fr]">
          <McpConnectionForm onCreated={(connection) => setConnections((current) => [...current, connection])} />
          <section><div className="mb-4 flex items-end justify-between px-1"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Configured</p><h2 className="mt-2 text-2xl font-semibold">已配置服务</h2></div><span className="text-xs text-slate-400">{loading ? "读取中…" : `${connections.length} 个`}</span></div><div className="space-y-4">{!loading && connections.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-sm text-slate-500">先添加远程 MCP 服务并完成工具发现，再到项目“工具权限”页逐项授权。</div> : null}{connections.map((connection) => <McpConnectionCard key={connection.id} connection={connection} onChanged={(next) => setConnections((current) => current.map((item) => item.id === next.id ? next : item))} />)}</div></section>
        </div>
      </div>
    </main>
  );
}

function McpConnectionForm({ onCreated }: { onCreated: (connection: Connection) => void }) {
  const [name, setName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [authKind, setAuthKind] = useState<"none" | "bearer">("bearer");
  const [bearerToken, setBearerToken] = useState("");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/settings/mcp-connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, endpointUrl, authKind, bearerToken: authKind === "bearer" ? bearerToken : null, allowPrivateNetwork }) });
      if (!response.ok) throw new Error(await responseError(response, "连接保存失败"));
      const connection = (await response.json() as { connection: Connection }).connection;
      onCreated(connection); setBearerToken(""); setMessage("连接已加密保存。下一步请执行工具发现。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "连接保存失败"); }
    finally { setPending(false); }
  }

  return <form onSubmit={submit} className="h-fit rounded-3xl border border-slate-200 bg-white p-6 shadow-sm lg:p-7"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">New MCP connection</p><h2 className="mt-2 text-2xl font-semibold">添加远程服务</h2><Field label="连接名称"><input className="field" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="内部知识工具" required /></Field><Field label="Streamable HTTP 端点"><input className="field" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} placeholder="https://tools.company.com/mcp" required /></Field><Field label="认证方式"><select className="field" value={authKind} onChange={(event) => setAuthKind(event.target.value as "none" | "bearer")}><option value="bearer">Bearer Token</option><option value="none">无认证</option></select></Field>{authKind === "bearer" ? <Field label="Bearer Token"><input type="password" autoComplete="new-password" className="field" value={bearerToken} onChange={(event) => setBearerToken(event.target.value)} minLength={8} required /></Field> : null}<label className="mt-5 flex items-start gap-3 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700"><input type="checkbox" checked={allowPrivateNetwork} onChange={(event) => setAllowPrivateNetwork(event.target.checked)} className="mt-1" /><span><strong className="block">允许受信内网地址</strong><span className="mt-1 block text-xs leading-5 text-slate-500">仅用于明确管理的公司服务；云元数据地址始终禁止。公网连接必须使用 HTTPS。</span></span></label>{message ? <p role="status" className="mt-4 text-xs leading-5 text-slate-600">{message}</p> : null}<button disabled={pending} className="mt-6 flex min-h-11 w-full items-center justify-center rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">{pending ? "加密保存中…" : "加密保存连接"}</button><style jsx>{`.field{margin-top:.5rem;width:100%;border-radius:.75rem;border:1px solid #cbd5e1;background:white;padding:.72rem .9rem;font-size:.875rem;color:#0f172a;outline:none}.field:focus{border-color:#818cf8;box-shadow:0 0 0 3px rgba(129,140,248,.14)}`}</style></form>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="mt-4 block text-sm font-medium text-slate-700">{label}{children}</label>;
}

function McpConnectionCard({ connection, onChanged }: { connection: Connection; onChanged: (connection: Connection) => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [token, setToken] = useState("");

  async function discover() {
    setPending("discover"); setMessage(null);
    try {
      const response = await fetch(`/api/settings/mcp-connections/${connection.id}/discover`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response, "工具发现失败"));
      const payload = await response.json() as { connection: Connection; discoveredCount: number; eligibleCount: number; rejectedCount: number };
      onChanged(payload.connection); setMessage(`发现 ${payload.discoveredCount} 个有效定义，其中 ${payload.eligibleCount} 个可进入只读授权；另拒绝 ${payload.rejectedCount} 个不兼容定义。`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "工具发现失败"); }
    finally { setPending(null); }
  }

  async function update(body: Record<string, unknown>, key: string, success: string) {
    setPending(key); setMessage(null);
    try {
      const response = await fetch(`/api/settings/mcp-connections/${connection.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, expectedUpdatedAt: connection.updatedAt }) });
      if (!response.ok) throw new Error(await responseError(response, "连接更新失败"));
      onChanged((await response.json() as { connection: Connection }).connection); setMessage(success); if (key === "token") setToken("");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "连接更新失败"); }
    finally { setPending(null); }
  }

  async function attest(tool: ToolDefinition) {
    setPending(`attest:${tool.id}`); setMessage(null);
    try {
      const response = await fetch(`/api/settings/mcp-connections/${connection.id}/tools/${tool.id}/attestation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "管理员在控制台核对工具定义、网络和凭据后认证。", evidence: { source: "mcp-connection-console" } }),
      });
      if (!response.ok) throw new Error(await responseError(response, "工具认证失败"));
      const attestation = (await response.json() as { attestation: ToolDefinition["attestations"][number] }).attestation;
      onChanged({ ...connection, toolDefinitions: connection.toolDefinitions.map((entry) => entry.id === tool.id ? { ...entry, attestations: [attestation] } : entry) });
      setMessage(`已认证 ${tool.name}。网络、凭据或定义变化后需要重新认证。`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "工具认证失败"); }
    finally { setPending(null); }
  }

  async function revokeAttestation(tool: ToolDefinition) {
    const attestation = activeAttestation(tool);
    if (attestation === null) return;
    if (!window.confirm(`撤销 ${tool.name} 的管理员认证？项目授权和后续调用将立即失败关闭。`)) return;
    setPending(`revoke-attest:${tool.id}`); setMessage(null);
    try {
      const response = await fetch(`/api/settings/mcp-connections/${connection.id}/tools/${tool.id}/attestation`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attestationId: attestation.id, expectedAttestedAt: attestation.attestedAt, note: "管理员在控制台主动撤销认证。" }),
      });
      if (!response.ok) throw new Error(await responseError(response, "撤销工具认证失败"));
      const revoked = (await response.json() as { attestation: ToolDefinition["attestations"][number] }).attestation;
      onChanged({ ...connection, toolDefinitions: connection.toolDefinitions.map((entry) => entry.id === tool.id ? { ...entry, attestations: [{ ...attestation, audits: [...attestation.audits, { event: "revoked" as const }] }] } : entry) });
      void revoked;
      setMessage(`已撤销 ${tool.name} 的管理员认证。`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "撤销工具认证失败"); }
    finally { setPending(null); }
  }

  const attestedCount = connection.toolDefinitions.filter((tool) => activeAttestation(tool) !== null).length;
  return <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-semibold">{connection.name}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${statusTones[connection.status]}`}>{statusLabels[connection.status]}</span></div><p className="mt-2 break-all text-xs text-slate-500">{connection.endpointUrl}</p></div><div className="text-right text-xs text-slate-400"><p>{attestedCount} / {connection.toolDefinitions.length} 个已认证</p><p className="mt-1">凭据 ····{connection.credential?.maskedSuffix ?? "无"}</p></div></div><div className="mt-4 grid gap-2 text-xs text-slate-600 sm:grid-cols-2"><p>协议：{connection.protocolVersion ?? "待发现"}</p><p>内网访问：{connection.allowPrivateNetwork ? "已显式允许" : "禁止"}</p><p>最近发现：{connection.lastDiscoveredAt ? new Date(connection.lastDiscoveredAt).toLocaleString("zh-CN") : "尚未执行"}</p><p className={connection.lastErrorCode ? "text-rose-600" : ""}>最近错误：{connection.lastErrorCode ?? "无"}</p></div>{connection.toolDefinitions.length > 0 ? <details className="mt-5 rounded-2xl bg-slate-50 p-4"><summary className="cursor-pointer text-xs font-semibold text-slate-700">查看当前工具定义与管理员认证</summary><div className="mt-3 space-y-2">{connection.toolDefinitions.map((tool) => { const attestation = activeAttestation(tool); return <div key={tool.id} className="rounded-xl bg-white px-3 py-3 text-xs"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-slate-800">{tool.title || tool.name}</p><p className="mt-1 font-mono text-[10px] text-slate-400">{tool.name} · {tool.definitionFingerprint.slice(0, 12)}…</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${attestation !== null ? "bg-emerald-50 text-emerald-700" : tool.remoteReadOnlyHint ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700"}`}>{attestation !== null ? "管理员已认证" : tool.remoteReadOnlyHint ? "仅远端声明" : "声明不足"}</span></div>{tool.remoteReadOnlyHint ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><p className="text-[11px] text-slate-500">远端提示不具备授权资格，必须由管理员认证。</p>{attestation !== null ? <button type="button" onClick={() => void revokeAttestation(tool)} disabled={pending !== null} className="flex min-h-9 items-center justify-center rounded-lg border border-rose-200 px-3 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">撤销认证</button> : <button type="button" onClick={() => void attest(tool)} disabled={pending !== null || connection.status !== "verified"} className="flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">{pending === `attest:${tool.id}` ? "认证中…" : "管理员认证"}</button>}</div> : null}</div>; })}</div></details> : null}{connection.authKind === "bearer" && connection.status !== "disabled" ? <div className="mt-4 flex gap-2"><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="输入新 Token 进行轮换" className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-200 px-3 text-sm" /><button type="button" onClick={() => void update({ bearerToken: token }, "token", "凭据已轮换；请重新发现工具后再调用。")} disabled={pending !== null || token.length < 8} className="flex min-h-11 items-center justify-center rounded-xl border border-slate-200 px-4 text-xs font-semibold text-slate-700 disabled:opacity-40">轮换凭据</button></div> : null}<div className="mt-5 flex flex-wrap items-center justify-between gap-3">{message ? <p role="status" className="flex-1 text-xs leading-5 text-slate-600">{message}</p> : <span />}{connection.status !== "disabled" ? <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void update({ trustCurrentNetwork: true }, "trust", "已固定当前解析地址；请重新发现工具。")} disabled={pending !== null} className="flex min-h-10 items-center justify-center rounded-xl px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50">重新确认网络</button><button type="button" onClick={() => void discover()} disabled={pending !== null} className="flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{pending === "discover" ? "发现中…" : "发现并固化工具"}</button><button type="button" onClick={() => void update({ enabled: false }, "disable", "连接已停用；现有项目授权会立即失败关闭。")} disabled={pending !== null} className="flex min-h-10 items-center justify-center rounded-xl px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">停用</button></div> : <button type="button" onClick={() => void update({ enabled: true }, "enable", "连接已启用；需要重新发现工具。")} disabled={pending !== null} className="flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">重新启用</button>}</div></article>;
}
