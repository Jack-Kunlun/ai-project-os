"use client";
import { UiFeedbackText, UiErrorText } from "@/components/ui-error-text";


import { PersonalModelOverview } from "./personal-model-overview";
import formFields from "@/components/model-form-fields.module.css";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { HelpTooltip } from "@/components/help-tooltip";
import { OperationPanel } from "@/components/operation-panel";
import { ParentPageLink } from "@/components/parent-page-link";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";
import styles from "../../support-pages.module.css";
import { UiText, useAppearance, useTranslate, type AppearanceLanguage } from "@/components/appearance-provider";
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

type Message = Readonly<{ tone: "success" | "error" | "info"; text: string; draftRetained?: boolean }>;

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

function formatDate(value: string | null, language: AppearanceLanguage = "zh-CN"): string {
  if (!value) return language === "en" ? "No record" : "暂无记录";
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function membershipDescription(membership: Membership, language: AppearanceLanguage, t: (text: string) => string): string {
  if (membership.status === "active") return membership.expiresAt ? `${t("可配置和测试个人模型，有效期至 ")}${formatDate(membership.expiresAt, language)}${t("。")}` : t("可配置和测试个人模型。");
  if (membership.status === "none") return t("普通用户只能使用平台赠送的免费额度，不能配置或测试个人模型。");
  if (membership.status === "expired") return t("会员已到期，不能继续配置、测试、启用或调用个人模型；仍可安全轮换密钥、停用和删除已有连接。");
  return t("会员资格已撤销，不能继续配置、测试、启用或调用个人模型；仍可安全轮换密钥、停用和删除已有连接。");
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

async function isPersonalProviderConflict(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  const payload = await response.clone().json().catch(() => null) as unknown;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
  return (error as { code?: unknown }).code === "AI_PROVIDER_CONFLICT";
}

function getCatalogEntry(catalog: readonly CatalogEntry[], kind: ProviderKind): CatalogEntry | undefined {
  return catalog.find((entry) => entry.kind === kind);
}

export function PersonalModelsClient({ membership }: { membership: Membership }) {
  const { t, language } = useAppearance();

  const [providers, setProviders] = useState<Provider[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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
    <div data-page-content className={styles.content}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ParentPageLink href="/personal/configuration" label="返回我的空间配置" />
        <span className="text-xs text-slate-400"><UiText text={"我的空间 / 我的模型"} /></span>
      </div>

      <section className={`${styles.pageHeader} mt-6`}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">My models</p>
          <h1 className={`${styles.pageTitle} mt-2`}><UiText text={"模型与额度"} /></h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600"><UiText text={"只管理你自己的模型连接。平台默认模型由管理员统一维护，个人连接不会自动替代项目路由。"} /></p>
        </div>
              <OperationPanel title={t("添加个人模型连接")} triggerLabel={t("添加连接")} description={t("连接仅保存到当前账户。API Key 会加密保存，保存后请在连接卡片中测试。")} open={createOpen} onOpenChange={setCreateOpen} disabled={loading || !canConfigure || catalog.length === 0}>
                <CreateProviderForm catalog={catalog} onCreated={(provider) => { setProviders((current) => [...current, provider]); setCreateOpen(false); setMessage({ tone: "success", text: "个人模型连接已保存。首次使用前请先测试连接。" }); }} />
              </OperationPanel>
      </section>

      <PersonalModelOverview><h2><UiText text="个人模型"/></h2>        <div className={`w-full min-w-0 text-xs leading-5 sm:w-auto sm:max-w-sm sm:shrink-0 ${canConfigure ? "text-emerald-700" : "text-amber-700"}`}>
          <p className="font-semibold">{t(membershipLabels[membership.status])}</p>
          <p className="mt-1 text-xs leading-5">{membershipDescription(membership, language, t)}</p>
        </div><p><a href="#personal-model-connections" className={styles.noteLink}><UiText text="查看与配置"/></a></p></PersonalModelOverview>

      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-5 rounded-2xl px-4 py-3 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-700" : message.tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}><UiFeedbackText text={message.text} /></p> : null}
      {loadError ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span><UiErrorText text={loadError} /></span><button type="button" onClick={() => void load()} className="font-semibold underline"><UiText text={"重试"} /></button></div> : null}

      <section id="personal-model-connections" className="mt-6 min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold"><UiText text={"已有连接"} /></h2>
              <p className="mt-1 text-xs leading-5 text-slate-500"><UiText text={"密钥只显示末尾掩码；固定官方端点不可修改。"} /></p>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{providers.length}{t(" 个连接")}</span>

            </div>
          </div>
          {canConfigure && catalog.length === 0 ? <div className="mt-5"><CreateProviderPlaceholder loading={loading} loadError={loadError} onRetry={load} /></div> : null}
          {loading && providers.length === 0 ? <div className="mt-5 space-y-3" aria-label={t("正在加载连接")}><div className="h-28 animate-pulse rounded-2xl bg-slate-100" /><div className="h-28 animate-pulse rounded-2xl bg-slate-100" /></div> : providers.length === 0 ? <EmptyState canConfigure={canConfigure} /> : <div className="mt-5 space-y-4">{providers.map((provider) => <ProviderCard key={provider.id} provider={provider} catalog={catalog} membership={membership} canConfigure={canConfigure} canMaintain={canMaintain} onChanged={(next) => setProviders((current) => current.map((item) => item.id === next.id ? next : item))} onRemoved={(id) => { setProviders((current) => current.filter((item) => item.id !== id)); setMessage({ tone: "success", text: "连接已删除。" }); }} onMessage={setMessage} onReload={load} />)}</div>}
      </section>

    </div>
  );
}

function EmptyState({ canConfigure }: { canConfigure: boolean }) {
  const t = useTranslate();
  return <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-8 text-center"><p className="text-sm font-semibold text-slate-700"><UiText text={"还没有个人模型连接"} /></p><p className="mt-2 text-xs leading-5 text-slate-500">{canConfigure ? t("使用上方“添加连接”入口创建连接，保存后先测试再用于项目。") : t("会员资格失效期间不能新增连接；历史连接仍可在这里安全清理。")}</p></div>;
}

function CreateProviderPlaceholder({ loading, loadError, onRetry }: { loading: boolean; loadError: string | null; onRetry: () => Promise<void> }) {
  const t = useTranslate();

  return <section className="h-fit rounded-3xl border border-indigo-100 bg-indigo-50/40 p-5 shadow-sm sm:p-6"><h2 className="text-xl font-semibold"><UiText text={"添加连接"} /></h2>{loading ? <div className="mt-5 space-y-3" aria-label={t("正在加载可用模型目录")}><div className="h-4 w-32 animate-pulse rounded bg-indigo-100" /><div className="h-11 animate-pulse rounded-xl bg-white/80" /><div className="h-11 animate-pulse rounded-xl bg-white/80" /><p className="text-xs text-slate-500"><UiText text={"正在加载可用模型目录…"} /></p></div> : <div className="mt-5 rounded-2xl border border-dashed border-indigo-200 bg-white/70 px-4 py-5"><p className="text-sm font-semibold text-slate-700"><UiText text={"暂时无法加载模型目录"} /></p><p className="mt-2 text-xs leading-5 text-slate-500">{t(loadError ?? "可用模型目录为空，请刷新后重试。")}</p><button type="button" onClick={() => void onRetry()} className="mt-4 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50"><UiText text={"重新加载"} /></button></div>}</section>;
}

function CreateProviderForm({ catalog, onCreated }: { catalog: readonly CatalogEntry[]; onCreated: (provider: Provider) => void }) {
  const t = useTranslate();

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

  return <section><div><p className="text-xs leading-5 text-slate-600"><UiText text={"仅支持平台内置的固定官方端点。API Key 只用于加密保存和请求，不会写入地址栏。"} /></p></div><form onSubmit={submit} className="mt-5 space-y-4"><Field label={t("连接名称")}><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required maxLength={80} placeholder={t("例如：我的 OpenAI")} className={`${formFields.field} field`} /></Field><Field label={t("供应商")}><select value={draft.kind} onChange={(event) => chooseKind(event.target.value as ProviderKind)} className={`${formFields.field} field`}>{catalog.map((entry) => <option key={entry.kind} value={entry.kind}>{entry.displayName}</option>)}</select></Field><Field label={t("固定 Base URL")}><input value={definition?.baseUrl ?? ""} readOnly aria-readonly="true" className={`${formFields.field} field bg-slate-100 text-slate-500`} /></Field><Field label={definition?.apiKeyLabel ?? "API Key"}><input type="password" value={draft.apiKey} onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))} required minLength={8} maxLength={512} autoComplete="new-password" className={`${formFields.field} field`} /></Field><p className="rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600"><UiText text={"生成模型或向量模型至少配置一项。"} /></p><ModelField label={t("生成模型（可选）")} value={draft.generationModelId} onChange={(value) => setDraft((current) => ({ ...current, generationModelId: value }))} suggestions={definition?.generationModelSuggestions ?? []} /><ModelField label={t("图片识别模型（可选）")} value={draft.visionModelId} onChange={(value) => setDraft((current) => ({ ...current, visionModelId: value }))} suggestions={definition?.visionModelSuggestions ?? []} disabled={!definition?.supportsVision} /><ModelField label={t("向量模型（可选）")} value={draft.embeddingModelId} onChange={(value) => { setDraft((current) => ({ ...current, embeddingModelId: value, embeddingDimensions: definition?.embeddingModelSuggestions.find((item) => item.id === value)?.dimensions.toString() ?? current.embeddingDimensions })); }} suggestions={definition?.embeddingModelSuggestions.map((item) => item.id) ?? []} disabled={!definition?.supportsEmbeddings} /><Field label={t("向量维度（可选）")}><input type="number" min={8} max={8192} step={1} value={draft.embeddingDimensions} onChange={(event) => setDraft((current) => ({ ...current, embeddingDimensions: event.target.value }))} required={Boolean(draft.embeddingModelId)} disabled={!definition?.supportsEmbeddings || !draft.embeddingModelId} className={`${formFields.field} field disabled:bg-slate-100`} /></Field><button type="submit" disabled={pending} className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">{pending ? t("保存中…") : t("保存个人连接")}</button>{message ? <p role={message.tone === "error" ? "alert" : "status"} className={`rounded-xl px-3 py-2 text-xs leading-5 ${message.tone === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}><UiFeedbackText text={message.text} /></p> : null}</form></section>;
}

