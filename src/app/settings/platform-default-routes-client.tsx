"use client";
import { UiFeedbackText } from "@/components/ui-error-text";
import { useAppearance } from "@/components/appearance-provider";


import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { formatUiDateTime } from "@/lib/ui-date-format";

const OPERATIONS = [
  "embedding",
  "visionExtract",
  "autoExtract",
  "sourceSummary",
  "projectAnalysis",
  "generateWithContext",
] as const;
type Operation = typeof OPERATIONS[number];
type Provider = {
  id: string;
  name: string;
  kind: string;
  scope: "platform";
  status: "configured" | "verified" | "error" | "disabled";
  disabledAt: string | null;
  configurationVersion: number;
  defaultGenerationModelId: string | null;
  defaultEmbeddingModelId: string | null;
  defaultVisionModelId: string | null;
  embeddingDimensions: number | null;
};
type Route = {
  id: string;
  operation: Operation;
  version: number;
  status: "draft" | "verified" | "active" | "retired";
  providerConnectionId: string;
  modelId: string;
  embeddingDimensions: number | null;
  maxOutputTokens: number | null;
  quotaMultiplierBps: number;
  validatedProviderConfigurationVersion: number | null;
  validatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type Readiness = {
  operation: Operation;
  code: "missing" | "provider-invalid" | "provider-not-verified" | "provider-disabled" | "configuration-changed" | "capability-mismatch" | "not-validated" | "ready";
  activeRouteId: string | null;
  activeRouteVersion: number | null;
  providerConnectionId: string | null;
  runtimeConnected: true;
};
type Audit = {
  id: string;
  action: string;
  routeId: string;
  operation: Operation;
  routeVersion: number;
  providerConnectionId: string;
  providerConfigurationVersion: number;
  actorId: string;
  reason: string | null;
  safeSnapshot: Record<string, unknown>;
  createdAt: string;
};
type Impact = {
  routeId: string;
  operation: Operation;
  runtimeConnected: true;
  indexImpact: {
    applicable: boolean;
    activeIndexCount: number;
    matchingActiveIndexCount: number;
    mismatchingActiveIndexCount: number;
    affectedProjectCount: number;
    affectedGenerationCount: number;
  };
};

const operationLabels: Record<Operation, string> = {
  embedding: "embedding（向量）",
  visionExtract: "visionExtract（图片识别）",
  autoExtract: "autoExtract（自动抽取）",
  sourceSummary: "sourceSummary（资料摘要）",
  projectAnalysis: "projectAnalysis（项目分析）",
  generateWithContext: "generateWithContext（带上下文生成）",
};

const readinessLabels: Record<Readiness["code"], string> = {
  missing: "未配置",
  "provider-invalid": "供应商结构无效",
  "provider-not-verified": "供应商待验证",
  "provider-disabled": "供应商已停用",
  "configuration-changed": "供应商配置已变化",
  "capability-mismatch": "能力不匹配",
  "not-validated": "路由待验证",
  ready: "控制面已激活且配置有效",
};

const routeStatusLabels: Record<Route["status"], string> = { draft: "草稿", verified: "已验证", active: "已启用", retired: "已停用" };

async function readError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function providerModel(provider: Provider | undefined, operation: Operation): { modelId: string; embeddingDimensions: string; maxOutputTokens: string } {
  if (provider === undefined) return { modelId: "", embeddingDimensions: "", maxOutputTokens: operation === "embedding" ? "" : "2048" };
  if (operation === "embedding") return { modelId: provider.defaultEmbeddingModelId ?? "", embeddingDimensions: provider.embeddingDimensions === null ? "" : String(provider.embeddingDimensions), maxOutputTokens: "" };
  if (operation === "visionExtract") return { modelId: provider.defaultVisionModelId ?? "", embeddingDimensions: "", maxOutputTokens: "2048" };
  return { modelId: provider.defaultGenerationModelId ?? "", embeddingDimensions: "", maxOutputTokens: "2048" };
}

function providerSupportsRoute(provider: Provider | undefined, route: Route): boolean {
  if (provider === undefined || provider.status !== "verified" || provider.disabledAt !== null || provider.scope !== "platform") return false;
  if (route.operation === "embedding") {
    return provider.defaultEmbeddingModelId === route.modelId
      && provider.embeddingDimensions === route.embeddingDimensions
      && route.maxOutputTokens === null;
  }
  if (route.operation === "visionExtract") {
    return provider.defaultVisionModelId === route.modelId
      && route.embeddingDimensions === null
      && route.maxOutputTokens !== null;
  }
  return provider.defaultGenerationModelId === route.modelId
    && route.embeddingDimensions === null
    && route.maxOutputTokens !== null;
}

function routeValidationLabel(route: Route, provider: Provider | undefined): string {
  if (provider === undefined || provider.scope !== "platform") return "验证已失效 · 供应商结构无效";
  if (provider.status === "disabled" || provider.disabledAt !== null) return "验证已失效 · 供应商已停用";
  if (route.validatedAt === null || route.validatedProviderConfigurationVersion === null) return "未验证";
  if (route.validatedProviderConfigurationVersion !== provider.configurationVersion) {
    return `验证已失效 · 配置版本 ${route.validatedProviderConfigurationVersion} → ${provider.configurationVersion}`;
  }
  if (provider.status !== "verified") return "验证已失效 · 供应商待验证";
  if (!providerSupportsRoute(provider, route)) return "验证已失效 · 能力不匹配";
  return "已验证";
}

function operationImpactSummary(impact: Impact): string[] {
  if (!impact.indexImpact.applicable) {
    return ["该操作不影响现有向量索引。"];
  }
  return [
    `活动索引 ${impact.indexImpact.activeIndexCount} 个，其中匹配 ${impact.indexImpact.matchingActiveIndexCount} 个，不匹配 ${impact.indexImpact.mismatchingActiveIndexCount} 个。`,
    `受影响项目 ${impact.indexImpact.affectedProjectCount} 个，索引代次 ${impact.indexImpact.affectedGenerationCount} 个。`,
  ];
}

function formatMultiplier(bps: number): string {
  const normalized = (bps / 10_000).toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
  if (!normalized.includes(".")) return `${normalized}.00`;
  const [, decimals = ""] = normalized.split(".");
  return decimals.length < 2 ? `${normalized}${"0".repeat(2 - decimals.length)}` : normalized;
}

function multiplierToBps(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,4})?$/u.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const bps = Number(`${whole}${fraction.padEnd(4, "0")}`);
  return Number.isSafeInteger(bps) && bps >= 1 && bps <= 100_000 ? bps : null;
}

