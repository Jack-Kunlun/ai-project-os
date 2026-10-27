"use client";
import { UiErrorText, UiFeedbackText } from "@/components/ui-error-text";


import formFields from "@/components/model-form-fields.module.css";

import { UiText, useAppearance } from "@/components/appearance-provider";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { AppHeader } from "@/components/app-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { AdminPageHeader } from "@/components/admin-page-header";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { modalBackdropClassName, modalFooterClassName, modalHeaderClassName, modalSurfaceClassName } from "@/components/modal-styles";
import { OperationPanel } from "@/components/operation-panel";
import { PlatformOperationAssignments } from "./platform-operation-assignments";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { ShellIcon } from "@/components/shell-icon";
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

type ProbeBudgetSummary = Readonly<{
  version: number;
  status: "active" | "scheduled" | "expired";
  unitLimit: number;
  reservedUnits: number;
  settledUnits: number;
  heldUnits: number;
  availableUnits: number;
  startsAt: string;
  expiresAt: string;
}>;

async function readError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function dateLabel(value: string | null, language: "zh-CN" | "en", t: (text: string) => string): string {
  return value === null ? t("尚未验证") : new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function entityCountLabel(count: number, singularMessage: string, pluralMessage: string, t: (text: string) => string): string {
  return count === 1 ? t(singularMessage) : `${count} ${t(pluralMessage)}`;
}

function describeProviderCheck(check: ProviderCheck, t: (text: string) => string): string {
  const messages: string[] = [];
  if (check.attempt.capabilities.generation === "passed") messages.push(t("生成连接通过"));
  if (check.attempt.capabilities.embedding === "passed") messages.push(`${t("向量连接通过")}${check.attempt.embeddingDimensions === null ? "" : `（${check.attempt.embeddingDimensions} ${t("维")}）`}`);
  if (check.attempt.capabilities.vision === "passed") messages.push(t("图片识别连接通过"));
  if (messages.length === 0) {
    const code = check.attempt.safeErrorCode;
    const detail = t(code === "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED"
      ? "尚未设置模型测试额度，请先设置最大测试次数和有效期。"
      : code === "PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED"
        ? "模型测试次数不足；请设置新的有效周期后重试。"
        : code === "PLATFORM_PROVIDER_PROBE_PROVIDER_AUTH_FAILED"
          ? "供应商拒绝了凭据，请检查 API Key 是否有效并重新保存。"
          : code === "PLATFORM_PROVIDER_PROBE_PROVIDER_RATE_LIMITED"
            ? "供应商触发限流，请稍后再试或检查供应商配额。"
            : code === "PLATFORM_PROVIDER_PROBE_PROVIDER_REJECTED"
              ? "供应商拒绝了当前模型或请求，请检查模型 ID 和能力配置。"
              : code === "PLATFORM_PROVIDER_PROBE_PROVIDER_INVALID_RESPONSE"
                ? "供应商返回了无法识别的响应，请检查模型 ID；DeepSeek 连接测试已关闭思考模式。"
                : code === "PLATFORM_PROVIDER_PROBE_PROVIDER_TIMEOUT"
                  ? "供应商响应超时，请检查网络或供应商状态。"
                  : code === "PLATFORM_PROVIDER_PROBE_PROVIDER_VISION_UNSUPPORTED"
                    ? "当前图片识别模型不支持该探测协议，请改用供应商目录中的图片模型。"
                    : code === "PLATFORM_PROVIDER_PROBE_PROVIDER_EMBEDDING_UNSUPPORTED"
                      ? "当前供应商不支持向量探测，请关闭向量模型或更换供应商。"
                      : "连接测试未通过，请检查模型配置和供应商状态后重试。");
    return `${detail}${code ? ` (${t("安全码")}: ${code})` : ""}`;
  }
  return messages.join(" · ");
}

function requiredProbeUnits(provider: Provider, catalog?: ProviderCatalogEntry): number {
  let units = provider.defaultGenerationModelId === null ? 0 : 1;
  if (provider.defaultEmbeddingModelId !== null && provider.embeddingDimensions !== null) units += 1;
  if (provider.defaultVisionModelId !== null && catalog?.supportsVision === true) units += 1;
  return units;
}

function probeBudgetMessage(budget: ProbeBudgetSummary | null, requiredUnits: number, t: (text: string) => string): string | null {
  if (requiredUnits === 0) return t("请先为该连接配置至少一个可测试模型，再执行连接测试。");
  if (budget === null) return t("连接测试需要模型测试额度，请先设置最大测试次数和有效期。");
  if (budget.status === "scheduled") return t("模型测试额度尚未生效，请检查开始时间。");
  if (budget.status === "expired") return t("模型测试额度已过期，请设置新的有效周期。");
  if (budget.availableUnits < requiredUnits) return t("模型测试次数不足，请减少本次测试模型或设置新的测试额度。");
  return null;
}

const statusLabel = {
  configured: "待验证",
  verified: "已验证",
  error: "验证失败",
  disabled: "已停用",
} as const;

export function SettingsClient({ username, canManageProviders, activeMembership, membershipStatus, adminMode = false }: { username: string; canManageProviders: boolean; activeMembership: boolean; membershipStatus: "active" | "expired" | "revoked" | "none"; adminMode?: boolean }) {
  const { t } = useAppearance();
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [operationsBusy, setOperationsBusy] = useState(false);
  const [loading, setLoading] = useState(canManageProviders);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const createTriggerRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    if (!canManageProviders) {
      return;
    }
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [canManageProviders, reload]);

  function handleProviderCreated(provider: Provider) {
    setProviders((current) => [...current, provider]);
    setCreateOpen(false);
  }

  function handleProviderChanged(next: Provider) {
    setProviders((current) => current.map((entry) => entry.id === next.id ? next : entry));
  }

  function handleProviderRemoved(providerId: string) {
    setProviders((current) => current.filter((entry) => entry.id !== providerId));
  }

  const content = (
    <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
        <AdminPageHeader title="模型与能力" description="先验证供应商连接，再勾选需要的能力，一次测试并启用。测试额度按请求次数计量。" actions={canManageProviders ? <button ref={createTriggerRef} disabled={operationsBusy} type="button" onClick={() => setCreateOpen(true)} className="inline-flex min-h-10 items-center rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"><UiText text={"新增供应商"} /></button> : undefined} />

        {!canManageProviders ? <section className="mt-7 border-t border-slate-200 pt-6"><h2 className="text-xl font-semibold"><UiText text={"平台模型由系统管理员管理"} /></h2><p className="mt-3 text-sm leading-7 text-slate-600"><UiText text={"普通用户可以使用平台额度和平台默认模型，不会请求或查看平台供应商接口。"} />{activeMembership ? t("当前会员有效，你可以在“我的空间”配置自己的模型连接。") : membershipStatus === "expired" ? t("会员资格已到期；重新获得资格后才可配置个人模型。") : membershipStatus === "revoked" ? t("会员资格已撤销；重新获得资格后才可配置个人模型。") : t("如需配置个人模型，请先完成会员申请。")}</p>{activeMembership ? <a href="/personal/models" className="mt-5 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white"><UiText text={"配置个人模型"} /></a> : null}</section> : null}
        {canManageProviders && error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><UiErrorText text={error} /></div> : null}

        {canManageProviders ? <fieldset disabled={operationsBusy} className="mt-5 min-w-0 space-y-4">
          <div className="flex items-end justify-between px-1">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400"><UiText text={"平台供应商"} /></p>
              <h2 className="mt-2 text-xl font-semibold"><UiText text={"供应商连接"} /></h2>
            </div>
            <span className="text-xs text-slate-400">{loading ? t("读取中…") : entityCountLabel(providers.length, "1 个供应商", "个供应商", t)}</span>
          </div>
          {loading ? <div className="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500"><UiText text={"读取中…"} /></div> : providers.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center text-sm text-slate-500"><UiText text={"尚未配置供应商。"} /><button type="button" onClick={() => setCreateOpen(true)} className="ml-1 font-semibold text-indigo-700 underline underline-offset-2"><UiText text={"新增供应商"} /></button></div>
          ) : <div role="table" aria-label={t("供应商连接")} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div role="rowgroup" className="hidden border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-500 md:block">
              <div role="row" className="grid grid-cols-[minmax(0,1.25fr)_minmax(6rem,.7fr)_minmax(0,1.5fr)_minmax(8rem,.9fr)_auto] items-center gap-4">
                <span role="columnheader"><UiText text={"供应商"} /></span><span role="columnheader"><UiText text={"连接状态"} /></span><span role="columnheader"><UiText text={"可用模型"} /></span><span role="columnheader"><UiText text={"最近测试"} /></span><span role="columnheader" className="sr-only"><UiText text={"操作"} /></span>
              </div>
            </div>
            <div role="rowgroup" className="divide-y divide-slate-200">
              {providers.map((provider) => <ProviderCard key={provider.id} provider={provider} catalog={catalog.find((entry) => entry.kind === provider.kind)} onChanged={handleProviderChanged} onRemoved={handleProviderRemoved} onProbeFinished={reload} />)}
            </div>
          </div>}
        </fieldset> : null}

        {canManageProviders ? <PlatformOperationAssignments providers={providers} onBusyChange={setOperationsBusy} /> : null}

        {canManageProviders && createOpen ? <ProviderCreateDialog open catalog={catalog} onCreated={handleProviderCreated} onClose={() => setCreateOpen(false)} restoreFocusRef={createTriggerRef} /> : null}
    </div>
  );
  if (adminMode) return content;
  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="settings" /><AdminPageFrame active="models" showSidebar={false}>{content}</AdminPageFrame></main>;
}

const dialogFocusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function ProviderCreateDialog({
  open,
  catalog,
  onCreated,
  onClose,
  restoreFocusRef,
}: {
  open: boolean;
  catalog: ProviderCatalogEntry[];
  onCreated: (provider: Provider) => void;
  onClose: () => void;
  restoreFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useAppearance();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    pendingRef.current = pending;
    onCloseRef.current = onClose;
  }, [onClose, pending]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreFocus = restoreFocusRef.current;
    const originalBodyOverflow = document.body.style.overflow;
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!pendingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(dialogFocusableSelector);
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = originalBodyOverflow;
      if (previousFocus) previousFocus.focus();
      else restoreFocus?.focus();
    };
  }, [open, restoreFocusRef]);

  if (!open) return null;
  const close = () => {
    if (!pending) onClose();
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden p-3 sm:p-6" role="presentation">
    <button type="button" aria-label={t("关闭新增供应商")} tabIndex={-1} onClick={close} className={`absolute inset-0 ${modalBackdropClassName}`} />
    {/* Keep the dialog compact on tall screens and contained on short screens. */}
    <div ref={dialogRef} data-operation-surface="modal" role="dialog" aria-modal="true" aria-labelledby="provider-create-dialog-title" aria-describedby="provider-create-dialog-description" className={`relative z-10 flex max-h-[min(44rem,calc(100dvh-1.5rem))] w-full max-w-6xl flex-col overflow-hidden rounded-2xl sm:max-h-[min(44rem,calc(100dvh-3rem))] ${modalSurfaceClassName}`}>
      <header data-operation-header className={`${modalHeaderClassName} flex items-start justify-between gap-4 px-5 py-4 sm:px-6`}>
        <div>
          <h2 id="provider-create-dialog-title" className="text-lg font-semibold text-slate-950"><UiText text={"新增供应商"} /></h2>
          <p id="provider-create-dialog-description" className="mt-2 text-xs leading-5 text-slate-600"><UiText text={"使用官方固定端点先测试未保存凭据，测试成功后才能保存为已验证连接。"} /></p>
        </div>
        <button ref={closeRef} type="button" aria-label={t("关闭新增供应商")} onClick={close} disabled={pending} className="app-icon-button"><ShellIcon name="close" className="app-icon--control" /></button>
      </header>
      <ProviderCreateForm catalog={catalog} onCreated={onCreated} onPendingChange={setPending} />
    </div>
  </div>;
}

