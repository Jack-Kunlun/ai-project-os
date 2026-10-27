"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UiText, useAppearance } from "@/components/appearance-provider";
import { UiFeedbackText } from "@/components/ui-error-text";
import { OperationPanel } from "@/components/operation-panel";
import { PlatformProbeBudgetClient, type ProbeBudgetSummary } from "@/app/admin/operations/probes/platform-probe-budget-client";
import { safeErrorPresentation, safeResponseError } from "@/lib/safe-error-presentation";
import { rememberSafeUiError } from "@/lib/safe-ui-error-cache";
import { PLATFORM_OPERATIONS, batchBudgetProblem, candidateKey, probeHttpFailureStatus, proofUsable, runOperationBatch, type BatchMode, type OperationCandidate, type OperationResult, type OperationTarget, type PlatformOperation, type ProbeOutcome } from "./platform-operation-batch";

type OperationView = { candidates: Record<PlatformOperation, {
  active: { providerConnectionId: string; modelId: string; embeddingDimensions: number | null } | null;
  candidates: OperationCandidate[];
}> };
type Plan = { mode: BatchMode; targets: readonly OperationTarget[]; embeddingImpact: boolean; available: number };
const labels: Record<PlatformOperation, string> = {
  embedding: "向量检索", visionExtract: "图片识别", autoExtract: "资料整理", sourceSummary: "资料摘要", projectAnalysis: "项目分析", generateWithContext: "带资料问答",
};
const purposes: Record<PlatformOperation, string> = {
  embedding: "将资料转成向量，供语义检索使用。", visionExtract: "识别图片中的文字与内容。", autoExtract: "从资料中提取可核对的事实。", sourceSummary: "概括单份资料的主要内容。", projectAnalysis: "基于项目资料生成分析结果。", generateWithContext: "结合资料生成回答与内容。",
};
const resultLabels = {
  queued: "等待执行", testing: "测试中…", passed: "测试通过，5 分钟内可启用", applying: "启用中…", enabled: "已测试并启用", failed: "测试未通过", applyFailed: "启用未成功，可重试启用", unknown: "测试结果待核对，未自动重试", applyUnknown: "启用结果待核对，请用“启用已通过项”确认", stopped: "未执行", expired: "测试结果已过期，请重新测试",
};
const buttonClass = "app-action-button rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-40";
const primaryClass = "app-action-button rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40";
const selectClass = "min-h-10 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 disabled:opacity-50";
const isUncertain = (result?: OperationResult) => result?.status === "unknown" || result?.status === "applyUnknown";

