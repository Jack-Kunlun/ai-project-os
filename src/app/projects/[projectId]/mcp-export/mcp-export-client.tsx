"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { safeResponseError } from "@/lib/safe-error-presentation";
import type { McpExportOperation } from "@/lib/mcp-export-grants";

type Grant = Readonly<{
  id: string;
  projectId: string;
  label: string;
  grantType: "legacyBearer" | "oauth";
  oauthClientId: string | null;
  oauthClientName: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}>;
type DispatchAudit = Readonly<{
  id: string;
  recipientLabel: string;
  oauthClientId: string | null;
  oauthClientName: string | null;
  provider: string;
  model: string;
  operation: string;
  inputFingerprint: string;
  contentFingerprint: string;
  createdAt: string;
}>;

async function requestError(response: Response, fallback: string): Promise<Error> {
  const safe = await safeResponseError(response, fallback);
  return new Error(safe.message);
}

export function McpExportClient({ projectId, legacyBearerEnabled }: { projectId: string; legacyBearerEnabled: boolean }) {
  const [grants, setGrants] = useState<readonly Grant[]>([]);
  const [audits, setAudits] = useState<readonly DispatchAudit[]>([]);
  const [label, setLabel] = useState("");
  const [lifetimeDays, setLifetimeDays] = useState(7);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [operation, setOperation] = useState<McpExportOperation>("project_summary");
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();

  const load = useCallback(async () => {
    const [grantResponse, auditResponse] = await Promise.all([
      fetch("/api/me/mcp-export-grants", { cache: "no-store" }),
      fetch(`/api/me/mcp-export-audits?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" }),
    ]);
    if (!grantResponse.ok) throw await requestError(grantResponse, "MCP 输出凭证加载失败");
    if (!auditResponse.ok) throw await requestError(auditResponse, "MCP 外发记录加载失败");
    const [grantPayload, auditPayload] = await Promise.all([
      grantResponse.json() as Promise<{ grants: Grant[] }>,
      auditResponse.json() as Promise<{ audits: DispatchAudit[] }>,
    ]);
    setGrants(grantPayload.grants.filter((grant) => grant.projectId === projectId));
    setAudits(auditPayload.audits);
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "MCP 输出凭证加载失败"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setIssuedToken(null);
    setMessage(null);
    try {
      const response = await fetch("/api/me/mcp-export-grants", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, label, lifetimeDays }),
      });
      if (!response.ok) throw await requestError(response, "创建 MCP 输出凭证失败");
      const payload = await response.json() as { token: string };
      setIssuedToken(payload.token);
      setLabel("");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建 MCP 输出凭证失败");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(grant: Grant) {
    const decision = await confirm({
      eyebrow: "撤销外部访问", title: `撤销“${grant.label}”？`,
      description: "撤销后，这个外部客户端将无法继续读取项目。",
      confirmLabel: "撤销凭证", cancelLabel: "返回",
    });
    if (!decision.confirmed) return;
    setBusy(true);
    setIssuedToken(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/me/mcp-export-grants/${grant.id}`, { method: "DELETE" });
      if (!response.ok) throw await requestError(response, "撤销 MCP 输出凭证失败");
      await load();
      setMessage("凭证已撤销。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "撤销 MCP 输出凭证失败");
    } finally {
      setBusy(false);
    }
  }

  async function approveNextRead(grant: Grant) {
    if (!provider.trim() || !model.trim()) {
      setMessage("请先填写外部服务和模型名称。");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const previewResponse = await fetch(`/api/me/mcp-export-grants/${grant.id}/approval-previews`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, model, operation }),
      });
      if (!previewResponse.ok) throw await requestError(previewResponse, "准备 MCP 外发确认失败");
      const { preview } = await previewResponse.json() as { preview: {
        approvalId: string; contentFingerprint: string; expiresAt: string;
        recipientLabel: string; provider: string; model: string; operation: McpExportOperation;
        oauthClientId: string | null; oauthClientName: string | null;
        content: Record<string, unknown>;
      } };
      const recipient = preview.oauthClientName ?? preview.recipientLabel;
      const decision = await confirm({
        eyebrow: "项目内容外发确认",
        title: `允许“${recipient}”读取一次${preview.operation}？`,
        description: `${preview.oauthClientId ? `OAuth 客户端 ID：${preview.oauthClientId}；` : ""}外部服务：${preview.provider}；模型：${preview.model}。本次外发内容：\n${JSON.stringify(preview.content, null, 2)}\n确认后仅可读取一次，5 分钟内有效；外部服务与模型由你声明，平台无法核验第三方实际使用情况。`,
        confirmLabel: "确认本次外发", cancelLabel: "返回",
        inputLabel: "输入“确认外发”继续", requiredValue: "确认外发", inputPlaceholder: "确认外发",
      });
      if (!decision.confirmed) return;
      const response = await fetch(`/api/me/mcp-export-grants/${grant.id}/approval-confirmations`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalId: preview.approvalId, contentFingerprint: preview.contentFingerprint, acknowledge: true }),
      });
      if (!response.ok) throw await requestError(response, "确认 MCP 外发失败");
      setMessage(`已批准“${recipient}”在 ${new Date(preview.expiresAt).toISOString()} 前读取一次 ${preview.operation}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "确认 MCP 外发失败");
    } finally {
      setBusy(false);
    }
  }

  return <div className="mt-6 space-y-6">
    {dialog}
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Outbound MCP</p>
      <h1 className="mt-2 text-2xl font-semibold">向外部客户端提供 MCP</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">当前提供项目摘要、最多 10 条最近已确认事实与来源，以及最多 10 项最近目标和工作项。OAuth 授权绑定客户端标识、项目和只读范围；访问令牌仍是可转移的 Bearer 密钥。每次工具读取还需要项目 Owner 单独确认，批准 5 分钟内只能用一次。</p>
      <p className="mt-2 text-xs text-slate-500">服务地址：当前站点的 <code>/api/mcp</code></p>
      {legacyBearerEnabled ? <><p className="mt-3 text-xs leading-5 text-amber-800">本地兼容模式：可创建旧式可转移 Bearer 凭证；此方式在生产环境始终关闭。</p><form onSubmit={(event) => void issue(event)} className="mt-6 grid gap-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <label className="grid gap-2 text-sm font-medium">客户端名称<input required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} className="min-h-11 rounded-xl border border-slate-300 px-3" placeholder="例如：桌面助手" /></label>
        <label className="grid gap-2 text-sm font-medium">有效天数<input type="number" min={1} max={30} value={lifetimeDays} onChange={(event) => setLifetimeDays(Number(event.target.value))} className="min-h-11 w-28 rounded-xl border border-slate-300 px-3" /></label>
        <button type="submit" disabled={busy} className="min-h-11 rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white disabled:opacity-50">创建凭证</button>
      </form></> : <p className="mt-5 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-950">由外部客户端发起 OAuth 授权后，在此查看并撤销连接。授权完成后仍需为每次工具读取单独确认。</p>}
      {issuedToken && <div role="status" className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm font-semibold text-amber-950">请现在复制凭证；关闭页面后无法再次查看。</p>
        <code className="mt-2 block break-all rounded-lg bg-white p-3 text-xs select-all">{issuedToken}</code>
      </div>}
      {message && <p role="status" className="mt-4 rounded-xl bg-slate-100 px-4 py-3 text-sm">{message}</p>}
    </section>
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">本项目凭证</h2>
      <p className="mt-2 text-xs leading-5 text-slate-500">批准前填写接收方声明的外部服务和模型。平台记录这些信息用于审计，无法核验第三方实际使用情况。</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-2 text-sm font-medium">外部服务<input maxLength={80} value={provider} onChange={(event) => setProvider(event.target.value)} className="min-h-11 rounded-xl border border-slate-300 px-3" placeholder="例如：桌面助手服务" /></label>
        <label className="grid gap-2 text-sm font-medium">外部模型<input maxLength={80} value={model} onChange={(event) => setModel(event.target.value)} className="min-h-11 rounded-xl border border-slate-300 px-3" placeholder="例如：客户端声明的模型" /></label>
      </div>
      <label className="mt-4 grid gap-2 text-sm font-medium">本次批准的工具<select value={operation} onChange={(event) => setOperation(event.target.value as McpExportOperation)} className="min-h-11 rounded-xl border border-slate-300 px-3"><option value="project_summary">项目摘要</option><option value="project_evidence">已确认事实与来源</option><option value="project_plan">项目计划</option></select></label>
      <div className="mt-4 space-y-3">{grants.length === 0 ? <p className="text-sm text-slate-500">暂无凭证。</p> : grants.map((grant) => <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 p-4">
        <div><p className="break-words font-medium">{grant.oauthClientName ?? grant.label}</p><p className="mt-1 break-all text-xs text-slate-500">{grant.grantType === "oauth" ? `OAuth 客户端 ID：${grant.oauthClientId ?? "客户端标识不可用"}` : "旧式 Bearer 凭证"}</p><p className="mt-1 text-xs text-slate-500">到期：{new Date(grant.expiresAt).toISOString()} · {grant.revokedAt ? "已撤销" : "未撤销"}</p></div>
        {!grant.revokedAt && <div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void approveNextRead(grant)} className="min-h-10 rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white disabled:opacity-50">批准下一次读取</button><button type="button" disabled={busy} onClick={() => void revoke(grant)} className="min-h-10 rounded-lg border border-rose-200 px-3 text-sm font-medium text-rose-700 disabled:opacity-50">撤销</button></div>}
      </div>)}</div>
    </section>
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">最近外发记录</h2><button type="button" disabled={busy} onClick={() => void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "MCP 外发记录加载失败"))} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm disabled:opacity-50">刷新记录</button></div>
      <p className="mt-2 text-xs leading-5 text-slate-500">记录服务端已准备的响应，不代表第三方已收到内容。仅显示最近 50 条。</p>
      <div className="mt-4 space-y-3">{audits.length === 0 ? <p className="text-sm text-slate-500">暂无外发记录。</p> : audits.map((audit) => <div key={audit.id} className="rounded-xl border border-slate-200 p-4 text-sm">
        <p className="font-medium">{audit.recipientLabel} · {audit.operation}</p>
        {audit.oauthClientName !== null && <p className="mt-1 break-words text-xs text-slate-600">OAuth 客户端：{audit.oauthClientName}</p>}
        {audit.oauthClientId !== null && <p className="mt-1 break-all text-xs text-slate-600">OAuth 客户端 ID：{audit.oauthClientId}</p>}
        <p className="mt-1 text-xs text-slate-600">{audit.provider} / {audit.model} · {new Date(audit.createdAt).toLocaleString()}</p>
        <p className="mt-1 break-all text-xs text-slate-500">输入指纹：{audit.inputFingerprint}</p>
        <p className="mt-1 break-all text-xs text-slate-500">内容指纹：{audit.contentFingerprint}</p>
      </div>)}</div>
    </section>
  </div>;
}
