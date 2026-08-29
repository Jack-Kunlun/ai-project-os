"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";

type User = { id: string; username: string; displayName: string | null };
type ObjectiveStatus = "draft" | "active" | "completed" | "cancelled";
type WorkItemStatus = "proposed" | "planned" | "inProgress" | "blocked" | "completed" | "cancelled";
type Priority = "low" | "medium" | "high" | "urgent";
type Objective = { id: string; title: string; description: string | null; status: ObjectiveStatus; targetDate: string | null; createdAt: string; updatedAt: string; completedAt: string | null; createdBy: User };
type WorkItem = { id: string; objectiveId: string | null; title: string; description: string | null; status: WorkItemStatus; priority: Priority; targetDate: string | null; origin: "manual" | "agentRecommendation"; agentRunId: string | null; recommendationIndex: number | null; evidenceFingerprint: string | null; createdAt: string; updatedAt: string; completedAt: string | null; createdBy: User };
type Dependency = { id: string; workItemId: string; dependsOnId: string; createdAt: string; createdBy: User };
type Recommendation = { agentRunId: string; recommendationIndex: number; text: string; citationCount: number; question: string; createdAt: string };
type Audit = { id: string; entityType: "objective" | "workItem" | "dependency"; entityId: string; event: string; details: unknown; createdAt: string; actor: User };
type Plan = { project: { id: string; name: string; archivedAt: string | null }; objectives: Objective[]; workItems: WorkItem[]; dependencies: Dependency[]; availableRecommendations: Recommendation[]; audits: Audit[]; canEdit: boolean };

const objectiveStatusLabels: Record<ObjectiveStatus, string> = { draft: "草稿", active: "进行中", completed: "已完成", cancelled: "已取消" };
const workItemStatusLabels: Record<WorkItemStatus, string> = { proposed: "待采纳", planned: "已计划", inProgress: "进行中", blocked: "受阻", completed: "已完成", cancelled: "已取消" };
const priorityLabels: Record<Priority, string> = { low: "低", medium: "中", high: "高", urgent: "紧急" };
const objectiveTransitions: Record<ObjectiveStatus, ObjectiveStatus[]> = { draft: ["active", "cancelled"], active: ["completed", "cancelled"], completed: [], cancelled: [] };
const workItemTransitions: Record<WorkItemStatus, WorkItemStatus[]> = { proposed: ["planned", "cancelled"], planned: ["inProgress", "blocked", "cancelled"], inProgress: ["blocked", "completed", "cancelled"], blocked: ["planned", "inProgress", "cancelled"], completed: [], cancelled: [] };

async function responseError(response: Response, fallback: string): Promise<string> {
  try { return ((await response.json()) as { error?: { message?: string } }).error?.message ?? fallback; }
  catch { return fallback; }
}

function userLabel(user: User): string {
  return user.displayName?.trim() || user.username;
}

function dateLabel(value: string | null): string {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value)) : "未设置";
}

function statusTone(status: ObjectiveStatus | WorkItemStatus): string {
  if (status === "completed") return "bg-emerald-100 text-emerald-700";
  if (status === "cancelled") return "bg-slate-100 text-slate-500";
  if (status === "blocked") return "bg-rose-100 text-rose-700";
  if (status === "active" || status === "inProgress") return "bg-indigo-100 text-indigo-700";
  if (status === "proposed") return "bg-amber-100 text-amber-800";
  return "bg-sky-100 text-sky-700";
}

