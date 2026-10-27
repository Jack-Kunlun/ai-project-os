"use client";

import { UiFeedbackText, UiText, useAppearance } from "@/components/appearance-provider";
import { OperationPanel } from "@/components/operation-panel";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

export type ProbeBudgetSummary = Readonly<{
  version: number;
  status: "active" | "scheduled" | "expired";
  unitLimit: number;
  alertThresholdUnits: number;
  reservedUnits: number;
  settledUnits: number;
  heldUnits: number;
  availableUnits: number;
  startsAt: string;
  expiresAt: string;
}>;

type PlatformProbeBudgetClientProps = Readonly<{
  compact?: boolean;
  disabled?: boolean;
  onBudgetChanged?: (budget: ProbeBudgetSummary | null) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  refreshKey?: number;
}>;

const statusLabels: Record<ProbeBudgetSummary["status"], string> = {
  active: "生效中",
  scheduled: "待生效",
  expired: "已过期",
};
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_BUDGET_DURATION_MS = 90 * DAY_MS;
const adminInputClass = "mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500";

async function readError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function dateLabel(value: string, language: "zh-CN" | "en"): string {
  return new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

/** datetime-local has no offset; format in the browser's local timezone. */
export function formatDateTimeLocal(value: Date): string {
  return `${value.getFullYear()}-${padDatePart(value.getMonth() + 1)}-${padDatePart(value.getDate())}T${padDatePart(value.getHours())}:${padDatePart(value.getMinutes())}`;
}

export function parseDateTimeLocal(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())
    || parsed.getFullYear() !== Number(year)
    || parsed.getMonth() + 1 !== Number(month)
    || parsed.getDate() !== Number(day)
    || parsed.getHours() !== Number(hour)
    || parsed.getMinutes() !== Number(minute)) return null;
  return parsed;
}

function defaultStartsAt(): string {
  return formatDateTimeLocal(new Date());
}

function defaultExpiresAt(): string {
  return formatDateTimeLocal(new Date(Date.now() + DAY_MS));
}

function metric(label: string, value: string | number, hint?: string, compact = false) {
  return <div className={`min-w-0 ${compact ? "border-l border-slate-200 pl-3 first:border-l-0 first:pl-0" : "rounded-xl border border-slate-200 bg-slate-50 px-3 py-3"}`}>
    <dt className="text-xs text-slate-500"><UiText text={label} /></dt>
    <dd className="mt-1 break-words text-sm font-semibold tabular-nums text-slate-900">{value}</dd>
    {hint ? <dd className="mt-1 text-xs leading-5 text-slate-500"><UiText text={hint} /></dd> : null}
  </div>;
}

