"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { AppHeader } from "@/components/app-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { AdminPageHeader } from "@/components/admin-page-header";
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

const PLATFORM_OPERATIONS = ["embedding", "visionExtract", "autoExtract", "sourceSummary", "projectAnalysis", "generateWithContext"] as const;
type PlatformOperation = typeof PLATFORM_OPERATIONS[number];
type PlatformOperationCandidate = Readonly<{ providerConnectionId: string; providerName: string; providerKind: ProviderKind; modelId: string; embeddingDimensions: number | null; maxOutputTokens: number | null }>;
type PlatformOperationView = Readonly<{
  operations: readonly PlatformOperation[];
  candidates: Record<PlatformOperation, Readonly<{ readiness: string; active: Readonly<{ id: string; version: number; providerConnectionId: string; modelId: string; embeddingDimensions: number | null; maxOutputTokens: number | null; quotaMultiplierBps: number; validatedAt: string | null }> | null; candidates: readonly PlatformOperationCandidate[] }>>;
}>;

const operationLabels: Record<PlatformOperation, string> = {
  embedding: "向量检索",
  visionExtract: "图片识别",
  autoExtract: "自动抽取",
  sourceSummary: "资料摘要",
  projectAnalysis: "项目分析",
  generateWithContext: "带上下文生成",
};

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
  if (messages.length === 0) {
    const code = check.attempt.safeErrorCode;
    const detail = code === "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED"
      ? "尚未启用连接测试额度，请先创建测试预算周期。"
      : code === "PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED"
        ? "连接测试额度不足；请创建新的测试预算周期后重试。"
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
                      : "连接测试未通过，请检查模型配置和供应商状态后重试。";
    return `${detail}${code ? `（安全码：${code}）` : ""}`;
  }
  return messages.join("；");
}

function requiredProbeUnits(provider: Provider, catalog?: ProviderCatalogEntry): number {
  let units = provider.defaultGenerationModelId === null ? 0 : 1;
  if (provider.defaultEmbeddingModelId !== null && provider.embeddingDimensions !== null) units += 1;
  if (provider.defaultVisionModelId !== null && catalog?.supportsVision === true) units += 1;
  return units;
}

function probeBudgetMessage(budget: ProbeBudgetSummary | null, requiredUnits: number): string | null {
  if (requiredUnits === 0) return `请先为该连接配置至少一个可测试模型，再执行连接测试。`;
  if (budget === null) return "连接测试需要平台探测预算，请先配置预算。";
  if (budget.status === "scheduled") return "平台探测预算尚未生效，请检查开始时间。";
  if (budget.status === "expired") return "平台探测预算已过期，请先创建新的测试预算周期。";
  if (budget.availableUnits < requiredUnits) return `平台探测预算可用单位不足（需要 ${requiredUnits}，当前 ${budget.availableUnits}），请先创建新的测试预算周期。`;
  return null;
}

const statusLabel = {
  configured: "待验证",
  verified: "已验证",
  error: "验证失败",
  disabled: "已停用",
} as const;

