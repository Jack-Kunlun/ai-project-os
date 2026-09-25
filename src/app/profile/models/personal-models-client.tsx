"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { HelpTooltip } from "@/components/help-tooltip";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";
import {
  createDefaultPersonalModelDraft,
  createPersonalModelConfigurationPatch,
  createPersonalModelEditDraft,
  createPersonalModelKeyPatch,
  hasPersonalModelCapability,
  type PersonalModelDraft,
  type PersonalProviderCatalogEntry,
  type PersonalProviderKind,
  type PersonalProviderRecord,
} from "./personal-models-state";

type MembershipStatus = "active" | "expired" | "revoked" | "none";

type Membership = Readonly<{
  status: MembershipStatus;
  startsAt: string | null;
  expiresAt: string | null;
  version: number | null;
}>;

type Provider = PersonalProviderRecord;
type ProviderKind = PersonalProviderKind;
type CatalogEntry = PersonalProviderCatalogEntry;

type Message = Readonly<{ tone: "success" | "error" | "info"; text: string }>;

const membershipLabels: Record<MembershipStatus, string> = {
  active: "会员有效",
  expired: "会员已到期",
  revoked: "会员已撤销",
  none: "普通用户",
};

const statusLabels: Record<string, string> = {
  configured: "待测试",
  verified: "已验证",
  error: "测试失败",
  disabled: "已停用",
};

