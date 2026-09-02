"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { AppHeader } from "@/components/app-header";

type Definition = {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  annotations: unknown;
  remoteReadOnlyHint: boolean;
  attested: boolean;
  attestationId: string | null;
  definitionFingerprint: string;
  discoveredAt: string;
  connection: { id: string; name: string; endpointUrl: string; status: "configured" | "verified" | "error" | "disabled"; lastDiscoveredAt: string | null };
};

type Grant = {
  id: string;
  connectionId: string;
  toolName: string;
  toolDefinitionId: string;
  status: "active" | "revoked";
  acknowledgedAt: string;
  revokedAt: string | null;
  updatedAt: string;
  stale: boolean;
  attestationId: string | null;
  definitionFingerprint: string | null;
  networkFingerprint: string | null;
  credentialFingerprint: string | null;
  attestation: { id: string; definitionFingerprint: string; networkFingerprint: string; credentialFingerprint: string; attestedAt: string } | null;
  managedBy: { username: string; displayName: string | null };
  toolDefinition: { definitionFingerprint: string; connection: { name: string; status: string } };
};

type Center = { definitions: Definition[]; grants: Grant[]; canManage: boolean; canInvoke: boolean; archived: boolean };

async function responseError(response: Response, fallback: string) {
  try { return (await response.json() as { error?: { message?: string } }).error?.message ?? fallback; }
  catch { return fallback; }
}

function displayName(user: { username: string; displayName: string | null }) {
  return user.displayName?.trim() || user.username;
}

type ProjectToolsClientProps = { username: string; projectId: string };

export function ProjectToolsClient(props: ProjectToolsClientProps) {
  const { confirm, dialog } = useAppConfirmDialog();
  return <>{dialog}<ProjectToolsContent {...props} confirm={confirm} /></>;
}

