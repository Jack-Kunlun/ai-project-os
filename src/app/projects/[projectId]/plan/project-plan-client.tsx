"use client";

import { DialogActions, DialogForm, DialogSubmit } from "@/components/dialog-actions";
import { ShellIcon } from "@/components/shell-icon";
import { UiFeedbackText, UiErrorText } from "@/components/ui-error-text";

import {  UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { OperationPanel } from "@/components/operation-panel";
import { ParentPageLink } from "@/components/parent-page-link";
import { buildProjectHref, parseProjectPageState, PROJECT_PLAN_STATUS_VALUES } from "@/lib/project-navigation";
import { safeResponseError } from "@/lib/safe-error-presentation";
import {
  ProjectOperationsSummary,
  WorkItemOperations,
  type PlanEvidenceCandidate,
  type PlanEvidenceLink,
  type PlanHealth,
  type PlanImpact,
  type PlanWorkItem,
} from "./project-plan-operations";
import styles from "./project-plan-client.module.css";

type User = { id: string; username: string; displayName: string | null };
type ObjectiveStatus = "draft" | "active" | "completed" | "cancelled";
type WorkItemStatus = "proposed" | "planned" | "inProgress" | "blocked" | "completed" | "cancelled";
type Priority = "low" | "medium" | "high" | "urgent";
type Objective = { id: string; title: string; description: string | null; status: ObjectiveStatus; targetDate: string | null; createdAt: string; updatedAt: string; completedAt: string | null; createdBy: User };
type WorkItem = PlanWorkItem & { status: WorkItemStatus; priority: Priority; origin: "manual" | "agentRecommendation"; agentRunId: string | null; recommendationIndex: number | null; evidenceFingerprint: string | null; createdAt: string; completedAt: string | null; createdBy: User };
type Dependency = { id: string; workItemId: string; dependsOnId: string; createdAt: string; createdBy: User };
type Recommendation = { agentRunId: string; recommendationIndex: number; text: string; citationCount: number; question: string; createdAt: string };
type Audit = { id: string; entityType: "objective" | "workItem" | "dependency" | "evidenceLink" | "impactSuggestion"; entityId: string; event: string; details: unknown; createdAt: string; actor: User };
type Plan = { project: { id: string; name: string; archivedAt: string | null }; objectives: Objective[]; workItems: WorkItem[]; dependencies: Dependency[]; evidenceLinks: PlanEvidenceLink[]; impactSuggestions: PlanImpact[]; members: User[]; evidenceCandidates: { projectItems: PlanEvidenceCandidate[]; projectSources: PlanEvidenceCandidate[] }; health: PlanHealth; availableRecommendations: Recommendation[]; audits: Audit[]; canEdit: boolean };
type View = "board" | "list";
type BoardColumn = { id: string; label: string; statuses: WorkItemStatus[] };

const objectiveStatusLabels: Record<ObjectiveStatus, string> = { draft: "草稿", active: "进行中", completed: "已完成", cancelled: "已取消" };
const workItemStatusLabels: Record<WorkItemStatus, string> = { proposed: "待采纳", planned: "已计划", inProgress: "进行中", blocked: "受阻", completed: "已完成", cancelled: "已取消" };
const priorityLabels: Record<Priority, string> = { low: "低", medium: "中", high: "高", urgent: "紧急" };
const objectiveTransitions: Record<ObjectiveStatus, ObjectiveStatus[]> = { draft: ["active", "cancelled"], active: ["completed", "cancelled"], completed: [], cancelled: [] };
const workItemTransitions: Record<WorkItemStatus, WorkItemStatus[]> = { proposed: ["planned", "cancelled"], planned: ["inProgress", "blocked", "cancelled"], inProgress: ["blocked", "completed", "cancelled"], blocked: ["planned", "inProgress", "cancelled"], completed: [], cancelled: [] };
const primaryColumns: BoardColumn[] = [
  { id: "planned", label: "待安排", statuses: ["proposed", "planned"] },
  { id: "inProgress", label: "进行中", statuses: ["inProgress"] },
  { id: "blocked", label: "受阻", statuses: ["blocked"] },
  { id: "completed", label: "已完成", statuses: ["completed"] },
];

async function responseError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function userLabel(user: User): string {
  return user.displayName?.trim() || user.username;
}

function dateLabel(value: string | null, language: string, t: (text: string) => string): string {
  return value ? new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { dateStyle: "medium" }).format(new Date(value)) : t("未设置");
}