function ProviderCard({ provider, catalog, membership, canConfigure, canMaintain, onChanged, onRemoved, onMessage, onReload }: { provider: Provider; catalog: readonly CatalogEntry[]; membership: Membership; canConfigure: boolean; canMaintain: boolean; onChanged: (provider: Provider) => void; onRemoved: (providerId: string) => void; onMessage: (message: Message) => void; onReload: () => Promise<void> }) {
  const { t, language } = useAppearance();

  const definition = getCatalogEntry(catalog, provider.kind);
  const [editing, setEditing] = useState<"configuration" | "key" | null>(null);
  const [operationOpen, setOperationOpen] = useState(false);
  const [operationMessage, setOperationMessage] = useState<Message | null>(null);
  const [draft, setDraft] = useState<PersonalModelDraft | null>(null);
  const [pending, setPending] = useState(false);
  const { confirm, dialog } = useAppConfirmDialog();
  const activeMembership = membership.status === "active";
  const enabled = provider.status !== "disabled" && provider.disabledAt === null;

  function reportMessage(next: Message) {
    setOperationMessage(next);
    onMessage(next);
  }

  function beginEditing(mode: "configuration" | "key") {
    if (draft === null) setOperationMessage(null);
    setDraft((current) => current ?? createPersonalModelEditDraft(provider));
    setEditing(mode);
    setOperationOpen(true);
  }

  function updateDraft(next: Partial<PersonalModelDraft>) {
    setDraft((current) => current === null ? current : { ...current, ...next });
  }

  function clearDraftKey() {
    setDraft((current) => current === null ? current : { ...current, apiKey: "" });
  }

  async function patch(input: Record<string, unknown>, expectedUpdatedAt: string, successText: string) {
    setPending(true);
    setOperationMessage(null);
    try {
      const response = await fetch(`/api/me/ai-providers/${provider.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, expectedUpdatedAt }) });
      if (!response.ok) {
        const staleSnapshot = await isPersonalProviderConflict(response);
        const error = await errorMessage(response, "连接更新失败");
        await onReload();
        if (staleSnapshot && editing !== null) {
          setOperationOpen(false);
          setEditing(null);
          setDraft(null);
          reportMessage({ tone: "error", text: "状态已刷新，请重新打开编辑" });
          return null;
        }
        reportMessage({ tone: "error", text: error, draftRetained: editing !== null });
        return null;
      }
      const payload = await response.json() as { provider: Provider };
      onChanged(payload.provider); reportMessage({ tone: "success", text: successText }); return payload.provider;
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "连接更新失败";
      await onReload();
      reportMessage({ tone: "error", text: error, draftRetained: editing !== null });
      return null;
    } finally { clearDraftKey(); setPending(false); }
  }

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing === null || draft === null || (editing === "configuration" && !canConfigure) || (editing === "key" && !canMaintain)) return;
    if (editing === "configuration" && !hasPersonalModelCapability(draft)) {
      reportMessage({ tone: "error", text: "请至少配置生成模型或向量模型。" });
      return;
    }
    if (editing === "key" && !draft.apiKey) {
      reportMessage({ tone: "error", text: "请输入新的 API Key。" });
      return;
    }
    const input = editing === "key"
      ? createPersonalModelKeyPatch(draft)
      : createPersonalModelConfigurationPatch(draft);
    if (draft.expectedUpdatedAt === undefined) {
      reportMessage({ tone: "error", text: "编辑快照已失效，请重新打开编辑。" });
      return;
    }
    const next = await patch(input, draft.expectedUpdatedAt, editing === "key" ? "API Key 已轮换，请重新测试连接。" : "配置已更新，请重新测试连接。");
    if (next) {
      setOperationOpen(false);
      setEditing(null);
      setDraft(null);
    }
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
    setPending(true); reportMessage({ tone: "info", text: "正在向固定官方端点发送不含用户或项目内容的探针…" });
    try {
      const response = await fetch(`/api/me/ai-providers/${provider.id}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      if (!response.ok) {
        const error = await errorMessage(response, "连接测试失败");
        await onReload();
        reportMessage({ tone: "error", text: error });
        return;
      }
      const payload = await response.json() as { provider: Provider };
      onChanged(payload.provider); reportMessage({ tone: "success", text: "连接测试通过。探针不包含用户或项目内容。" });
    } catch (cause) {
      await onReload();
      reportMessage({ tone: "error", text: cause instanceof Error ? cause.message : "连接测试失败" });
    } finally { setPending(false); }
  }

  async function remove() {
    let current = provider;
    if (current.status !== "disabled" || current.disabledAt === null) {
      const disabled = await patch({ enabled: false }, current.updatedAt, "连接已停用，请继续确认删除。");
      if (!disabled) return;
      current = disabled;
    }
    const result = await confirm({ eyebrow: t("Delete personal connection"), title: `${t("删除“")}${current.name}${t("”？")}`, description: t("删除前已停用连接。删除会移除连接和加密凭据，且不可恢复；如果仍被项目或历史记录引用，服务端会拒绝操作。"), inputLabel: `${t("输入连接名称“")}${current.name}${t("”以确认")}`, requiredValue: current.name, inputPlaceholder: current.name, confirmLabel: t("确认删除"), tone: "danger", maxLength: 80 });
    if (!result.confirmed) return;
    setPending(true);
    try {
      const response = await fetch(`/api/me/ai-providers/${current.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationName: result.value, expectedUpdatedAt: current.updatedAt }) });
      if (!response.ok) {
        const error = await errorMessage(response, "连接删除失败");
        await onReload();
        reportMessage({ tone: "error", text: error });
        return;
      }
      onRemoved(current.id);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "连接删除失败";
      await onReload();
      reportMessage({ tone: "error", text: error });
    }
    finally { setPending(false); }
  }

  return <article className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5">{dialog}<div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-base font-semibold text-slate-900">{provider.name}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${provider.status === "verified" ? "bg-emerald-100 text-emerald-700" : provider.status === "error" ? "bg-rose-100 text-rose-700" : provider.status === "disabled" ? "bg-slate-200 text-slate-600" : "bg-amber-100 text-amber-700"}`}>{t(statusLabels[provider.status] ?? provider.status)}</span></div><p className="mt-2 text-xs text-slate-500">{definition?.displayName ?? provider.kind} <UiText text={" · 固定端点 "} />{provider.baseUrl}</p></div><div className="text-right text-xs text-slate-400"><p>Key ····{provider.credential.maskedSuffix}</p><p className="mt-1"><UiText text={"更新于 "} />{formatDate(provider.updatedAt, language)}</p></div></div>
    {provider.lastErrorCode ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700"><UiText text={"最近错误："} />{provider.lastErrorCode}{t(provider.lastErrorCode === "AI_PROVIDER_IN_USE" ? "。该连接仍可能被项目或历史记录引用；清理活动路由或撤销委托后若仍失败，请保持连接停用并稍后重试。" : "。修改配置后请重新测试。")}</p> : null}
    <dl className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3"><div><dt className="text-slate-400"><UiText text={"生成模型"} /></dt><dd className="mt-1 break-all font-medium">{provider.defaultGenerationModelId ?? t("未配置")}</dd></div><div><dt className="text-slate-400"><UiText text={"图片模型"} /></dt><dd className="mt-1 break-all font-medium">{provider.defaultVisionModelId ?? t("未配置")}</dd></div><div><dt className="text-slate-400"><UiText text={"向量模型"} /></dt><dd className="mt-1 break-all font-medium">{provider.defaultEmbeddingModelId ? `${provider.defaultEmbeddingModelId}${provider.embeddingDimensions ? ` · ${provider.embeddingDimensions}${t(" 维")}` : ""}` : t("未配置")}</dd></div></dl>
    <div className="mt-4"><ScopeEvidenceCard title={t("个人模型连接边界")} evidence={{ scope: t("个人连接"), owner: t("当前账户"), payer: t("个人连接所有者承担费用"), affectedProjects: t("尚未取得项目委托证据；仅在项目权限与明确委托生效后影响，不展示项目标识或数量"), latestSuccess: provider.lastTestedAt ? `${t("最近连接测试：")}${formatDate(provider.lastTestedAt, language)}` : t("尚未完成连接测试") }} /></div>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2">
        <OperationPanel title={t(editing === "key" ? "安全轮换个人模型 API Key" : "编辑个人模型配置")} triggerLabel={t("管理配置")} description={t("编辑模型配置或安全轮换 API Key。关闭面板会保留当前草稿。")} open={operationOpen} onOpenChange={(open) => { if (open && draft === null) beginEditing(canConfigure ? "configuration" : "key"); else setOperationOpen(open); }} disabled={pending || (!canConfigure && !canMaintain)}>
          {editing !== null && draft !== null && (editing === "configuration" ? canConfigure : canMaintain) ? <div className="space-y-4">
            <div className="flex flex-wrap gap-2" role="group" aria-label={t("连接维护操作")}>
              {canConfigure ? <button type="button" onClick={() => setEditing("configuration")} className={`rounded-lg px-3 py-2 text-xs font-semibold ${editing === "configuration" ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-700"}`}><UiText text={"编辑配置"} /></button> : null}
              {canMaintain ? <button type="button" onClick={() => setEditing("key")} className={`rounded-lg px-3 py-2 text-xs font-semibold ${editing === "key" ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-700"}`}><UiText text={"轮换 Key"} /></button> : null}
            </div>
            <form onSubmit={saveConfiguration} className="grid gap-3 sm:grid-cols-2">
              {editing === "configuration" ? <><Field label={t("连接名称")}><input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} required maxLength={80} className={`${formFields.field} field`} /></Field><Field label={t("固定 Base URL")}><input value={provider.baseUrl} readOnly aria-readonly="true" className={`${formFields.field} field bg-slate-100 text-slate-500`} /></Field><p className="rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600 sm:col-span-2"><UiText text={"生成模型或向量模型至少配置一项。"} /></p><ModelField label={t("生成模型（可选）")} value={draft.generationModelId} onChange={(value) => updateDraft({ generationModelId: value })} suggestions={definition?.generationModelSuggestions ?? []} /><ModelField label={t("图片识别模型（可选）")} value={draft.visionModelId} onChange={(value) => updateDraft({ visionModelId: value })} suggestions={definition?.visionModelSuggestions ?? []} disabled={!definition?.supportsVision} /><ModelField label={t("向量模型（可选）")} value={draft.embeddingModelId} onChange={(value) => updateDraft({ embeddingModelId: value, embeddingDimensions: definition?.embeddingModelSuggestions.find((item) => item.id === value)?.dimensions.toString() ?? draft.embeddingDimensions })} suggestions={definition?.embeddingModelSuggestions.map((item) => item.id) ?? []} disabled={!definition?.supportsEmbeddings} /><Field label={t("向量维度（可选）")}><input type="number" min={8} max={8192} step={1} value={draft.embeddingDimensions} onChange={(event) => updateDraft({ embeddingDimensions: event.target.value })} required={Boolean(draft.embeddingModelId)} disabled={!definition?.supportsEmbeddings || !draft.embeddingModelId} className={`${formFields.field} field disabled:bg-slate-100`} /></Field></> : <div className="sm:col-span-2 rounded-xl bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600"><UiText text={"当前资格只允许安全维护。轮换 API Key 不会恢复测试、启用或调用能力。"} /></div>}
              {editing === "key" ? <Field label={t("新的 API Key")}><input type="password" value={draft.apiKey} onChange={(event) => updateDraft({ apiKey: event.target.value })} autoComplete="new-password" placeholder={t("输入新的 API Key")} required minLength={8} maxLength={512} className={`${formFields.field} field`} /></Field> : null}
              <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-2"><button type="submit" disabled={pending} className="app-action-button app-action-button--compact rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{pending ? t("保存中…") : editing === "key" ? t("轮换 Key") : t("保存配置")}</button><button type="button" onClick={() => { setOperationOpen(false); setEditing(null); setDraft(null); }} className="app-action-button app-action-button--compact rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600"><UiText text={"放弃草稿"} /></button></div>
              {operationMessage ? <p role={operationMessage.tone === "error" ? "alert" : "status"} className={`text-sm sm:col-span-2 ${operationMessage.tone === "error" ? "text-rose-700" : "text-slate-700"}`}>{operationMessage.tone === "error" ? <UiErrorText text={operationMessage.text} /> : <UiFeedbackText text={operationMessage.text} />}{operationMessage.draftRetained ? <><br /><UiText text="状态已刷新，非敏感字段草稿已保留；如填写过 API Key，需重新输入。若版本已变化，请放弃草稿后重新打开编辑。" /></> : null}</p> : null}
            </form>
          </div> : null}
        </OperationPanel>
        {activeMembership ? <button type="button" onClick={() => void testConnection()} disabled={pending || !enabled} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{pending ? t("处理中…") : t("测试连接")}</button> : null}
      </div>
      <div className="flex flex-wrap gap-2">{provider.status === "disabled" ? activeMembership ? <button type="button" onClick={() => void toggleEnabled()} disabled={pending} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"><UiText text={"重新启用"} /></button> : null : <button type="button" onClick={() => void toggleEnabled()} disabled={pending} className="rounded-lg px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"><UiText text={"停用"} /></button>}<button type="button" onClick={() => void remove()} disabled={pending} className="rounded-lg px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"><UiText text={"删除"} /></button></div>
    </div>
    {provider.status === "disabled" ? <p className="mt-3 text-xs leading-5 text-slate-500"><UiText text={"连接已停用。"} />{t(activeMembership ? "会员有效时可重新启用，启用后请重新测试。" : "当前资格不能重新启用，只能轮换 Key、停用或删除。")}</p> : null}
  </article>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const t = useTranslate();
  const help = label === t("API Key") || label === t("新的 API Key")
    ? "从所选供应商的控制台创建你自己的 API Key。示例仅说明格式，请勿使用他人的密钥；保存后在连接卡片中测试。"
    : label === t("固定 Base URL")
      ? "这里显示平台内置的供应商官方地址，由系统固定，无法手动改成其他服务。"
      : label.includes(t("模型"))
        ? "填写供应商提供的模型 ID，例如供应商模型目录中的标识；先保存连接，再测试，最后在项目中授权使用。向量维度要与所选向量模型一致。"
        : label === t("供应商")
          ? "先选择你已开通账号的供应商，再填写该供应商的 API Key 和模型 ID。"
          : null;
  return <div className="relative"><label className="block text-xs font-semibold text-slate-700">{label}{children}</label>{help ? <span className="absolute right-0 top-0"><HelpTooltip label={label}>{t(help)}</HelpTooltip></span> : null}</div>;
}

function ModelField({ label, value, onChange, suggestions, disabled = false }: { label: string; value: string; onChange: (value: string) => void; suggestions: readonly string[]; disabled?: boolean }) {
  const listId = `model-suggestions-${label.replace(/[^a-z0-9]+/giu, "-")}`;
  return <Field label={label}><input value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} list={listId} className={`${formFields.field} field disabled:bg-slate-100`} /><datalist id={listId}>{suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}</datalist></Field>;
}
