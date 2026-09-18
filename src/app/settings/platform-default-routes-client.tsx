"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";

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

export function PlatformDefaultRoutesPanel({ refreshToken = 0, onRouteMutation }: { refreshToken?: number; onRouteMutation?: () => void }) {
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
        title: `退役「${operationLabels[route.operation]} · v${route.version}」？`,
        description: "退役只影响控制面状态，不会切换或删除现有项目路由；请填写原因以便审计追踪。",
        inputLabel: "退役原因（必填）",
        inputPlaceholder: "例如：供应商配置更新，准备验证新版本",
        inputOptional: false,
        confirmLabel: "确认退役",
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
      setMessage(action === "validate" ? "本地配置合同验证通过；尚未发送网络请求。" : action === "activate" ? "控制面路由已激活；后续 Web AI 有效路由解析会采用它。真实模型调用未在此页面现场验证。" : "路由已退役。");
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
    <section className="mt-10 rounded-3xl border border-indigo-200 bg-indigo-50/60 p-7 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-indigo-100 pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-700">Platform default routes</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">平台默认模型路由控制面</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">这里仅配置、验证和审计平台默认路由。已激活且通过门禁的 active 路由会被当前 Web AI 有效路由解析采用；本页不宣称真实模型调用已现场验证。普通用户按平台额度使用这些默认路由。</p>
        </div>
        <span className="rounded-full bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-800">Web AI 路由解析已接入</span>
      </div>

      {providersLoaded && eligibleProviders.length === 0 ? <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4" role="status"><div><p className="text-sm font-semibold text-amber-900">尚无已验证的平台供应商</p><p className="mt-1 text-xs leading-5 text-amber-800">先配置并测试一个平台模型连接，才能创建默认路由。</p></div><a href="/admin/models?returnTo=%2Fadmin%2Fmodels%2Froutes" className="inline-flex min-h-10 items-center rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700">去配置平台模型</a></div> : null}

      <form onSubmit={saveDraft} className="mt-6 grid gap-4 rounded-2xl border border-white/80 bg-white p-5 shadow-sm lg:grid-cols-2">
        <label className="text-xs font-semibold text-slate-600">操作
          <select value={operation} disabled={editingRouteId !== null} onChange={(event) => changeOperation(event.target.value as Operation)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm disabled:bg-slate-100 disabled:text-slate-400">
            {OPERATIONS.map((entry) => <option key={entry} value={entry}>{operationLabels[entry]}</option>)}
          </select>
          {editingRouteId !== null ? <span className="mt-1 block text-[12px] font-normal text-slate-400">编辑草稿时操作固定；如需其他操作，请取消编辑后新建。</span> : null}
        </label>
        <label className="text-xs font-semibold text-slate-600">有效平台供应商
          <select value={providerId} onChange={(event) => changeProvider(event.target.value)} required className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm">
            <option value="">请选择供应商</option>
            {eligibleProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · 配置版本 {provider.configurationVersion}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">模型 ID
          <input value={modelId} onChange={(event) => setModelId(event.target.value)} required className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" />
        </label>
        {operation === "embedding" ? <label className="text-xs font-semibold text-slate-600">向量维度（必须精确匹配供应商）
          <input type="number" min={8} max={8192} value={embeddingDimensions} onChange={(event) => setEmbeddingDimensions(event.target.value)} required className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" />
        </label> : <label className="text-xs font-semibold text-slate-600">最大输出 Token
          <input type="number" min={1} max={65536} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} required className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" />
        </label>}
        <label className="text-xs font-semibold text-slate-600">倍率
          <input type="number" min={0.0001} max={10} step={0.0001} value={quotaMultiplier} onChange={(event) => setQuotaMultiplier(event.target.value)} required className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm" />
          <span className="mt-1 block text-[12px] font-normal text-slate-400">按倍数填写；当前值 {draftQuotaMultiplierBps === null ? "待填写" : `${formatMultiplier(draftQuotaMultiplierBps)}×（${draftQuotaMultiplierBps} bps）`}。</span>
        </label>
        <div className="flex items-end gap-2"><button disabled={pending || providerId === ""} className="min-w-0 flex-1 rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">{pending ? "处理中…" : editingRouteId === null ? "创建路由草稿" : "保存草稿修改"}</button>{editingRouteId !== null ? <button type="button" disabled={pending} onClick={cancelDraftEdit} className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-600 disabled:opacity-40">取消编辑</button> : null}</div>
      </form>

      {message ? <p role="status" className="mt-4 rounded-xl bg-white px-4 py-3 text-sm text-slate-700">{message}</p> : null}

      <div className="mt-7 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {OPERATIONS.map((entry) => {
          const state = readiness?.[entry];
          return <article key={entry} className="rounded-2xl border border-white/80 bg-white p-4"><p className="text-xs font-semibold text-slate-500">{operationLabels[entry]}</p><p className={`mt-2 text-sm font-semibold ${state?.code === "ready" ? "text-emerald-700" : "text-amber-700"}`}>{state ? readinessLabels[state.code] : "读取中…"}</p><p className="mt-1 text-xs text-slate-500">就绪的 active 路由会被 Web AI 有效路由解析采用；真实模型调用需另行现场验收</p></article>;
        })}
      </div>

      <div className="mt-7 space-y-3">
        {routes.length === 0 ? <div className="rounded-2xl border border-dashed border-indigo-200 bg-white/70 p-8 text-center text-sm text-slate-500">尚无路由草稿。创建前请先添加并测试一个平台供应商。</div> : routes.map((route) => {
          const provider = providers.find((entry) => entry.id === route.providerConnectionId);
          return <article key={route.id} className="rounded-2xl border border-white/80 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-900">{operationLabels[route.operation]} · v{route.version}</h3><p className="mt-1 text-xs text-slate-500">{route.modelId} · 倍率 {formatMultiplier(route.quotaMultiplierBps)}×（{route.quotaMultiplierBps} bps） · {route.status}</p><p className="mt-1 text-xs text-slate-500">供应商：{provider?.name ?? "未知"} · 当前配置版本 {provider?.configurationVersion ?? "未知"} · 已验证版本 {route.validatedProviderConfigurationVersion ?? "未验证"} · {provider?.status ?? "未知"}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${routeValidationLabel(route, provider) === "已验证" ? "bg-emerald-50 text-emerald-700" : routeValidationLabel(route, provider) === "未验证" ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-800"}`}>{routeValidationLabel(route, provider)}</span></div>
            <div className="mt-4"><ScopeEvidenceCard title="路由配置边界" evidence={{ scope: `平台默认 · ${operationLabels[route.operation]}`, owner: "平台管理员", payer: "平台额度，由当前发起人扣减", affectedProjects: impact?.routeId === route.id ? `当前影响 ${impact.indexImpact.affectedProjectCount} 个项目` : "可能影响所有未采用个人委派的项目；精确数量请查看影响", latestSuccess: route.validatedAt ? `最近本地验证：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(route.validatedAt))}` : "尚未完成本地验证" }} /></div>
            <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={pending || route.status !== "draft"} onClick={() => editDraft(route)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40">编辑草稿</button><button type="button" disabled={pending || route.status !== "draft"} onClick={() => void lifecycle(route, "validate")} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">本地验证</button><button type="button" disabled={pending || route.status !== "verified"} onClick={() => void lifecycle(route, "activate")} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">激活控制面路由</button><button type="button" disabled={pending || route.status === "retired"} onClick={() => void lifecycle(route, "retire")} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40">退役</button><button type="button" disabled={pending} onClick={() => void showImpact(route)} className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-40">查看影响</button></div>
          </article>;
        })}
      </div>

      {impact ? <section className="mt-5 rounded-2xl border border-indigo-100 bg-white p-5" aria-live="polite"><h3 className="text-sm font-semibold text-slate-900">影响预览 · {operationLabels[impact.operation]}</h3><p className="mt-2 text-xs text-slate-500">运行时状态：已接入 Web AI 有效路由解析；仅 active 且就绪的路由会影响后续运行。本页不会执行真实模型调用，也不会重建、删除或切换索引。</p><div className="mt-3 space-y-1 text-xs leading-5 text-slate-600">{operationImpactSummary(impact).map((summary) => <p key={summary}>{summary}</p>)}</div></section> : null}
      <details className="mt-7 rounded-2xl border border-white/80 bg-white p-5"><summary className="cursor-pointer text-sm font-semibold text-slate-800">最近控制面审计（仅安全快照）</summary><div className="mt-4 space-y-3">{audits.length === 0 ? <p className="text-xs text-slate-500">暂无审计记录。</p> : audits.map((audit) => <div key={audit.id} className="border-b border-slate-100 pb-3 text-xs text-slate-600"><p className="font-semibold text-slate-800">{audit.action} · {operationLabels[audit.operation]} · v{audit.routeVersion}</p><p className="mt-1">Provider 配置版本 {audit.providerConfigurationVersion} · {audit.reason ?? "无原因"}</p></div>)}</div></details>
      {dialog}
    </section>
  );
}
