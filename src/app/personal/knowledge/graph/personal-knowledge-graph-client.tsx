"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { PersonalWorkspaceNav } from "@/components/personal-workspace-nav";
import { safeResponseError } from "@/lib/safe-error-presentation";

type DocumentNode = Readonly<{ id: string; title: string; version: number }>;
type DocumentEdge = Readonly<{ id: string; fromDocumentId: string; toDocumentId: string; stale: boolean }>;
type Suggestion = Readonly<{
  id: string; documentId: string; documentTitle: string;
  subject: string; subjectKind: string; predicate: string;
  object: string; objectKind: string; evidence: string;
  status: "pending" | "accepted"; stale: boolean;
}>;
type GraphPayload = Readonly<{
  documents: { nodes: DocumentNode[]; edges: DocumentEdge[]; truncated: boolean };
  suggestions: Suggestion[];
  truncated: boolean;
}>;
type Provider = Readonly<{ id: string; name: string; status: string; defaultGenerationModelId: string | null }>;

const kindLabel: Record<string, string> = { person: "人物", organization: "组织", concept: "概念", place: "地点", other: "其他" };

function positions<T>(items: readonly T[], key: (item: T) => string) {
  return new Map(items.map((item, index) => {
    const angle = items.length <= 1 ? 0 : (index / items.length) * Math.PI * 2 - Math.PI / 2;
    return [key(item), { x: items.length <= 1 ? 50 : 50 + Math.cos(angle) * 38, y: items.length <= 1 ? 50 : 50 + Math.sin(angle) * 36 }] as const;
  }));
}

export function PersonalKnowledgeGraphClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();

  const load = useCallback(async () => {
    try {
      const [graphResponse, providerResponse] = await Promise.all([
        fetch("/api/personal/knowledge/graph", { cache: "no-store" }),
        fetch("/api/me/ai-providers", { cache: "no-store" }),
      ]);
      if (!graphResponse.ok) throw new Error((await safeResponseError(graphResponse, "知识图谱加载失败")).message);
      setGraph(await graphResponse.json() as GraphPayload);
      if (providerResponse.ok) setProviders((await providerResponse.json() as { providers: Provider[] }).providers.filter((provider) => provider.status === "verified" && provider.defaultGenerationModelId));
    } catch (cause) {
      setMessage({ text: cause instanceof Error ? cause.message : "知识图谱加载失败", error: true });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const documents = useMemo(() => graph?.documents.nodes ?? [], [graph]);
  const selectedDocumentId = documents.some((row) => row.id === documentId) ? documentId : documents[0]?.id ?? "";
  const selectedProviderId = providers.some((row) => row.id === providerId) ? providerId : providers[0]?.id ?? "";
  const docPositions = useMemo(() => positions(documents, (node) => node.id), [documents]);
  const accepted = graph?.suggestions.filter((row) => row.status === "accepted" && !row.stale).slice(0, 20) ?? [];
  const pendingSuggestions = graph?.suggestions.filter((row) => row.status === "pending") ?? [];
  const entityNodes = [...new Map(accepted.flatMap((row) => [
    [`${row.subjectKind}:${row.subject}`, { key: `${row.subjectKind}:${row.subject}`, label: row.subject, kind: row.subjectKind }],
    [`${row.objectKind}:${row.object}`, { key: `${row.objectKind}:${row.object}`, label: row.object, kind: row.objectKind }],
  ] as const)).values()];
  const entityPositions = positions(entityNodes, (node) => node.key);

  async function extract() {
    if (!selectedDocumentId || !selectedProviderId || pending) return;
    const provider = providers.find((row) => row.id === selectedProviderId);
    setPending(true); setMessage(null);
    try {
      const preparedResponse = await fetch("/api/personal/knowledge/graph", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "prepare", documentId: selectedDocumentId, providerId: selectedProviderId }),
      });
      if (!preparedResponse.ok) throw new Error((await safeResponseError(preparedResponse, "无法准备关系提取")).message);
      const prepared = await preparedResponse.json() as { attemptId: string; providerName: string; modelId: string };
      const decision = await confirm({
        eyebrow: "知识关系提取", title: "发送文档给个人模型提取候选关系？",
        description: `当前文档正文会发送给 ${prepared.providerName || provider?.name || "所选服务"}（${prepared.modelId}），可能产生服务商费用。结果只进入待审核列表，逐条确认后才显示为实体关系。`,
        confirmLabel: "确认提取", cancelLabel: "返回",
      });
      if (!decision.confirmed) return;
      const response = await fetch("/api/personal/knowledge/graph", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "execute", documentId: selectedDocumentId, attemptId: prepared.attemptId }),
      });
      if (!response.ok) throw new Error((await safeResponseError(response, "关系提取失败")).message);
      const result = await response.json() as { suggested: number };
      setMessage({ text: `提取完成，返回 ${result.suggested} 条候选关系。请核对原文后逐条审核。`, error: false });
      await load();
    } catch (cause) { setMessage({ text: cause instanceof Error ? cause.message : "关系提取失败", error: true }); }
    finally { setPending(false); }
  }

  async function review(id: string, status: "accepted" | "rejected") {
    if (pending) return;
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/personal/knowledge/graph/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error((await safeResponseError(response, "关系审核失败")).message);
      await load();
    } catch (cause) { setMessage({ text: cause instanceof Error ? cause.message : "关系审核失败", error: true }); }
    finally { setPending(false); }
  }

  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
    <AppHeader username={username} active="personalKnowledge" isSystemAdmin={isSystemAdmin} />
    <PersonalWorkspaceNav active="knowledge" />
    <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10">
      {dialog}
      <Link href="/personal/knowledge" className="text-sm font-semibold text-indigo-700">← 返回知识库</Link>
      <div className="mt-4"><h1 className="text-3xl font-semibold">知识图谱</h1><p className="mt-2 text-sm text-slate-600">同时查看你手动确认的文档关联，以及从当前知识版本提取并经你审核的实体关系。</p></div>
      {message ? <p role={message.error ? "alert" : "status"} className={`mt-5 rounded-xl px-4 py-3 text-sm ${message.error ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{message.text}</p> : null}
      {loading ? <div role="status" className="mt-8 h-72 animate-pulse rounded-3xl bg-white" /> : graph === null ? <button type="button" onClick={() => void load()} className="mt-5 text-sm font-semibold text-indigo-700">重新加载</button> : <>
        <section className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 sm:p-7">
          <h2 className="text-xl font-semibold">文档与来源关系</h2><p className="mt-2 text-xs text-slate-500">仅展示你明确建立的文档关联；虚线表示文档版本已变化。</p>
          {documents.length === 0 ? <p className="mt-6 text-sm text-slate-500">知识库还没有文档。</p> : <>
            <svg viewBox="0 0 100 100" className="mt-4 h-72 w-full rounded-xl bg-slate-50" role="img" aria-label="个人知识文档关系图"><title>个人知识文档关系图</title>
              {graph.documents.edges.map((edge) => { const from = docPositions.get(edge.fromDocumentId); const to = docPositions.get(edge.toDocumentId); return from && to ? <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={edge.stale ? "#d97706" : "#6366f1"} strokeDasharray={edge.stale ? "2 2" : undefined} strokeWidth=".7" /> : null; })}
              {documents.map((node) => { const point = docPositions.get(node.id)!; return <g key={node.id}><circle cx={point.x} cy={point.y} r="5" fill="#312e81" /><text x={point.x} y={point.y + 1} fill="white" textAnchor="middle" fontSize="2.5">{node.title.slice(0, 2)}</text></g>; })}
            </svg>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">{documents.map((node) => <li key={node.id}><Link href={`/personal/knowledge?document=${encodeURIComponent(node.id)}`} className="text-xs font-semibold text-indigo-700">{node.title} →</Link></li>)}</ul>
            {graph.documents.edges.length === 0 ? <p className="mt-3 text-xs text-slate-500">暂无文档关联；可在我的空间中建立。</p> : null}
          </>}
        </section>

        <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 sm:p-7">
          <h2 className="text-xl font-semibold">人物、概念与其他实体</h2><p className="mt-2 text-xs text-slate-500">只有已审核且来源版本仍有效的关系进入图谱。下方每条关系保留原文引文。</p>
          {accepted.length === 0 ? <p className="mt-6 text-sm text-slate-500">还没有经审核的实体关系。</p> : <>
            <svg viewBox="0 0 100 100" className="mt-4 h-72 w-full rounded-xl bg-indigo-50/40" role="img" aria-label="已审核实体关系图"><title>已审核实体关系图</title>
              {accepted.map((row) => { const from = entityPositions.get(`${row.subjectKind}:${row.subject}`); const to = entityPositions.get(`${row.objectKind}:${row.object}`); return from && to ? <line key={row.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#8b5cf6" strokeWidth=".7" /> : null; })}
              {entityNodes.map((node) => { const point = entityPositions.get(node.key)!; return <g key={node.key}><circle cx={point.x} cy={point.y} r="5" fill="#6d28d9" /><text x={point.x} y={point.y + 1} fill="white" textAnchor="middle" fontSize="2.3">{node.label.slice(0, 2)}</text></g>; })}
            </svg>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">{accepted.map((row) => <li key={row.id} className="rounded-xl bg-slate-50 p-3 text-xs"><p className="font-semibold">{row.subject} — {row.predicate} → {row.object}</p><p className="mt-1 text-slate-500">来源：{row.documentTitle} · “{row.evidence}”</p></li>)}</ul>
          </>}
        </section>

        <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 sm:p-7">
          <h2 className="text-xl font-semibold">提取并审核关系</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="text-xs font-semibold text-slate-700">知识文档<select value={selectedDocumentId} onChange={(event) => setDocumentId(event.target.value)} className="mt-1 block min-h-10 w-full rounded-xl border border-slate-200 bg-white px-3 font-normal">{documents.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
            <label className="text-xs font-semibold text-slate-700">个人文本模型<select value={selectedProviderId} onChange={(event) => setProviderId(event.target.value)} className="mt-1 block min-h-10 w-full rounded-xl border border-slate-200 bg-white px-3 font-normal">{providers.length === 0 ? <option value="">尚无已验证模型</option> : providers.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.defaultGenerationModelId}</option>)}</select></label>
            <button type="button" onClick={() => void extract()} disabled={pending || !selectedDocumentId || !selectedProviderId} className="min-h-10 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{pending ? "处理中…" : "提取候选关系"}</button>
          </div>
          <h3 className="mt-7 text-sm font-semibold">待审核 · {pendingSuggestions.length}</h3>
          {pendingSuggestions.length === 0 ? <p className="mt-2 text-xs text-slate-500">暂无待审核关系。</p> : <ul className="mt-3 space-y-3">{pendingSuggestions.map((row) => <li key={row.id} className="rounded-2xl border border-slate-200 p-4"><p className="text-sm font-semibold">{row.subject} <span className="text-xs text-slate-400">({kindLabel[row.subjectKind] ?? row.subjectKind})</span> — {row.predicate} → {row.object} <span className="text-xs text-slate-400">({kindLabel[row.objectKind] ?? row.objectKind})</span></p><p className="mt-2 text-xs leading-5 text-slate-600">来源：{row.documentTitle} · “{row.evidence}”</p>{row.stale ? <p className="mt-2 text-xs text-amber-700">来源文档已更新；此候选不能再接受，请重新提取。</p> : null}<div className="mt-3 flex gap-2"><button type="button" disabled={pending || row.stale} onClick={() => void review(row.id, "accepted")} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">确认关系</button><button type="button" disabled={pending} onClick={() => void review(row.id, "rejected")} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">忽略</button></div></li>)}</ul>}
        </section>
      </>}
    </div>
  </main>;
}
