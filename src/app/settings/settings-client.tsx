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
import { DialogActions, DialogForm, DialogSubmit } from "@/components/dialog-actions";
import { PlatformOperationAssignments } from "./platform-operation-assignments";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { ShellIcon } from "@/components/shell-icon";
import { safeErrorPresentation, safeResponseError, type SafeErrorPresentation } from "@/lib/safe-error-presentation";

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
    const detail = t(code === "PLATFORM_PROVIDER_PROBE_PROVIDER_AUTH_FAILED"
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
        <AdminPageHeader title="模型与能力" description="先验证供应商连接，再勾选需要的能力，一次测试并启用。" actions={canManageProviders ? <button ref={createTriggerRef} disabled={operationsBusy || loading || catalog.length === 0} type="button" onClick={() => setCreateOpen(true)} className="inline-flex min-h-10 items-center rounded-control px-4 py-2.5 text-xs font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 app-button-primary"><UiText text={"新增供应商"} /></button> : undefined} />

        {!canManageProviders ? <section className="mt-7 border-t border-app-border pt-6"><h2 className="text-xl font-semibold"><UiText text={"平台模型由系统管理员管理"} /></h2><p className="mt-3 text-sm leading-7 text-app-muted"><UiText text={"普通用户可以使用平台额度和平台默认模型，不会请求或查看平台供应商接口。"} />{activeMembership ? t("当前会员有效，你可以在“我的空间”配置自己的模型连接。") : membershipStatus === "expired" ? t("会员资格已到期；重新获得资格后才可配置个人模型。") : membershipStatus === "revoked" ? t("会员资格已撤销；重新获得资格后才可配置个人模型。") : t("如需配置个人模型，请先完成会员申请。")}</p>{activeMembership ? <a href="/personal/models" className="mt-5 inline-flex rounded-control px-5 py-3 text-sm font-semibold app-button-primary"><UiText text={"配置个人模型"} /></a> : null}</section> : null}
        {canManageProviders && error ? <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-field border border-app-danger-border bg-app-danger-soft px-5 py-4 text-sm text-app-danger-ink app-feedback-error"><UiErrorText text={error} /><button type="button" onClick={() => void reload()} disabled={loading} className="app-button-secondary rounded-control border px-3 py-2 text-xs font-semibold disabled:opacity-50"><UiText text={"重试读取"} /></button></div> : null}

        {canManageProviders ? <fieldset disabled={operationsBusy} className="mt-5 min-w-0 space-y-4">
          <div className="flex items-end justify-between px-1">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-app-muted"><UiText text={"平台供应商"} /></p>
              <h2 className="mt-2 text-xl font-semibold"><UiText text={"供应商连接"} /></h2>
            </div>
            <span className="text-xs text-app-muted">{loading ? t("读取中…") : entityCountLabel(providers.length, "1 个供应商", "个供应商", t)}</span>
          </div>
          {loading ? <div className="rounded-panel border border-app-border bg-app-surface px-6 py-12 text-center text-sm text-app-muted app-panel"><UiText text={"读取中…"} /></div> : error ? <div className="rounded-panel border border-app-border bg-app-surface px-6 py-12 text-center text-sm text-app-muted app-panel"><UiText text={"供应商列表读取失败；重试成功前不会显示空列表。"} /></div> : providers.length === 0 ? (
            <div className="rounded-panel border border-dashed border-app-border bg-app-surface px-6 py-12 text-center text-sm text-app-muted"><UiText text={"尚未配置供应商。"} /><button type="button" onClick={() => setCreateOpen(true)} className="ml-1 font-semibold text-app-link underline underline-offset-2"><UiText text={"新增供应商"} /></button></div>
          ) : <div role="table" aria-label={t("供应商连接")} className="overflow-hidden rounded-panel border border-app-border bg-app-surface app-panel">
            <div role="rowgroup" className="hidden border-b border-app-border bg-app-surface-soft px-4 py-3 text-xs font-semibold text-app-muted md:block">
              <div role="row" className="grid grid-cols-[minmax(0,1.25fr)_minmax(6rem,.7fr)_minmax(0,1.5fr)_minmax(8rem,.9fr)_auto] items-center gap-4">
                <span role="columnheader"><UiText text={"供应商"} /></span><span role="columnheader"><UiText text={"连接状态"} /></span><span role="columnheader"><UiText text={"可用模型"} /></span><span role="columnheader"><UiText text={"最近测试"} /></span><span role="columnheader" className="sr-only"><UiText text={"操作"} /></span>
              </div>
            </div>
            <div role="rowgroup" className="divide-y divide-app-border">
              {providers.map((provider) => <ProviderCard key={provider.id} provider={provider} catalog={catalog.find((entry) => entry.kind === provider.kind)} onChanged={handleProviderChanged} onRemoved={handleProviderRemoved} onProbeFinished={reload} />)}
            </div>
          </div>}
        </fieldset> : null}

        {canManageProviders ? <PlatformOperationAssignments providers={providers} onBusyChange={setOperationsBusy} /> : null}

        {canManageProviders && createOpen ? <ProviderCreateDialog open catalog={catalog} onCreated={handleProviderCreated} onClose={() => setCreateOpen(false)} restoreFocusRef={createTriggerRef} /> : null}
    </div>
  );
  if (adminMode) return content;
  return <main className="min-h-screen bg-app-surface text-app-text"><AppHeader username={username} active="settings" /><AdminPageFrame active="models" showSidebar={false}>{content}</AdminPageFrame></main>;
}

const dialogFocusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

type DraftProbeProof = { draftProbeId: string; createRequestKey: string; expiresAt: number };

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
  const [proof, setProof] = useState<DraftProbeProof | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!proof) return;
    const timer = window.setTimeout(() => setProof(null), Math.max(0, proof.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [proof]);
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
    <div ref={dialogRef} data-operation-surface="modal" role="dialog" aria-modal="true" aria-labelledby="provider-create-dialog-title" aria-describedby="provider-create-dialog-description" className={["app-dialog-surface app-dialog-surface--modal", (`relative z-10 flex max-h-[min(44rem,calc(100dvh-1.5rem))] w-full max-w-[920px] flex-col overflow-hidden rounded-panel sm:max-h-[min(44rem,calc(100dvh-3rem))] ${modalSurfaceClassName}`)].filter(Boolean).join(' ')}>
      <header data-operation-header className={`${modalHeaderClassName} flex items-start justify-between gap-4 px-5 py-4 sm:px-6`}>
        <div>
          <div className="flex flex-wrap items-center gap-2"><h2 id="provider-create-dialog-title" className="text-base font-semibold text-app-text"><UiText text={"新增供应商"} /></h2>
            <span role="status" aria-live="polite">{proof && <span className="inline-flex items-center gap-1 rounded-full bg-app-success-soft px-2 py-1 text-xs font-semibold text-app-success-ink"><UiText text="测试通过" /></span>}</span>
          </div>
          <p id="provider-create-dialog-description" className="mt-2 text-xs leading-5 text-app-muted"><UiText text={"使用官方固定端点先测试未保存凭据，测试成功后才能保存为已验证连接。"} /></p>
        </div>
        <button ref={closeRef} type="button" aria-label={t("关闭新增供应商")} onClick={close} disabled={pending} className="app-icon-button"><ShellIcon name="close" className="app-icon--control" /></button>
      </header>
      <ProviderCreateForm proof={proof} setProof={setProof} catalog={catalog} onCreated={onCreated} onPendingChange={setPending} />
    </div>
  </div>;
}

