"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { AdminHeader } from "@/components/admin-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";

type ProviderKind = "openai" | "deepseek" | "qwen" | "glm";
type ProviderCatalogEntry = {
  kind: ProviderKind;
  displayName: string;
  baseUrl: string;
  apiKeyLabel: string;
  generationModelSuggestions: string[];
  embeddingModelSuggestions: Array<{ id: string; dimensions: number }>;
  visionModelSuggestions: string[];
  supportsEmbeddings: boolean;
  supportsVision: boolean;
};
type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultGenerationModelId: string | null;
  defaultEmbeddingModelId: string | null;
  defaultVisionModelId: string | null;
  embeddingDimensions: number | null;
  configurationVersion: number;
  status: "configured" | "verified" | "error" | "disabled";
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  credential: { maskedSuffix: string; rotatedAt: string | null; updatedAt: string };
  _count: { platformDefaultAiRoutes: number };
};
type ProviderCheck = Readonly<{
  attempt: Readonly<{
    status: string;
    safeErrorCode: string | null;
    capabilities: Readonly<{
      generation: "passed" | "notConfigured";
      embedding: "passed" | "notConfigured";
      vision: "passed" | "notConfigured";
    }>;
    embeddingDimensions: number | null;
  }>;
}>;

async function readError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function dateLabel(value: string | null): string {
  return value === null ? "尚未验证" : new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function describeProviderCheck(check: ProviderCheck): string {
  const messages: string[] = [];
  if (check.attempt.capabilities.generation === "passed") messages.push("生成连接通过");
  if (check.attempt.capabilities.embedding === "passed") messages.push(`向量连接通过${check.attempt.embeddingDimensions === null ? "" : `（${check.attempt.embeddingDimensions} 维）`}`);
  if (check.attempt.capabilities.vision === "passed") messages.push("图片识别连接通过");
  if (messages.length === 0) return check.attempt.safeErrorCode === null ? "未检测到可用模型能力" : `连接测试未通过（安全错误码：${check.attempt.safeErrorCode}）`;
  return messages.join("；");
}

const statusLabel = {
  configured: "待验证",
  verified: "已验证",
  error: "验证失败",
  disabled: "已停用",
} as const;

export function SettingsClient({ username, canManageProviders, activeMembership, membershipStatus, adminMode = false, returnTo }: { username: string; canManageProviders: boolean; activeMembership: boolean; membershipStatus: "active" | "expired" | "revoked" | "none"; adminMode?: boolean; returnTo?: "/admin/models/routes" }) {
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(canManageProviders);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const response = await fetch("/api/settings/providers", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "供应商配置加载失败"));
      const payload = await response.json() as { providers: Provider[]; catalog: ProviderCatalogEntry[] };
      setProviders(payload.providers);
      setCatalog(payload.catalog);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "供应商配置加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!canManageProviders) {
      return;
    }
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [canManageProviders]);

  function handleProviderCreated(provider: Provider) {
    setProviders((current) => [...current, provider]);
  }

  function handleProviderChanged(next: Provider) {
    setProviders((current) => current.map((entry) => entry.id === next.id ? next : entry));
  }

  function handleProviderRemoved(providerId: string) {
    setProviders((current) => current.filter((entry) => entry.id !== providerId));
  }

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      {adminMode ? <AdminHeader username={username} /> : <AppHeader username={username} active="settings" />}
      <AdminPageFrame active="models" showSidebar={adminMode}><div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <section className="pb-5 pt-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">AI connections</p>
              <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">平台模型</h1>
            </div>
            {adminMode && returnTo ? <a href={returnTo} className="inline-flex min-h-10 items-center rounded-xl border border-indigo-200 px-4 py-2 text-xs font-semibold text-indigo-700 transition hover:border-indigo-400 hover:bg-indigo-50">返回默认路由</a> : null}
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">添加、编辑和验证平台供应商连接。密钥仅提交至服务端加密保存；默认路由、平台额度和探测预算使用独立治理入口。</p>
        </section>

        {!canManageProviders ? <section className="mt-7 rounded-3xl border border-indigo-200 bg-indigo-50/70 p-7"><h2 className="text-xl font-semibold">平台模型由系统管理员管理</h2><p className="mt-3 text-sm leading-7 text-slate-600">普通用户可以使用平台额度和平台默认模型，不会请求或查看平台供应商接口。{activeMembership ? "当前会员有效，你可以在个人账号中配置自己的模型连接。" : membershipStatus === "expired" ? "会员资格已到期；重新获得资格后才可配置个人模型。" : membershipStatus === "revoked" ? "会员资格已撤销；重新获得资格后才可配置个人模型。" : "如需配置个人模型，请在个人中心提交会员申请。"}</p>{activeMembership ? <a href="/profile/models" className="mt-5 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white">配置个人模型</a> : null}</section> : null}
        {canManageProviders && error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}

        {canManageProviders ? <section className="mt-3 grid gap-6 lg:grid-cols-[0.72fr_1.28fr]">
          <ProviderCreateForm catalog={catalog} onCreated={handleProviderCreated} />
          <div className="space-y-4">
            <div className="flex items-end justify-between px-1">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Connections</p>
                <h2 className="mt-2 text-2xl font-semibold">已配置连接</h2>
              </div>
              <span className="text-xs text-slate-400">{loading ? "读取中…" : `${providers.length} 个`}</span>
            </div>
            {!loading && providers.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center text-sm text-slate-500">从左侧添加第一个模型供应商。</div>
            ) : providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                catalog={catalog.find((entry) => entry.kind === provider.kind)}
                onChanged={handleProviderChanged}
                onRemoved={handleProviderRemoved}
                onProbeFinished={reload}
              />
            ))}
          </div>
        </section> : null}
      </div></AdminPageFrame>
    </main>
  );
}