function formatDate(value: string | null): string {
  if (!value) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function membershipDescription(membership: Membership): string {
  if (membership.status === "active") return membership.expiresAt ? `可配置和测试个人模型，有效期至 ${formatDate(membership.expiresAt)}。` : "可配置和测试个人模型。";
  if (membership.status === "none") return "普通用户只能使用平台赠送的免费额度，不能配置或测试个人模型。";
  if (membership.status === "expired") return "会员已到期，不能继续配置、测试、启用或调用个人模型；仍可安全轮换密钥、停用和删除已有连接。";
  return "会员资格已撤销，不能继续配置、测试、启用或调用个人模型；仍可安全轮换密钥、停用和删除已有连接。";
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function getCatalogEntry(catalog: readonly CatalogEntry[], kind: ProviderKind): CatalogEntry | undefined {
  return catalog.find((entry) => entry.kind === kind);
}

export function PersonalModelsClient({ membership }: { membership: Membership }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/me/ai-providers", { cache: "no-store" });
      if (!response.ok) throw new Error(await errorMessage(response, "个人模型连接加载失败"));
      const payload = await response.json() as { providers: Provider[]; catalog: CatalogEntry[] };
      setProviders(payload.providers);
      setCatalog(payload.catalog);
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "个人模型连接加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const canConfigure = membership.status === "active";
  const canMaintain = membership.status === "active" || membership.status === "expired" || membership.status === "revoked" || membership.status === "none";

  return (
    <div className="mx-auto max-w-6xl px-5 pb-16 pt-7 sm:px-8 lg:px-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/personal/configuration" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-indigo-700">
          <span aria-hidden="true">←</span> 返回我的空间配置
        </Link>
        <span className="text-xs text-slate-400">我的空间 / 我的模型</span>
      </div>

      <section className="mt-6 flex flex-col gap-5 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-7">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">My models</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">我的模型</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">只管理你自己的模型连接。平台默认模型由管理员统一维护，个人连接不会自动替代项目路由。</p>
        </div>
        <div className={`shrink-0 rounded-2xl px-4 py-3 text-sm ${canConfigure ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
          <p className="font-semibold">{membershipLabels[membership.status]}</p>
          <p className="mt-1 text-xs leading-5">{membershipDescription(membership)}</p>
        </div>
      </section>

      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-5 rounded-2xl px-4 py-3 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-700" : message.tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>{message.text}</p> : null}
      {loadError ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span>{loadError}</span><button type="button" onClick={() => void load()} className="font-semibold underline">重试</button></div> : null}

      <div className={`mt-6 grid gap-6 ${canConfigure ? "lg:grid-cols-[minmax(280px,0.78fr)_minmax(0,1.22fr)]" : "lg:grid-cols-1"}`}>
        {canConfigure ? catalog.length > 0 ? <CreateProviderForm catalog={catalog} onCreated={(provider) => { setProviders((current) => [...current, provider]); setMessage({ tone: "success", text: "个人模型连接已保存。首次使用前请先测试连接。" }); }} /> : <CreateProviderPlaceholder loading={loading} loadError={loadError} onRetry={load} /> : null}
        <section className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">已有连接</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">密钥只显示末尾掩码；固定官方端点不可修改。</p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{providers.length} 个连接</span>
          </div>
          {loading ? <div className="mt-5 space-y-3" aria-label="正在加载连接"><div className="h-28 animate-pulse rounded-2xl bg-slate-100" /><div className="h-28 animate-pulse rounded-2xl bg-slate-100" /></div> : providers.length === 0 ? <EmptyState canConfigure={canConfigure} /> : <div className="mt-5 space-y-4">{providers.map((provider) => <ProviderCard key={provider.id} provider={provider} catalog={catalog} membership={membership} canConfigure={canConfigure} canMaintain={canMaintain} onChanged={(next) => setProviders((current) => current.map((item) => item.id === next.id ? next : item))} onRemoved={(id) => { setProviders((current) => current.filter((item) => item.id !== id)); setMessage({ tone: "success", text: "连接已删除。" }); }} onMessage={setMessage} onReload={load} />)}</div>}
        </section>
      </div>
      <style jsx global>{`.field{margin-top:.5rem;width:100%;border-radius:.75rem;border:1px solid #cbd5e1;background:white;padding:.72rem .9rem;font-size:.875rem;color:#0f172a;outline:none}.field:focus{border-color:#818cf8;box-shadow:0 0 0 3px rgba(129,140,248,.14)}.field:disabled{background:#f1f5f9;color:#64748b}`}</style>
    </div>
  );
}

function EmptyState({ canConfigure }: { canConfigure: boolean }) {
  return <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-8 text-center"><p className="text-sm font-semibold text-slate-700">还没有个人模型连接</p><p className="mt-2 text-xs leading-5 text-slate-500">{canConfigure ? "从左侧添加一个连接，保存后先测试再用于项目。" : "会员资格失效期间不能新增连接；历史连接仍可在这里安全清理。"}</p></div>;
}

function CreateProviderPlaceholder({ loading, loadError, onRetry }: { loading: boolean; loadError: string | null; onRetry: () => Promise<void> }) {
  return <section className="h-fit rounded-3xl border border-indigo-100 bg-indigo-50/40 p-5 shadow-sm sm:p-6"><h2 className="text-xl font-semibold">添加连接</h2>{loading ? <div className="mt-5 space-y-3" aria-label="正在加载可用模型目录"><div className="h-4 w-32 animate-pulse rounded bg-indigo-100" /><div className="h-11 animate-pulse rounded-xl bg-white/80" /><div className="h-11 animate-pulse rounded-xl bg-white/80" /><p className="text-xs text-slate-500">正在加载可用模型目录…</p></div> : <div className="mt-5 rounded-2xl border border-dashed border-indigo-200 bg-white/70 px-4 py-5"><p className="text-sm font-semibold text-slate-700">暂时无法加载模型目录</p><p className="mt-2 text-xs leading-5 text-slate-500">{loadError ?? "可用模型目录为空，请刷新后重试。"}</p><button type="button" onClick={() => void onRetry()} className="mt-4 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50">重新加载</button></div>}</section>;
}

function CreateProviderForm({ catalog, onCreated }: { catalog: readonly CatalogEntry[]; onCreated: (provider: Provider) => void }) {
  const initialDraft = createDefaultPersonalModelDraft(catalog) ?? {
    name: "",
    kind: "openai" as const,
    apiKey: "",
    generationModelId: "",
    visionModelId: "",
    embeddingModelId: "",
    embeddingDimensions: "",
  };
  const [draft, setDraft] = useState<PersonalModelDraft>(initialDraft);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const definition = getCatalogEntry(catalog, draft.kind);

  function chooseKind(nextKind: ProviderKind) {
    setDraft((current) => {
      const next = getCatalogEntry(catalog, nextKind);
      if (next === undefined) return current;
      const defaults = createDefaultPersonalModelDraft([next], current.name);
      return defaults === null ? current : { ...defaults, apiKey: current.apiKey };
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasPersonalModelCapability(draft)) {
      setMessage({ tone: "error", text: "请至少配置生成模型或向量模型。" });
      return;
    }
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/me/ai-providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft.name, kind: draft.kind, apiKey: draft.apiKey, generationModelId: draft.generationModelId || null, visionModelId: definition?.supportsVision && draft.visionModelId ? draft.visionModelId : null, embeddingModelId: definition?.supportsEmbeddings && draft.embeddingModelId ? draft.embeddingModelId : null, embeddingDimensions: definition?.supportsEmbeddings && draft.embeddingModelId && draft.embeddingDimensions ? Number(draft.embeddingDimensions) : null }) });
      if (!response.ok) throw new Error(await errorMessage(response, "个人模型连接保存失败"));
      const payload = await response.json() as { provider: Provider };
      onCreated(payload.provider);
      setDraft(createDefaultPersonalModelDraft(catalog) ?? initialDraft);
      setMessage({ tone: "success", text: "已保存，请在连接卡片中测试。" });
    } catch (cause) { setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "个人模型连接保存失败" }); }
    finally { setDraft((current) => ({ ...current, apiKey: "" })); setPending(false); }
  }

  return <section className="rounded-3xl border border-indigo-100 bg-indigo-50/40 p-5 shadow-sm sm:p-6"><div><h2 className="text-xl font-semibold">添加连接</h2><p className="mt-1 text-xs leading-5 text-slate-600">仅支持平台内置的固定官方端点。API Key 只用于加密保存和请求，不会写入地址栏。</p></div><form onSubmit={submit} className="mt-5 space-y-4"><Field label="连接名称"><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required maxLength={80} placeholder="例如：我的 OpenAI" className="field" /></Field><Field label="供应商"><select value={draft.kind} onChange={(event) => chooseKind(event.target.value as ProviderKind)} className="field">{catalog.map((entry) => <option key={entry.kind} value={entry.kind}>{entry.displayName}</option>)}</select></Field><Field label="固定 Base URL"><input value={definition?.baseUrl ?? ""} readOnly aria-readonly="true" className="field bg-slate-100 text-slate-500" /></Field><Field label={definition?.apiKeyLabel ?? "API Key"}><input type="password" value={draft.apiKey} onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))} required minLength={8} maxLength={512} autoComplete="new-password" className="field" /></Field><p className="rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">生成模型或向量模型至少配置一项。</p><ModelField label="生成模型（可选）" value={draft.generationModelId} onChange={(value) => setDraft((current) => ({ ...current, generationModelId: value }))} suggestions={definition?.generationModelSuggestions ?? []} /><ModelField label="图片识别模型（可选）" value={draft.visionModelId} onChange={(value) => setDraft((current) => ({ ...current, visionModelId: value }))} suggestions={definition?.visionModelSuggestions ?? []} disabled={!definition?.supportsVision} /><ModelField label="向量模型（可选）" value={draft.embeddingModelId} onChange={(value) => { setDraft((current) => ({ ...current, embeddingModelId: value, embeddingDimensions: definition?.embeddingModelSuggestions.find((item) => item.id === value)?.dimensions.toString() ?? current.embeddingDimensions })); }} suggestions={definition?.embeddingModelSuggestions.map((item) => item.id) ?? []} disabled={!definition?.supportsEmbeddings} /><Field label="向量维度（可选）"><input type="number" min={8} max={8192} step={1} value={draft.embeddingDimensions} onChange={(event) => setDraft((current) => ({ ...current, embeddingDimensions: event.target.value }))} required={Boolean(draft.embeddingModelId)} disabled={!definition?.supportsEmbeddings || !draft.embeddingModelId} className="field disabled:bg-slate-100" /></Field><button type="submit" disabled={pending} className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">{pending ? "保存中…" : "保存个人连接"}</button>{message ? <p role={message.tone === "error" ? "alert" : "status"} className={`rounded-xl px-3 py-2 text-xs leading-5 ${message.tone === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{message.text}</p> : null}</form></section>;
}