function statusTone(status: ObjectiveStatus | WorkItemStatus): string {
  if (status === "completed") return styles.completedTone;
  if (status === "cancelled") return styles.cancelledTone;
  if (status === "blocked") return styles.blockedTone;
  if (status === "active" || status === "inProgress") return styles.activeTone;
  if (status === "proposed") return styles.proposedTone;
  return styles.plannedTone;
}

function currentObjective(objectives: Objective[]): Objective | null {
  const candidates = objectives.filter((objective) => objective.status === "active" || objective.status === "draft");
  return candidates.sort((left, right) => Number(right.status === "active") - Number(left.status === "active") || right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
}

export function ProjectPlanClient(props: { username: string; projectId: string; isSystemAdmin: boolean }) {
  return <ProjectPlanContent key={props.projectId} {...props} />;
}

function ProjectPlanContent({ username, projectId, isSystemAdmin }: { username: string; projectId: string; isSystemAdmin: boolean }) {
  const translateUi = useTranslate();
  const { language, t } = useAppearance();
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigation = useMemo(() => parseProjectPageState("plan", projectId, new URLSearchParams(searchParams.toString())), [projectId, searchParams]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [objectiveForm, setObjectiveForm] = useState({ title: "", description: "", targetDate: "" });
  const [workItemForm, setWorkItemForm] = useState({ title: "", description: "", acceptanceCriteria: "", objectiveId: "", assigneeId: "", priority: "medium" as Priority, targetDate: "" });
  const [objectiveOpen, setObjectiveOpen] = useState(false);
  const [workItemOpen, setWorkItemOpen] = useState(false);
  const [view, setView] = useState<View>("board");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [objectiveFilter, setObjectiveFilter] = useState("all");
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const currentProjectId = useRef(projectId);

  useLayoutEffect(() => {
    currentProjectId.current = projectId;
    return () => {
      requestSequence.current += 1;
      activeController.current?.abort();
    };
  }, [projectId]);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}): Promise<void> => {
    const sequence = ++requestSequence.current;
    const requestedProjectId = projectId;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    if (showLoading) setLoading(true);
    try {
      const response = await fetch(`/api/projects/${requestedProjectId}/plan`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response, t("项目计划加载失败")));
      const next = await response.json() as Plan;
      if (controller.signal.aborted || sequence !== requestSequence.current || currentProjectId.current !== requestedProjectId) return;
      setPlan(next);
      setError(null);
    } catch (cause) {
      if (controller.signal.aborted || sequence !== requestSequence.current || currentProjectId.current !== requestedProjectId) return;
      setError(cause instanceof Error ? cause.message : t("项目计划加载失败"));
    } finally {
      if (!controller.signal.aborted && sequence === requestSequence.current && currentProjectId.current === requestedProjectId) setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => {
      window.clearTimeout(timer);
      requestSequence.current += 1;
      activeController.current?.abort();
    };
  }, [reload]);

  const currentPlan = plan?.project.id === projectId ? plan : null;
  const pageLoading = loading || currentPlan === null && error === null;

  useEffect(() => {
    if (navigation.focus === null || currentPlan === null) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(`work-item-${navigation.focus}`);
      target?.scrollIntoView({ block: "center" });
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [navigation.focus, currentPlan]);

  async function request(body: unknown, method: "POST" | "PATCH", key: string, success: string): Promise<boolean> {
    const requestedProjectId = projectId;
    setPending(key);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${requestedProjectId}/plan`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await responseError(response, t("项目计划更新失败")));
      if (currentProjectId.current !== requestedProjectId) return false;
      setMessage(t(success));
      await reload();
      return currentProjectId.current === requestedProjectId;
    } catch (cause) {
      if (currentProjectId.current === requestedProjectId) setError(cause instanceof Error ? cause.message : t("项目计划更新失败"));
      return false;
    } finally {
      if (currentProjectId.current === requestedProjectId) setPending(null);
    }
  }

  async function createObjective(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!await request({ operation: "createObjective", title: objectiveForm.title, description: objectiveForm.description || null, targetDate: objectiveForm.targetDate || null }, "POST", "create-objective", "目标已创建为草稿，由成员决定何时启动。")) return;
    setObjectiveForm({ title: "", description: "", targetDate: "" });
    setObjectiveOpen(false);
  }

  async function createWorkItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!await request({ operation: "createWorkItem", title: workItemForm.title, description: workItemForm.description || null, acceptanceCriteria: workItemForm.acceptanceCriteria || null, objectiveId: workItemForm.objectiveId || null, assigneeId: workItemForm.assigneeId || null, priority: workItemForm.priority, targetDate: workItemForm.targetDate || null }, "POST", "create-work-item", "工作项已加入计划。")) return;
    setWorkItemForm({ title: "", description: "", acceptanceCriteria: "", objectiveId: "", assigneeId: "", priority: "medium", targetDate: "" });
    setWorkItemOpen(false);
  }

  const workItemById = useMemo(() => new Map(currentPlan?.workItems.map((item) => [item.id, item]) ?? []), [currentPlan]);
  const objectiveById = useMemo(() => new Map(currentPlan?.objectives.map((item) => [item.id, item]) ?? []), [currentPlan]);
  const activeWorkItems = currentPlan?.workItems.filter((item) => item.status !== "cancelled") ?? [];
  const currentUser = currentPlan?.members.find((member) => member.username === username) ?? null;
  const visibleWorkItems = currentPlan?.workItems.filter((item) => {
    if (navigation.status !== null && item.status !== navigation.status) return false;
    if (ownerFilter === "me" && (currentUser === null || item.assigneeId !== currentUser.id)) return false;
    if (ownerFilter === "unassigned" && item.assigneeId !== null) return false;
    if (ownerFilter !== "all" && ownerFilter !== "me" && ownerFilter !== "unassigned" && item.assigneeId !== ownerFilter) return false;
    if (objectiveFilter !== "all" && item.objectiveId !== objectiveFilter) return false;
    return true;
  }) ?? [];
  const selectedWorkItem = currentPlan?.workItems.find((item) => item.id === selectedWorkItemId) ?? null;
  const objective = currentPlan ? currentObjective(currentPlan.objectives) : null;
  const objectiveWorkItems = objective ? currentPlan?.workItems.filter((item) => item.objectiveId === objective.id && item.status !== "cancelled") ?? [] : [];
  const completedObjectiveItems = objectiveWorkItems.filter((item) => item.status === "completed").length;
  const mainColumns = navigation.status === "cancelled" ? [{ id: "cancelled", label: t("已取消"), statuses: ["cancelled"] as WorkItemStatus[] }] : primaryColumns.map((column) => ({ ...column, label: t(column.label) }));
  const cancelledItems = visibleWorkItems.filter((item) => item.status === "cancelled");

  function chooseWorkItem(item: WorkItem) {
    setSelectedWorkItemId(item.id);
    setDetailOpen(true);
  }

  function setStatusFilter(value: string) {
    const status = value === "all" ? null : value;
    router.replace(buildProjectHref(projectId, "plan", { status, from: navigation.from, returnTo: navigation.returnTo }), { scroll: false });
  }

  return <main className={styles.page}>
    <AppHeader username={username} active="projects" projectId={projectId} projectSection="plan" isSystemAdmin={isSystemAdmin} />
    <div data-page-content className={styles.content}>
      <header className={styles.heading}>
        <div><p className={styles.eyebrow}><UiText text={"PROJECT PLAN"} /></p><h1>{currentPlan?.project.name ?? <UiText text={"项目计划"} />}</h1><p className={styles.subtitle}><UiText text={"维护目标、工作项、负责人、期限和验收证据。"} /></p></div>
        {currentPlan ? <div className={styles.headingActions}>
          <OperationPanel title={t("创建项目目标")} triggerLabel={t("新建目标")} open={objectiveOpen} onOpenChange={setObjectiveOpen} disabled={!currentPlan.canEdit} description={t("目标先保存为草稿，后续由项目成员明确决定何时启动或完成。")}>
            <DialogForm onSubmit={createObjective} className={styles.form}>
              {error ? <p role="alert" className={styles.formError}><UiErrorText text={error} /></p> : null}
              <label><UiText text={"目标名称"} /><input required maxLength={160} value={objectiveForm.title} onChange={(event) => setObjectiveForm((value) => ({ ...value, title: event.target.value }))} placeholder={t("目标名称")} /></label>
              <label><UiText text={"完成标准或背景"} /><textarea maxLength={20_000} rows={3} value={objectiveForm.description} onChange={(event) => setObjectiveForm((value) => ({ ...value, description: event.target.value }))} placeholder={t("可选")} /></label>
              <label><UiText text={"目标日期"} /><input type="date" value={objectiveForm.targetDate} onChange={(event) => setObjectiveForm((value) => ({ ...value, targetDate: event.target.value }))} /></label>
              <DialogActions><button type="button" className="app-action-button" disabled={pending !== null} onClick={() => setObjectiveOpen(false)}>{t("取消")}</button><DialogSubmit className={`app-action-button ${styles.formSubmit}`}  disabled={!currentPlan.canEdit || pending !== null || objectiveForm.title.trim().length === 0}>{pending === "create-objective" ? t("创建中…") : t("创建目标草稿")}</DialogSubmit></DialogActions>
            </DialogForm>
          </OperationPanel>
          <OperationPanel title={t("添加人工工作项")} triggerLabel={t("新建工作项")} open={workItemOpen} onOpenChange={setWorkItemOpen} disabled={!currentPlan.canEdit} description={t("工作项先进入已计划状态；开始和完成仍需要成员明确操作。")}>
            <DialogForm onSubmit={createWorkItem} className={styles.form}>
              {error ? <p role="alert" className={styles.formError}><UiErrorText text={error} /></p> : null}
              <label><UiText text={"工作项名称"} /><input required maxLength={160} value={workItemForm.title} onChange={(event) => setWorkItemForm((value) => ({ ...value, title: event.target.value }))} placeholder={t("工作项名称")} /></label>
              <div className={styles.formGrid}><label><UiText text={"工作说明"} /><textarea maxLength={20_000} rows={3} value={workItemForm.description} onChange={(event) => setWorkItemForm((value) => ({ ...value, description: event.target.value }))} placeholder={t("范围与背景（可选）")} /></label><label><UiText text={"验收标准"} /><textarea maxLength={20_000} rows={3} value={workItemForm.acceptanceCriteria} onChange={(event) => setWorkItemForm((value) => ({ ...value, acceptanceCriteria: event.target.value }))} placeholder={t("可验证的验收标准")} /></label></div>
              <div className={styles.formGridFour}>
                <label><UiText text={"所属目标"} /><select value={workItemForm.objectiveId} onChange={(event) => setWorkItemForm((value) => ({ ...value, objectiveId: event.target.value }))}><option value=""><UiText text={"不关联目标"} /></option>{currentPlan.objectives.filter((item) => item.status !== "cancelled" && item.status !== "completed").map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
                <label><UiText text={"负责人"} /><select value={workItemForm.assigneeId} onChange={(event) => setWorkItemForm((value) => ({ ...value, assigneeId: event.target.value }))}><option value=""><UiText text={"未分配负责人"} /></option>{currentPlan.members.map((member) => <option key={member.id} value={member.id}>{userLabel(member)}</option>)}</select></label>
                <label><UiText text={"优先级"} /><select value={workItemForm.priority} onChange={(event) => setWorkItemForm((value) => ({ ...value, priority: event.target.value as Priority }))}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{t(label)} <UiText text={"优先级"} /></option>)}</select></label>
                <label><UiText text={"目标日期"} /><input type="date" value={workItemForm.targetDate} onChange={(event) => setWorkItemForm((value) => ({ ...value, targetDate: event.target.value }))} /></label>
              </div>
              <DialogActions><button type="button" className="app-action-button" disabled={pending !== null} onClick={() => setWorkItemOpen(false)}>{t("取消")}</button><DialogSubmit className={`app-action-button ${styles.formSubmit}`}  disabled={!currentPlan.canEdit || pending !== null || workItemForm.title.trim().length === 0}>{pending === "create-work-item" ? t("添加中…") : t("加入项目计划")}</DialogSubmit></DialogActions>
            </DialogForm>
          </OperationPanel>
        </div> : null}
      </header>

      {pageLoading ? <div className={styles.loading} role="status" aria-label={translateUi("正在加载项目计划")}><div /><div /><div /></div> : null}
      {currentPlan?.project.archivedAt ? <p className={styles.archivedNotice}><UiText text={"项目已归档，计划保持只读，目标、工作项和依赖不会被修改。"} /></p> : null}
      {message ? <p role="status" className={styles.success}><UiFeedbackText text={message} /></p> : null}
      {error && currentPlan ? <p role="alert" className={styles.error}><UiErrorText text={error} /></p> : null}
      {!pageLoading && currentPlan === null ? <div className={styles.errorPanel} role="alert"><p><UiErrorText text={error ?? "项目计划加载失败"} /></p><button type="button" onClick={() => void reload({ showLoading: true })}><UiText text={"重试"} /></button></div> : null}
      {navigation.returnTo ? <ParentPageLink href={navigation.returnTo} label="返回来源页面" /> : null}

      {currentPlan ? <>
        <section className={styles.goalBanner} aria-label={t("当前项目目标")}>
          <span className={styles.targetMark} aria-hidden="true">◎</span>
          <div className={styles.goalCopy}>
            <p className={styles.eyebrow}><UiText text={"CURRENT OBJECTIVE"} /></p>
            <h2>{objective?.title ?? t("尚未设置当前目标")}</h2>
            <p>{objective ? `${t(objectiveStatusLabels[objective.status])} · ${objective.targetDate ? `${t("目标日期")} ${dateLabel(objective.targetDate, language, t)}` : t("目标日期未设置")}` : t("可以创建目标草稿，再由成员明确启动。")}</p>
          </div>
          {objectiveWorkItems.length > 0 ? <div className={styles.goalProgress}><span className={styles.progressTrack}><span style={{ width: `${Math.round(completedObjectiveItems / objectiveWorkItems.length * 100)}%` }} /></span><strong>{completedObjectiveItems}/{objectiveWorkItems.length}</strong><small><UiText text={"已完成"} /></small></div> : <span className={styles.goalNotSet}>{objective ? t("尚无关联工作项") : t("目标未设置")}</span>}
          <a href="#objectives" className={styles.textLink}><UiText text={"目标详情 →"} /></a>
        </section>

        <div className={styles.summaryRow}>
          <div className={styles.healthSummary}><span className={`${styles.healthDot} ${currentPlan.health.status === "atRisk" ? styles.healthRisk : currentPlan.health.status === "attention" ? styles.healthAttention : ""}`} /><strong>{t(currentPlan.health.status === "atRisk" ? "需要立即处理" : currentPlan.health.status === "attention" ? "存在待处理事项" : currentPlan.health.status === "empty" ? "尚未建立工作项" : "计划运行正常")}</strong><span><UiText text={"逾期"} />{" "}{currentPlan.health.counts.overdue} {" "}<UiText text={"· 受阻"} />{" "}{currentPlan.health.counts.blocked} {" "}<UiText text={"· 缺少证据"} />{" "}{currentPlan.health.counts.missingEvidence}</span></div>
          <div className={styles.summaryCounts}><span><UiText text={"目标"} />{" "}<b>{currentPlan.objectives.filter((item) => item.status !== "cancelled").length}</b></span><span><UiText text={"待采纳"} />{" "}<b>{currentPlan.workItems.filter((item) => item.status === "proposed").length}</b></span><span><UiText text={"推进中"} />{" "}<b>{currentPlan.workItems.filter((item) => item.status === "inProgress" || item.status === "blocked").length}</b></span><span><UiText text={"已完成"} />{" "}<b>{currentPlan.workItems.filter((item) => item.status === "completed").length}</b></span></div>
        </div>

        <section className={styles.planSection} aria-label={t("项目工作项")}>
          <div className={styles.sectionHeading}><div><p className={styles.eyebrow}><UiText text={"WORK ITEMS"} /></p><h2><UiText text={"项目计划"} /></h2></div><span className={styles.totalCount}>{visibleWorkItems.length} {" "}<UiText text={"项工作"} /></span></div>
          <div className={styles.toolbar}>
            <div className={styles.viewSwitch} role="group" aria-label={t("项目计划视图")}>
              <button type="button" aria-pressed={view === "board"} className={view === "board" ? styles.activeView : ""} onClick={() => setView("board")}><ShellIcon name="grid" className="app-icon--control"/> {" "}<UiText text={"看板"} /></button>
              <button type="button" aria-pressed={view === "list"} className={view === "list" ? styles.activeView : ""} onClick={() => setView("list")}><ShellIcon name="plan" className="app-icon--control"/> {" "}<UiText text={"列表"} /></button>
            </div>
            <div className={styles.filters}>
              <label><UiText text={"状态"} /><select value={navigation.status ?? "all"} onChange={(event) => setStatusFilter(event.target.value)}><option value="all"><UiText text={"全部工作项"} /></option>{PROJECT_PLAN_STATUS_VALUES.map((status) => <option key={status} value={status}>{t(workItemStatusLabels[status])}</option>)}</select></label>
              <label><UiText text={"负责人"} /><select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}><option value="all"><UiText text={"所有负责人"} /></option><option value="me"><UiText text={"我的工作"} /></option><option value="unassigned"><UiText text={"未分配"} /></option>{currentPlan.members.map((member) => <option key={member.id} value={member.id}>{userLabel(member)}</option>)}</select></label>
              <label><UiText text={"目标"} /><select value={objectiveFilter} onChange={(event) => setObjectiveFilter(event.target.value)}><option value="all"><UiText text={"所有目标"} /></option>{currentPlan.objectives.filter((item) => item.status !== "cancelled").map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            </div>
          </div>

          {view === "board" ? <div className={styles.board}>
            {mainColumns.map((column) => {
              const items = visibleWorkItems.filter((item) => column.statuses.includes(item.status));
              return <section key={column.id} className={styles.boardColumn} aria-label={`${column.label} ${t("工作项")}`}>
                <div className={styles.columnHeading}><span className={`${styles.columnDot} ${column.id === "blocked" ? styles.healthRisk : column.id === "inProgress" ? styles.healthAttention : ""}`} /><h3>{column.label}</h3><span>{items.length}</span></div>
                <div className={styles.boardCards}>{items.map((item) => <WorkItemCard key={item.id} item={item} objective={objectiveById.get(item.objectiveId ?? "")} evidenceCount={currentPlan.evidenceLinks.filter((link) => link.workItemId === item.id).length} onOpen={() => chooseWorkItem(item)} />)}</div>
                {items.length === 0 ? <p className={styles.columnEmpty}><UiText text={"暂无工作项"} /></p> : null}
                {column.id === "planned" && currentPlan.canEdit && navigation.status !== "cancelled" ? <button type="button" className={`${styles.addWorkButton} app-action-button`} onClick={() => setWorkItemOpen(true)}><UiText text={"＋ 添加工作项"} /></button> : null}
              </section>;
            })}
          </div> : <div className={styles.listView}>
            {visibleWorkItems.map((item) => <WorkItemRow key={item.id} item={item} objective={objectiveById.get(item.objectiveId ?? "")} evidenceCount={currentPlan.evidenceLinks.filter((link) => link.workItemId === item.id).length} onOpen={() => chooseWorkItem(item)} />)}
            {visibleWorkItems.length === 0 ? <div className={styles.emptyState}><UiText text={"当前筛选条件下没有工作项。"} /></div> : null}
          </div>}

          {view === "board" && navigation.status === null && cancelledItems.length > 0 ? <details className={styles.cancelledDetails}><summary><UiText text={"已取消工作项"} />{" "}<span>{cancelledItems.length}</span></summary><div className={styles.listView}>{cancelledItems.map((item) => <WorkItemRow key={item.id} item={item} objective={objectiveById.get(item.objectiveId ?? "")} evidenceCount={currentPlan.evidenceLinks.filter((link) => link.workItemId === item.id).length} onOpen={() => chooseWorkItem(item)} />)}</div></details> : null}
          {visibleWorkItems.length === 0 && view === "board" ? <div className={styles.emptyState}>{currentPlan.workItems.length === 0 ? t("没有工作项。可以手动创建，或保存有证据的智能体建议。") : t("当前筛选条件下没有工作项。")}</div> : null}
        </section>

        <details id="objectives" className={styles.collapsibleSection}>
          <summary><UiText text={"全部目标"} />{" "}<span>{currentPlan.objectives.filter((item) => item.status !== "cancelled").length}</span></summary>
          <div className={styles.objectiveList}>{currentPlan.objectives.map((objectiveItem) => <article key={objectiveItem.id} className={styles.objectiveCard}>
            <div className={styles.objectiveText}><strong>{objectiveItem.title}</strong><span>{objectiveItem.description || t("未填写目标说明")}</span><small><UiText text={"目标日期："} />{dateLabel(objectiveItem.targetDate, language, t)} {" "}<UiText text={"· 创建人："} />{userLabel(objectiveItem.createdBy)}</small></div>
            <span className={`${styles.statusChip} ${statusTone(objectiveItem.status)}`}>{t(objectiveStatusLabels[objectiveItem.status])}</span>
            {objectiveTransitions[objectiveItem.status].length > 0 ? <div className={styles.transitionButtons}>{objectiveTransitions[objectiveItem.status].map((status) => <button className="app-action-button" key={status} type="button" onClick={() => void request({ entity: "objective", id: objectiveItem.id, expectedUpdatedAt: objectiveItem.updatedAt, status }, "PATCH", `objective:${objectiveItem.id}:${status}`, t("目标已更新为“{status}”。").replace("{status}", t(objectiveStatusLabels[status])))} disabled={!currentPlan.canEdit || pending !== null}>{t(objectiveStatusLabels[status])}</button>)}</div> : null}
          </article>)}{currentPlan.objectives.length === 0 ? <p className={styles.emptyState}><UiText text={"还没有项目目标。"} /></p> : null}</div>
        </details>

        <details className={styles.collapsibleSection}>
          <summary><UiText text={"带证据的智能体建议"} />{" "}<span>{currentPlan.availableRecommendations.length}</span></summary>
          <p className={styles.detailIntro}><UiText text={"建议只会保存为待采纳工作项；接受、推进和完成由项目成员明确操作。"} /></p>
          <div className={styles.recommendations}>{currentPlan.availableRecommendations.map((recommendation) => <article key={`${recommendation.agentRunId}:${recommendation.recommendationIndex}`} className={styles.recommendationCard}>
            <strong>{recommendation.text}</strong><p>{recommendation.citationCount} {" "}<UiText text={"条引用 · 来源问题："} />{recommendation.question}</p><button className="app-action-button" type="button" onClick={() => void request({ operation: "promoteRecommendation", agentRunId: recommendation.agentRunId, recommendationIndex: recommendation.recommendationIndex }, "POST", `promote:${recommendation.agentRunId}:${recommendation.recommendationIndex}`, t("建议已保存为待采纳工作项，证据快照保持不可变。"))} disabled={!currentPlan.canEdit || pending !== null}>{pending === `promote:${recommendation.agentRunId}:${recommendation.recommendationIndex}` ? t("保存中…") : t("保存为待采纳工作项")}</button>
          </article>)}{currentPlan.availableRecommendations.length === 0 ? <p className={styles.emptyState}><UiText text={"没有尚未处理的智能体建议。"} /></p> : null}</div>
          <Link href={`/projects/${projectId}/intelligence`} className={styles.textLink}><UiText text={"进入项目智能体 →"} /></Link>
        </details>

        <details className={styles.collapsibleSection}>
          <summary><UiText text={"计划健康与仓库变更"} />{" "}<span><UiText text={"受阻"} />{" "}{currentPlan.health.counts.blocked} {" "}<UiText text={"· 待评估"} />{" "}{currentPlan.health.counts.openImpacts}</span></summary>
          <ProjectOperationsSummary health={currentPlan.health} impacts={currentPlan.impactSuggestions} workItems={currentPlan.workItems} canEdit={currentPlan.canEdit} pending={pending} error={error} request={request} />
        </details>

        <details id="plan-history" className={styles.collapsibleSection}>
          <summary><UiText text={"最近计划审计"} />{" "}<span>{Math.min(currentPlan.audits.length, 12)} {" "}<UiText text={"条"} /></span></summary>
          <div className={styles.auditList}>{currentPlan.audits.slice(0, 12).map((audit) => <div key={audit.id}><strong>{audit.event}</strong><span>{userLabel(audit.actor)} · {new Date(audit.createdAt).toLocaleString(language === "en" ? "en-US" : "zh-CN")}</span></div>)}{currentPlan.audits.length === 0 ? <p className={styles.emptyState}><UiText text={"还没有计划审计记录。"} /></p> : null}</div>
        </details>

        {selectedWorkItem ? <OperationPanel title={selectedWorkItem.title} triggerLabel={t("打开工作项详情")} open={detailOpen} onOpenChange={setDetailOpen} className={styles.hiddenOperationTrigger} description={t("查看范围、负责人、期限、依赖和关联证据；计划变更会经过服务器状态与证据校验。")}>
          <WorkItemDetail item={selectedWorkItem} objective={objectiveById.get(selectedWorkItem.objectiveId ?? "")} dependencies={currentPlan.dependencies.filter((entry) => entry.workItemId === selectedWorkItem.id).map((dependency) => ({ ...dependency, title: workItemById.get(dependency.dependsOnId)?.title ?? "未知工作项" }))} evidenceLinks={currentPlan.evidenceLinks.filter((link) => link.workItemId === selectedWorkItem.id)} />
          <WorkItemOperations key={`${selectedWorkItem.id}:${selectedWorkItem.updatedAt}`} item={selectedWorkItem} objectives={currentPlan.objectives} members={currentPlan.members} evidenceLinks={currentPlan.evidenceLinks.filter((link) => link.workItemId === selectedWorkItem.id)} evidenceCandidates={[...currentPlan.evidenceCandidates.projectItems, ...currentPlan.evidenceCandidates.projectSources]} dependencies={currentPlan.dependencies.filter((entry) => entry.workItemId === selectedWorkItem.id).map((dependency) => ({ ...dependency, title: workItemById.get(dependency.dependsOnId)?.title ?? "未知工作项" }))} dependencyCandidates={activeWorkItems.filter((candidate) => candidate.id !== selectedWorkItem.id && !currentPlan.dependencies.some((dependency) => dependency.workItemId === selectedWorkItem.id && dependency.dependsOnId === candidate.id))} canEdit={currentPlan.canEdit} pending={pending} error={error} request={request} />
          <DialogActions className={styles.detailActions}>{workItemTransitions[selectedWorkItem.status].map((status) => <button className="app-action-button" key={status} type="button" onClick={() => void request({ entity: "workItem", id: selectedWorkItem.id, expectedUpdatedAt: selectedWorkItem.updatedAt, status }, "PATCH", `work-item:${selectedWorkItem.id}:${status}`, t("工作项已更新为“{status}”。").replace("{status}", t(workItemStatusLabels[status])))} disabled={!currentPlan.canEdit || pending !== null}>{pending === `work-item:${selectedWorkItem.id}:${status}` ? t("更新中…") : t(workItemStatusLabels[status])}</button>)}</DialogActions>
        </OperationPanel> : null}
      </> : null}
    </div>
  </main>;
}

function WorkItemCard({ item, objective, evidenceCount, onOpen }: { item: WorkItem; objective: Objective | undefined; evidenceCount: number; onOpen: () => void }) {
  const { language, t } = useAppearance();
  return <button id={`work-item-${item.id}`} type="button" className={styles.workCard} onClick={onOpen} aria-label={t("查看工作项：{title}").replace("{title}", item.title)}>
    <div className={styles.cardMeta}><span className={`${styles.statusChip} ${statusTone(item.status)}`}>{t(workItemStatusLabels[item.status])}</span><span className={styles.priority}>{t(priorityLabels[item.priority])} <UiText text={"优先级"} /></span></div>
    <strong>{item.title}</strong>
    {item.description ? <p>{item.description}</p> : null}
    {objective ? <span className={styles.objectiveTag}>{objective.title}</span> : null}
    <div className={styles.cardFooter}><span>{evidenceCount > 0 ? t("已关联 {count} 条证据").replace("{count}", String(evidenceCount)) : t("尚未关联证据")}</span><span>{item.targetDate ? dateLabel(item.targetDate, language, t) : t("未设置期限")}</span></div>
    <div className={styles.assignee}>{item.assignee ? userLabel(item.assignee) : t("未分配负责人")}</div>
  </button>;
}

function WorkItemRow({ item, objective, evidenceCount, onOpen }: { item: WorkItem; objective: Objective | undefined; evidenceCount: number; onOpen: () => void }) {
  const { language, t } = useAppearance();
  return <button id={`work-item-${item.id}`} type="button" className={styles.listItem} onClick={onOpen} aria-label={t("查看工作项：{title}").replace("{title}", item.title)}>
    <span className={styles.listTitle}><strong>{item.title}</strong><small>{objective?.title ?? t("未关联目标")}</small></span>
    <span className={`${styles.statusChip} ${statusTone(item.status)}`}>{t(workItemStatusLabels[item.status])}</span>
    <span className={styles.listMeta}>{item.assignee ? userLabel(item.assignee) : t("未分配")}</span>
    <span className={styles.listMeta}>{item.targetDate ? dateLabel(item.targetDate, language, t) : t("未设置期限")}</span>
    <span className={styles.listMeta}>{evidenceCount > 0 ? t("已关联 {count} 条证据").replace("{count}", String(evidenceCount)) : t("无证据")}</span>
    <span aria-hidden="true" className={styles.arrow}>→</span>
  </button>;
}

function WorkItemDetail({ item, objective, dependencies, evidenceLinks }: { item: WorkItem; objective: Objective | undefined; dependencies: Array<{ id: string; dependsOnId: string; title: string }>; evidenceLinks: PlanEvidenceLink[] }) {
  const { language, t } = useAppearance();
  return <div className={styles.workDetail}>
    <div className={styles.detailBadges}><span className={`${styles.statusChip} ${statusTone(item.status)}`}>{t(workItemStatusLabels[item.status])}</span><span className={styles.priority}>{t(priorityLabels[item.priority])} <UiText text={"优先级"} /></span>{item.origin === "agentRecommendation" ? <span className={styles.proposedBadge}><UiText text={"智能体建议 · 等待人工采纳"} /></span> : null}</div>
    <p>{item.description || t("尚未填写工作说明。")}</p>
    <div className={styles.detailGrid}><div><span><UiText text={"验收标准"} /></span><strong>{item.acceptanceCriteria || t("尚未设置")}</strong></div><div><span><UiText text={"所属目标"} /></span><strong>{objective?.title ?? t("未关联目标")}</strong></div><div><span><UiText text={"负责人"} /></span><strong>{item.assignee ? userLabel(item.assignee) : t("未分配")}</strong></div><div><span><UiText text={"目标日期"} /></span><strong>{dateLabel(item.targetDate, language, t)}</strong></div></div>
    <section className={styles.detailSubsection}><h3><UiText text={"前置依赖"} /></h3>{dependencies.length > 0 ? <ul>{dependencies.map((dependency) => <li key={dependency.id}>{dependency.title}</li>)}</ul> : <p><UiText text={"无前置依赖。"} /></p>}</section>
    <section className={styles.detailSubsection}><h3><UiText text={"关联证据"} /></h3>{evidenceLinks.length > 0 ? <ul>{evidenceLinks.map((link) => <li key={link.id}>{link.label}{link.stale ? ` · ${t("需要复核")}` : ""}</li>)}</ul> : <p><UiText text={"尚未关联完成证据。"} /></p>}</section>
  </div>;
}