function ProviderCreateForm({
  proof, setProof, catalog,
  onCreated,
  onPendingChange,
}: {
  catalog: ProviderCatalogEntry[];
  onCreated: (provider: Provider) => void;
  onPendingChange: (pending: boolean) => void;
  proof: DraftProbeProof | null;
  setProof: (proof: DraftProbeProof | null) => void;
}) {
  const { t } = useAppearance();
  const initial = catalog.find(entry => entry.kind === "deepseek") ?? catalog[0];
  const [kind, setKind] = useState<ProviderKind>(initial?.kind ?? "deepseek");
  const definition = useMemo(() => catalog.find((entry) => entry.kind === kind), [catalog, kind]);
  const [name, setName] = useState(initial?.displayName ?? "");
  const [apiKey, setApiKey] = useState("");
  const [generationModelId, setGenerationModelId] = useState(initial?.generationModelSuggestions[0] ?? "");
  const [visionModelId, setVisionModelId] = useState(initial?.visionModelSuggestions[0] ?? "");
  const [embeddingEnabled, setEmbeddingEnabled] = useState(Boolean(initial?.embeddingModelSuggestions[0]));
  const [embeddingModelId, setEmbeddingModelId] = useState(initial?.embeddingModelSuggestions[0]?.id ?? "");
  const [embeddingDimensions, setEmbeddingDimensions] = useState(String(initial?.embeddingModelSuggestions[0]?.dimensions ?? ""));
  const [action, setAction] = useState<"test" | "save" | null>(null);
  const pending = action !== null;
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<SafeErrorPresentation | null>(null);

  function clearProof() {
    setProof(null);
    setMessage(null);
    setFailure(null);
  }

  function chooseKind(nextKind: ProviderKind) {
    clearProof();
    setKind(nextKind);
    setApiKey("");
    const next = catalog.find((entry) => entry.kind === nextKind);
    if (!next) return;
    setName(next.displayName);
    setGenerationModelId(next.generationModelSuggestions[0] ?? "");
    setVisionModelId(next.visionModelSuggestions[0] ?? "");
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
    setAction("test");
    onPendingChange(true);
    setMessage(null);
    setFailure(null);
    setProof(null);
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
      if (!response.ok) {
        setFailure(await safeResponseError(response, "供应商连接测试失败"));
        return;
      }
      const payload = await response.json() as { draftProbeId: string | null; expiresAt?: string; attempt: { safeErrorCode: string | null } };
      if (typeof payload?.draftProbeId !== "string" || payload.draftProbeId.length === 0) {
        setFailure(safeErrorPresentation({ error: { code: payload?.attempt?.safeErrorCode } }, "供应商连接测试未通过"));
        return;
      }
      const expiresAt = Date.parse(payload.expiresAt ?? "");
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        setFailure(safeErrorPresentation({ error: { code: "PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT" } }, "供应商连接测试未通过"));
        return;
      }
      setProof({ draftProbeId: payload.draftProbeId, createRequestKey, expiresAt });
    } catch {
      setProof(null);
      setFailure(safeErrorPresentation(null, "未能取得连接测试结果，请检查网络后重试。"));
    } finally {
      setAction(null);
      onPendingChange(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (proof === null || proof.expiresAt <= Date.now()) {
      setProof(null);
      setMessage("请先完成真实连接测试，再保存连接。");
      return;
    }
    setAction("save");
    onPendingChange(true);
    setMessage(null);
    setFailure(null);
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
      if (!response.ok) {
        const failure = await safeResponseError(response, "供应商创建失败");
        setFailure(failure);
        if (failure.code === "PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT") setProof(null);
        return;
      }
      const payload = await response.json() as { provider: Provider };
      onCreated(payload.provider);
      setApiKey("");
      setProof(null);
      setMessage("连接已保存并标记为已验证。 ");
    } catch {
      setFailure(safeErrorPresentation(null, "供应商创建失败"));
    } finally {
      setAction(null);
      onPendingChange(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col text-app-text">
      {/* The body owns overflow so the header and action footer stay available while fields scroll. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4 sm:px-6">
        <fieldset disabled={pending} className="min-w-0">
        <Field compact label="供应商">
          <select value={kind} onChange={(event) => chooseKind(event.target.value as ProviderKind)} className={["app-field", (`${formFields.lightField} light-field`)].filter(Boolean).join(' ')}>
            {catalog.map((entry) => <option key={entry.kind} value={entry.kind}>{t(entry.displayName)}</option>)}
          </select>
        </Field>
        <Field compact label="连接名称"><input value={name} onChange={(event) => { clearProof(); setName(event.target.value); }} maxLength={80} required className={["app-field", (`${formFields.lightField} light-field`)].filter(Boolean).join(' ')} /></Field>
        <Field compact label={definition?.apiKeyLabel ?? "API Key"}><input type="password" value={apiKey} onChange={(event) => { clearProof(); setApiKey(event.target.value); }} autoComplete="new-password" maxLength={512} required className={["app-field", (`${formFields.lightField} light-field`)].filter(Boolean).join(' ')} /></Field>
        <Field compact label="生成模型（可选）"><input list={`generation-${kind}`} value={generationModelId} onChange={(event) => { clearProof(); setGenerationModelId(event.target.value); }} className={["app-field", (`${formFields.lightField} light-field`)].filter(Boolean).join(' ')} /></Field>
        <datalist id={`generation-${kind}`}>{definition?.generationModelSuggestions.map((id) => <option key={id} value={id} />)}</datalist>
        {definition?.supportsVision ? <><Field compact label="图片识别模型（可选）"><input list={`vision-${kind}`} value={visionModelId} onChange={(event) => { clearProof(); setVisionModelId(event.target.value); }} className={["app-field", (`${formFields.lightField} light-field`)].filter(Boolean).join(' ')} /></Field><datalist id={`vision-${kind}`}>{definition.visionModelSuggestions.map((id) => <option key={id} value={id} />)}</datalist></> : null}
        {definition?.supportsEmbeddings ? (
          <>
            <label className="mt-3 flex items-center gap-3 text-sm text-app-text"><input type="checkbox" checked={embeddingEnabled} onChange={(event) => { clearProof(); setEmbeddingEnabled(event.target.checked); }} /> <UiText text={"同时配置向量模型"} /></label>
            {embeddingEnabled ? <div className="grid grid-cols-[1fr_7rem] gap-3"><Field compact label="向量模型"><input list={`embedding-${kind}`} value={embeddingModelId} onChange={(event) => { clearProof(); chooseEmbeddingModel(event.target.value); }} required className={["app-field", (`${formFields.lightField} light-field`)].filter(Boolean).join(' ')} /></Field><Field compact label="维度"><input type="number" min={8} max={8192} value={embeddingDimensions} onChange={(event) => { clearProof(); setEmbeddingDimensions(event.target.value); }} required className={["app-field", (`${formFields.lightField} light-field`)].filter(Boolean).join(' ')} /></Field></div> : null}
            <datalist id={`embedding-${kind}`}>{definition.embeddingModelSuggestions.map((item) => <option key={item.id} value={item.id} />)}</datalist>
          </>
        ) : <p className="mt-3 rounded-panel border border-app-warning-border bg-app-warning-soft px-4 py-3 text-xs leading-5 text-app-warning-ink"><UiText text={"DeepSeek 当前作为生成供应商使用；语义索引需为项目另选 OpenAI、Qwen 或 GLM。"} /></p>}
        <details className="mt-3 rounded-panel border border-app-border bg-app-surface-soft px-4 py-3 text-xs leading-5 text-app-muted">
          <summary className="cursor-pointer font-semibold text-app-text"><UiText text={"能力说明与推荐模型"} /></summary>
          <p className="mt-1"><UiText text={"生成模型用于文本、摘要和计划；图片识别模型可选，留空即关闭；向量模型可选，维度必须匹配，切换模型或维度后需重建相关索引。API Key 只在服务端加密保存。"} /></p>
          {definition ? <div className="mt-3 space-y-1 text-app-muted"><p><UiText text={"生成推荐："} />{definition.generationModelSuggestions.join("、") || "暂无"}</p><p><UiText text={"图片推荐："} />{definition.visionModelSuggestions.join("、") || "暂无"}</p><p><UiText text={"向量推荐："} />{definition.embeddingModelSuggestions.map((item) => `${item.id}（${item.dimensions} 维）`).join("、") || "暂无"}</p></div> : null}
        </details>
        </fieldset>
      </div>
      <footer className={`${modalFooterClassName} flex shrink-0 flex-col items-stretch gap-3 px-5 py-4 sm:px-6`}>
        {failure ? <div role="alert" className="w-full min-w-0 space-y-1 break-words rounded-field border border-app-danger-border bg-app-danger-soft px-3 py-2 text-xs leading-5 text-app-danger-ink sm:col-span-2 app-feedback-error">
          <p className="font-semibold">{t(failure.summary)}</p>
          <p>{t(failure.nextStep)}</p>
          {failure.code ? <p className="[overflow-wrap:anywhere]">{t("安全错误码")}：{failure.code}</p> : null}
        </div> : null}
        {message ? <p className="text-xs leading-5 text-app-muted sm:col-span-2" role="status"><UiFeedbackText text={message} /></p> : null}
        <div className="flex w-full flex-wrap items-center justify-end gap-2"><button type="button" onClick={() => void testConnection()} disabled={pending || catalog.length === 0 || apiKey.trim().length < 8} className="rounded-control border px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 app-button-secondary">{action === "test" ? t("处理中…") : t("测试连接")}</button><button disabled={pending || catalog.length === 0 || proof === null} className="rounded-control px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 app-button-primary">{action === "save" ? t("保存中…") : t("保存连接")}</button></div>
      </footer>

    </form>
  );
}

function Field({ label, children, compact = false }: { label: string; children: React.ReactNode; compact?: boolean }) {
  const t = useAppearance().t;
  return <label className={`${compact ? "mt-3 text-xs" : "mt-5 text-sm"} block font-medium text-app-text`}>{t(label)}{children}</label>;
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
    try {
      if (requiredProbeUnits(provider, catalog) === 0) {
        setMessage("请先为该连接配置至少一个可测试模型，再执行连接测试。");
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
      <div role="cell" className="min-w-0"><h3 className="break-words font-semibold text-app-text">{provider.name}</h3><p className="mt-1 text-xs text-app-muted">{providerDisplayName}<span aria-hidden="true"> · </span>{provider.kind}</p></div>
      <div role="cell" className="justify-self-end md:justify-self-start"><span className={`inline-flex min-h-6 items-center rounded-full px-2.5 py-1 text-xs font-semibold ${provider.status === "verified" ? "bg-app-success-soft text-app-success-ink" : provider.status === "error" ? "bg-app-danger-soft text-app-danger-ink" : "bg-app-surface-soft text-app-muted"}`}>{t(statusLabel[provider.status])}</span></div>
      <div role="cell" className="col-span-2 min-w-0 text-xs leading-5 md:col-span-1"><span className="font-medium text-app-text">{entityCountLabel(configuredModels.length, "1 个模型", "个模型", t)}</span>{configuredModels.length ? <span className="mt-1 block break-words text-app-muted">{configuredModels.join(" · ")}</span> : <span className="mt-1 block text-app-muted"><UiText text={"未配置"} /></span>}</div>
      <div role="cell" className="text-xs text-app-muted">{dateLabel(provider.lastTestedAt, language, t)}</div>
      <div role="cell" className="col-span-2 flex justify-end md:col-span-1 md:justify-start"><OperationPanel title={`${provider.name} · ${t("供应商连接")}`} translateTitle={false} triggerLabel="管理连接" variant="drawer">
        <div className="space-y-5">
          <dl className="grid gap-3 rounded-panel bg-app-surface-soft p-4 text-xs sm:grid-cols-2"><div><dt className="text-app-muted"><UiText text={"供应商"} /></dt><dd className="mt-1 font-medium text-app-text">{providerDisplayName} · {provider.kind}</dd></div><div><dt className="text-app-muted"><UiText text={"连接状态"} /></dt><dd className="mt-1 font-medium text-app-text">{t(statusLabel[provider.status])}</dd></div><div><dt className="text-app-muted"><UiText text={"Key 尾号"} /></dt><dd className="mt-1 font-medium text-app-text">{provider.credential.maskedSuffix}</dd></div><div><dt className="text-app-muted"><UiText text={"配置版本"} /></dt><dd className="mt-1 font-medium text-app-text">{provider.configurationVersion}</dd></div><div><dt className="text-app-muted"><UiText text={"活动默认路由"} /></dt><dd className="mt-1 font-medium text-app-text">{provider._count.platformDefaultAiRoutes}</dd></div><div><dt className="text-app-muted"><UiText text={"最近测试"} /></dt><dd className="mt-1 font-medium text-app-text">{dateLabel(provider.lastTestedAt, language, t)}</dd></div></dl>
          <div className="flex flex-wrap gap-2"><OperationPanel title={`${t("编辑供应商：")}${provider.name}`} translateTitle={false} triggerLabel="编辑" description="修改连接模型和凭据。保存后配置需要重新执行连接测试。" open={editing} onOpenChange={setEditing}><DialogForm onSubmit={save} className="grid gap-4 sm:grid-cols-2"><EditField label="连接名称"><input value={name} onChange={(event) => setName(event.target.value)} required className={["app-field", (`${formFields.editField} edit-field`)].filter(Boolean).join(' ')} /></EditField><EditField label="生成模型（可选）"><input value={generationModelId} onChange={(event) => setGenerationModelId(event.target.value)} className={["app-field", (`${formFields.editField} edit-field`)].filter(Boolean).join(' ')} /></EditField>{catalog?.supportsVision ? <EditField label="图片识别模型（可选）"><input value={visionModelId} onChange={(event) => setVisionModelId(event.target.value)} className={["app-field", (`${formFields.editField} edit-field`)].filter(Boolean).join(' ')} /></EditField> : null}{catalog?.supportsEmbeddings ? <><EditField label="向量模型（留空即关闭）"><input value={embeddingModelId} onChange={(event) => setEmbeddingModelId(event.target.value)} className={["app-field", (`${formFields.editField} edit-field`)].filter(Boolean).join(' ')} /></EditField><EditField label="向量维度"><input type="number" value={embeddingDimensions} onChange={(event) => setEmbeddingDimensions(event.target.value)} disabled={!embeddingModelId} className={["app-field", (`${formFields.editField} edit-field`)].filter(Boolean).join(' ')} /></EditField></> : null}<EditField label="替换 API Key（可选）"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" className={["app-field", (`${formFields.editField} edit-field`)].filter(Boolean).join(' ')} /></EditField><DialogActions><DialogSubmit disabled={pending} className="min-h-10 rounded-control px-4 py-3 text-xs font-semibold disabled:opacity-50 app-button-primary">{pending ? t("保存中…") : t("保存变更")}</DialogSubmit><button type="button" onClick={() => void toggleEnabled()} disabled={pending || disableBlocked} title={disableBlocked ? disableBlockTitle : undefined} className="min-h-10 rounded-control border border-app-border px-4 py-3 text-xs font-semibold text-app-muted disabled:opacity-40">{t(provider.status === "disabled" ? "重新启用" : "停用连接")}</button></DialogActions>{disableBlocked ? <p className="text-xs leading-5 text-app-warning-ink sm:col-span-2"><UiText text={"无法停用："} />{disableBlockSeparator}{disableBlockReasons}{disableBlockSeparator}<UiText text={"仍在使用该连接。请先移除项目路由或停用活动能力。"} /></p> : null}{message ? <p role="status" className="text-xs leading-5 text-app-text sm:col-span-2"><UiFeedbackText text={message} /></p> : null}</DialogForm></OperationPanel><DialogActions><button type="button" onClick={() => void testConnection()} disabled={testing || provider.status === "disabled"} className="min-h-10 rounded-control px-4 py-2.5 text-xs font-semibold disabled:opacity-40 app-button-primary">{testing ? t("测试中…") : t("测试连接")}</button></DialogActions></div>
          <dl className="grid gap-3 rounded-panel border border-app-border p-4 text-xs sm:grid-cols-3"><div><dt className="text-app-muted"><UiText text={"生成模型"} /></dt><dd className="mt-1 break-words font-medium text-app-text">{provider.defaultGenerationModelId ?? t("未配置")}</dd></div><div><dt className="text-app-muted"><UiText text={"图片识别"} /></dt><dd className="mt-1 break-words font-medium text-app-text">{provider.defaultVisionModelId ?? t("未配置")}</dd></div><div><dt className="text-app-muted"><UiText text={"向量模型"} /></dt><dd className="mt-1 break-words font-medium text-app-text">{provider.defaultEmbeddingModelId ? `${provider.defaultEmbeddingModelId} · ${provider.embeddingDimensions} ${t("维")}` : t("未配置")}</dd></div></dl>
          <ScopeEvidenceCard title="供应商配置边界" evidence={{ scope: t("平台供应商连接"), owner: t("平台管理员"), payer: t("使用平台默认路由时由当前发起人扣减平台额度"), affectedProjects: provider._count.platformDefaultAiRoutes > 0 ? `${t("项目影响需经活动默认路由影响预览核实；当前有")} ${provider._count.platformDefaultAiRoutes} ${t("条活动默认路由引用")}` : t("尚无活动默认路由引用；暂无项目影响证据"), latestSuccess: provider.lastTestedAt ? `${t("最近连接测试")}：${dateLabel(provider.lastTestedAt, language, t)}` : t("尚未完成连接测试") }} />
          {provider.status === "disabled" ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-app-danger-border bg-app-danger-soft px-4 py-3"><p className="text-xs leading-5 text-app-danger-ink"><UiText text={"永久删除仅适用于没有活动平台默认路由或历史审计引用的连接，并会同时删除加密凭据。"} /></p><DialogActions><button type="button" onClick={() => void removeConnection()} disabled={pending} className="min-h-10 rounded-control px-4 py-2.5 text-xs font-semibold disabled:opacity-40 app-button-danger"><UiText text={"永久删除"} /></button></DialogActions></div> : null}
          {(checkResult || message) && !editing ? <p role="status" className="text-xs leading-5 text-app-muted">{checkResult ? describeProviderCheck(checkResult, t) : <UiFeedbackText text={message ?? ""} />}</p> : null}
          {provider.lastErrorCode ? <p className="text-xs text-app-danger-ink"><UiText text={"最近一次连接测试未通过："} />{describeProviderCheck({ attempt: { status: "failed", safeErrorCode: provider.lastErrorCode, capabilities: { generation: "notConfigured", embedding: "notConfigured", vision: "notConfigured" }, embeddingDimensions: null } }, t)}</p> : null}
        </div>
      </OperationPanel></div>
    </div>{dialog}</>
  );
}

function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  const t = useAppearance().t;
  return <label className="block text-xs font-medium text-app-muted">{t(label)}{children}</label>;
}
