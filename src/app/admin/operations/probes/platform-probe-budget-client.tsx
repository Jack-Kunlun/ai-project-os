"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";

type ProbeBudgetSummary = Readonly<{
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

const statusLabels: Record<ProbeBudgetSummary["status"], string> = {
  active: "已启用",
  scheduled: "待生效",
  expired: "已过期",
};

async function readError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

const adminInputClass = "mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100";

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

/** datetime-local has no offset; format in the browser's local timezone. */
export function formatDateTimeLocal(value: Date): string {
  return `${value.getFullYear()}-${padDatePart(value.getMonth() + 1)}-${padDatePart(value.getDate())}T${padDatePart(value.getHours())}:${padDatePart(value.getMinutes())}`;
}

export function parseDateTimeLocal(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function budgetEvidence(budget: ProbeBudgetSummary | null, loading: boolean): string {
  if (loading) return "正在读取预算状态";
  if (budget === null) return "尚未启用预算；暂无探测预算状态证据";
  return `预算状态证据：版本 ${budget.version} · ${statusLabels[budget.status]} · 有效期 ${dateLabel(budget.startsAt)} — ${dateLabel(budget.expiresAt)}`;
}

export function PlatformProbeBudgetClient() {
  const [budget, setBudget] = useState<ProbeBudgetSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [unitLimit, setUnitLimit] = useState("10");
  const [threshold, setThreshold] = useState("8");
  const [startsAt, setStartsAt] = useState(() => formatDateTimeLocal(new Date()));
  const [expiresAt, setExpiresAt] = useState(() => formatDateTimeLocal(new Date(Date.now() + 24 * 60 * 60 * 1_000)));
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/platform-provider-probe/budget", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "探测预算读取失败"));
      const payload = await response.json() as { budget: ProbeBudgetSummary | null };
      setBudget(payload.budget);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "探测预算读取失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const parsedStartsAt = parseDateTimeLocal(startsAt);
      const parsedExpiresAt = parseDateTimeLocal(expiresAt);
      if (parsedStartsAt === null || parsedExpiresAt === null || parsedExpiresAt <= parsedStartsAt) {
        throw new Error("请填写有效的本地开始和结束时间，结束时间必须晚于开始时间。");
      }
      const response = await fetch("/api/admin/platform-provider-probe/budget", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          unitLimit: Number(unitLimit),
          alertThresholdUnits: Number(threshold),
          startsAt: parsedStartsAt.toISOString(),
          expiresAt: parsedExpiresAt.toISOString(),
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "探测预算启用失败"));
      await load();
      setMessage("新的平台连接探测预算已启用；未知外发不会自动重试。 ");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "探测预算启用失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8" aria-labelledby="platform-probe-budget-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Operations budget</p>
          <h2 id="platform-probe-budget-title" className="mt-2 text-2xl font-semibold">平台连接探测预算</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">每个已配置能力的连接测试消耗 1 个单位：生成、向量和图片识别分别计量。预算只控制测试外部流量与成本，不是用户 Token 额度，也不会启用或切换能力；预算周期更新后旧周期立即停用，剩余单位不转移。</p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{loading ? "读取中…" : budget === null ? "未启用" : statusLabels[budget.status]}</span>
      </div>
      <div className="mt-6"><ScopeEvidenceCard title="平台探测预算边界" evidence={{ scope: "平台 · 供应商连通性探测", owner: "平台管理员", payer: "平台探测预算", affectedProjects: "项目不适用 · 仅平台供应商连通性探测", latestSuccess: budgetEvidence(budget, loading) }} /></div>
      {budget ? <dl className="mt-6 grid gap-4 rounded-2xl bg-slate-50 p-4 text-xs sm:grid-cols-4"><div><dt className="text-slate-400">版本</dt><dd className="mt-1 font-medium text-slate-700">{budget.version}</dd></div><div><dt className="text-slate-400">可用单位</dt><dd className="mt-1 font-medium text-slate-700">{budget.availableUnits} / {budget.unitLimit}</dd></div><div><dt className="text-slate-400">已结算 / 待核对</dt><dd className="mt-1 font-medium text-slate-700">{budget.settledUnits} / {budget.heldUnits}</dd></div><div><dt className="text-slate-400">有效期</dt><dd className="mt-1 font-medium text-slate-700">{dateLabel(budget.startsAt)} — {dateLabel(budget.expiresAt)}</dd></div></dl> : null}
      <form onSubmit={activate} className="mt-6 grid gap-4 border-t border-slate-100 pt-6 sm:grid-cols-4">
        <label className="text-xs font-medium text-slate-600">单位上限<input type="number" min={1} max={10_000} value={unitLimit} onChange={(event) => setUnitLimit(event.target.value)} required className={adminInputClass} /></label>
        <label className="text-xs font-medium text-slate-600">告警阈值<input type="number" min={0} max={10_000} value={threshold} onChange={(event) => setThreshold(event.target.value)} required className={adminInputClass} /></label>
        <label className="text-xs font-medium text-slate-600">开始时间<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required className={adminInputClass} /></label>
        <label className="text-xs font-medium text-slate-600">结束时间<input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required className={adminInputClass} /></label>
        <div className="sm:col-span-4"><button disabled={pending} className="rounded-xl bg-indigo-600 px-4 py-3 text-xs font-semibold text-white disabled:opacity-50">{pending ? "保存中…" : budget === null ? "创建测试预算周期" : "更新测试额度"}</button></div>
      </form>
      {message ? <p role="status" className="mt-4 text-xs leading-5 text-slate-600">{message}</p> : null}
    </section>
  );
}
