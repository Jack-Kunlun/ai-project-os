"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";

type RuleKind = "repositorySync" | "memoryQuality" | "memoryIndex" | "projectBrief" | "webSourceSync";
type AutomationRun = { id: string; status: string; scheduledFor: string; failureCode: string | null; completedAt: string | null; result: unknown };
type AutomationRule = {
  id: string;
  name: string;
  kind: RuleKind;
  status: "active" | "paused";
  intervalMinutes: number;
  nextRunAt: string;
  lastRunAt: string | null;
  consecutiveFailures: number;
  runs: AutomationRun[];
};

const kindLabels: Record<RuleKind, string> = {
  repositorySync: "代码仓库同步",
  memoryQuality: "记忆质量检查",
  memoryIndex: "增量记忆索引",
  projectBrief: "项目状态简报",
  webSourceSync: "网页来源刷新",
};

async function responseError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function intervalLabel(value: number) {
  if (value % 1440 === 0) return `每 ${value / 1440} 天`;
  if (value % 60 === 0) return `每 ${value / 60} 小时`;
  return `每 ${value} 分钟`;
}

export function ProjectAutomationsClient({ username, projectId }: { username: string; projectId: string }) {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/automations`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "自动化规则加载失败"));
      setRules((await response.json() as { rules: AutomationRule[] }).rules);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "自动化规则加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="automations" />
      <div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12">
        <section className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-8 py-10 text-white shadow-xl shadow-slate-950/10">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Persistent worker</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">项目自动化</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">规则和运行记录保存在数据库，由独立 Worker 领取并带租约执行。仓库与本地治理任务可自动完成；向模型发送内容的任务只会准备边界并通知你确认，不会静默外传。</p>
        </section>
        {error ? <div role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        <div className="mt-8 grid gap-7 xl:grid-cols-[.75fr_1.25fr]">
          <AutomationForm projectId={projectId} onCreated={(rule) => setRules((current) => [...current, rule])} />
          <section><div className="mb-4 flex items-end justify-between px-1"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Rules</p><h2 className="mt-2 text-2xl font-semibold">运行规则</h2></div><span className="text-xs text-slate-400">{loading ? "读取中…" : `${rules.length} 条`}</span></div><div className="space-y-4">{!loading && rules.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-sm text-slate-500">添加第一条自动化规则。建议先启用“代码仓库同步”和“记忆质量检查”。</div> : rules.map((rule) => <AutomationCard key={rule.id} projectId={projectId} rule={rule} onReload={reload} />)}</div></section>
        </div>
      </div>
    </main>
  );
}

function AutomationForm({ projectId, onCreated }: { projectId: string; onCreated: (rule: AutomationRule) => void }) {
  const [name, setName] = useState("每日代码仓库同步");
  const [kind, setKind] = useState<RuleKind>("repositorySync");
  const [intervalMinutes, setIntervalMinutes] = useState("1440");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function chooseKind(value: RuleKind) {
    setKind(value);
    setName(value === "repositorySync" ? "每日代码仓库同步" : value === "memoryQuality" ? "每日记忆质量检查" : value === "memoryIndex" ? "增量记忆索引提醒" : value === "projectBrief" ? "项目简报提醒" : "网页来源刷新");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const config = kind === "repositorySync" ? { linkIds: [] } : kind === "memoryIndex" ? { mode: "incremental" } : {};
      const response = await fetch(`/api/projects/${projectId}/automations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, kind, intervalMinutes: Number(intervalMinutes), config }) });
      if (!response.ok) throw new Error(await responseError(response, "自动化规则创建失败"));
      const rule = (await response.json() as { rule: AutomationRule }).rule;
      onCreated(rule); setMessage("规则已保存，Worker 会在下次运行时间领取任务。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "自动化规则创建失败"); }
    finally { setPending(false); }
  }

  return <form onSubmit={submit} className="h-fit rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">New rule</p><h2 className="mt-2 text-2xl font-semibold">添加自动化</h2><Field label="任务类型"><select value={kind} onChange={(event) => chooseKind(event.target.value as RuleKind)} className="field">{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="规则名称"><input value={name} onChange={(event) => setName(event.target.value)} className="field" required /></Field><Field label="执行间隔"><select value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} className="field"><option value="60">每小时</option><option value="360">每 6 小时</option><option value="720">每 12 小时</option><option value="1440">每天</option><option value="10080">每周</option></select></Field>{kind === "memoryIndex" || kind === "projectBrief" ? <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">此任务涉及模型数据发送。到期后系统只生成待确认通知，由你在页面核对模型、范围和外发内容。</p> : null}{message ? <p role="status" className="mt-4 text-xs text-slate-600">{message}</p> : null}<button disabled={pending} className="mt-6 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">{pending ? "保存中…" : "保存自动化规则"}</button><style jsx>{`.field{margin-top:.5rem;width:100%;border-radius:.75rem;border:1px solid #cbd5e1;background:white;padding:.72rem .9rem;font-size:.875rem;color:#0f172a;outline:none}.field:focus{border-color:#818cf8;box-shadow:0 0 0 3px rgba(129,140,248,.14)}`}</style></form>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="mt-5 block text-sm font-medium text-slate-700">{label}{children}</label>; }

function AutomationCard({ projectId, rule, onReload }: { projectId: string; rule: AutomationRule; onReload: () => Promise<void> }) {
  const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null); const latest = rule.runs[0];
  async function patch(body: unknown) { setPending(true); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/automations/${rule.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await responseError(response, "规则更新失败")); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "规则更新失败"); } finally { setPending(false); } }
  async function runNow() { setPending(true); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/automations/${rule.id}/run`, { method: "POST" }); if (!response.ok) throw new Error(await responseError(response, "立即运行失败")); setMessage("已排到 Worker 队列，完成结果会进入通知中心。"); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "立即运行失败"); } finally { setPending(false); } }
  return <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">{rule.name}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${rule.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{rule.status === "active" ? "运行中" : "已暂停"}</span></div><p className="mt-2 text-xs text-slate-500">{kindLabels[rule.kind]} · {intervalLabel(rule.intervalMinutes)}</p></div><p className="text-xs text-slate-400">连续失败 {rule.consecutiveFailures} 次</p></div><div className="mt-5 grid gap-3 sm:grid-cols-3"><Info label="下次运行" value={new Date(rule.nextRunAt).toLocaleString("zh-CN")} /><Info label="最近运行" value={rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString("zh-CN") : "尚未运行"} /><Info label="最近结果" value={latest?.status ?? "—"} /></div>{latest?.failureCode ? <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-700">{latest.failureCode}</p> : null}<div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-xs text-slate-600">{message ?? (rule.kind === "memoryIndex" || rule.kind === "projectBrief" ? "到期后需要页面确认模型外发。" : "运行记录和租约均持久化。")}</p><div className="flex gap-2"><button onClick={() => void patch({ enabled: rule.status !== "active" })} disabled={pending} className="rounded-xl px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50">{rule.status === "active" ? "暂停" : "启用"}</button>{rule.status === "active" ? <button onClick={() => void runNow()} disabled={pending} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">立即运行</button> : null}</div></div></article>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl bg-slate-50 px-4 py-3"><span className="block text-[11px] text-slate-400">{label}</span><strong className="mt-1 block truncate text-xs font-semibold text-slate-700">{value}</strong></div>; }
