"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { UiText, useTranslate } from "@/components/appearance-provider";
import { useMemo, useState } from "react";
import { OperationPanel } from "@/components/operation-panel";
import { ShellIcon } from "@/components/shell-icon";

export type PlanUser = { id: string; username: string; displayName: string | null };
export type PlanObjective = { id: string; title: string; status: string };
export type PlanWorkItem = {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  status: "proposed" | "planned" | "inProgress" | "blocked" | "completed" | "cancelled";
  priority: "low" | "medium" | "high" | "urgent";
  objectiveId: string | null;
  targetDate: string | null;
  assigneeId: string | null;
  assignee: PlanUser | null;
  updatedAt: string;
};
export type PlanEvidenceLink = {
  id: string;
  workItemId: string;
  kind: "projectItem" | "projectSource" | "repositorySync";
  projectItemId: string | null;
  projectSourceId: string | null;
  repositorySyncRunId: string | null;
  label: string;
  evidenceFingerprint: string;
  stale: boolean;
  createdAt: string;
  createdBy: PlanUser;
};
export type PlanEvidenceCandidate = { id: string; kind: "projectItem" | "projectSource"; label: string; detail: string };
export type PlanImpact = {
  id: string;
  repositorySyncRunId: string;
  status: "proposed" | "acknowledged" | "dismissed";
  title: string;
  summary: string;
  evidenceFingerprint: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: PlanUser | null;
};
export type PlanHealth = {
  status: "empty" | "healthy" | "attention" | "atRisk";
  dueSoonDays: number;
  counts: {
    active: number;
    overdue: number;
    dueSoon: number;
    blocked: number;
    dependencyBlocked: number;
    unassigned: number;
    missingAcceptance: number;
    missingEvidence: number;
    staleEvidence: number;
    pendingRecommendations: number;
    openImpacts: number;
    pendingApprovals: number;
  };
};
export type PlanRequest = (body: unknown, method: "POST" | "PATCH", key: string, success: string) => Promise<boolean>;

const priorityLabels: Record<PlanWorkItem["priority"], string> = { low: "低", medium: "中", high: "高", urgent: "紧急" };
const evidenceKindLabels: Record<PlanEvidenceLink["kind"], string> = { projectItem: "已确认事实", projectSource: "项目来源", repositorySync: "仓库变更" };

function userLabel(user: PlanUser): string {
  return user.displayName?.trim() || user.username;
}

function dateInput(value: string | null): string {
  return value?.slice(0, 10) ?? "";
}