export function PlatformOperationAssignments({ providers, onBusyChange }: { providers: readonly { id: string; name: string; configurationVersion: number; status: string }[]; onBusyChange: (busy: boolean) => void }) {
  const { t } = useAppearance();
  const [view, setView] = useState<OperationView | null>(null);
  const [choices, setChoices] = useState<Partial<Record<PlatformOperation, string>>>({});
  const [selected, setSelected] = useState<PlatformOperation[]>([]);
  const [results, setResults] = useState<Partial<Record<PlatformOperation, OperationResult>>>({});
  const [budget, setBudget] = useState<ProbeBudgetSummary | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [bulkModel, setBulkModel] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [phase, setPhase] = useState<"confirm" | "running" | "done">("done");
  const [embeddingAck, setEmbeddingAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [, refreshProofClock] = useState(0);
  const lock = useRef(false);
  const executing = useRef(false);
  const stop = useRef(false);
  const initialized = useRef(false);
  const loadRequest = useRef(0);
  const providerRevision = providers.map((provider) => `${provider.id}:${provider.configurationVersion}:${provider.status}`).join(";");

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    const response = await fetch("/api/settings/platform-ai-operations", { cache: "no-store" }).catch((error: unknown) => {
      if (request === loadRequest.current) throw error;
      return null;
    });
    if (!response || request !== loadRequest.current) return;
    if (!response.ok) throw new Error((await safeResponseError(response, "平台能力配置加载失败")).message);
    const next = await response.json() as OperationView;
    if (request !== loadRequest.current) return;
    setView(next);
    setChoices((current) => {
      const updated = { ...current };
      for (const operation of PLATFORM_OPERATIONS) {
        if (updated[operation] !== undefined) continue;
        const group = next.candidates[operation];
        const initial = group.candidates.find((candidate) => candidate.providerConnectionId === group.active?.providerConnectionId && candidate.modelId === group.active?.modelId) ?? group.candidates[0];
        if (initial) updated[operation] = candidateKey(initial);
      }
      return updated;
    });
    if (!initialized.current) {
      initialized.current = true;
      setSelected(PLATFORM_OPERATIONS.filter((operation) => next.candidates[operation].active === null && next.candidates[operation].candidates.length > 0));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!lock.current) void load().catch((error: Error) => setMessage(error.message));
    }, 0);
    return () => { window.clearTimeout(timer); loadRequest.current += 1; };
  }, [load, providerRevision]);
  useEffect(() => () => { stop.current = true; }, []);
  const hasProof = Object.values(results).some((result) => result.proof !== undefined);
  useEffect(() => {
    if (!hasProof) return;
    const timer = window.setInterval(() => refreshProofClock((value) => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [hasProof]);

  function changeBusy(value: boolean) {
    lock.current = value;
    setBusy(value);
    onBusyChange(value);
  }
  function candidate(operation: PlatformOperation) {
    // A stale selection must be explicitly replaced; never silently test a different model.
    return view?.candidates[operation].candidates.find((item) => candidateKey(item) === choices[operation]);
  }
  function choose(operation: PlatformOperation, value: string) {
    if (lock.current || isUncertain(results[operation])) return;
    setChoices((current) => ({ ...current, [operation]: value }));
    setResults((current) => { const next = { ...current }; delete next[operation]; return next; });
  }
  function closePanel(open: boolean) {
    if (phase === "running") return;
    setPanelOpen(open);
    if (!open) changeBusy(false);
  }
  const passed = selected.filter((operation) => {
    const result = results[operation];
    return result?.proof && ["passed", "applyFailed", "applyUnknown"].includes(result.status) && candidate(operation) && candidateKey(result.target.candidate) === choices[operation] && (result.status === "applyUnknown" || proofUsable(result.proof));
  });

  async function prepare(mode: BatchMode) {
    if (lock.current) return;
    const operations = mode === "apply" ? passed : selected;
    if (operations.length === 0) return;
    if (mode !== "apply" && operations.some((operation) => isUncertain(results[operation]))) {
      setMessage("所选项目有结果待核对项，请先核对；不会再次发送测试。"); return;
    }
    if (operations.some((operation) => candidate(operation) === undefined)) {
      setMessage("所选模型已不可用，请重新选择已验证连接。你之前的配置尚未更改。"); return;
    }
    changeBusy(true);
    setMessage(null);
    try {
      let currentBudget = budget;
      if (mode !== "apply") {
        const response = await fetch("/api/admin/platform-provider-probe/budget", { cache: "no-store" });
        if (!response.ok) throw new Error((await safeResponseError(response, "测试额度读取失败")).message);
        currentBudget = (await response.json() as { budget: ProbeBudgetSummary | null }).budget;
        setBudget(currentBudget);
        const problem = batchBudgetProblem(currentBudget, operations.length);
        if (problem) { setMessage(problem); changeBusy(false); setBudgetOpen(true); return; }
      }
      let embeddingImpact = false;
      const targets = operations.map((operation): OperationTarget => {
        const picked = candidate(operation)!;
        const active = view?.candidates[operation].active;
        const changed = mode !== "test" && operation === "embedding" && active != null && (active.providerConnectionId !== picked.providerConnectionId || active.modelId !== picked.modelId || active.embeddingDimensions !== picked.embeddingDimensions);
        embeddingImpact ||= changed;
        return Object.freeze({ operation, candidate: Object.freeze({ ...picked }), proof: mode === "apply" ? results[operation]?.proof : undefined, confirmEmbeddingImpact: changed });
      });
      setPlan({ mode, targets: Object.freeze(targets), embeddingImpact, available: currentBudget?.availableUnits ?? 0 });
      setEmbeddingAck(false);
      setPhase("confirm");
      setPanelOpen(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "测试额度读取失败"); changeBusy(false);
    }
  }

  async function execute() {
    if (!plan || phase !== "confirm" || (plan.embeddingImpact && !embeddingAck)) return;
    // A synchronous guard prevents two clicks from dispatching the same batch before React renders.
    if (executing.current) return;
    executing.current = true;
    const targets = plan.targets;
    if (plan.mode === "apply" && targets.some((target) => results[target.operation]?.status !== "applyUnknown" && !proofUsable(target.proof))) {
      setMessage("部分测试结果已过期，请重新测试后再启用。"); setPhase("done"); changeBusy(false); executing.current = false; return;
    }
    setPhase("running");
    stop.current = false;
    setStopRequested(false);
    setResults((current) => ({ ...current, ...Object.fromEntries(targets.map((target) => [target.operation, { target, status: "queued" }])) }));
    try {
      await runOperationBatch(targets, plan.mode, {
        requestKey: () => crypto.randomUUID(), now: Date.now, shouldStop: () => stop.current,
        update: (result) => setResults((current) => ({ ...current, [result.target.operation]: result })),
        probe: async (target, clientRequestKey) => {
          const response = await fetch(`/api/settings/platform-ai-operations/${target.operation}/probe`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...target.candidate, providerName: undefined, providerKind: undefined, clientRequestKey, quotaMultiplierBps: 10_000 }),
          });
          if (!response.ok) {
            const status = probeHttpFailureStatus(response.status, await response.clone().json().catch(() => null));
            const error = await safeResponseError(response, "能力模型测试失败");
            return { status, probeId: null, expiresAt: null, safeErrorCode: error.code, message: error.message };
          }
          const result = await response.json() as ProbeOutcome;
          if (!["settled", "released", "rejected"].includes(result.status)) return { ...result, message: "测试请求结果未知，已暂停后续项。请联系管理员核对供应商记录，不要直接重发。" };
          if (!result.safeErrorCode) return result;
          const error = safeErrorPresentation({ error: { code: result.safeErrorCode } }, "能力模型测试失败");
          rememberSafeUiError(error);
          return { ...result, message: error.message };
        },
        apply: async (target, proof) => {
          const response = await fetch(`/api/settings/platform-ai-operations/${target.operation}/apply`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...target.candidate, providerName: undefined, providerKind: undefined, ...proof, expiresAt: undefined, quotaMultiplierBps: 10_000, confirmEmbeddingImpact: target.confirmEmbeddingImpact && embeddingAck }),
          });
          if (response.status >= 500) throw new Error("Uncertain apply");
          if (!response.ok) return { ok: false, message: (await safeResponseError(response, "能力启用失败")).message };
          // Consume the response before treating the operation as confirmed.
          const payload = await response.json() as { route?: { status?: string } };
          return { ok: payload.route?.status === "active", message: payload.route?.status === "active" ? undefined : t("当前配置已变化，请刷新能力后核对。") };
        },
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "平台能力配置加载失败");
    } finally {
      executing.current = false;
      stop.current = false;
      setRefreshKey((current) => current + 1);
      setPhase("done");
      changeBusy(false);
    }
  }

  const textOperations = selected.filter((operation) => operation !== "embedding" && operation !== "visionExtract");
  const sharedModels = (view?.candidates.autoExtract.candidates ?? []).filter((item) => textOperations.every((operation) => view?.candidates[operation].candidates.some((other) => candidateKey(other) === candidateKey(item))));
  const panelTitle = phase === "confirm" ? "确认本批模型操作" : phase === "running" ? "正在逐项处理" : "本批处理结果";
  function resultText(operation: PlatformOperation) {
    const result = results[operation];
    if (!result) return t("尚未测试");
    if (result.status === "passed" && !proofUsable(result.proof)) return t(resultLabels.expired);
    return t(resultLabels[result.status]);
  }
  const batchCounts = plan?.targets.reduce((counts, target) => {
    const status = results[target.operation]?.status;
    if (status === "enabled" || status === "passed") counts.success += 1;
    else if (status === "failed" || status === "applyFailed" || status === "expired") counts.failed += 1;
    else if (status === "unknown" || status === "applyUnknown") counts.unknown += 1;
    return counts;
  }, { success: 0, failed: 0, unknown: 0 });

  return <section className="mt-6 space-y-4" aria-labelledby="platform-operation-cards-title">
    <PlatformProbeBudgetClient compact disabled={busy} open={budgetOpen} onOpenChange={setBudgetOpen} onBudgetChanged={setBudget} refreshKey={refreshKey} />
    {budget && budget.heldUnits > 0 ? <p className="text-xs leading-5 text-amber-800"><UiText text="当前额度周期有待核对请求，再次测试前请先核对供应商记录。逐项测试结果仅保留在当前页面，刷新后不会恢复。" /></p> : null}
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="platform-operation-cards-title" className="text-xl font-semibold text-slate-950"><UiText text="能力分配" /></h2><p className="mt-2 max-w-3xl text-xs leading-5 text-slate-500"><UiText text="选择模型后可批量测试并启用。候选来自已验证连接；测试只检查连通性，不代表业务输出质量。" /></p></div>
      <button type="button" onClick={() => { if (!lock.current) void load().catch((error: Error) => setMessage(error.message)); }} disabled={busy} className={buttonClass}><UiText text="刷新能力" /></button>
    </div>
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <button type="button" disabled={busy || !view} onClick={() => setSelected(PLATFORM_OPERATIONS.filter((operation) => candidate(operation) && !isUncertain(results[operation])))} className={buttonClass}><UiText text="全选" /></button>
      <button type="button" disabled={busy || !selected.length} onClick={() => setSelected([])} className={buttonClass}><UiText text="清空" /></button>
      <span aria-live="polite">{t("已选")} {selected.length} {t("项能力，本批最多使用")} {selected.length} {t("次测试额度")}</span>
    </div>
    {textOperations.length > 0 ? <div className="flex flex-wrap items-end gap-2 border-y border-slate-200 py-3">
      <label className="w-full max-w-sm text-xs text-slate-600"><UiText text="统一设置所选文字能力模型" /><select value={bulkModel} disabled={busy} onChange={(event) => setBulkModel(event.target.value)} className={`mt-2 ${selectClass}`}><option value="">{t("选择文字模型")}</option>{sharedModels.map((item) => <option key={candidateKey(item)} value={candidateKey(item)}>{item.providerName} · {item.modelId}</option>)}</select></label>
      <button type="button" disabled={busy || !sharedModels.some((item) => candidateKey(item) === bulkModel) || textOperations.some((operation) => isUncertain(results[operation]))} onClick={() => textOperations.forEach((operation) => choose(operation, bulkModel))} className={buttonClass}><UiText text="应用到所选文字能力" /></button>
    </div> : null}
    <div role="table" aria-label={t("能力分配")} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div role="rowgroup" className="hidden border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500 lg:block"><div role="row" className="grid grid-cols-4 gap-4">{["选择能力", "本次使用模型", "当前生效", "本次测试"].map((label) => <span role="columnheader" key={label}>{t(label)}</span>)}</div></div>
      <div role="rowgroup" className="divide-y divide-slate-200">{PLATFORM_OPERATIONS.map((operation) => {
        const group = view?.candidates[operation];
        const chosen = candidate(operation);
        const activeProvider = providers.find((provider) => provider.id === group?.active?.providerConnectionId)?.name;
        const result = results[operation];
        return <div role="row" key={operation} data-operation={operation} className="grid min-w-0 gap-3 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-center lg:gap-4">
          <div role="cell"><label className="flex items-start gap-3 text-sm font-semibold text-slate-900"><input type="checkbox" checked={selected.includes(operation)} disabled={busy || !chosen || result?.status === "unknown"} onChange={(event) => setSelected((current) => event.target.checked ? [...current, operation] : current.filter((item) => item !== operation))} className="mt-1 h-4 w-4 shrink-0 accent-indigo-600" />{t(labels[operation])}</label><p className="mt-1 pl-7 text-xs leading-5 text-slate-500">{t(purposes[operation])}</p></div>
          <div role="cell" className="min-w-0"><label className="block text-xs text-slate-500"><span className="lg:sr-only">{t(labels[operation])} · {t("本次使用模型")}</span><select value={choices[operation] ?? ""} onChange={(event) => choose(operation, event.target.value)} disabled={busy || isUncertain(result) || !group?.candidates.length} className={selectClass}>
            {!chosen ? <option value={choices[operation] ?? ""}>{t(group?.candidates.length ? "原选择已失效，请重新选择" : "暂无合格候选")}</option> : null}
            {group?.candidates.map((item) => <option key={candidateKey(item)} value={candidateKey(item)}>{item.providerName} · {item.modelId}{item.embeddingDimensions ? ` · ${item.embeddingDimensions} ${t("维")}` : ""}</option>)}
          </select></label></div>
          <div role="cell" className="min-w-0 break-words text-xs leading-5 text-slate-600"><span className="block text-slate-400 lg:sr-only">{t("当前生效")}</span>{group?.active ? <>{activeProvider ? `${activeProvider} · ` : ""}{group.active.modelId}{group.active.embeddingDimensions ? ` · ${group.active.embeddingDimensions} ${t("维")}` : ""}</> : t(view ? "未启用" : "读取中…")}</div>
          <div role="cell" aria-live="polite" className={`min-w-0 break-words text-xs leading-5 ${result?.status === "enabled" || result?.status === "passed" ? "text-emerald-700" : isUncertain(result) || result?.status === "failed" || result?.status === "applyFailed" ? "text-amber-800" : "text-slate-500"}`}>{resultText(operation)}{result?.message ? <p className="mt-1"><UiFeedbackText text={result.message} /></p> : null}</div>
        </div>;
      })}</div>
    </div>
    {message ? <p role="status" className="text-xs leading-5 text-amber-800"><UiFeedbackText text={message} /></p> : null}
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white py-4">
      <p className="max-w-xl text-xs leading-5 text-slate-500"><UiText text="本批每项最多 1 次测试额度，再次手动测试另计；通过后立即启用，失败保留原配置。结果未知时暂停后续项，不自动重试。" /></p>
      <div className="flex flex-wrap gap-2">
        {passed.length > 0 ? <button type="button" disabled={busy} onClick={() => void prepare("apply")} className={buttonClass}><UiText text="启用已通过项" /> ({passed.length})</button> : null}
        <button type="button" disabled={busy || !selected.length || selected.some((operation) => isUncertain(results[operation]))} onClick={() => void prepare("test")} className={buttonClass}><UiText text="仅测试" /></button>
        <button type="button" disabled={busy || !selected.length || selected.some((operation) => isUncertain(results[operation]))} onClick={() => void prepare("testAndApply")} className={primaryClass}><UiText text="测试并启用所选" /></button>
      </div>
    </div>
    <OperationPanel title={panelTitle} triggerLabel="查看本批结果" className={plan ? "" : "hidden"} open={panelOpen} onOpenChange={closePanel} footer={<div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-slate-500"><UiText text={phase === "running" ? "停止只跳过后续项，当前项会完成。" : "测试通过凭据 5 分钟有效且只能使用一次。"} /></p>
      <div className="flex flex-wrap gap-2">{phase === "confirm" ? <><button type="button" onClick={() => closePanel(false)} className={buttonClass}><UiText text="取消" /></button><button type="button" disabled={plan?.embeddingImpact && !embeddingAck} onClick={() => void execute()} className={primaryClass}><UiText text={plan?.mode === "apply" ? "确认启用通过项" : plan?.mode === "test" ? "确认仅测试" : "确认测试并启用"} /></button></> : phase === "running" ? <button type="button" disabled={stopRequested} onClick={() => { stop.current = true; setStopRequested(true); }} className={buttonClass}><UiText text={stopRequested ? "已请求停止后续项" : "停止后续项"} /></button> : <button type="button" onClick={() => closePanel(false)} className={buttonClass}><UiText text="完成" /></button>}</div>
    </div>}>
      {plan ? <div className="space-y-4">
        <p className="text-sm leading-6 text-slate-600"><UiText text={plan.mode === "apply" ? "仅启用已有通过结果，不会再次测试或新增测试次数。启用结果未知时使用原凭据核对，不重复测试。" : "逐项向所选供应商发送固定测试样例，不包含项目资料。仅检查连通性；供应商可能另收 Token 费用。"} /></p>
        {plan.mode !== "apply" && budget && budget.heldUnits > 0 ? <p className="text-xs leading-5 text-amber-800"><UiText text="当前额度周期有待核对请求，再次测试前请先核对供应商记录。逐项测试结果仅保留在当前页面，刷新后不会恢复。" /></p> : null}
        {phase === "confirm" ? <p className="text-xs text-slate-600">{t("本批能力")} {plan.targets.length} · {t("最多使用测试次数")} {plan.mode === "apply" ? 0 : plan.targets.length} · {t("当前可用")} {plan.available}</p> : <p role="status" className="text-xs text-slate-600">{t("成功")} {batchCounts?.success} · {t("失败")} {batchCounts?.failed} · {t("待核对")} {batchCounts?.unknown}</p>}
        <ul className="divide-y divide-slate-200">{plan.targets.map((target) => <li key={target.operation} className="flex flex-wrap justify-between gap-3 py-3 text-xs leading-5"><div><strong>{t(labels[target.operation])}</strong><p className="break-all text-slate-500">{target.candidate.providerName} · {target.candidate.modelId}</p></div>{phase !== "confirm" ? <span>{resultText(target.operation)}</span> : null}</li>)}</ul>
        {phase === "confirm" && plan.embeddingImpact ? <label className="flex items-start gap-3 text-xs leading-5 text-amber-800"><input type="checkbox" checked={embeddingAck} onChange={(event) => setEmbeddingAck(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><UiText text="我已确认更换向量模型或维度可能需要重建现有资料索引。" /></label> : null}
        {phase === "confirm" && plan.mode === "testAndApply" ? <p className="text-xs leading-5 text-slate-500"><UiText text="每项测试通过后立即启用；部分失败时保留已成功项，失败项的原配置不变。" /></p> : null}
        {message ? <p role="status" className="text-xs text-amber-800"><UiFeedbackText text={message} /></p> : null}
        {phase === "done" && plan.targets.some((target) => results[target.operation]?.status === "failed") ? <button type="button" className={buttonClass} onClick={() => { setSelected(plan.targets.filter((target) => results[target.operation]?.status === "failed").map((target) => target.operation)); closePanel(false); }}><UiText text="选中明确失败项以重试" /></button> : null}
      </div> : null}
    </OperationPanel>
  </section>;
}