export function ProjectPlanClient({ username, projectId }: { username: string; projectId: string }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [objectiveForm, setObjectiveForm] = useState({ title: "", description: "", targetDate: "" });
  const [workItemForm, setWorkItemForm] = useState({ title: "", description: "", objectiveId: "", priority: "medium" as Priority, targetDate: "" });
  const [dependencyChoices, setDependencyChoices] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/plan`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "项目计划加载失败"));
      setPlan(await response.json() as Plan); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "项目计划加载失败"); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);

  async function request(body: unknown, method: "POST" | "PATCH", key: string, success: string) {
    setPending(key); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/plan`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await responseError(response, "项目计划更新失败"));
      setMessage(success); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "项目计划更新失败"); }
    finally { setPending(null); }
  }

  async function createObjective(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await request({ operation: "createObjective", title: objectiveForm.title, description: objectiveForm.description || null, targetDate: objectiveForm.targetDate || null }, "POST", "create-objective", "目标已创建为草稿，由成员决定何时启动。");
    setObjectiveForm({ title: "", description: "", targetDate: "" });
  }

  async function createWorkItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await request({ operation: "createWorkItem", title: workItemForm.title, description: workItemForm.description || null, objectiveId: workItemForm.objectiveId || null, priority: workItemForm.priority, targetDate: workItemForm.targetDate || null }, "POST", "create-work-item", "工作项已加入计划。");
    setWorkItemForm({ title: "", description: "", objectiveId: "", priority: "medium", targetDate: "" });
  }

  const workItemById = useMemo(() => new Map(plan?.workItems.map((item) => [item.id, item]) ?? []), [plan]);
  const objectiveById = useMemo(() => new Map(plan?.objectives.map((item) => [item.id, item]) ?? []), [plan]);
  const activeWorkItems = plan?.workItems.filter((item) => item.status !== "cancelled") ?? [];
  const counts = {
    objectives: plan?.objectives.filter((item) => item.status !== "cancelled").length ?? 0,
    proposed: plan?.workItems.filter((item) => item.status === "proposed").length ?? 0,
    active: plan?.workItems.filter((item) => item.status === "inProgress" || item.status === "blocked").length ?? 0,
    completed: plan?.workItems.filter((item) => item.status === "completed").length ?? 0,
  };

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
    <AppHeader username={username} active="projects" projectId={projectId} projectSection="plan" />
    <div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12">
      <section className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950 px-8 py-10 text-white shadow-xl shadow-slate-950/10">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Evidence-driven project planning</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{plan?.project.name ?? "项目计划"}</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">把目标、工作项、依赖与智能体建议放到同一条可追溯计划链中。智能体只能提供带证据的建议；采纳、推进和完成始终由项目成员决定。</p></div>
          <button type="button" onClick={() => void reload()} className="flex min-h-11 items-center justify-center rounded-xl border border-white/20 bg-white/10 px-5 py-2.5 text-sm font-semibold text-white hover:bg-white/15">刷新计划</button>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4"><Metric label="有效目标" value={counts.objectives} /><Metric label="待采纳建议" value={counts.proposed} /><Metric label="推进中/受阻" value={counts.active} /><Metric label="已完成" value={counts.completed} /></div>
      </section>

      {loading ? <div className="mt-8 h-44 animate-pulse rounded-3xl bg-slate-200" aria-label="正在加载项目计划" /> : null}
      {plan?.project.archivedAt ? <p className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">项目已归档，计划保持只读，目标、工作项和依赖不会被修改。</p> : null}
      {message ? <p role="status" className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm text-indigo-700">{message}</p> : null}
      {error ? <p role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</p> : null}

      {plan ? <>
        <section className="mt-8 grid gap-5 xl:grid-cols-2">
          <form onSubmit={createObjective} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-500">Human objective</p><h2 className="mt-2 text-xl font-semibold">创建项目目标</h2><p className="mt-2 text-sm leading-6 text-slate-500">目标先以草稿保存，启动和完成需要明确的状态操作。</p>
            <input required maxLength={160} value={objectiveForm.title} onChange={(event) => setObjectiveForm((value) => ({ ...value, title: event.target.value }))} placeholder="目标名称" className="mt-5 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm" />
            <textarea maxLength={20_000} rows={3} value={objectiveForm.description} onChange={(event) => setObjectiveForm((value) => ({ ...value, description: event.target.value }))} placeholder="完成标准或背景（可选）" className="mt-3 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm" />
            <div className="mt-3 flex flex-wrap items-center gap-3"><input type="date" value={objectiveForm.targetDate} onChange={(event) => setObjectiveForm((value) => ({ ...value, targetDate: event.target.value }))} className="min-h-11 rounded-xl border border-slate-200 px-3 text-sm" /><button disabled={!plan.canEdit || pending !== null || objectiveForm.title.trim().length === 0} className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40">{pending === "create-objective" ? "创建中…" : "创建目标草稿"}</button></div>
          </form>
          <form onSubmit={createWorkItem} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-500">Human work item</p><h2 className="mt-2 text-xl font-semibold">添加人工工作项</h2><p className="mt-2 text-sm leading-6 text-slate-500">人工创建的工作项直接进入“已计划”，仍需成员手动开始。</p>
            <input required maxLength={160} value={workItemForm.title} onChange={(event) => setWorkItemForm((value) => ({ ...value, title: event.target.value }))} placeholder="工作项名称" className="mt-5 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm" />
            <textarea maxLength={20_000} rows={3} value={workItemForm.description} onChange={(event) => setWorkItemForm((value) => ({ ...value, description: event.target.value }))} placeholder="范围或验收条件（可选）" className="mt-3 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm" />
            <div className="mt-3 grid gap-3 sm:grid-cols-3"><select value={workItemForm.objectiveId} onChange={(event) => setWorkItemForm((value) => ({ ...value, objectiveId: event.target.value }))} className="min-h-11 rounded-xl border border-slate-200 px-3 text-sm"><option value="">不关联目标</option>{plan.objectives.filter((item) => item.status !== "cancelled" && item.status !== "completed").map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><select value={workItemForm.priority} onChange={(event) => setWorkItemForm((value) => ({ ...value, priority: event.target.value as Priority }))} className="min-h-11 rounded-xl border border-slate-200 px-3 text-sm">{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}优先级</option>)}</select><input type="date" value={workItemForm.targetDate} onChange={(event) => setWorkItemForm((value) => ({ ...value, targetDate: event.target.value }))} className="min-h-11 rounded-xl border border-slate-200 px-3 text-sm" /></div>
            <button disabled={!plan.canEdit || pending !== null || workItemForm.title.trim().length === 0} className="mt-3 flex min-h-11 w-full items-center justify-center rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40">{pending === "create-work-item" ? "添加中…" : "加入项目计划"}</button>
          </form>
        </section>

        <section className="mt-8 rounded-3xl border border-amber-200 bg-amber-50 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">Agent recommendations</p><h2 className="mt-2 text-xl font-semibold text-amber-950">带证据的智能体建议</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-amber-900">这里仅显示尚未加入计划的建议。点击后会固定原建议、引用证据和运行指纹，并创建“待采纳”工作项；不会自动开始。</p></div><Link href={`/projects/${projectId}/intelligence`} className="flex min-h-10 items-center justify-center rounded-xl border border-amber-300 px-4 py-2 text-xs font-semibold text-amber-900">进入项目智能体</Link></div>
          <div className="mt-5 grid gap-3 lg:grid-cols-2">{plan.availableRecommendations.map((recommendation) => <article key={`${recommendation.agentRunId}:${recommendation.recommendationIndex}`} className="rounded-2xl border border-amber-200 bg-white p-5"><p className="text-sm font-semibold leading-6 text-slate-800">{recommendation.text}</p><p className="mt-3 text-xs text-slate-500">{recommendation.citationCount} 条引用 · 来源问题：{recommendation.question}</p><button type="button" onClick={() => void request({ operation: "promoteRecommendation", agentRunId: recommendation.agentRunId, recommendationIndex: recommendation.recommendationIndex }, "POST", `promote:${recommendation.agentRunId}:${recommendation.recommendationIndex}`, "建议已保存为待采纳工作项，证据快照保持不可变。") } disabled={!plan.canEdit || pending !== null} className="mt-4 flex min-h-10 w-full items-center justify-center rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-400 disabled:opacity-40">{pending === `promote:${recommendation.agentRunId}:${recommendation.recommendationIndex}` ? "保存中…" : "保存为待采纳工作项"}</button></article>)}{plan.availableRecommendations.length === 0 ? <div className="rounded-2xl border border-dashed border-amber-300 px-5 py-10 text-center text-sm text-amber-800 lg:col-span-2">没有尚未处理的智能体建议。可以先运行一次只读项目调查。</div> : null}</div>
        </section>

        <section className="mt-8"><div className="mb-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Objectives</p><h2 className="mt-2 text-2xl font-semibold">项目目标</h2></div><div className="grid gap-4 lg:grid-cols-2">{plan.objectives.map((objective) => <article key={objective.id} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><h3 className="text-lg font-semibold">{objective.title}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{objective.description ?? "未填写完成标准"}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusTone(objective.status)}`}>{objectiveStatusLabels[objective.status]}</span></div><p className="mt-4 text-xs text-slate-400">目标日期：{dateLabel(objective.targetDate)} · 创建人：{userLabel(objective.createdBy)}</p><div className="mt-5 flex flex-wrap gap-2">{objectiveTransitions[objective.status].map((status) => <button key={status} type="button" onClick={() => void request({ entity: "objective", id: objective.id, expectedUpdatedAt: objective.updatedAt, status }, "PATCH", `objective:${objective.id}:${status}`, `目标已更新为“${objectiveStatusLabels[status]}”。`)} disabled={!plan.canEdit || pending !== null} className="flex min-h-10 items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:border-indigo-300 disabled:opacity-40">{objectiveStatusLabels[status]}</button>)}</div></article>)}{plan.objectives.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 px-6 py-14 text-center text-sm text-slate-500 lg:col-span-2">还没有项目目标。</div> : null}</div></section>

        <section className="mt-8"><div className="mb-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Work items</p><h2 className="mt-2 text-2xl font-semibold">工作项与依赖</h2></div><div className="space-y-4">{plan.workItems.map((item) => {
          const dependencies = plan.dependencies.filter((entry) => entry.workItemId === item.id);
          const candidates = activeWorkItems.filter((candidate) => candidate.id !== item.id && !dependencies.some((entry) => entry.dependsOnId === candidate.id));
          return <article key={item.id} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div className="max-w-3xl"><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-semibold">{item.title}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusTone(item.status)}`}>{workItemStatusLabels[item.status]}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{priorityLabels[item.priority]}优先级</span></div><p className="mt-2 text-sm leading-6 text-slate-500">{item.description ?? "未填写范围或验收条件"}</p></div><div className="text-right text-xs text-slate-400"><p>{item.objectiveId ? `目标：${objectiveById.get(item.objectiveId)?.title ?? "已移除"}` : "未关联目标"}</p><p className="mt-1">目标日期：{dateLabel(item.targetDate)}</p></div></div>
            {item.origin === "agentRecommendation" ? <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900"><p className="font-semibold">智能体建议 · 等待人工采纳</p><p className="mt-1 font-mono text-[10px] text-amber-700">证据指纹 {item.evidenceFingerprint?.slice(0, 16)}…</p></div> : null}
            <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_auto]"><div><p className="text-xs font-semibold text-slate-500">前置依赖</p><div className="mt-2 flex flex-wrap gap-2">{dependencies.map((dependency) => <span key={dependency.id} className="inline-flex min-h-9 items-center gap-2 rounded-xl bg-slate-100 px-3 py-1.5 text-xs text-slate-700">{workItemById.get(dependency.dependsOnId)?.title ?? "未知工作项"}<button type="button" aria-label="移除依赖" onClick={() => void request({ operation: "removeDependency", dependencyId: dependency.id, expectedUpdatedAt: item.updatedAt }, "POST", `remove-dependency:${dependency.id}`, "工作项依赖已移除，审计记录保留。") } disabled={!plan.canEdit || pending !== null} className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-white hover:text-rose-600 disabled:opacity-40">×</button></span>)}{dependencies.length === 0 ? <span className="text-xs text-slate-400">无前置依赖</span> : null}</div>{candidates.length > 0 && item.status !== "completed" && item.status !== "cancelled" ? <div className="mt-3 flex flex-wrap gap-2"><select aria-label="选择前置依赖" value={dependencyChoices[item.id] ?? ""} onChange={(event) => setDependencyChoices((value) => ({ ...value, [item.id]: event.target.value }))} className="min-h-10 flex-1 rounded-xl border border-slate-200 px-3 text-xs"><option value="">选择前置工作项</option>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select><button type="button" onClick={() => { const dependsOnId = dependencyChoices[item.id]; if (dependsOnId) void request({ operation: "addDependency", workItemId: item.id, dependsOnId, expectedUpdatedAt: item.updatedAt }, "POST", `add-dependency:${item.id}`, "前置依赖已添加并通过循环检查。"); }} disabled={!plan.canEdit || pending !== null || !(dependencyChoices[item.id])} className="flex min-h-10 items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 disabled:opacity-40">添加依赖</button></div> : null}</div><div className="flex flex-wrap items-end justify-end gap-2">{workItemTransitions[item.status].map((status) => <button key={status} type="button" onClick={() => void request({ entity: "workItem", id: item.id, expectedUpdatedAt: item.updatedAt, status }, "PATCH", `work-item:${item.id}:${status}`, `工作项已更新为“${workItemStatusLabels[status]}”。`)} disabled={!plan.canEdit || pending !== null} className="flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-600 disabled:opacity-40">{workItemStatusLabels[status]}</button>)}</div></div>
          </article>;
        })}{plan.workItems.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 px-6 py-16 text-center text-sm text-slate-500">还没有工作项。可以人工创建，或把有证据的智能体建议保存为待采纳项。</div> : null}</div></section>

        <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Audit trail</p><h2 className="mt-2 text-xl font-semibold">最近计划审计</h2></div><span className="text-xs text-slate-400">最近 {Math.min(plan.audits.length, 12)} 条</span></div><div className="mt-5 divide-y divide-slate-100">{plan.audits.slice(0, 12).map((audit) => <div key={audit.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs"><span className="font-semibold text-slate-700">{audit.event}</span><span className="text-slate-400">{userLabel(audit.actor)} · {new Date(audit.createdAt).toLocaleString("zh-CN")}</span></div>)}{plan.audits.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">还没有计划审计记录。</p> : null}</div></section>
      </> : null}
    </div>
  </main>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-2xl border border-white/10 bg-white/10 px-4 py-4"><p className="text-2xl font-semibold">{value}</p><p className="mt-1 text-xs text-slate-300">{label}</p></div>;
}