export function ProjectOperationsSummary({ health, impacts, workItems, canEdit, pending, error, request }: {
  health: PlanHealth;
  impacts: PlanImpact[];
  workItems: PlanWorkItem[];
  canEdit: boolean;
  pending: string | null;
  error: string | null;
  request: PlanRequest;
}) {
  const t = useTranslate();
  const [impactTargets, setImpactTargets] = useState<Record<string, string>>({});
  const [openImpactId, setOpenImpactId] = useState<string | null>(null);
  const proposedImpacts = impacts.filter((impact) => impact.status === "proposed");
  const eligibleWorkItems = workItems.filter((item) => item.status !== "completed" && item.status !== "cancelled");
  const healthLabel = t(health.status === "atRisk" ? "需要立即处理" : health.status === "attention" ? "存在待处理事项" : health.status === "empty" ? "尚未建立工作项" : "运行正常");
  const tone = health.status === "atRisk" ? "border-rose-200 bg-rose-50 text-rose-900" : health.status === "attention" ? "border-amber-200 bg-amber-50 text-amber-950" : health.status === "empty" ? "border-slate-200 bg-slate-50 text-slate-800" : "border-emerald-200 bg-emerald-50 text-emerald-900";

  return <>
    <section className={`mt-8 rounded-3xl border p-6 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div><p className="text-xs font-semibold uppercase tracking-[0.18em] opacity-70"><UiText text={"Project health"} /></p><h2 className="mt-2 text-2xl font-semibold">{healthLabel}</h2><p className="mt-2 max-w-3xl text-sm leading-6 opacity-80"><UiText text={"健康状态由期限、受阻、依赖、负责人、验收标准、证据、待采纳建议、仓库变更和动作审批确定性计算，不调用模型。尚未建立工作项时不会推断为运行正常。"} /></p></div>
        <a href="#impact-signals" className="inline-flex min-h-10 items-center justify-center rounded-xl border border-current/20 px-4 py-2 text-xs font-semibold"><UiText text={"查看待评估变更"} /></a>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <HealthMetric label={t("活动工作")} value={health.counts.active} />
        <HealthMetric label={t("逾期")} value={health.counts.overdue} />
        <HealthMetric label={t("受阻")} value={health.counts.blocked} />
        <HealthMetric label={t("{days} 天内到期").replace("{days}", String(health.dueSoonDays))} value={health.counts.dueSoon} />
        <HealthMetric label={t("未分配")} value={health.counts.unassigned} />
        <HealthMetric label={t("缺少验收/证据")} value={health.counts.missingAcceptance + health.counts.missingEvidence} />
        <HealthMetric label={t("待审批/评估")} value={health.counts.pendingApprovals + health.counts.openImpacts} />
      </div>
      {health.counts.staleEvidence > 0 ? <p className="mt-4 text-xs font-semibold">{t("有 {count} 条关联证据已过期或来源状态发生变化，请重新核对。").replace("{count}", String(health.counts.staleEvidence))}</p> : null}
    </section>

    <section id="impact-signals" className="mt-8 rounded-3xl border border-cyan-200 bg-cyan-50 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700"><UiText text={"Repository change signals"} /></p><h2 className="mt-2 text-xl font-semibold text-cyan-950"><UiText text={"仓库变更待评估"} /></h2><p className="mt-2 max-w-3xl text-sm leading-6 text-cyan-900"><UiText text={"系统从已经成功并完成对账的仓库同步中固定变更清单。它不会自动判断影响范围；请把相关信号关联到工作项，或在人工核对后忽略。"} /></p></div><button type="button" onClick={() => void request({ operation: "refreshImpacts" }, "POST", "refresh-impacts", "仓库变更信号已刷新。") } disabled={!canEdit || pending !== null} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-cyan-700 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-600 disabled:opacity-40">{pending === "refresh-impacts" ? t("检查中…") : t("检查最新同步")}</button></div>
      <div className="mt-5 space-y-3">{proposedImpacts.map((impact) => <article key={impact.id} className="rounded-2xl border border-cyan-200 bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-800">{impact.title}</h3><p className="mt-2 text-xs leading-5 text-slate-500">{impact.summary}</p><p className="mt-2 font-mono text-[10px] text-cyan-700"><UiText text={"证据指纹"} />{" "}{impact.evidenceFingerprint.slice(0, 16)}…</p></div><span className="rounded-full bg-cyan-100 px-3 py-1 text-[12px] font-semibold text-cyan-800"><UiText text={"待人工评估"} /></span></div><div className="mt-4 flex flex-wrap items-center gap-2"><OperationPanel title={t("关联仓库变更")} triggerLabel={t("关联到工作项")} open={openImpactId === impact.id} onOpenChange={(open) => setOpenImpactId(open ? impact.id : null)} disabled={!canEdit || pending !== null || eligibleWorkItems.length === 0} description={t("选择受影响工作项后会固定关系和证据，并留下审计记录。")}>{error ? <p role="alert" className="mb-4 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700"><UiErrorText text={error} /></p> : null}<div className="max-w-2xl rounded-2xl border border-slate-200 bg-white p-5"><label className="block text-sm font-semibold text-slate-700"><UiText text={"受影响工作项"} /><select aria-label={t("选择受影响工作项")} value={impactTargets[impact.id] ?? ""} onChange={(event) => setImpactTargets((current) => ({ ...current, [impact.id]: event.target.value }))} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 px-3 text-sm font-normal"><option value=""><UiText text={"选择关联工作项"} /></option>{eligibleWorkItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><button type="button" onClick={async () => { const workItemId = impactTargets[impact.id]; const item = workItems.find((entry) => entry.id === workItemId); if (item && await request({ operation: "linkImpact", impactId: impact.id, workItemId, expectedUpdatedAt: item.updatedAt }, "POST", `link-impact:${impact.id}`, "变更信号已关联到工作项并保留证据。")) setOpenImpactId(null); }} disabled={!canEdit || pending !== null || !impactTargets[impact.id]} className="mt-4 inline-flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"><UiText text={"关联并确认"} /></button></div></OperationPanel><button type="button" onClick={() => void request({ entity: "impactSuggestion", id: impact.id, expectedStatus: "proposed", status: "dismissed" }, "PATCH", `dismiss-impact:${impact.id}`, "变更信号已标记为无需纳入，审计记录保留。") } disabled={!canEdit || pending !== null} className="inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 disabled:opacity-40"><UiText text={"核对后忽略"} /></button></div></article>)}{proposedImpacts.length === 0 ? <div className="rounded-2xl border border-dashed border-cyan-300 px-5 py-9 text-center text-sm text-cyan-800"><UiText text={"没有待评估的仓库变更信号。已有成功同步时，可点击“检查最新同步”。"} /></div> : null}</div>
    </section>
  </>;
}

export function WorkItemOperations({ item, objectives, members, evidenceLinks, evidenceCandidates, dependencies, dependencyCandidates, canEdit, pending, error, request }: {
  item: PlanWorkItem;
  objectives: PlanObjective[];
  members: PlanUser[];
  evidenceLinks: PlanEvidenceLink[];
  evidenceCandidates: PlanEvidenceCandidate[];
  dependencies: Array<{ id: string; dependsOnId: string; title: string }>;
  dependencyCandidates: PlanWorkItem[];
  canEdit: boolean;
  pending: string | null;
  error: string | null;
  request: PlanRequest;
}) {
  const t = useTranslate();
  const [draft, setDraft] = useState({ description: item.description ?? "", acceptanceCriteria: item.acceptanceCriteria ?? "", objectiveId: item.objectiveId ?? "", assigneeId: item.assigneeId ?? "", priority: item.priority, targetDate: dateInput(item.targetDate) });
  const [evidenceChoice, setEvidenceChoice] = useState("");
  const [dependencyChoice, setDependencyChoice] = useState("");
  const [open, setOpen] = useState(false);
  const terminal = item.status === "completed" || item.status === "cancelled";
  const linkedKeys = useMemo(() => new Set(evidenceLinks.flatMap((link) => link.kind === "repositorySync" ? [] : [`${link.kind}:${link.kind === "projectItem" ? link.projectItemId ?? "" : link.projectSourceId ?? ""}`])), [evidenceLinks]);
  const candidates = evidenceCandidates.filter((candidate) => !linkedKeys.has(`${candidate.kind}:${candidate.id}`));

  async function save(): Promise<boolean> {
    return request({ entity: "workItem", id: item.id, expectedUpdatedAt: item.updatedAt, description: draft.description || null, acceptanceCriteria: draft.acceptanceCriteria || null, objectiveId: draft.objectiveId || null, assigneeId: draft.assigneeId || null, priority: draft.priority, targetDate: draft.targetDate || null }, "PATCH", `save-operations:${item.id}`, "工作项运营信息已更新。");
  }

  async function addEvidence() {
    const [evidenceKind, evidenceId] = evidenceChoice.split(":", 2);
    if ((evidenceKind !== "projectItem" && evidenceKind !== "projectSource") || !evidenceId) return;
    if (await request({ operation: "linkEvidence", workItemId: item.id, evidenceKind, evidenceId, expectedUpdatedAt: item.updatedAt }, "POST", `link-evidence:${item.id}`, "证据已关联并固定快照。")) setOpen(false);
  }

  async function addDependency() {
    const candidate = dependencyCandidates.find((entry) => entry.id === dependencyChoice);
    if (candidate && await request({ operation: "addDependency", workItemId: item.id, dependsOnId: candidate.id, expectedUpdatedAt: item.updatedAt }, "POST", `add-dependency:${item.id}`, "前置依赖已添加并通过循环检查。")) setOpen(false);
  }

  return <section className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold text-slate-700"><UiText text={"关联证据"} /></p><p className="mt-1 text-[12px] text-slate-400"><UiText text={"完成工作项前需要至少一条活动证据。"} /></p></div>{terminal ? <span className="rounded-full bg-slate-200 px-3 py-1 text-[12px] font-semibold text-slate-500"><UiText text={"终态只读"} /></span> : null}</div>
    <div className="mt-4 flex flex-wrap gap-2">{evidenceLinks.map((link) => <span key={link.id} className={`inline-flex min-h-9 items-center gap-2 rounded-xl px-3 py-1.5 text-xs ${link.stale ? "bg-rose-100 text-rose-700" : "bg-white text-slate-700"}`} title={t("证据指纹 {fingerprint}").replace("{fingerprint}", link.evidenceFingerprint)}><span className="font-semibold">{t(evidenceKindLabels[link.kind])}</span><span className="max-w-52 truncate">{link.label}</span>{link.stale ? <span><UiText text={"需复核"} /></span> : null}</span>)}{evidenceLinks.length === 0 ? <span className="text-xs text-slate-400"><UiText text={"尚未关联完成证据"} /></span> : null}</div>
    {!terminal && canEdit ? <div className="mt-4"><OperationPanel title={t("管理工作项“{title}”").replace("{title}", item.title)} triggerLabel={t("编辑与管理")} open={open} onOpenChange={setOpen} disabled={pending !== null} description={t("编辑负责人、验收标准和计划字段，或管理工作项依赖与完成证据。")}>
      {error ? <p role="alert" className="mb-4 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700"><UiErrorText text={error} /></p> : null}
      <div className="space-y-5">
        <section className="max-w-4xl rounded-2xl border border-slate-200 bg-white p-5"><h3 className="text-sm font-semibold text-slate-800"><UiText text={"工作项信息"} /></h3><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4"><label className="text-xs font-medium text-slate-600"><UiText text={"负责人"} /><select aria-label={t("负责人")} value={draft.assigneeId} onChange={(event) => setDraft((current) => ({ ...current, assigneeId: event.target.value }))} className="mt-1 min-h-10 w-full rounded-xl border border-slate-200 bg-white px-3"><option value=""><UiText text={"未分配负责人"} /></option>{members.map((member) => <option key={member.id} value={member.id}>{userLabel(member)}</option>)}</select></label><label className="text-xs font-medium text-slate-600"><UiText text={"所属目标"} /><select aria-label={t("所属目标")} value={draft.objectiveId} onChange={(event) => setDraft((current) => ({ ...current, objectiveId: event.target.value }))} className="mt-1 min-h-10 w-full rounded-xl border border-slate-200 bg-white px-3"><option value=""><UiText text={"不关联目标"} /></option>{objectives.filter((objective) => objective.status !== "completed" && objective.status !== "cancelled").map((objective) => <option key={objective.id} value={objective.id}>{objective.title}</option>)}</select></label><label className="text-xs font-medium text-slate-600"><UiText text={"优先级"} /><select aria-label={t("优先级")} value={draft.priority} onChange={(event) => setDraft((current) => ({ ...current, priority: event.target.value as PlanWorkItem["priority"] }))} className="mt-1 min-h-10 w-full rounded-xl border border-slate-200 bg-white px-3">{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{t(label)} {t("优先级")}</option>)}</select></label><label className="text-xs font-medium text-slate-600"><UiText text={"目标日期"} /><input aria-label={t("目标日期")} type="date" value={draft.targetDate} onChange={(event) => setDraft((current) => ({ ...current, targetDate: event.target.value }))} className="mt-1 min-h-10 w-full rounded-xl border border-slate-200 bg-white px-3" /></label></div><div className="mt-3 grid gap-3 md:grid-cols-2"><label className="text-xs font-medium text-slate-600"><UiText text={"工作说明"} /><textarea aria-label={t("工作说明")} rows={3} maxLength={20_000} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} placeholder={t("范围与背景")} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5" /></label><label className="text-xs font-medium text-slate-600"><UiText text={"验收标准"} /><textarea aria-label={t("验收标准")} rows={3} maxLength={20_000} value={draft.acceptanceCriteria} onChange={(event) => setDraft((current) => ({ ...current, acceptanceCriteria: event.target.value }))} placeholder={t("填写可验证的验收标准")} className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5" /></label></div><button type="button" onClick={async () => { if (await save()) setOpen(false); }} disabled={!canEdit || pending !== null} className="mt-4 inline-flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">{pending === `save-operations:${item.id}` ? t("保存中…") : t("保存工作项")}</button></section>
        <section className="max-w-4xl rounded-2xl border border-slate-200 bg-white p-5"><h3 className="text-sm font-semibold text-slate-800"><UiText text={"完成证据"} /></h3><div className="mt-4 flex flex-wrap gap-2">{evidenceLinks.map((link) => <span key={link.id} className={`inline-flex min-h-9 items-center gap-2 rounded-xl px-3 py-1.5 text-xs ${link.stale ? "bg-rose-100 text-rose-700" : "bg-slate-50 text-slate-700"}`} title={t("证据指纹 {fingerprint}").replace("{fingerprint}", link.evidenceFingerprint)}><span className="font-semibold">{t(evidenceKindLabels[link.kind])}</span><span className="max-w-52 truncate">{link.label}</span>{link.stale ? <span><UiText text={"需复核"} /></span> : null}<button type="button" aria-label={t("移除证据 {label}").replace("{label}", link.label)} onClick={async () => { if (await request({ operation: "removeEvidence", evidenceLinkId: link.id, expectedUpdatedAt: item.updatedAt }, "POST", `remove-evidence:${link.id}`, "证据关联已移除，原始记录和审计保留。")) setOpen(false); }} disabled={pending !== null} className="app-icon-button app-icon-button--compact"><ShellIcon name="close" className="app-icon--compact" /></button></span>)}{evidenceLinks.length === 0 ? <span className="text-xs text-slate-400"><UiText text={"尚未关联完成证据"} /></span> : null}</div><div className="mt-3 flex flex-wrap gap-2"><select aria-label={t("选择计划证据")} value={evidenceChoice} onChange={(event) => setEvidenceChoice(event.target.value)} className="min-h-10 min-w-56 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-xs"><option value=""><UiText text={"选择已确认事实或活动来源"} /></option>{candidates.map((candidate) => <option key={`${candidate.kind}:${candidate.id}`} value={`${candidate.kind}:${candidate.id}`}>{t(candidate.kind === "projectItem" ? "事实" : "来源")} · {candidate.label}</option>)}</select><button type="button" onClick={() => void addEvidence()} disabled={pending !== null || evidenceChoice.length === 0} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"><UiText text={"关联证据"} /></button></div></section>
        <section className="max-w-4xl rounded-2xl border border-slate-200 bg-white p-5"><h3 className="text-sm font-semibold text-slate-800"><UiText text={"前置依赖"} /></h3><div className="mt-4 flex flex-wrap gap-2">{dependencies.map((dependency) => <span key={dependency.id} className="inline-flex min-h-9 items-center gap-2 rounded-xl bg-slate-50 px-3 py-1.5 text-xs text-slate-700">{dependency.title}<button type="button" aria-label={t("移除依赖")} onClick={async () => { if (await request({ operation: "removeDependency", dependencyId: dependency.id, expectedUpdatedAt: item.updatedAt }, "POST", `remove-dependency:${dependency.id}`, "工作项依赖已移除，审计记录保留。")) setOpen(false); }} disabled={pending !== null} className="app-icon-button app-icon-button--compact"><ShellIcon name="close" className="app-icon--compact" /></button></span>)}{dependencies.length === 0 ? <span className="text-xs text-slate-400"><UiText text={"无前置依赖"} /></span> : null}</div>{dependencyCandidates.length > 0 ? <div className="mt-3 flex flex-wrap gap-2"><select aria-label={t("选择前置依赖")} value={dependencyChoice} onChange={(event) => setDependencyChoice(event.target.value)} className="min-h-10 min-w-56 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-xs"><option value=""><UiText text={"选择前置工作项"} /></option>{dependencyCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select><button type="button" onClick={() => void addDependency()} disabled={pending !== null || !dependencyChoice} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"><UiText text={"添加依赖"} /></button></div> : null}</section>
      </div>
    </OperationPanel></div> : null}
  </section>;
}

function HealthMetric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-2xl border border-current/10 bg-white/60 px-3 py-3"><p className="text-xl font-semibold">{value}</p><p className="mt-1 text-[12px] opacity-70">{label}</p></div>;
}