export function SettingsClient({ username, canManageProviders, activeMembership, membershipStatus, adminMode = false }: { username: string; canManageProviders: boolean; activeMembership: boolean; membershipStatus: "active" | "expired" | "revoked" | "none"; adminMode?: boolean }) {
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [probeBudget, setProbeBudget] = useState<ProbeBudgetSummary | null>(null);
  const [probeBudgetLoading, setProbeBudgetLoading] = useState(adminMode);
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
      if (adminMode) {
        setProbeBudgetLoading(true);
        const budgetResponse = await fetch("/api/admin/platform-provider-probe/budget", { cache: "no-store" });
        if (budgetResponse.ok) {
          const budgetPayload = await budgetResponse.json() as { budget: ProbeBudgetSummary | null };
          setProbeBudget(budgetPayload.budget);
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "供应商配置加载失败");
    } finally {
      setLoading(false);
      if (adminMode) setProbeBudgetLoading(false);
    }
  }, [adminMode]);

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
        <AdminPageHeader title="平台模型" description="先查看当前已配置连接；新增供应商时填写官方固定端点的模型与密钥配置。连接测试会单独消耗探测预算。" actions={canManageProviders ? <button ref={createTriggerRef} type="button" onClick={() => setCreateOpen(true)} className="inline-flex min-h-10 items-center rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">新增供应商</button> : undefined} />

        {!canManageProviders ? <section className="mt-7 rounded-3xl border border-indigo-200 bg-indigo-50/70 p-7"><h2 className="text-xl font-semibold">平台模型由系统管理员管理</h2><p className="mt-3 text-sm leading-7 text-slate-600">普通用户可以使用平台额度和平台默认模型，不会请求或查看平台供应商接口。{activeMembership ? "当前会员有效，你可以在个人账号中配置自己的模型连接。" : membershipStatus === "expired" ? "会员资格已到期；重新获得资格后才可配置个人模型。" : membershipStatus === "revoked" ? "会员资格已撤销；重新获得资格后才可配置个人模型。" : "如需配置个人模型，请在个人中心提交会员申请。"}</p>{activeMembership ? <a href="/profile/models" className="mt-5 inline-flex rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white">配置个人模型</a> : null}</section> : null}
        {canManageProviders && error ? <div role="alert" className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}

        {canManageProviders ? <section className="mt-5 space-y-4">
          <div className="flex items-end justify-between px-1">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Connections</p>
              <h2 className="mt-2 text-2xl font-semibold">已配置连接</h2>
            </div>
            <span className="text-xs text-slate-400">{loading ? "读取中…" : `${providers.length} 个`}</span>
          </div>
          {loading ? <div className="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-500">读取中…</div> : providers.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center text-sm text-slate-500">尚未配置供应商。<button type="button" onClick={() => setCreateOpen(true)} className="ml-1 font-semibold text-indigo-700 underline underline-offset-2">新增供应商</button></div>
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
        </section> : null}

        {canManageProviders ? <PlatformOperationCards /> : null}

        {adminMode ? <section className="mt-6 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-5" aria-labelledby="platform-probe-budget-summary-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="platform-probe-budget-summary-title" className="text-base font-semibold text-slate-950">连接测试额度</h2>
              <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-600">每测试一个已配置能力（生成、向量或图片识别）消耗 1 个单位。该额度只控制连接测试的外部流量和成本，不是用户 Token 额度，也不会启用或切换默认路由。</p>
            </div>
            <a href="/admin/operations/probes" className="shrink-0 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:border-indigo-400 hover:bg-indigo-50">更新测试额度</a>
          </div>
          {probeBudgetLoading ? <p className="mt-4 text-xs text-slate-500">读取当前测试额度…</p> : probeBudget ? <dl className="mt-4 grid gap-3 rounded-xl bg-white/80 p-4 text-xs sm:grid-cols-4"><div><dt className="text-slate-400">可用单位</dt><dd className="mt-1 font-semibold text-slate-800">{probeBudget.availableUnits} / {probeBudget.unitLimit}</dd></div><div><dt className="text-slate-400">已结算 / 待核对</dt><dd className="mt-1 font-semibold text-slate-800">{probeBudget.settledUnits} / {probeBudget.heldUnits}</dd></div><div><dt className="text-slate-400">预算版本</dt><dd className="mt-1 font-semibold text-slate-800">{probeBudget.version} · {probeBudget.status === "active" ? "已启用" : probeBudget.status === "scheduled" ? "待生效" : "已过期"}</dd></div><div><dt className="text-slate-400">有效期</dt><dd className="mt-1 font-semibold text-slate-800">{dateLabel(probeBudget.startsAt)} — {dateLabel(probeBudget.expiresAt)}</dd></div></dl> : <p className="mt-4 rounded-xl bg-white/80 px-4 py-3 text-xs text-amber-800">尚未启用连接测试额度；配置后才能验证供应商连接。</p>}
        </section> : null}

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

function PlatformOperationCards() {
  const [view, setView] = useState<PlatformOperationView | null>(null);
  const [selection, setSelection] = useState<Partial<Record<PlatformOperation, string>>>({});
  const [proofs, setProofs] = useState<Partial<Record<PlatformOperation, { probeId: string; clientRequestKey: string }>>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/platform-ai-operations", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "平台能力配置加载失败"));
      const payload = await response.json() as PlatformOperationView;
      setView(payload);
      setSelection((current) => {
        const next = { ...current };
        for (const operation of PLATFORM_OPERATIONS) {
          if (next[operation] === undefined) next[operation] = payload.candidates[operation].active?.providerConnectionId ?? payload.candidates[operation].candidates[0]?.providerConnectionId;
        }
        return next;
      });
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "平台能力配置加载失败");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function selectedCandidate(operation: PlatformOperation): PlatformOperationCandidate | undefined {
    const candidates = view?.candidates[operation].candidates ?? [];
    return candidates.find((candidate) => candidate.providerConnectionId === selection[operation]) ?? candidates[0];
  }

  async function probe(operation: PlatformOperation): Promise<void> {
    const candidate = selectedCandidate(operation);
    if (candidate === undefined) return;
    const clientRequestKey = crypto.randomUUID();
    setPending(`${operation}:probe`);
    setMessage(null);
    try {
      const response = await fetch(`/api/settings/platform-ai-operations/${operation}/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestKey, providerConnectionId: candidate.providerConnectionId, modelId: candidate.modelId, embeddingDimensions: candidate.embeddingDimensions, maxOutputTokens: candidate.maxOutputTokens, quotaMultiplierBps: 10_000 }),
      });
      if (!response.ok) throw new Error(await readError(response, "能力模型测试失败"));
      const payload = await response.json() as { probeId: string | null; safeErrorCode: string | null };
      if (payload.probeId === null) throw new Error(payload.safeErrorCode ?? "能力模型测试未通过");
      setProofs((current) => ({ ...current, [operation]: { probeId: payload.probeId as string, clientRequestKey } }));
      setMessage(`${operationLabels[operation]}真实测试通过，可以启用。`);
    } catch (error) {
      setProofs((current) => { const next = { ...current }; delete next[operation]; return next; });
      setMessage(error instanceof Error ? error.message : "能力模型测试失败");
    } finally {
      setPending(null);
    }
  }

  async function apply(operation: PlatformOperation): Promise<void> {
    const candidate = selectedCandidate(operation);
    const proof = proofs[operation];
    if (candidate === undefined || proof === undefined) return;
    let confirmEmbeddingImpact = true;
    if (operation === "embedding") {
      const confirmation = await confirm({
        eyebrow: "向量能力",
        title: "确认启用新的向量模型？",
        description: "切换向量模型或维度可能影响现有索引。请确认已安排相关索引重建；停用后不可恢复，需要新建配置或版本。",
        confirmLabel: "确认启用",
        cancelLabel: "取消",
        tone: "warning",
      });
      confirmEmbeddingImpact = confirmation.confirmed;
    }
    if (!confirmEmbeddingImpact) return;
    setPending(`${operation}:apply`);
    setMessage(null);
    try {
      const response = await fetch(`/api/settings/platform-ai-operations/${operation}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ probeId: proof.probeId, clientRequestKey: proof.clientRequestKey, providerConnectionId: candidate.providerConnectionId, modelId: candidate.modelId, embeddingDimensions: candidate.embeddingDimensions, maxOutputTokens: candidate.maxOutputTokens, quotaMultiplierBps: 10_000, confirmEmbeddingImpact }),
      });
      if (!response.ok) throw new Error(await readError(response, "能力启用失败"));
      setProofs((current) => { const next = { ...current }; delete next[operation]; return next; });
      await load();
      setMessage(`${operationLabels[operation]}已启用。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "能力启用失败");
    } finally {
      setPending(null);
    }
  }

  return <><section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="platform-operation-cards-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Capability configuration</p><h2 id="platform-operation-cards-title" className="mt-2 text-xl font-semibold text-slate-950">平台能力配置</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-slate-500">候选仅来自已验证且启用的连接。每项能力都必须用选定模型完成一次真实测试后才能启用；此处不展示供应商全量目录。</p></div>
      <button type="button" onClick={() => void load()} disabled={pending !== null} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50">刷新能力</button>
    </div>
    <div className="mt-5 grid gap-3 lg:grid-cols-2">
      {PLATFORM_OPERATIONS.map((operation) => {
        const group = view?.candidates[operation];
        const candidate = selectedCandidate(operation);
        const proof = proofs[operation];
        const active = group?.active ?? null;
        const activeCandidate = active === null ? undefined : group?.candidates.find((item) => item.providerConnectionId === active.providerConnectionId && item.modelId === active.modelId);
        const configured = active !== null;
        return <article key={operation} className={`rounded-2xl border p-4 ${configured ? "border-slate-200 bg-white" : view === null ? "border-slate-200 bg-white" : "border-amber-200 bg-amber-50/60"}`} data-operation={operation}>
          <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold text-slate-900">{operationLabels[operation]}</h3><p className={`mt-1 text-xs ${configured ? "text-emerald-700" : view === null ? "text-slate-500" : "text-amber-800"}`}>{configured ? "已配置并生效" : view === null ? "读取配置中…" : "未配置生效模型"}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${configured ? "bg-emerald-50 text-emerald-700" : view === null ? "bg-slate-100 text-slate-500" : "bg-amber-100 text-amber-900"}`}>{operation}</span></div>
          {configured ? <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">当前生效模型：{activeCandidate ? `${activeCandidate.providerName} · ` : ""}{active.modelId}{active.embeddingDimensions ? ` · ${active.embeddingDimensions} 维` : ""}</p> : view !== null ? <p className="mt-3 rounded-xl border border-amber-200 bg-white/70 px-3 py-2 text-xs leading-5 text-amber-900">尚未配置当前生效模型；测试通过后才能启用。</p> : null}
          <label className="mt-4 block text-xs font-medium text-slate-600">选择已验证连接与能力模型<select value={selection[operation] ?? ""} onChange={(event) => { setSelection((current) => ({ ...current, [operation]: event.target.value })); setProofs((current) => { const next = { ...current }; delete next[operation]; return next; }); }} disabled={pending !== null || (group?.candidates.length ?? 0) === 0} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-400">{group?.candidates.length ? group.candidates.map((item) => <option key={`${item.providerConnectionId}:${item.modelId}`} value={item.providerConnectionId}>{item.providerName} · {item.providerKind} · {item.modelId}{item.embeddingDimensions ? ` · ${item.embeddingDimensions} 维` : ""}</option>) : <option value="">暂无合格候选</option>}</select></label>
          {candidate ? <p className="mt-3 text-xs text-slate-500">当前选择：{candidate.providerName} / {candidate.providerKind} / {candidate.modelId}{candidate.embeddingDimensions ? ` · ${candidate.embeddingDimensions} 维` : ""}</p> : null}
          <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => void probe(operation)} disabled={pending !== null || candidate === undefined} className="rounded-xl border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-40">{pending === `${operation}:probe` ? "测试中…" : "测试所选模型"}</button><button type="button" onClick={() => void apply(operation)} disabled={pending !== null || proof === undefined} className="rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{pending === `${operation}:apply` ? "启用中…" : "启用能力"}</button></div>
          {proof ? <p className="mt-3 text-xs font-semibold text-emerald-700">真实测试证明有效，可启用</p> : null}
        </article>;
      })}
    </div>
    {message ? <p role="status" className="mt-4 text-xs leading-5 text-slate-600">{message}</p> : null}
  </section>{dialog}</>;
}

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
    <button type="button" aria-label="关闭新增供应商" tabIndex={-1} onClick={close} className="absolute inset-0 bg-slate-950/50" />
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="provider-create-dialog-title" aria-describedby="provider-create-dialog-description" className="relative z-10 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-slate-950 shadow-2xl shadow-slate-950/30">
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-6 py-5 text-white sm:px-7">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">New connection</p>
          <h2 id="provider-create-dialog-title" className="mt-2 text-2xl font-semibold">新增供应商</h2>
          <p id="provider-create-dialog-description" className="mt-2 text-xs leading-5 text-slate-300">使用官方固定端点先测试未保存凭据，测试成功后才能保存为已验证连接。</p>
        </div>
        <button ref={closeRef} type="button" aria-label="关闭新增供应商" onClick={close} disabled={pending} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/10 disabled:opacity-50">关闭</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-7 sm:px-7">
        <ProviderCreateForm catalog={catalog} onCreated={onCreated} onPendingChange={setPending} />
      </div>
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
    <form onSubmit={submit} className="pt-6 text-white">
      <Field label="供应商">
        <select value={kind} onChange={(event) => chooseKind(event.target.value as ProviderKind)} className="dark-field">
          {catalog.map((entry) => <option key={entry.kind} value={entry.kind}>{entry.displayName}</option>)}
        </select>
      </Field>
      <Field label="连接名称"><input value={name} onChange={(event) => { clearProof(); setName(event.target.value); }} maxLength={80} required className="dark-field" /></Field>
      <Field label={definition?.apiKeyLabel ?? "API Key"}><input type="password" value={apiKey} onChange={(event) => { clearProof(); setApiKey(event.target.value); }} autoComplete="new-password" maxLength={512} required className="dark-field" /></Field>
      <Field label="生成模型（可选）"><input list={`generation-${kind}`} value={generationModelId} onChange={(event) => { clearProof(); setGenerationModelId(event.target.value); }} className="dark-field" /></Field>
      <datalist id={`generation-${kind}`}>{definition?.generationModelSuggestions.map((id) => <option key={id} value={id} />)}</datalist>
      {definition?.supportsVision ? <><Field label="图片识别模型（可选）"><input list={`vision-${kind}`} value={visionModelId} onChange={(event) => { clearProof(); setVisionModelId(event.target.value); }} className="dark-field" /></Field><datalist id={`vision-${kind}`}>{definition.visionModelSuggestions.map((id) => <option key={id} value={id} />)}</datalist></> : null}
      {definition?.supportsEmbeddings ? (
        <>
          <label className="mt-5 flex items-center gap-3 text-sm text-slate-200"><input type="checkbox" checked={embeddingEnabled} onChange={(event) => { clearProof(); setEmbeddingEnabled(event.target.checked); }} /> 同时配置向量模型</label>
          {embeddingEnabled ? <div className="grid grid-cols-[1fr_7rem] gap-3"><Field label="向量模型"><input list={`embedding-${kind}`} value={embeddingModelId} onChange={(event) => { clearProof(); chooseEmbeddingModel(event.target.value); }} required className="dark-field" /></Field><Field label="维度"><input type="number" min={8} max={8192} value={embeddingDimensions} onChange={(event) => { clearProof(); setEmbeddingDimensions(event.target.value); }} required className="dark-field" /></Field></div> : null}
          <datalist id={`embedding-${kind}`}>{definition.embeddingModelSuggestions.map((item) => <option key={item.id} value={item.id} />)}</datalist>
        </>
      ) : <p className="mt-5 rounded-xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-xs leading-5 text-amber-100">DeepSeek 当前作为生成供应商使用；语义索引需为项目另选 OpenAI、Qwen 或 GLM。</p>}
      <div className="mt-5 rounded-xl border border-white/10 bg-white/[.06] px-4 py-3 text-xs leading-5 text-slate-300">
        <p className="font-semibold text-slate-100">能力说明</p>
        <p className="mt-1">生成模型用于文本、摘要和计划；图片识别模型可选，留空即关闭；向量模型可选，维度必须匹配，切换模型或维度后需重建相关索引。API Key 只在服务端加密保存；连接测试会单独消耗平台探测预算。</p>
        {definition ? <div className="mt-3 space-y-1 text-slate-400"><p>生成推荐：{definition.generationModelSuggestions.join("、") || "暂无"}</p><p>图片推荐：{definition.visionModelSuggestions.join("、") || "暂无"}</p><p>向量推荐：{definition.embeddingModelSuggestions.map((item) => `${item.id}（${item.dimensions} 维）`).join("、") || "暂无"}</p></div> : null}
      </div>
      {message ? <p className="mt-5 text-xs leading-5 text-slate-300" role="status">{message}</p> : null}
      <div className="mt-6 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => void testConnection()} disabled={pending || catalog.length === 0 || apiKey.trim().length < 8} className="rounded-xl border border-indigo-300 px-4 py-3 text-sm font-semibold text-indigo-100 transition hover:bg-white/10 disabled:opacity-50">{pending ? "处理中…" : "测试连接"}</button><button disabled={pending || catalog.length === 0 || proof === null} className="rounded-xl bg-indigo-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-300 disabled:opacity-50">{pending ? "保存中…" : "保存连接"}</button></div>
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
  const [probeBudgetHref, setProbeBudgetHref] = useState<string | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();
  const disableBlocked = provider.status !== "disabled" && provider._count.platformDefaultAiRoutes > 0;
  const disableBlockReasons = [
    provider._count.platformDefaultAiRoutes > 0 ? "活动默认路由" : null,
  ].filter((reason): reason is string => reason !== null).join("、");

  async function testConnection() {
    setTesting(true);
    setMessage(null);
    setProbeBudgetHref(null);
    try {
      const budgetResponse = await fetch("/api/admin/platform-provider-probe/budget", { cache: "no-store" });
      if (!budgetResponse.ok) throw new Error(await readError(budgetResponse, "平台探测预算读取失败，请稍后重试。"));
      const budgetPayload = await budgetResponse.json() as { budget: ProbeBudgetSummary | null };
      const budgetMessage = probeBudgetMessage(budgetPayload.budget, requiredProbeUnits(provider, catalog));
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
      {editing ? <form onSubmit={save} className="mt-5 grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-2"><EditField label="连接名称"><input value={name} onChange={(event) => setName(event.target.value)} required className="edit-field" /></EditField><EditField label="生成模型（可选）"><input value={generationModelId} onChange={(event) => setGenerationModelId(event.target.value)} className="edit-field" /></EditField>{catalog?.supportsVision ? <EditField label="图片识别模型（可选）"><input value={visionModelId} onChange={(event) => setVisionModelId(event.target.value)} className="edit-field" /></EditField> : null}{catalog?.supportsEmbeddings ? <><EditField label="向量模型（留空即关闭）"><input value={embeddingModelId} onChange={(event) => setEmbeddingModelId(event.target.value)} className="edit-field" /></EditField><EditField label="向量维度"><input type="number" value={embeddingDimensions} onChange={(event) => setEmbeddingDimensions(event.target.value)} disabled={!embeddingModelId} className="edit-field" /></EditField></> : null}<EditField label="替换 API Key（可选）"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" className="edit-field" /></EditField><div className="flex items-end gap-2"><button disabled={pending} className="rounded-xl bg-indigo-600 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50">保存变更</button><button type="button" onClick={() => void toggleEnabled()} disabled={pending || disableBlocked} title={disableBlocked ? `无法停用：${disableBlockReasons}仍在使用该连接` : undefined} className="rounded-xl border border-slate-200 px-4 py-3 text-xs font-semibold text-slate-600 disabled:opacity-40">{provider.status === "disabled" ? "重新启用" : "停用连接"}</button></div>{disableBlocked ? <p className="text-xs leading-5 text-amber-700 sm:col-span-2">无法停用：{disableBlockReasons}仍在使用该连接。请先移除项目路由或停用活动能力。</p> : null}<style jsx>{`.edit-field{margin-top:.4rem;width:100%;border-radius:.75rem;border:1px solid #e2e8f0;padding:.7rem .85rem;font-size:.8rem;outline:none}.edit-field:focus{border-color:#818cf8;box-shadow:0 0 0 2px #e0e7ff}`}</style></form> : null}
      {provider.status === "disabled" ? <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3"><p className="text-xs leading-5 text-rose-700">永久删除仅适用于没有活动平台默认路由或历史审计引用的连接，并会同时删除加密凭据。</p><button type="button" onClick={() => void removeConnection()} disabled={pending} className="rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">永久删除</button></div> : null}
      {message ? <p role="status" className="mt-4 text-xs leading-5 text-slate-600">{message}{probeBudgetHref ? <> <a href={probeBudgetHref} className="font-semibold text-indigo-700 underline underline-offset-2">配置探测预算</a></> : null}</p> : null}
      {provider.lastErrorCode ? <p className="mt-2 text-xs text-rose-600">最近一次连接测试未通过：{describeProviderCheck({ attempt: { status: "failed", safeErrorCode: provider.lastErrorCode, capabilities: { generation: "notConfigured", embedding: "notConfigured", vision: "notConfigured" }, embeddingDimensions: null } })}</p> : null}
    </article>{dialog}</>
  );
}

function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-slate-600">{label}{children}</label>;
}