function ProjectToolsContent({ username, projectId, confirm }: ProjectToolsClientProps & { confirm: ReturnType<typeof useAppConfirmDialog>["confirm"] }) {
  const [center, setCenter] = useState<Center | null>(null);
  const [argumentsByGrant, setArgumentsByGrant] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/mcp-tool-grants`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "项目工具加载失败"));
      setCenter(await response.json() as Center); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "项目工具加载失败"); }
  }, [projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);

  const grantByTool = useMemo(() => new Map(center?.grants.map((grant) => [`${grant.connectionId}:${grant.toolName}`, grant]) ?? []), [center]);

  async function grant(definition: Definition, existing: Grant | undefined) {
    const confirmation = await confirm({
      eyebrow: "Project capability grant",
      title: `授权 ${definition.connection.name} / ${definition.name}`,
      description: "远端声明不构成强制保证。请确认服务和凭据本身可信且只读；每次调用仍需按项目策略审批。",
      confirmLabel: "授权给项目",
      tone: "warning",
    });
    if (!confirmation.confirmed) return;
    setPending(`grant:${definition.id}`); setMessage(null); setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/mcp-tool-grants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ toolDefinitionId: definition.id, acknowledgeReadOnly: true, expectedUpdatedAt: existing?.updatedAt ?? null }) });
      if (!response.ok) throw new Error(await responseError(response, "工具授权失败"));
      setMessage("工具已授权。每次调用仍会进入动作中心等待 Owner 单独审批。"); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "工具授权失败"); }
    finally { setPending(null); }
  }

  async function revoke(grant: Grant) {
    const confirmation = await confirm({
      eyebrow: "Project capability grant",
      title: "撤销项目工具授权",
      description: "尚未执行的动作会在执行前因授权变化失败关闭。",
      confirmLabel: "撤销授权",
      tone: "danger",
    });
    if (!confirmation.confirmed) return;
    setPending(`revoke:${grant.id}`); setMessage(null); setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/mcp-tool-grants/${grant.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedUpdatedAt: grant.updatedAt }) });
      if (!response.ok) throw new Error(await responseError(response, "撤销授权失败"));
      setMessage("工具授权已撤销。"); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "撤销授权失败"); }
    finally { setPending(null); }
  }

  async function invoke(grant: Grant) {
    let args: unknown;
    try { args = JSON.parse(argumentsByGrant[grant.id] ?? "{}"); }
    catch { setError("调用参数必须是有效 JSON 对象"); return; }
    setPending(`invoke:${grant.id}`); setMessage(null); setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: "project.mcp.read-tool.invoke", input: { grantId: grant.id, arguments: args }, clientRequestId: crypto.randomUUID() }) });
      if (!response.ok) throw new Error(await responseError(response, "工具调用动作创建失败"));
      setMessage("调用动作已固化工具、参数、网络和凭据指纹，并送往“动作与审批”等待 Owner 审批。"); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "工具调用动作创建失败"); }
    finally { setPending(null); }
  }

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="projects" projectId={projectId} projectSection="tools" /><div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12"><section className="grid gap-7 rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-8 py-10 text-white shadow-xl shadow-slate-950/10 lg:grid-cols-[1.25fr_.75fr]"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Project capability grants</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">项目工具权限</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">项目 Owner 只能从管理员已认证的当前目录逐项授权工具。远端注解只是提示，调用前会再次核对认证、工具定义、网络地址、凭据和项目授权，任何漂移都失败关闭。</p></div><div className="rounded-2xl border border-white/10 bg-white/5 p-5 text-xs leading-6 text-slate-300"><p className="font-semibold text-white">调用不会自动进入 AI 上下文</p><p className="mt-2">结果只保存在对应动作记录中，不会自动写入项目记忆、RAG 索引或交给模型。需要使用结果时由用户核对后另行处理。</p></div></section>{center?.archived ? <p className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">项目已归档，不能新增授权或创建工具调用动作。</p> : null}{message ? <p role="status" className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm text-indigo-700">{message} <Link href={`/projects/${projectId}/actions`} className="font-semibold underline">打开动作与审批</Link></p> : null}{error ? <p role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}<section className="mt-9"><div className="mb-5 flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Verified catalog</p><h2 className="mt-2 text-2xl font-semibold">可选工具目录</h2><p className="mt-2 text-sm text-slate-500">只展示当前发现快照。远端声明不足、尚未管理员认证或定义更新的工具均不能授权。</p></div><Link href="/connections/mcp" className="flex min-h-11 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-indigo-300">管理 MCP 连接</Link></div><div className="grid gap-5 lg:grid-cols-2">{center?.definitions.map((definition) => { const grantEntry = grantByTool.get(`${definition.connection.id}:${definition.name}`); const active = grantEntry?.status === "active" && !grantEntry.stale && grantEntry.toolDefinitionId === definition.id; const busy = pending?.endsWith(definition.id) || (grantEntry && pending?.endsWith(grantEntry.id)); return <article key={definition.id} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600">{definition.connection.name}</p><h3 className="mt-2 text-xl font-semibold">{definition.title || definition.name}</h3><p className="mt-1 font-mono text-[11px] text-slate-400">{definition.name}</p></div><span className={`rounded-full px-3 py-1 text-[11px] font-semibold ${definition.attested ? "bg-emerald-50 text-emerald-700" : definition.remoteReadOnlyHint ? "bg-amber-50 text-amber-700" : "bg-rose-50 text-rose-700"}`}>{definition.attested ? active ? "已认证并授权" : "管理员已认证" : definition.remoteReadOnlyHint ? "仅远端声明" : "不可授权"}</span></div><p className="mt-4 text-sm leading-6 text-slate-600">{definition.description || "服务未提供工具说明。"}</p><details className="mt-4 rounded-2xl bg-slate-50 p-4"><summary className="cursor-pointer text-xs font-semibold text-slate-700">查看输入 Schema 与定义指纹</summary><pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-5 text-slate-500">{JSON.stringify(definition.inputSchema, null, 2)}</pre><p className="mt-3 font-mono text-[10px] text-slate-400">{definition.definitionFingerprint}</p></details>{center.canManage ? <div className="mt-5 flex justify-end gap-2">{active && grantEntry ? <button type="button" onClick={() => void revoke(grantEntry)} disabled={Boolean(busy) || center.archived} className="flex min-h-11 items-center justify-center rounded-xl border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-40">撤销授权</button> : <button type="button" onClick={() => void grant(definition, grantEntry)} disabled={Boolean(busy) || !definition.attested || definition.connection.status !== "verified" || center.archived} className="flex min-h-11 items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40">{grantEntry ? "重新确认授权" : definition.attested ? "授权给项目" : "等待管理员认证"}</button>}</div> : null}</article>; }) ?? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500 lg:col-span-2">正在读取工具目录…</div>}{center && center.definitions.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500 lg:col-span-2">尚无当前工具定义。请先由管理员添加 MCP 连接并完成工具发现。</div> : null}</div></section><section className="mt-10"><div className="mb-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Approved tools</p><h2 className="mt-2 text-2xl font-semibold">创建只读调用动作</h2><p className="mt-2 text-sm text-slate-500">参数会按授权时的输入 Schema 校验。创建后不会直接调用远端，必须到动作中心核对完整参数和指纹并批准。管理员认证或项目授权撤销后，动作创建与执行都会失败关闭。</p></div><div className="space-y-4">{center?.grants.filter((grant) => grant.status === "active").map((grant) => <article key={grant.id} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">{grant.toolDefinition.connection.name} / {grant.toolName}</h3><p className="mt-2 text-xs text-slate-500">Owner：{displayName(grant.managedBy)} · {new Date(grant.acknowledgedAt).toLocaleString("zh-CN")}</p></div><span className={`rounded-full px-3 py-1 text-[11px] font-semibold ${grant.stale ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{grant.stale ? "认证、定义或连接已变化" : "授权有效"}</span></div><label className="mt-5 block text-sm font-medium text-slate-700">调用参数（JSON 对象）<textarea value={argumentsByGrant[grant.id] ?? "{}"} onChange={(event) => setArgumentsByGrant((current) => ({ ...current, [grant.id]: event.target.value }))} className="mt-2 min-h-32 w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-6 outline-none focus:border-indigo-400" spellCheck={false} /></label><div className="mt-4 flex justify-end"><button type="button" onClick={() => void invoke(grant)} disabled={!center.canInvoke || grant.stale || center.archived || pending !== null} className="flex min-h-11 items-center justify-center rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40">{pending === `invoke:${grant.id}` ? "固化动作中…" : "创建并请求审批"}</button></div></article>)}{center && center.grants.filter((grant) => grant.status === "active").length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">当前项目还没有有效工具授权。</div> : null}</div></section></div></main>;
}