function ProviderCreateForm({
  catalog,
  onCreated,
  onPendingChange,
}: {
  catalog: ProviderCatalogEntry[];
  onCreated: (provider: Provider) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const { t } = useAppearance();
  const [kind, setKind] = useState<ProviderKind>("deepseek");
  const definition = useMemo(() => catalog.find((entry) => entry.kind === kind), [catalog, kind]);
  const [name, setName] = useState("DeepSeek");
  const [apiKey, setApiKey] = useState("");
  const [generationModelId, setGenerationModelId] = useState("deepseek-flash");
  const [visionModelId, setVisionModelId] = useState("deepseek-flash");
  const [embeddingEnabled, setEmbeddingEnabled] = useState(false);
  const [embeddingModelId, setEmbeddingModelId] = useState("");
  const [embeddingDimensions, setEmbeddingDimensions] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [proof, setProof] = useState<{ draftProbeId: string; createRequestKey: string } | null>(null);

  function clearProof() {
    setProof(null);
  }

  function chooseKind(nextKind: ProviderKind) {
    clearProof();
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

  async function testConnection(): Promise<void> {
    const createRequestKey = crypto.randomUUID();
    setPending(true);
    onPendingChange(true);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/providers/draft-probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientRequestKey: createRequestKey,
          name,
          kind,
          apiKey,
          generationModelId: generationModelId || null,
          visionModelId: definition?.supportsVision && visionModelId ? visionModelId : null,
          embeddingModelId: embeddingEnabled ? embeddingModelId : null,
          embeddingDimensions: embeddingEnabled ? Number(embeddingDimensions) : null,
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "供应商连接测试失败"));
      const payload = await response.json() as { draftProbeId: string | null; attempt: { safeErrorCode: string | null } };
      if (payload.draftProbeId === null) throw new Error(payload.attempt.safeErrorCode ?? "供应商连接测试未通过");
      setProof({ draftProbeId: payload.draftProbeId, createRequestKey });
      setMessage("真实连接测试通过；现在可以保存为已验证连接。 ");
    } catch (testError) {
      setProof(null);
      setMessage(testError instanceof Error ? testError.message : "供应商连接测试失败");
    } finally {
      setPending(false);
      onPendingChange(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (proof === null) {
      setMessage("请先完成真实连接测试，再保存连接。");
      return;
    }
    setPending(true);
    onPendingChange(true);
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
          draftProbeId: proof.draftProbeId,
          createRequestKey: proof.createRequestKey,
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "供应商创建失败"));
      const payload = await response.json() as { provider: Provider };
      onCreated(payload.provider);
      setApiKey("");
      setProof(null);
      setMessage("连接已保存并标记为已验证。 ");
    } catch (submitError) {
      setMessage(submitError instanceof Error ? submitError.message : "供应商创建失败");
    } finally {
      setPending(false);
      onPendingChange(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col text-slate-900">
      {/* The body owns overflow so the header and action footer stay available while fields scroll. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4 sm:px-6">
        <Field compact label="供应商">
          <select value={kind} onChange={(event) => chooseKind(event.target.value as ProviderKind)} className={`${formFields.lightField} light-field`}>
            {catalog.map((entry) => <option key={entry.kind} value={entry.kind}>{t(entry.displayName)}</option>)}
          </select>
        </Field>
        <Field compact label="连接名称"><input value={name} onChange={(event) => { clearProof(); setName(event.target.value); }} maxLength={80} required className={`${formFields.lightField} light-field`} /></Field>
        <Field compact label={definition?.apiKeyLabel ?? "API Key"}><input type="password" value={apiKey} onChange={(event) => { clearProof(); setApiKey(event.target.value); }} autoComplete="new-password" maxLength={512} required className={`${formFields.lightField} light-field`} /></Field>
        <Field compact label="生成模型（可选）"><input list={`generation-${kind}`} value={generationModelId} onChange={(event) => { clearProof(); setGenerationModelId(event.target.value); }} className={`${formFields.lightField} light-field`} /></Field>
        <datalist id={`generation-${kind}`}>{definition?.generationModelSuggestions.map((id) => <option key={id} value={id} />)}</datalist>
        {definition?.supportsVision ? <><Field compact label="图片识别模型（可选）"><input list={`vision-${kind}`} value={visionModelId} onChange={(event) => { clearProof(); setVisionModelId(event.target.value); }} className={`${formFields.lightField} light-field`} /></Field><datalist id={`vision-${kind}`}>{definition.visionModelSuggestions.map((id) => <option key={id} value={id} />)}</datalist></> : null}
        {definition?.supportsEmbeddings ? (
          <>
            <label className="mt-3 flex items-center gap-3 text-sm text-slate-700"><input type="checkbox" checked={embeddingEnabled} onChange={(event) => { clearProof(); setEmbeddingEnabled(event.target.checked); }} /> <UiText text={"同时配置向量模型"} /></label>
            {embeddingEnabled ? <div className="grid grid-cols-[1fr_7rem] gap-3"><Field compact label="向量模型"><input list={`embedding-${kind}`} value={embeddingModelId} onChange={(event) => { clearProof(); chooseEmbeddingModel(event.target.value); }} required className={`${formFields.lightField} light-field`} /></Field><Field compact label="维度"><input type="number" min={8} max={8192} value={embeddingDimensions} onChange={(event) => { clearProof(); setEmbeddingDimensions(event.target.value); }} required className={`${formFields.lightField} light-field`} /></Field></div> : null}
            <datalist id={`embedding-${kind}`}>{definition.embeddingModelSuggestions.map((item) => <option key={item.id} value={item.id} />)}</datalist>
          </>
        ) : <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900"><UiText text={"DeepSeek 当前作为生成供应商使用；语义索引需为项目另选 OpenAI、Qwen 或 GLM。"} /></p>}
        <details className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">
          <summary className="cursor-pointer font-semibold text-slate-800"><UiText text={"能力说明与推荐模型"} /></summary>
          <p className="mt-1"><UiText text={"生成模型用于文本、摘要和计划；图片识别模型可选，留空即关闭；向量模型可选，维度必须匹配，切换模型或维度后需重建相关索引。API Key 只在服务端加密保存；连接测试按实际模型类型使用 1–3 次模型测试额度。"} /></p>
          {definition ? <div className="mt-3 space-y-1 text-slate-500"><p><UiText text={"生成推荐："} />{definition.generationModelSuggestions.join("、") || "暂无"}</p><p><UiText text={"图片推荐："} />{definition.visionModelSuggestions.join("、") || "暂无"}</p><p><UiText text={"向量推荐："} />{definition.embeddingModelSuggestions.map((item) => `${item.id}（${item.dimensions} 维）`).join("、") || "暂无"}</p></div> : null}
        </details>
      </div>
      <footer className={`${modalFooterClassName} grid shrink-0 gap-3 px-5 py-4 sm:grid-cols-2 sm:px-6`}>
        {message ? <p className="text-xs leading-5 text-slate-600 sm:col-span-2" role="status"><UiFeedbackText text={message} /></p> : null}
        <button type="button" onClick={() => void testConnection()} disabled={pending || catalog.length === 0 || apiKey.trim().length < 8} className="rounded-md border border-indigo-200 px-4 py-3 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50">{pending ? t("处理中…") : t("测试连接")}</button><button disabled={pending || catalog.length === 0 || proof === null} className="rounded-md bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{pending ? t("保存中…") : t("保存连接")}</button>
      </footer>

    </form>
  );
}

function Field({ label, children, compact = false }: { label: string; children: React.ReactNode; compact?: boolean }) {
  const t = useAppearance().t;
  return <label className={`${compact ? "mt-3 text-xs" : "mt-5 text-sm"} block font-medium text-slate-700`}>{t(label)}{children}</label>;
}

function ProviderCard({ provider, catalog, onChanged, onRemoved, onProbeFinished }: { provider: Provider; catalog?: ProviderCatalogEntry; onChanged: (provider: Provider) => void; onRemoved: (providerId: string) => void; onProbeFinished: () => Promise<void> }) {
  const { language, t } = useAppearance();
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<ProviderCheck | null>(null);
  const [name, setName] = useState(provider.name);
  const [generationModelId, setGenerationModelId] = useState(provider.defaultGenerationModelId ?? "");
  const [visionModelId, setVisionModelId] = useState(provider.defaultVisionModelId ?? "");
  const [embeddingModelId, setEmbeddingModelId] = useState(provider.defaultEmbeddingModelId ?? "");
  const [embeddingDimensions, setEmbeddingDimensions] = useState(provider.embeddingDimensions ? String(provider.embeddingDimensions) : "");
  const [apiKey, setApiKey] = useState("");
  const [probeBudgetHref, setProbeBudgetHref] = useState<string | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();
  const disableBlocked = provider.status !== "disabled" && provider._count.platformDefaultAiRoutes > 0;
  const disableBlockReasons = [
    provider._count.platformDefaultAiRoutes > 0 ? "活动默认路由" : null,
  ].filter((reason): reason is string => reason !== null).map(t).join("、");
  const disableBlockSeparator = language === "en" ? " " : "";
  const disableBlockTitle = `${t("无法停用：")}${disableBlockSeparator}${disableBlockReasons}${disableBlockSeparator}${t("仍在使用该连接")}`;
  const providerDisplayName = catalog?.displayName ? t(catalog.displayName) : provider.kind;

  async function testConnection() {
    setTesting(true);
    setMessage(null);
    setCheckResult(null);
    setProbeBudgetHref(null);
    try {
      const budgetResponse = await fetch("/api/admin/platform-provider-probe/budget", { cache: "no-store" });
      if (!budgetResponse.ok) throw new Error(await readError(budgetResponse, "测试额度读取失败"));
      const budgetPayload = await budgetResponse.json() as { budget: ProbeBudgetSummary | null };
      const budgetMessage = probeBudgetMessage(budgetPayload.budget, requiredProbeUnits(provider, catalog), t);
      if (budgetMessage !== null) {
        setMessage(budgetMessage);
        if (requiredProbeUnits(provider, catalog) > 0) setProbeBudgetHref("/admin/operations/probes");
        return;
      }
      const clientRequestKey = globalThis.crypto.randomUUID();
      const response = await fetch(`/api/settings/providers/${provider.id}/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestKey, expectedConfigurationVersion: provider.configurationVersion }),
      });
      if (!response.ok) throw new Error(await readError(response, "连接测试失败"));
      const payload = await response.json() as ProviderCheck;
      await onProbeFinished();
      setCheckResult(payload);
    } catch (testError) {
      setCheckResult(null);
      setMessage(testError instanceof Error ? testError.message : "连接测试失败");
    } finally {
      setTesting(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setCheckResult(null);
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
    setCheckResult(null);
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
    const confirmation = await confirm({ eyebrow: t("平台供应商"), title: `${t("永久删除")}“${provider.name}”？`, description: t("连接配置和加密凭据都会被删除，且不可恢复。有关联项目路由或审计记录时，服务端会拒绝操作。"), inputLabel: `${t("输入连接名称")}“${provider.name}”${t("以确认")}`, requiredValue: provider.name, confirmLabel: t("确认永久删除"), tone: "danger", maxLength: 120 });
    if (!confirmation.confirmed) return;
    const confirmationName = confirmation.value;
    setPending(true);
    setMessage(null);
    setCheckResult(null);
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

  const configuredModels = [...new Set([provider.defaultGenerationModelId, provider.defaultVisionModelId, provider.defaultEmbeddingModelId].filter((modelId): modelId is string => Boolean(modelId)))];

  return (
    <><div role="row" data-provider-id={provider.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 px-4 py-4 md:grid-cols-[minmax(0,1.25fr)_minmax(6rem,.7fr)_minmax(0,1.5fr)_minmax(8rem,.9fr)_auto] md:items-center md:gap-4 md:py-3">
      <div role="cell" className="min-w-0"><h3 className="break-words font-semibold text-slate-900">{provider.name}</h3><p className="mt-1 text-xs text-slate-500">{providerDisplayName}<span aria-hidden="true"> · </span>{provider.kind}</p></div>
      <div role="cell" className="justify-self-end md:justify-self-start"><span className={`inline-flex min-h-6 items-center rounded-full px-2.5 py-1 text-xs font-semibold ${provider.status === "verified" ? "bg-emerald-50 text-emerald-700" : provider.status === "error" ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-600"}`}>{t(statusLabel[provider.status])}</span></div>
      <div role="cell" className="col-span-2 min-w-0 text-xs leading-5 md:col-span-1"><span className="font-medium text-slate-700">{entityCountLabel(configuredModels.length, "1 个模型", "个模型", t)}</span>{configuredModels.length ? <span className="mt-1 block break-words text-slate-500">{configuredModels.join(" · ")}</span> : <span className="mt-1 block text-slate-400"><UiText text={"未配置"} /></span>}</div>
      <div role="cell" className="text-xs text-slate-500">{dateLabel(provider.lastTestedAt, language, t)}</div>
      <div role="cell" className="col-span-2 flex justify-end md:col-span-1 md:justify-start"><OperationPanel title={`${provider.name} · ${t("供应商连接")}`} translateTitle={false} triggerLabel="管理连接" variant="drawer">
        <div className="space-y-5">
          <dl className="grid gap-3 rounded-2xl bg-slate-50 p-4 text-xs sm:grid-cols-2"><div><dt className="text-slate-400"><UiText text={"供应商"} /></dt><dd className="mt-1 font-medium text-slate-700">{providerDisplayName} · {provider.kind}</dd></div><div><dt className="text-slate-400"><UiText text={"连接状态"} /></dt><dd className="mt-1 font-medium text-slate-700">{t(statusLabel[provider.status])}</dd></div><div><dt className="text-slate-400"><UiText text={"Key 尾号"} /></dt><dd className="mt-1 font-medium text-slate-700">{provider.credential.maskedSuffix}</dd></div><div><dt className="text-slate-400"><UiText text={"配置版本"} /></dt><dd className="mt-1 font-medium text-slate-700">{provider.configurationVersion}</dd></div><div><dt className="text-slate-400"><UiText text={"活动默认路由"} /></dt><dd className="mt-1 font-medium text-slate-700">{provider._count.platformDefaultAiRoutes}</dd></div><div><dt className="text-slate-400"><UiText text={"最近测试"} /></dt><dd className="mt-1 font-medium text-slate-700">{dateLabel(provider.lastTestedAt, language, t)}</dd></div></dl>
          <div className="flex flex-wrap gap-2"><OperationPanel title={`${t("编辑供应商：")}${provider.name}`} translateTitle={false} triggerLabel="编辑" description="修改连接模型和凭据。保存后配置需要重新执行连接测试。" open={editing} onOpenChange={setEditing}><form onSubmit={save} className="grid gap-4 sm:grid-cols-2"><EditField label="连接名称"><input value={name} onChange={(event) => setName(event.target.value)} required className={`${formFields.editField} edit-field`} /></EditField><EditField label="生成模型（可选）"><input value={generationModelId} onChange={(event) => setGenerationModelId(event.target.value)} className={`${formFields.editField} edit-field`} /></EditField>{catalog?.supportsVision ? <EditField label="图片识别模型（可选）"><input value={visionModelId} onChange={(event) => setVisionModelId(event.target.value)} className={`${formFields.editField} edit-field`} /></EditField> : null}{catalog?.supportsEmbeddings ? <><EditField label="向量模型（留空即关闭）"><input value={embeddingModelId} onChange={(event) => setEmbeddingModelId(event.target.value)} className={`${formFields.editField} edit-field`} /></EditField><EditField label="向量维度"><input type="number" value={embeddingDimensions} onChange={(event) => setEmbeddingDimensions(event.target.value)} disabled={!embeddingModelId} className={`${formFields.editField} edit-field`} /></EditField></> : null}<EditField label="替换 API Key（可选）"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" className={`${formFields.editField} edit-field`} /></EditField><div className="flex items-end gap-2"><button disabled={pending} className="min-h-10 rounded-xl bg-indigo-600 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50">{pending ? t("保存中…") : t("保存变更")}</button><button type="button" onClick={() => void toggleEnabled()} disabled={pending || disableBlocked} title={disableBlocked ? disableBlockTitle : undefined} className="min-h-10 rounded-xl border border-slate-200 px-4 py-3 text-xs font-semibold text-slate-600 disabled:opacity-40">{t(provider.status === "disabled" ? "重新启用" : "停用连接")}</button></div>{disableBlocked ? <p className="text-xs leading-5 text-amber-700 sm:col-span-2"><UiText text={"无法停用："} />{disableBlockSeparator}{disableBlockReasons}{disableBlockSeparator}<UiText text={"仍在使用该连接。请先移除项目路由或停用活动能力。"} /></p> : null}{message ? <p role="status" className="text-xs leading-5 text-slate-700 sm:col-span-2"><UiFeedbackText text={message} /></p> : null}</form></OperationPanel><button type="button" onClick={() => void testConnection()} disabled={testing || provider.status === "disabled"} className="min-h-10 rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-40">{testing ? t("测试中…") : t("测试连接")}</button></div>
          <dl className="grid gap-3 rounded-2xl border border-slate-200 p-4 text-xs sm:grid-cols-3"><div><dt className="text-slate-400"><UiText text={"生成模型"} /></dt><dd className="mt-1 break-words font-medium text-slate-700">{provider.defaultGenerationModelId ?? t("未配置")}</dd></div><div><dt className="text-slate-400"><UiText text={"图片识别"} /></dt><dd className="mt-1 break-words font-medium text-slate-700">{provider.defaultVisionModelId ?? t("未配置")}</dd></div><div><dt className="text-slate-400"><UiText text={"向量模型"} /></dt><dd className="mt-1 break-words font-medium text-slate-700">{provider.defaultEmbeddingModelId ? `${provider.defaultEmbeddingModelId} · ${provider.embeddingDimensions} ${t("维")}` : t("未配置")}</dd></div></dl>
          <ScopeEvidenceCard title="供应商配置边界" evidence={{ scope: t("平台供应商连接"), owner: t("平台管理员"), payer: t("使用平台默认路由时由当前发起人扣减平台额度"), affectedProjects: provider._count.platformDefaultAiRoutes > 0 ? `${t("项目影响需经活动默认路由影响预览核实；当前有")} ${provider._count.platformDefaultAiRoutes} ${t("条活动默认路由引用")}` : t("尚无活动默认路由引用；暂无项目影响证据"), latestSuccess: provider.lastTestedAt ? `${t("最近连接测试")}：${dateLabel(provider.lastTestedAt, language, t)}` : t("尚未完成连接测试") }} />
          {provider.status === "disabled" ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3"><p className="text-xs leading-5 text-rose-700"><UiText text={"永久删除仅适用于没有活动平台默认路由或历史审计引用的连接，并会同时删除加密凭据。"} /></p><button type="button" onClick={() => void removeConnection()} disabled={pending} className="min-h-10 rounded-xl bg-rose-600 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-40"><UiText text={"永久删除"} /></button></div> : null}
          {(checkResult || message) && !editing ? <p role="status" className="text-xs leading-5 text-slate-600">{checkResult ? describeProviderCheck(checkResult, t) : <UiFeedbackText text={message ?? ""} />}{probeBudgetHref ? <> <a href={probeBudgetHref} className="font-semibold text-indigo-700 underline underline-offset-2"><UiText text={"设置模型测试额度"} /></a></> : null}</p> : null}
          {provider.lastErrorCode ? <p className="text-xs text-rose-600"><UiText text={"最近一次连接测试未通过："} />{describeProviderCheck({ attempt: { status: "failed", safeErrorCode: provider.lastErrorCode, capabilities: { generation: "notConfigured", embedding: "notConfigured", vision: "notConfigured" }, embeddingDimensions: null } }, t)}</p> : null}
        </div>
      </OperationPanel></div>
    </div>{dialog}</>
  );
}

function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  const t = useAppearance().t;
  return <label className="block text-xs font-medium text-slate-600">{t(label)}{children}</label>;
}