export function PlatformProbeBudgetClient({
  compact = false,
  disabled = false,
  onBudgetChanged,
  open,
  onOpenChange,
  refreshKey = 0,
}: PlatformProbeBudgetClientProps) {
  const { language, t } = useAppearance();
  const [budget, setBudget] = useState<ProbeBudgetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [unitLimit, setUnitLimit] = useState("10");
  const [threshold, setThreshold] = useState("8");
  const [startsAt, setStartsAt] = useState(defaultStartsAt);
  const [expiresAt, setExpiresAt] = useState(defaultExpiresAt);
  const [message, setMessage] = useState<string | null>(null);
  const [messageType, setMessageType] = useState<"error" | "status">("error");
  const [localOpen, setLocalOpen] = useState(false);
  const formId = useId();
  const controlledOpen = open !== undefined;
  const operationOpen = open ?? localOpen;
  const onBudgetChangedRef = useRef(onBudgetChanged);
  const onOpenChangeRef = useRef(onOpenChange);
  const loadRequestRef = useRef(0);
  const pendingRef = useRef(false);
  const draftTouchedRef = useRef(false);

  useEffect(() => { onBudgetChangedRef.current = onBudgetChanged; }, [onBudgetChanged]);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

  const load = useCallback(async (): Promise<ProbeBudgetSummary | null> => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    try {
      const response = await fetch("/api/admin/platform-provider-probe/budget", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "测试额度读取失败"));
      const payload = await response.json() as { budget: ProbeBudgetSummary | null };
      if (requestId !== loadRequestRef.current) return null;
      setBudget(payload.budget);
      setLoadFailed(false);
      setMessage(null);
      onBudgetChangedRef.current?.(payload.budget);
      if (!draftTouchedRef.current) {
        setUnitLimit(String(payload.budget?.unitLimit ?? 10));
        setThreshold(String(payload.budget?.alertThresholdUnits ?? 8));
        setStartsAt(defaultStartsAt());
        setExpiresAt(defaultExpiresAt());
      }
      return payload.budget;
    } catch (error) {
      if (requestId !== loadRequestRef.current) return null;
      const failure = error instanceof Error ? error.message : "测试额度读取失败";
      setLoadFailed(true);
      setMessageType("error");
      setMessage(failure);
      return null;
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      loadRequestRef.current += 1;
    };
  }, [load, refreshKey]);

  function requestOpenChange(next: boolean, force = false) {
    if (next && (disabled || pendingRef.current)) return;
    if (!next && pendingRef.current && !force) return;
    if (!controlledOpen) setLocalOpen(next);
    onOpenChangeRef.current?.(next);
    if (next) setMessage(null);
  }

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || loading || pendingRef.current) return;
    setMessage(null);

    const parsedStartsAt = parseDateTimeLocal(startsAt);
    const parsedExpiresAt = parseDateTimeLocal(expiresAt);
    const parsedLimit = Number(unitLimit);
    const parsedThreshold = Number(threshold);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 10_000) {
      setMessageType("error");
      setMessage("最大测试次数须为 1–10,000 之间的整数。");
      return;
    }
    if (!Number.isInteger(parsedThreshold) || parsedThreshold < 0 || parsedThreshold > parsedLimit) {
      setMessageType("error");
      setMessage("告警阈值须为 0 至最大测试次数之间的整数。");
      return;
    }
    if (parsedStartsAt === null || parsedExpiresAt === null || parsedExpiresAt <= parsedStartsAt) {
      setMessageType("error");
      setMessage("请填写有效的生效时间与有效至；结束时间必须晚于开始时间。");
      return;
    }
    if (parsedExpiresAt.getTime() - parsedStartsAt.getTime() > MAX_BUDGET_DURATION_MS) {
      setMessageType("error");
      setMessage("测试额度周期最长为 90 天。");
      return;
    }

    pendingRef.current = true;
    setPending(true);
    try {
      const response = await fetch("/api/admin/platform-provider-probe/budget", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          unitLimit: parsedLimit,
          alertThresholdUnits: parsedThreshold,
          startsAt: parsedStartsAt.toISOString(),
          expiresAt: parsedExpiresAt.toISOString(),
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "测试额度保存失败"));
      draftTouchedRef.current = false;
      const refreshedBudget = await load();
      requestOpenChange(false, true);
      setMessageType("status");
      setMessage(refreshedBudget
        ? "新的测试额度周期已保存；若生效时间在未来，到时才可使用。"
        : "测试额度已保存，但最新状态暂时无法读取；请稍后重新打开此页面。");
    } catch (error) {
      setMessageType("error");
      setMessage(error instanceof Error ? error.message : "测试额度保存失败");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const visibleAvailable = budget?.status === "active" ? budget.availableUnits : 0;
  const editDisabled = disabled || pending || loading || loadFailed;
  const feedback = message ? <p role={messageType === "error" ? "alert" : "status"} className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${messageType === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>{messageType === "error" ? <UiFeedbackText text={message} /> : <UiText text={message} />}</p> : null;
  const summary = <section aria-label={t("模型测试额度摘要")} className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${compact ? "p-4" : "mt-6 p-5 sm:p-6"}`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-sm font-semibold text-slate-900"><UiText text={"测试额度"} /></span>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{loading ? t("读取中…") : loadFailed ? t("读取失败") : budget ? t(statusLabels[budget.status]) : t("未设置")}</span>
      </div>
      <OperationPanel
        title="设置模型测试额度"
        triggerLabel={budget ? "调整测试额度" : "设置测试额度"}
        description="保存会替换当前周期，旧周期立即停用；生效时间在未来时，新周期到时才生效。旧周期未用次数不结转；系统不会自动补充额度。"
        open={operationOpen}
        onOpenChange={(next) => requestOpenChange(next)}
        disabled={editDisabled}
        inquiryEnabled={false}
        footer={<div className="flex w-full flex-wrap items-center justify-between gap-3">
          <span className="text-xs leading-5 text-slate-500"><UiText text={"最大 10,000 次；周期最长 90 天。保存后旧周期立即停用，剩余次数不结转。"} /></span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={pending} onClick={() => requestOpenChange(false)} className="app-action-button rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"><UiText text={"取消"} /></button>
          <button type="submit" form={formId} disabled={editDisabled} className="app-action-button rounded-xl bg-indigo-600 px-4 py-3 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{pending ? t("保存中…") : t("保存新周期")}</button>
          </div>
        </div>}
      >
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-600">
            <p><UiText text={"此处统计测试请求次数，不是平台 Token、人民币费用或供应商余额。供应商可能另收 Token 费用。"} /></p>
            <p className="mt-2"><UiText text={"每次单项能力连通性测试最多计 1 次，六项全部测试最多计 6 次；再次手动测试另计。供应商连接测试按生成、向量、图片模型计 1–3 次。"} /></p>
            <p className="mt-2"><UiText text={"结果未知的请求会占用次数并显示为待核对，不会自动重试。达到告警阈值会通知管理员，不会自动补充额度。"} /></p>
          </div>
          {operationOpen ? feedback : null}
          <form id={formId} noValidate onSubmit={activate} className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-medium text-slate-700"><UiText text={"最大测试次数"} /><input type="number" min={1} max={10_000} step={1} value={unitLimit} disabled={editDisabled} onChange={(event) => { draftTouchedRef.current = true; setUnitLimit(event.target.value); }} className={adminInputClass} aria-label={t("最大测试次数")} /></label>
            <label className="text-xs font-medium text-slate-700"><UiText text={"有效至"} /><input type="datetime-local" value={expiresAt} disabled={editDisabled} onChange={(event) => { draftTouchedRef.current = true; setExpiresAt(event.target.value); }} className={adminInputClass} aria-label={t("有效至")} /></label>
            <details className="rounded-xl border border-slate-200 px-4 py-3 sm:col-span-2">
              <summary className="cursor-pointer text-xs font-semibold text-indigo-700"><UiText text={"高级设置"} /></summary>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-xs font-medium text-slate-700"><UiText text={"生效时间"} /><input type="datetime-local" value={startsAt} disabled={editDisabled} onChange={(event) => { draftTouchedRef.current = true; setStartsAt(event.target.value); }} className={adminInputClass} aria-label={t("生效时间")} /></label>
                <label className="text-xs font-medium text-slate-700"><UiText text={"告警阈值"} /><input type="number" min={0} max={10_000} step={1} value={threshold} disabled={editDisabled} onChange={(event) => { draftTouchedRef.current = true; setThreshold(event.target.value); }} className={adminInputClass} aria-label={t("告警阈值")} /></label>
              </div>
            </details>
          </form>
        </div>
      </OperationPanel>
      {loadFailed ? <button type="button" onClick={() => void load()} className="app-action-button rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700">{t("重新读取")}</button> : null}
    </div>
    <dl className={`mt-4 grid grid-cols-2 gap-2 ${compact ? "sm:grid-cols-5" : "sm:grid-cols-5"}`}>
      {metric("可用测试次数", budget ? `${visibleAvailable} / ${budget.unitLimit}` : "—", undefined, compact)}
      {metric("已计入", budget?.settledUnits ?? "—", "已完成的测试请求", compact)}
      {metric("进行中", budget?.reservedUnits ?? "—", "已预留、尚未完成", compact)}
      {metric("结果待核对", budget?.heldUnits ?? "—", "未知结果占用的次数", compact)}
      {metric("有效至", budget ? dateLabel(budget.expiresAt, language) : "—", budget?.status === "scheduled" ? "当前周期尚未生效" : undefined, compact)}
    </dl>
    <p className="mt-3 text-xs leading-5 text-slate-600"><UiText text={"额度按测试请求次数统计，不是平台 Token 或人民币余额；供应商可能另收 Token 费用。未知请求会保留待核对状态，不自动重试。"} /></p>
    {!operationOpen ? feedback : null}
  </section>;

  return summary;
}