function ProviderCard({ provider, catalog, membership, canConfigure, canMaintain, onChanged, onRemoved, onMessage, onReload }: { provider: Provider; catalog: readonly CatalogEntry[]; membership: Membership; canConfigure: boolean; canMaintain: boolean; onChanged: (provider: Provider) => void; onRemoved: (providerId: string) => void; onMessage: (message: Message) => void; onReload: () => Promise<void> }) {
  const definition = getCatalogEntry(catalog, provider.kind);
  const [editing, setEditing] = useState<"configuration" | "key" | null>(null);
  const [draft, setDraft] = useState<PersonalModelDraft | null>(null);
  const [pending, setPending] = useState(false);
  const { confirm, dialog } = useAppConfirmDialog();
  const activeMembership = membership.status === "active";
  const enabled = provider.status !== "disabled" && provider.disabledAt === null;

  function beginEditing(mode: "configuration" | "key") {
    setDraft(createPersonalModelEditDraft(provider));
    setEditing(mode);
  }

  function updateDraft(next: Partial<PersonalModelDraft>) {
    setDraft((current) => current === null ? current : { ...current, ...next });
  }

  function clearDraftKey() {
    setDraft((current) => current === null ? current : { ...current, apiKey: "" });
  }

  async function patch(input: Record<string, unknown>, expectedUpdatedAt: string, successText: string) {
    setPending(true);
    try {
      const response = await fetch(`/api/me/ai-providers/${provider.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, expectedUpdatedAt }) });
      if (!response.ok) {
        const error = await errorMessage(response, "连接更新失败");
        await onReload();
        const editingMessage = editing === null ? error : `${error} 状态已刷新，请重新打开编辑。`;
        if (editing !== null) {
          setEditing(null);
          setDraft(null);
        }
        onMessage({ tone: "error", text: editingMessage });
        return null;
      }
      const payload = await response.json() as { provider: Provider };
      onChanged(payload.provider); onMessage({ tone: "success", text: successText }); return payload.provider;
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "连接更新失败";
      await onReload();
      const editingMessage = editing === null ? error : `${error} 状态已刷新，请重新打开编辑。`;
      if (editing !== null) {
        setEditing(null);
        setDraft(null);
      }
      onMessage({ tone: "error", text: editingMessage });
      return null;
    } finally { clearDraftKey(); setPending(false); }
  }

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing === null || draft === null || (editing === "configuration" && !canConfigure) || (editing === "key" && !canMaintain)) return;
    if (editing === "configuration" && !hasPersonalModelCapability(draft)) {
      onMessage({ tone: "error", text: "请至少配置生成模型或向量模型。" });
      return;
    }
    if (editing === "key" && !draft.apiKey) {
      onMessage({ tone: "error", text: "请输入新的 API Key。" });
      return;
    }
    const input = editing === "key"
      ? createPersonalModelKeyPatch(draft)
      : createPersonalModelConfigurationPatch(draft);
    if (draft.expectedUpdatedAt === undefined) {
      onMessage({ tone: "error", text: "编辑快照已失效，请重新打开编辑。" });
      return;
    }
    const next = await patch(input, draft.expectedUpdatedAt, editing === "key" ? "API Key 已轮换，请重新测试连接。" : "配置已更新，请重新测试连接。");
    if (next) setEditing(null);
  }

  async function toggleEnabled() {
    if (provider.status === "disabled") {
      if (!activeMembership) return;
      await patch({ enabled: true }, provider.updatedAt, "连接已重新启用，请重新测试连接。");
    } else {
      await patch({ enabled: false }, provider.updatedAt, "连接已停用；如需删除，请在停用后确认连接名称。");
    }
  }

  async function testConnection() {
    setPending(true); onMessage({ tone: "info", text: "正在向固定官方端点发送不含用户或项目内容的探针…" });
    try {
      const response = await fetch(`/api/me/ai-providers/${provider.id}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      if (!response.ok) {
        const error = await errorMessage(response, "连接测试失败");
        await onReload();
        onMessage({ tone: "error", text: error });
        return;
      }
      const payload = await response.json() as { provider: Provider };
      onChanged(payload.provider); onMessage({ tone: "success", text: "连接测试通过。探针不包含用户或项目内容。" });
    } catch (cause) {
      await onReload();
      onMessage({ tone: "error", text: cause instanceof Error ? cause.message : "连接测试失败" });
    } finally { setPending(false); }
  }

  async function remove() {
    let current = provider;
    if (current.status !== "disabled" || current.disabledAt === null) {
      const disabled = await patch({ enabled: false }, current.updatedAt, "连接已停用，请继续确认删除。");
      if (!disabled) return;
      current = disabled;
    }
    const result = await confirm({ eyebrow: "Delete personal connection", title: `删除“${current.name}”？`, description: "删除前已停用连接。删除会移除连接和加密凭据，且不可恢复；如果仍被项目或历史记录引用，服务端会拒绝操作。", inputLabel: `输入连接名称“${current.name}”以确认`, requiredValue: current.name, inputPlaceholder: current.name, confirmLabel: "确认删除", tone: "danger", maxLength: 80 });
    if (!result.confirmed) return;
    setPending(true);
    try {
      const response = await fetch(`/api/me/ai-providers/${current.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationName: result.value, expectedUpdatedAt: current.updatedAt }) });
      if (!response.ok) {
        const error = await errorMessage(response, "连接删除失败");
        await onReload();
        onMessage({ tone: "error", text: error });
        return;
      }
      onRemoved(current.id);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "连接删除失败";
      await onReload();
      onMessage({ tone: "error", text: error });
    }
    finally { setPending(false); }
  }

  return <article className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5">{dialog}<div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-base font-semibold text-slate-900">{provider.name}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${provider.status === "verified" ? "bg-emerald-100 text-emerald-700" : provider.status === "error" ? "bg-rose-100 text-rose-700" : provider.status === "disabled" ? "bg-slate-200 text-slate-600" : "bg-amber-100 text-amber-700"}`}>{statusLabels[provider.status] ?? provider.status}</span></div><p className="mt-2 text-xs text-slate-500">{definition?.displayName ?? provider.kind} · 固定端点 {provider.baseUrl}</p></div><div className="text-right text-xs text-slate-400"><p>Key ····{provider.credential.maskedSuffix}</p><p className="mt-1">更新于 {formatDate(provider.updatedAt)}</p></div></div>
    {provider.lastErrorCode ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">最近错误：{provider.lastErrorCode}{provider.lastErrorCode === "AI_PROVIDER_IN_USE" ? "。该连接仍可能被项目或历史记录引用；清理活动路由或撤销委托后若仍失败，请保持连接停用并稍后重试。" : "。修改配置后请重新测试。"}</p> : null}
    <dl className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3"><div><dt className="text-slate-400">生成模型</dt><dd className="mt-1 break-all font-medium">{provider.defaultGenerationModelId ?? "未配置"}</dd></div><div><dt className="text-slate-400">图片模型</dt><dd className="mt-1 break-all font-medium">{provider.defaultVisionModelId ?? "未配置"}</dd></div><div><dt className="text-slate-400">向量模型</dt><dd className="mt-1 break-all font-medium">{provider.defaultEmbeddingModelId ? `${provider.defaultEmbeddingModelId}${provider.embeddingDimensions ? ` · ${provider.embeddingDimensions} 维` : ""}` : "未配置"}</dd></div></dl>
    <div className="mt-4"><ScopeEvidenceCard title="个人模型连接边界" evidence={{ scope: "个人连接", owner: "当前账户", payer: "个人连接所有者承担费用", affectedProjects: "尚未取得项目委托证据；仅在项目权限与明确委托生效后影响，不展示项目标识或数量", latestSuccess: provider.lastTestedAt ? `最近连接测试：${formatDate(provider.lastTestedAt)}` : "尚未完成连接测试" }} /></div>
    {editing !== null && draft !== null && (editing === "configuration" ? canConfigure : canMaintain) ? <form onSubmit={saveConfiguration} className="mt-4 grid gap-3 rounded-xl border border-indigo-100 bg-white p-4 sm:grid-cols-2">{editing === "configuration" ? <><Field label="连接名称"><input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} required maxLength={80} className="field" /></Field><Field label="固定 Base URL"><input value={provider.baseUrl} readOnly aria-readonly="true" className="field bg-slate-100 text-slate-500" /></Field><p className="rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600 sm:col-span-2">生成模型或向量模型至少配置一项。</p><ModelField label="生成模型（可选）" value={draft.generationModelId} onChange={(value) => updateDraft({ generationModelId: value })} suggestions={definition?.generationModelSuggestions ?? []} /><ModelField label="图片识别模型（可选）" value={draft.visionModelId} onChange={(value) => updateDraft({ visionModelId: value })} suggestions={definition?.visionModelSuggestions ?? []} disabled={!definition?.supportsVision} /><ModelField label="向量模型（可选）" value={draft.embeddingModelId} onChange={(value) => updateDraft({ embeddingModelId: value, embeddingDimensions: definition?.embeddingModelSuggestions.find((item) => item.id === value)?.dimensions.toString() ?? draft.embeddingDimensions })} suggestions={definition?.embeddingModelSuggestions.map((item) => item.id) ?? []} disabled={!definition?.supportsEmbeddings} /><Field label="向量维度（可选）"><input type="number" min={8} max={8192} step={1} value={draft.embeddingDimensions} onChange={(event) => updateDraft({ embeddingDimensions: event.target.value })} required={Boolean(draft.embeddingModelId)} disabled={!definition?.supportsEmbeddings || !draft.embeddingModelId} className="field disabled:bg-slate-100" /></Field></> : <div className="sm:col-span-2 rounded-xl bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600">当前资格只允许安全维护。轮换 API Key 不会恢复测试、启用或调用能力。</div>}{editing === "key" ? <Field label="新的 API Key"><input type="password" value={draft.apiKey} onChange={(event) => updateDraft({ apiKey: event.target.value })} autoComplete="new-password" placeholder="输入新的 API Key" required minLength={8} maxLength={512} className="field" /></Field> : null}<div className="flex items-center gap-2 sm:col-span-2"><button type="submit" disabled={pending} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{pending ? "保存中…" : editing === "key" ? "轮换 Key" : "保存配置"}</button><button type="button" onClick={() => { setEditing(null); setDraft(null); }} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">取消</button></div></form> : null}
    {editing === null ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2">{activeMembership ? <><button type="button" onClick={() => beginEditing("configuration")} disabled={pending} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50">编辑配置</button><button type="button" onClick={() => void testConnection()} disabled={pending || !enabled} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{pending ? "处理中…" : "测试连接"}</button></> : null}<button type="button" onClick={() => beginEditing("key")} disabled={pending || !canMaintain} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50">轮换 Key</button></div><div className="flex flex-wrap gap-2">{provider.status === "disabled" ? activeMembership ? <button type="button" onClick={() => void toggleEnabled()} disabled={pending} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50">重新启用</button> : null : <button type="button" onClick={() => void toggleEnabled()} disabled={pending} className="rounded-lg px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">停用</button>}<button type="button" onClick={() => void remove()} disabled={pending} className="rounded-lg px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">删除</button></div></div> : null}
    {provider.status === "disabled" ? <p className="mt-3 text-xs leading-5 text-slate-500">连接已停用。{activeMembership ? "会员有效时可重新启用，启用后请重新测试。" : "当前资格不能重新启用，只能轮换 Key、停用或删除。"}</p> : null}
  </article>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const help = label.includes("API Key")
    ? "从所选供应商的控制台创建你自己的 API Key。示例仅说明格式，请勿使用他人的密钥；保存后在连接卡片中测试。"
    : label.includes("Base URL")
      ? "这里显示平台内置的供应商官方地址，由系统固定，无法手动改成其他服务。"
      : label.includes("模型")
        ? "填写供应商提供的模型 ID，例如供应商模型目录中的标识；先保存连接，再测试，最后在项目中授权使用。向量维度要与所选向量模型一致。"
        : label === "供应商"
          ? "先选择你已开通账号的供应商，再填写该供应商的 API Key 和模型 ID。"
          : null;
  return <div className="relative"><label className="block text-xs font-semibold text-slate-700">{label}{children}</label>{help ? <span className="absolute right-0 top-0"><HelpTooltip label={label}>{help}</HelpTooltip></span> : null}</div>;
}

function ModelField({ label, value, onChange, suggestions, disabled = false }: { label: string; value: string; onChange: (value: string) => void; suggestions: readonly string[]; disabled?: boolean }) {
  const listId = `model-suggestions-${label.replace(/[^a-z0-9]+/giu, "-")}`;
  return <Field label={label}><input value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} list={listId} className="field disabled:bg-slate-100" /><datalist id={listId}>{suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}</datalist></Field>;
}