export function PlatformDefaultRoutesPanel({ refreshToken = 0, onRouteMutation, readOnly = false }: { refreshToken?: number; onRouteMutation?: () => void; readOnly?: boolean }) {
  const { language } = useAppearance();
  const { confirm, dialog } = useAppConfirmDialog();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [readiness, setReadiness] = useState<Record<Operation, Readiness> | null>(null);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [operation, setOperation] = useState<Operation>("embedding");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [embeddingDimensions, setEmbeddingDimensions] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("2048");
  const [quotaMultiplier, setQuotaMultiplier] = useState("1.00");
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const editingRouteIdRef = useRef<string | null>(null);
  const providerIdRef = useRef("");
  const operationRef = useRef<Operation>("embedding");
  const requestSequenceRef = useRef(0);

  const eligibleProviders = providers.filter((provider) => provider.status === "verified" && provider.disabledAt === null);
  const draftQuotaMultiplierBps = multiplierToBps(quotaMultiplier);

  const reload = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    try {
      const response = await fetch("/api/settings/platform-ai-routes", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "平台默认路由加载失败"));
      const payload = await response.json() as {
        routes: Route[];
        providers: Provider[];
        readiness: { operations: Record<Operation, Readiness> };
        audits: Audit[];
      };
      if (requestSequence !== requestSequenceRef.current) return;
      const currentEditingRouteId = editingRouteIdRef.current;
      const currentProviderId = providerIdRef.current;
      const validProviders = payload.providers.filter((provider) => provider.status === "verified" && provider.disabledAt === null);
      const nextProviderId = currentProviderId !== "" && validProviders.some((provider) => provider.id === currentProviderId)
        ? currentProviderId
        : validProviders[0]?.id ?? "";
      const shouldApplyDefaults = currentEditingRouteId === null
        && (currentProviderId === "" || nextProviderId !== currentProviderId);
      setRoutes(payload.routes);
      setProviders(payload.providers);
      setProvidersLoaded(true);
      setReadiness(payload.readiness.operations);
      setAudits(payload.audits);
      const nextEditingRouteId = currentEditingRouteId !== null
        && payload.routes.some((route) => route.id === currentEditingRouteId && route.status === "draft")
        ? currentEditingRouteId
        : null;
      editingRouteIdRef.current = nextEditingRouteId;
      setEditingRouteId(nextEditingRouteId);
      providerIdRef.current = nextProviderId;
      setProviderId(nextProviderId);
      if (shouldApplyDefaults) {
        const defaults = providerModel(payload.providers.find((provider) => provider.id === nextProviderId), operationRef.current);
        setModelId(defaults.modelId);
        setEmbeddingDimensions(defaults.embeddingDimensions);
        setMaxOutputTokens(defaults.maxOutputTokens);
      }
      setMessage(null);
    } catch (loadError) {
      if (requestSequence !== requestSequenceRef.current) return;
      setMessage(loadError instanceof Error ? loadError.message : "平台默认路由加载失败");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void reload(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshToken, reload]);

  function changeOperation(nextOperation: Operation) {
    operationRef.current = nextOperation;
    setOperation(nextOperation);
    if (editingRouteIdRef.current === null) {
      const defaults = providerModel(providers.find((provider) => provider.id === providerIdRef.current), nextOperation);
      setModelId(defaults.modelId);
      setEmbeddingDimensions(defaults.embeddingDimensions);
      setMaxOutputTokens(defaults.maxOutputTokens);
    }
  }

  function changeProvider(nextProviderId: string) {
    providerIdRef.current = nextProviderId;
    setProviderId(nextProviderId);
    if (editingRouteIdRef.current === null) {
      const defaults = providerModel(providers.find((provider) => provider.id === nextProviderId), operationRef.current);
      setModelId(defaults.modelId);
      setEmbeddingDimensions(defaults.embeddingDimensions);
      setMaxOutputTokens(defaults.maxOutputTokens);
    }
  }

  function editDraft(route: Route) {
    if (route.status !== "draft") return;
    editingRouteIdRef.current = route.id;
    operationRef.current = route.operation;
    providerIdRef.current = route.providerConnectionId;
    setEditingRouteId(route.id);
    setOperation(route.operation);
    setProviderId(route.providerConnectionId);
    setModelId(route.modelId);
    setEmbeddingDimensions(route.embeddingDimensions === null ? "" : String(route.embeddingDimensions));
    setMaxOutputTokens(route.maxOutputTokens === null ? "" : String(route.maxOutputTokens));
    setQuotaMultiplier(formatMultiplier(route.quotaMultiplierBps));
    setMessage(null);
  }

  function cancelDraftEdit() {
    editingRouteIdRef.current = null;
    setEditingRouteId(null);
    const defaults = providerModel(providers.find((provider) => provider.id === providerIdRef.current), operationRef.current);
    setModelId(defaults.modelId);
    setEmbeddingDimensions(defaults.embeddingDimensions);
    setMaxOutputTokens(defaults.maxOutputTokens);
    setQuotaMultiplier("1.00");
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const editingRoute = editingRouteId === null ? null : routes.find((route) => route.id === editingRouteId) ?? null;
    if (editingRouteId !== null && editingRoute === null) {
      setMessage("草稿已不存在，请刷新后重试。");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const quotaMultiplierBps = multiplierToBps(quotaMultiplier);
      if (quotaMultiplierBps === null) {
        setMessage("倍率请输入 0.0001 到 10.0000 之间的数字。 ");
        setPending(false);
        return;
      }
      const response = await fetch(editingRoute === null ? "/api/settings/platform-ai-routes" : `/api/settings/platform-ai-routes/${editingRoute.id}`, {
        method: editingRoute === null ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerConnectionId: providerId,
          modelId,
          embeddingDimensions: operation === "embedding" ? Number(embeddingDimensions) : null,
          maxOutputTokens: operation === "embedding" ? null : Number(maxOutputTokens),
          quotaMultiplierBps,
          ...(editingRoute === null ? { operation } : { expectedUpdatedAt: editingRoute.updatedAt }),
        }),
      });
      if (!response.ok) throw new Error(await readError(response, editingRoute === null ? "平台默认路由草稿创建失败" : "平台默认路由草稿保存失败"));
      editingRouteIdRef.current = null;
      setEditingRouteId(null);
      await reload();
      onRouteMutation?.();
      setMessage(editingRoute === null ? "草稿已创建；验证并激活后，后续 Web AI 有效路由解析会采用该平台默认路由。真实模型调用未在此页面现场验证。" : "草稿已保存；需要重新完成本地验证。");
    } catch (createError) {
      setMessage(createError instanceof Error ? createError.message : editingRoute === null ? "平台默认路由草稿创建失败" : "平台默认路由草稿保存失败");
    } finally {
      setPending(false);
    }
  }

  async function lifecycle(route: Route, action: "validate" | "activate" | "retire") {
    let reason: string | null = null;
    if (action === "retire") {
      const confirmation = await confirm({
        eyebrow: "Platform default route",
        title: `停用「${operationLabels[route.operation]} · v${route.version}」？`,
        description: "停用只影响控制面状态，不会切换或删除现有项目路由；停用后不可恢复，需要在能力配置中重新测试并启用新版本。",
        inputLabel: "停用原因（必填）",
        inputPlaceholder: "例如：供应商配置更新，准备验证新版本",
        inputOptional: false,
        confirmLabel: "确认停用",
        tone: "warning",
        maxLength: 500,
      });
      if (!confirmation.confirmed) return;
      reason = confirmation.value;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/settings/platform-ai-routes/${route.id}/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, expectedUpdatedAt: route.updatedAt, ...(reason === null ? {} : { reason }) }),
      });
      if (!response.ok) throw new Error(await readError(response, "平台默认路由状态更新失败"));
      await reload();
      onRouteMutation?.();
      setMessage(action === "validate" ? "旧路由验证入口已关闭，请在能力配置中完成真实测试。" : action === "activate" ? "旧路由启用入口已关闭，请在能力配置中完成真实测试和启用。" : "路由已停用；停用后不可恢复，需要新建配置版本。");
    } catch (lifecycleError) {
      setMessage(lifecycleError instanceof Error ? lifecycleError.message : "平台默认路由状态更新失败");
    } finally {
      setPending(false);
    }
  }

  async function showImpact(route: Route) {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/settings/platform-ai-routes/${route.id}/impact`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "影响预览加载失败"));
      setImpact(await response.json() as Impact);
    } catch (impactError) {
      setMessage(impactError instanceof Error ? impactError.message : "影响预览加载失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-10 rounded-panel border border-app-accent-border bg-app-accent-soft p-7 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-app-accent-border pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-app-link">Platform default routes</p>
          <h2 className="mt-2 text-2xl font-semibold text-app-text">平台默认模型路由控制面</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-app-muted">这里仅查看平台能力路由的当前状态、审计和影响。新的能力必须在平台模型页选择、真实测试并启用；本页不提供手工草稿或绕过真实测试的入口。</p>
        </div>
        <span className="rounded-full bg-app-success-soft px-3 py-1.5 text-xs font-semibold text-app-success-ink">Web AI 路由解析已接入</span>
      </div>

      {providersLoaded && eligibleProviders.length === 0 ? <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-field border border-app-warning-border bg-app-warning-soft px-5 py-4 app-feedback-warning" role="status"><div><p className="text-sm font-semibold text-app-warning-ink">尚无已验证的平台供应商</p><p className="mt-1 text-xs leading-5 text-app-warning-ink">先配置并测试一个平台模型连接，才能创建默认路由。</p></div><a href="/admin/models" className="inline-flex min-h-10 items-center rounded-control px-4 py-2 text-xs font-semibold transition app-button-primary">去配置平台模型</a></div> : null}

      {!readOnly ? <form onSubmit={saveDraft} className="mt-6 grid gap-4 rounded-panel border border-app-border bg-app-surface p-5 lg:grid-cols-2 app-panel">
        <label className="text-xs font-semibold text-app-muted">操作
          <select value={operation} disabled={editingRouteId !== null} onChange={(event) => changeOperation(event.target.value as Operation)} className="mt-2 w-full rounded-field border border-app-border px-3 py-2.5 text-sm disabled:bg-app-surface-soft disabled:text-app-muted app-field">
            {OPERATIONS.map((entry) => <option key={entry} value={entry}>{operationLabels[entry]}</option>)}
          </select>
          {editingRouteId !== null ? <span className="mt-1 block text-[12px] font-normal text-app-muted">编辑草稿时操作固定；如需其他操作，请取消编辑后新建。</span> : null}
        </label>
        <label className="text-xs font-semibold text-app-muted">有效平台供应商
          <select value={providerId} onChange={(event) => changeProvider(event.target.value)} required className="mt-2 w-full rounded-field border border-app-border px-3 py-2.5 text-sm app-field">
            <option value="">请选择供应商</option>
            {eligibleProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · 配置版本 {provider.configurationVersion}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-app-muted">模型 ID
          <input value={modelId} onChange={(event) => setModelId(event.target.value)} required className="mt-2 w-full rounded-field border border-app-border px-3 py-2.5 text-sm app-field" />
        </label>
        {operation === "embedding" ? <label className="text-xs font-semibold text-app-muted">向量维度（必须精确匹配供应商）
          <input type="number" min={8} max={8192} value={embeddingDimensions} onChange={(event) => setEmbeddingDimensions(event.target.value)} required className="mt-2 w-full rounded-field border border-app-border px-3 py-2.5 text-sm app-field" />
        </label> : <label className="text-xs font-semibold text-app-muted">最大输出 Token
          <input type="number" min={1} max={65536} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} required className="mt-2 w-full rounded-field border border-app-border px-3 py-2.5 text-sm app-field" />
        </label>}
        <label className="text-xs font-semibold text-app-muted">倍率
          <input type="number" min={0.0001} max={10} step={0.0001} value={quotaMultiplier} onChange={(event) => setQuotaMultiplier(event.target.value)} required className="mt-2 w-full rounded-field border border-app-border px-3 py-2.5 text-sm app-field" />
          <span className="mt-1 block text-[12px] font-normal text-app-muted">按倍数填写；当前值 {draftQuotaMultiplierBps === null ? "待填写" : `${formatMultiplier(draftQuotaMultiplierBps)}×（${draftQuotaMultiplierBps} bps）`}。</span>
        </label>
        <div className="flex items-end gap-2"><button disabled={pending || providerId === ""} className="min-w-0 flex-1 rounded-control px-4 py-3 text-sm font-semibold disabled:opacity-40 app-button-primary">{pending ? "处理中…" : editingRouteId === null ? "创建路由草稿" : "保存草稿修改"}</button>{editingRouteId !== null ? <button type="button" disabled={pending} onClick={cancelDraftEdit} className="rounded-control border border-app-border px-4 py-3 text-sm font-semibold text-app-muted disabled:opacity-40">取消编辑</button> : null}</div>
      </form> : <p className="mt-6 rounded-panel border border-app-accent-border bg-app-surface px-5 py-4 text-xs leading-5 text-app-muted">路由写入已关闭。请前往 <a href="/admin/models" className="font-semibold text-app-link underline underline-offset-2">平台能力配置</a> 完成选择、真实测试和启用。</p>}

      {message ? <p role="status" className="mt-4 rounded-field bg-app-surface px-4 py-3 text-sm text-app-text app-feedback-info"><UiFeedbackText text={message} /></p> : null}

      <div className="mt-7 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {OPERATIONS.map((entry) => {
          const state = readiness?.[entry];
          return <article key={entry} className="rounded-panel border border-app-border bg-app-surface p-4 app-panel"><p className="text-xs font-semibold text-app-muted">{operationLabels[entry]}</p><p className={`mt-2 text-sm font-semibold ${state?.code === "ready" ? "text-app-success-ink" : "text-app-warning-ink"}`}>{state ? readinessLabels[state.code] : "读取中…"}</p><p className="mt-1 text-xs text-app-muted">就绪的 active 路由会被 Web AI 有效路由解析采用；真实模型调用需另行现场验收</p></article>;
        })}
      </div>

      <div className="mt-7 space-y-3">
        {routes.length === 0 ? <div className="rounded-panel border border-dashed border-app-accent-border bg-app-surface p-8 text-center text-sm text-app-muted">尚无路由草稿。创建前请先添加并测试一个平台供应商。</div> : routes.map((route) => {
          const provider = providers.find((entry) => entry.id === route.providerConnectionId);
          return <article key={route.id} className="rounded-panel border border-app-border bg-app-surface p-5 app-panel">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold text-app-text">{operationLabels[route.operation]} · v{route.version}</h3><p className="mt-1 text-xs text-app-muted">{route.modelId} · 倍率 {formatMultiplier(route.quotaMultiplierBps)}×（{route.quotaMultiplierBps} bps） · {routeStatusLabels[route.status]}</p><p className="mt-1 text-xs text-app-muted">供应商：{provider?.name ?? "未知"} · 当前配置版本 {provider?.configurationVersion ?? "未知"} · 已验证版本 {route.validatedProviderConfigurationVersion ?? "未验证"} · {provider?.status ?? "未知"}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${routeValidationLabel(route, provider) === "已验证" ? "bg-app-success-soft text-app-success-ink" : routeValidationLabel(route, provider) === "未验证" ? "bg-app-surface-soft text-app-muted" : "bg-app-warning-soft text-app-warning-ink"}`}>{routeValidationLabel(route, provider)}</span></div>
            <div className="mt-4"><ScopeEvidenceCard title="路由配置边界" evidence={{ scope: `平台默认 · ${operationLabels[route.operation]}`, owner: "平台管理员", payer: "平台额度，由当前发起人扣减", affectedProjects: impact?.routeId === route.id ? `当前影响 ${impact.indexImpact.affectedProjectCount} 个项目` : "可能影响所有未采用个人委派的项目；精确数量请查看影响", latestSuccess: route.validatedAt ? `最近本地验证：${formatUiDateTime(new Date(route.validatedAt), language, { dateStyle: "medium", timeStyle: "short" })}` : "尚未完成本地验证" }} /></div>
            <div className="mt-4 flex flex-wrap gap-2">{!readOnly ? <><button type="button" disabled={pending || route.status !== "draft"} onClick={() => editDraft(route)} className="rounded-control border border-app-border px-3 py-2 text-xs font-semibold text-app-muted disabled:opacity-40">编辑草稿</button><button type="button" disabled={pending || route.status !== "draft"} onClick={() => void lifecycle(route, "validate")} className="rounded-control px-3 py-2 text-xs font-semibold disabled:opacity-40 app-button-primary">本地验证</button><button type="button" disabled={pending || route.status !== "verified"} onClick={() => void lifecycle(route, "activate")} className="rounded-control px-3 py-2 text-xs font-semibold disabled:opacity-40 app-button-primary">激活控制面路由</button><button type="button" disabled={pending || route.status === "retired"} onClick={() => void lifecycle(route, "retire")} className="rounded-control border border-app-border px-3 py-2 text-xs font-semibold text-app-muted disabled:opacity-40">停用</button></> : null}<button type="button" disabled={pending} onClick={() => void showImpact(route)} className="rounded-control border border-app-accent-border px-3 py-2 text-xs font-semibold text-app-link disabled:opacity-40">查看影响</button></div>
          </article>;
        })}
      </div>

      {impact ? <section className="mt-5 rounded-panel border app-panel-accent bg-app-surface p-5 app-panel" aria-live="polite"><h3 className="text-sm font-semibold text-app-text">影响预览 · {operationLabels[impact.operation]}</h3><p className="mt-2 text-xs text-app-muted">运行时状态：已接入 Web AI 有效路由解析；仅 active 且就绪的路由会影响后续运行。本页不会执行真实模型调用，也不会重建、删除或切换索引。</p><div className="mt-3 space-y-1 text-xs leading-5 text-app-muted">{operationImpactSummary(impact).map((summary) => <p key={summary}>{summary}</p>)}</div></section> : null}
      <details className="mt-7 rounded-panel border border-app-border bg-app-surface p-5"><summary className="cursor-pointer text-sm font-semibold text-app-text">最近控制面审计（仅安全快照）</summary><div className="mt-4 space-y-3">{audits.length === 0 ? <p className="text-xs text-app-muted">暂无审计记录。</p> : audits.map((audit) => <div key={audit.id} className="border-b border-app-border pb-3 text-xs text-app-muted"><p className="font-semibold text-app-text">{audit.action} · {operationLabels[audit.operation]} · v{audit.routeVersion}</p><p className="mt-1">Provider 配置版本 {audit.providerConfigurationVersion} · {audit.reason ?? "无原因"}</p></div>)}</div></details>
      {dialog}
    </section>
  );
}