function ProviderCreateForm({
  catalog,
  onCreated,
}: {
  catalog: ProviderCatalogEntry[];
  onCreated: (provider: Provider) => void;
}) {
  const [kind, setKind] = useState<ProviderKind>("deepseek");
  const definition = useMemo(() => catalog.find((entry) => entry.kind === kind), [catalog, kind]);
  const [name, setName] = useState("DeepSeek");
  const [apiKey, setApiKey] = useState("");
  const [generationModelId, setGenerationModelId] = useState("deepseek-v4-flash");
  const [visionModelId, setVisionModelId] = useState("deepseek-v4-flash-vision-exp");
  const [embeddingEnabled, setEmbeddingEnabled] = useState(false);
  const [embeddingModelId, setEmbeddingModelId] = useState("");
  const [embeddingDimensions, setEmbeddingDimensions] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function chooseKind(nextKind: ProviderKind) {
    setKind(nextKind);
    const next = catalog.find((entry) => entry.kind === nextKind);
    if (!next) return;
    setName(next.displayName);
    setGenerationModelId(nextKind === "glm" ? "" : next.generationModelSuggestions[0] ?? "");
    setVisionModelId(nextKind === "glm" ? "" : next.visionModelSuggestions[0] ?? "");
    const embedding = next.embeddingModelSuggestions[0];
    setEmbeddingEnabled(next.supportsEmbeddings && embedding !== undefined);
    setEmbeddingModelId(embedding?.id ?? "");
    setEmbeddingDimensions(embedding ? String(embedding.dimensions) : "");
  }

  function chooseEmbeddingModel(modelId: string) {
    setEmbeddingModelId(modelId);
    const match = definition?.embeddingModelSuggestions.find((entry) => entry.id === modelId);
    if (match) setEmbeddingDimensions(String(match.dimensions));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          kind,
          apiKey,
          generationModelId: generationModelId || null,
          visionModelId: definition?.supportsVision && visionModelId ? visionModelId : null,
          embeddingModelId: embeddingEnabled ? embeddingModelId : null,
          embeddingDimensions: embeddingEnabled ? Number(embeddingDimensions) : null,
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "供应商创建失败"));
      const payload = await response.json() as { provider: Provider };
      onCreated(payload.provider);
      setApiKey("");
      setMessage("连接已加密保存；请在右侧执行连接测试。 ");
    } catch (submitError) {
      setMessage(submitError instanceof Error ? submitError.message : "供应商创建失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="h-fit rounded-3xl bg-slate-950 p-7 text-white shadow-xl shadow-slate-950/10">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">New connection</p>
      <h2 className="mt-3 text-2xl font-semibold">添加供应商</h2>
      <Field label="供应商">
        <select value={kind} onChange={(event) => chooseKind(event.target.value as ProviderKind)} className="dark-field">
          {catalog.map((entry) => <option key={entry.kind} value={entry.kind}>{entry.displayName}</option>)}
        </select>
      </Field>
      <Field label="连接名称"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required className="dark-field" /></Field>
      <Field label={definition?.apiKeyLabel ?? "API Key"}><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" maxLength={512} required className="dark-field" /></Field>
      <Field label="生成模型（可选）"><input list={`generation-${kind}`} value={generationModelId} onChange={(event) => setGenerationModelId(event.target.value)} className="dark-field" /></Field>
      <datalist id={`generation-${kind}`}>{definition?.generationModelSuggestions.map((id) => <option key={id} value={id} />)}</datalist>
      {definition?.supportsVision ? <><Field label="图片识别模型（可选）"><input list={`vision-${kind}`} value={visionModelId} onChange={(event) => setVisionModelId(event.target.value)} className="dark-field" /></Field><datalist id={`vision-${kind}`}>{definition.visionModelSuggestions.map((id) => <option key={id} value={id} />)}</datalist></> : null}
      {definition?.supportsEmbeddings ? (
        <>
          <label className="mt-5 flex items-center gap-3 text-sm text-slate-200"><input type="checkbox" checked={embeddingEnabled} onChange={(event) => setEmbeddingEnabled(event.target.checked)} /> 同时配置向量模型</label>
          {embeddingEnabled ? <div className="grid grid-cols-[1fr_7rem] gap-3"><Field label="向量模型"><input list={`embedding-${kind}`} value={embeddingModelId} onChange={(event) => chooseEmbeddingModel(event.target.value)} required className="dark-field" /></Field><Field label="维度"><input type="number" min={8} max={8192} value={embeddingDimensions} onChange={(event) => setEmbeddingDimensions(event.target.value)} required className="dark-field" /></Field></div> : null}
          <datalist id={`embedding-${kind}`}>{definition.embeddingModelSuggestions.map((item) => <option key={item.id} value={item.id} />)}</datalist>
        </>
      ) : <p className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-xs leading-5 text-amber-100">DeepSeek 当前作为生成供应商使用；语义索引需为项目另选 OpenAI、Qwen 或 GLM。</p>}
      {message ? <p className="mt-5 text-xs leading-5 text-slate-300" role="status">{message}</p> : null}
      <button disabled={pending || catalog.length === 0} className="mt-6 w-full rounded-xl bg-indigo-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-300 disabled:opacity-50">{pending ? "保存中…" : "加密保存连接"}</button>
      <style jsx>{`.dark-field{margin-top:.5rem;width:100%;border-radius:.75rem;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.1);padding:.75rem 1rem;font-size:.875rem;color:white;outline:none}.dark-field:focus{border-color:#a5b4fc;box-shadow:0 0 0 2px rgba(165,180,252,.2)}select.dark-field option{color:#0f172a}`}</style>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="mt-5 block text-sm font-medium text-slate-200">{label}{children}</label>;
}

function ProviderCard({ provider, catalog, onChanged, onRemoved, onProbeFinished }: { provider: Provider; catalog?: ProviderCatalogEntry; onChanged: (provider: Provider) => void; onRemoved: (providerId: string) => void; onProbeFinished: () => Promise<void> }) {
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState(provider.name);
  const [generationModelId, setGenerationModelId] = useState(provider.defaultGenerationModelId ?? "");
  const [visionModelId, setVisionModelId] = useState(provider.defaultVisionModelId ?? "");
  const [embeddingModelId, setEmbeddingModelId] = useState(provider.defaultEmbeddingModelId ?? "");
  const [embeddingDimensions, setEmbeddingDimensions] = useState(provider.embeddingDimensions ? String(provider.embeddingDimensions) : "");
  const [apiKey, setApiKey] = useState("");
  const { confirm, dialog } = useAppConfirmDialog();
  const disableBlocked = provider.status !== "disabled" && provider._count.platformDefaultAiRoutes > 0;
  const disableBlockReasons = [
    provider._count.platformDefaultAiRoutes > 0 ? "活动默认路由" : null,
  ].filter((reason): reason is string => reason !== null).join("、");

  async function testConnection() {
    setTesting(true);
    setMessage(null);
    try {
      const clientRequestKey = globalThis.crypto.randomUUID();
      const response = await fetch(`/api/settings/providers/${provider.id}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestKey, expectedConfigurationVersion: provider.configurationVersion }),
      });
      if (!response.ok) throw new Error(await readError(response, "连接测试失败"));
      const payload = await response.json() as ProviderCheck;
      await onProbeFinished();
      setMessage(describeProviderCheck(payload));
    } catch (testError) {
      setMessage(testError instanceof Error ? testError.message : "连接测试失败");
    } finally {
      setTesting(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/settings/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          generationModelId: generationModelId || null,
          visionModelId: catalog?.supportsVision && visionModelId ? visionModelId : null,
          embeddingModelId: catalog?.supportsEmbeddings && embeddingModelId ? embeddingModelId : null,
          embeddingDimensions: catalog?.supportsEmbeddings && embeddingModelId ? Number(embeddingDimensions) : null,
          ...(apiKey ? { apiKey } : {}),
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "配置保存失败"));
      const payload = await response.json() as { provider: Provider };
      onChanged(payload.provider);
      setApiKey("");
      setEditing(false);
      setMessage("配置已保存；变更后请重新执行连接测试。 ");
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : "配置保存失败");
    } finally {
      setPending(false);
    }
  }

  async function toggleEnabled() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/settings/providers/${provider.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: provider.status === "disabled" }),
      });
      if (!response.ok) throw new Error(await readError(response, "状态更新失败"));
      onChanged((await response.json() as { provider: Provider }).provider);
    } catch (toggleError) {
      setMessage(toggleError instanceof Error ? toggleError.message : "状态更新失败");
    } finally {
      setPending(false);
    }
  }

  async function removeConnection() {
    const confirmation = await confirm({ eyebrow: "Model provider", title: `永久删除“${provider.name}”？`, description: "连接配置和加密凭据都会被删除，且不可恢复。有关联项目路由或审计记录时，服务端会拒绝操作。", inputLabel: `输入连接名称“${provider.name}”以确认`, requiredValue: provider.name, confirmLabel: "确认永久删除", tone: "danger", maxLength: 120 });
    if (!confirmation.confirmed) return;
    const confirmationName = confirmation.value;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/settings/providers/${provider.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmationName }),
      });
      if (!response.ok) throw new Error(await readError(response, "供应商连接删除失败"));
      onRemoved(provider.id);
    } catch (deleteError) {
      setMessage(deleteError instanceof Error ? deleteError.message : "供应商连接删除失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <><article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3"><h3 className="text-lg font-semibold">{provider.name}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${provider.status === "verified" ? "bg-emerald-50 text-emerald-700" : provider.status === "error" ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{statusLabel[provider.status]}</span></div>
          <p className="mt-2 text-xs text-slate-500">{catalog?.displayName ?? provider.kind} · Key 尾号 {provider.credential.maskedSuffix} · 配置版本 {provider.configurationVersion} · 活动默认路由 {provider._count.platformDefaultAiRoutes} 条 · {dateLabel(provider.lastTestedAt)}</p>
        </div>
        <div className="flex gap-2"><button type="button" onClick={() => setEditing((value) => !value)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">{editing ? "收起" : "编辑"}</button><button type="button" onClick={() => void testConnection()} disabled={testing || provider.status === "disabled"} className="rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{testing ? "测试中…" : "测试连接"}</button></div>
      </div>
      <dl className="mt-5 grid gap-3 rounded-2xl bg-slate-50 p-4 text-xs sm:grid-cols-3"><div><dt className="text-slate-400">生成模型</dt><dd className="mt-1 font-medium text-slate-700">{provider.defaultGenerationModelId ?? "未配置"}</dd></div><div><dt className="text-slate-400">图片识别</dt><dd className="mt-1 font-medium text-slate-700">{provider.defaultVisionModelId ?? "未配置"}</dd></div><div><dt className="text-slate-400">向量模型</dt><dd className="mt-1 font-medium text-slate-700">{provider.defaultEmbeddingModelId ? `${provider.defaultEmbeddingModelId} · ${provider.embeddingDimensions} 维` : "未配置"}</dd></div></dl>
      <div className="mt-5"><ScopeEvidenceCard title="供应商配置边界" evidence={{ scope: "平台供应商连接", owner: "平台管理员", payer: "使用平台默认路由时由当前发起人扣减平台额度", affectedProjects: provider._count.platformDefaultAiRoutes > 0 ? `项目影响需经活动默认路由影响预览核实；当前有 ${provider._count.platformDefaultAiRoutes} 条活动默认路由引用` : "尚无活动默认路由引用；暂无项目影响证据", latestSuccess: provider.lastTestedAt ? `最近连接测试：${dateLabel(provider.lastTestedAt)}` : "尚未完成连接测试" }} /></div>
      {editing ? <form onSubmit={save} className="mt-5 grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-2"><EditField label="连接名称"><input value={name} onChange={(event) => setName(event.target.value)} required className="edit-field" /></EditField><EditField label="生成模型（可选）"><input value={generationModelId} onChange={(event) => setGenerationModelId(event.target.value)} className="edit-field" /></EditField>{catalog?.supportsVision ? <EditField label="图片识别模型（可选）"><input value={visionModelId} onChange={(event) => setVisionModelId(event.target.value)} className="edit-field" /></EditField> : null}{catalog?.supportsEmbeddings ? <><EditField label="向量模型（留空即关闭）"><input value={embeddingModelId} onChange={(event) => setEmbeddingModelId(event.target.value)} className="edit-field" /></EditField><EditField label="向量维度"><input type="number" value={embeddingDimensions} onChange={(event) => setEmbeddingDimensions(event.target.value)} disabled={!embeddingModelId} className="edit-field" /></EditField></> : null}<EditField label="替换 API Key（可选）"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" className="edit-field" /></EditField><div className="flex items-end gap-2"><button disabled={pending} className="rounded-xl bg-indigo-600 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50">保存变更</button><button type="button" onClick={() => void toggleEnabled()} disabled={pending || disableBlocked} title={disableBlocked ? `无法停用：${disableBlockReasons}仍在使用该连接` : undefined} className="rounded-xl border border-slate-200 px-4 py-3 text-xs font-semibold text-slate-600 disabled:opacity-40">{provider.status === "disabled" ? "重新启用" : "停用连接"}</button></div>{disableBlocked ? <p className="text-xs leading-5 text-amber-700 sm:col-span-2">无法停用：{disableBlockReasons}仍在使用该连接。请先移除项目路由或退役活动默认路由。</p> : null}<style jsx>{`.edit-field{margin-top:.4rem;width:100%;border-radius:.75rem;border:1px solid #e2e8f0;padding:.7rem .85rem;font-size:.8rem;outline:none}.edit-field:focus{border-color:#818cf8;box-shadow:0 0 0 2px #e0e7ff}`}</style></form> : null}
      {provider.status === "disabled" ? <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3"><p className="text-xs leading-5 text-rose-700">永久删除仅适用于没有活动平台默认路由或历史审计引用的连接，并会同时删除加密凭据。</p><button type="button" onClick={() => void removeConnection()} disabled={pending} className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">永久删除</button></div> : null}
      {message ? <p role="status" className="mt-4 text-xs leading-5 text-slate-600">{message}</p> : null}
      {provider.lastErrorCode ? <p className="mt-2 text-xs text-rose-600">安全错误码：{provider.lastErrorCode}</p> : null}
    </article>{dialog}</>
  );
}

function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-slate-600">{label}{children}</label>;
}
