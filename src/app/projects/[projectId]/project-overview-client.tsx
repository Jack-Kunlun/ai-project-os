"use client";
import { UiErrorText, UiFeedbackText } from "@/components/ui-error-text";


import { UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { buildProjectHref, parseProjectPageState } from "@/lib/project-navigation";
import { summarizeProjectOverview } from "@/lib/project-overview-metrics";
import { safeResponseError } from "@/lib/safe-error-presentation";
import type { JobKind, JobStatus } from "@/lib/workspace-summary";
import { jobStatusLabels } from "@/lib/workspace-summary";
import type { SnapshotRecord } from "@/lib/project-snapshot";
import { ProjectGovernanceSections } from "./governance/project-governance-client";
import styles from "./project-overview-client.module.css";

type Project = {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  _count: { sources: number; assets: number; items: number; scans: number; snapshots: number };
};

type GovernanceSummary = {
  pendingReviews: { web: number; verified: number; total: number };
  jobs: { reconciliationRequired: number; failed: number };
  github: { partial: number; rateLimited: number; unknown: number };
  index: { readiness: string; compatible: boolean; activeRecordCount: number };
  attentionTotal: number;
};

type WorldStatus = "on_track" | "needs_attention" | "at_risk" | "insufficient_data";
type WorldSummary = {
  status: WorldStatus;
  counts: {
    activeFacts: number;
    decisions: number;
    progress: number;
    issues: number;
    risks: number;
    activeRelations: number;
    activeConflicts: number;
    openQualityIssues: number;
    linkedWorkItems: number;
  };
  planHealth: { status: string; counts: { overdue: number; blocked: number; dueSoon: number; unassigned: number } };
};

type OverviewObjective = { id: string; title: string; description: string | null; status: "draft" | "active" | "completed" | "cancelled"; targetDate: string | null; updatedAt: string };
type OverviewWorkItem = {
  id: string;
  title: string;
  status: "proposed" | "planned" | "inProgress" | "blocked" | "completed" | "cancelled";
  objectiveId: string | null;
  targetDate: string | null;
  assignee: { id: string; username: string; displayName: string | null } | null;
};
type OverviewAudit = { id: string; event: string; createdAt: string; actor: { username: string; displayName: string | null } };
type OverviewPlan = {
  project: { id: string; name: string; archivedAt: string | null };
  objectives: OverviewObjective[];
  workItems: OverviewWorkItem[];
  health: { counts: { active: number; blocked: number } };
  audits: OverviewAudit[];
};
type ConfirmedFact = {
  id: string;
  title: string;
  content: string;
  sourceExcerpt: string;
  sourceId: string;
  updatedAt: string;
  source: { kind: string };
};
type OverviewJob = { id: string; kind: JobKind; status: JobStatus; stage: string; createdAt: string; reconciliationRequired: boolean };

type OverviewData = {
  project: Project;
  itemCounts: { candidate: number; confirmed: number; dismissed: number; superseded: number };
  snapshot: SnapshotRecord | null;
  snapshotStale: boolean;
  governance: GovernanceSummary;
  world: WorldSummary;
  plan: OverviewPlan | null;
  planError: string | null;
  recentFacts: ConfirmedFact[];
  factsError: string | null;
  jobs: OverviewJob[];
  activityError: string | null;
};

type ProjectJobActivity = Readonly<{ id: string; label: string; detail: string; createdAt: string; href: string }>;

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw new Error((await safeResponseError(response, fallback)).message);
  return await response.json() as T;
}

function formatDate(value: string, language: "zh-CN" | "en"): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

const worldStatusMeta: Record<WorldStatus, { label: string; detail: string; tone: string }> = {
  on_track: { label: "运行正常", detail: "当前事实、关系与计划没有出现阻断信号。", tone: styles.statusGood },
  needs_attention: { label: "需要关注", detail: "存在需要核对的风险、关系或项目计划信号。", tone: styles.statusWarning },
  at_risk: { label: "存在风险", detail: "存在问题、事实冲突或受阻计划，需要优先处理。", tone: styles.statusRisk },
  insufficient_data: { label: "资料不足", detail: "当前还没有足够的已确认事实来判断项目状态。", tone: styles.statusNeutral },
};

const workStatusLabels: Record<OverviewWorkItem["status"], string> = {
  proposed: "待采纳",
  planned: "已计划",
  inProgress: "进行中",
  blocked: "受阻",
  completed: "已完成",
  cancelled: "已取消",
};

const activityJobLabels: Record<JobKind, string> = {
  assetExtract: "文件图片识别",
  githubScan: "代码扫描",
  githubMaterialSync: "仓库资料同步",
  githubProjectSync: "GitHub 全量同步",
  memoryIndex: "记忆索引",
  autoExtract: "自动抽取",
  semanticSearch: "语义检索",
  ragAnswer: "引用式问答",
  projectBrief: "项目简报",
  projectAgent: "智能体调查",
};

function objectiveStatusLabel(status: OverviewObjective["status"]): string {
  return status === "active" ? "进行中" : status === "draft" ? "草稿" : status === "completed" ? "已完成" : "已取消";
}

function orderedNextWork(items: OverviewWorkItem[]): OverviewWorkItem[] {
  const rank: Record<OverviewWorkItem["status"], number> = { blocked: 0, inProgress: 1, planned: 2, proposed: 3, completed: 4, cancelled: 5 };
  return items.filter((item) => item.status !== "completed" && item.status !== "cancelled").sort((left, right) => {
    const statusOrder = rank[left.status] - rank[right.status];
    if (statusOrder !== 0) return statusOrder;
    if (left.targetDate && right.targetDate) return left.targetDate.localeCompare(right.targetDate);
    if (left.targetDate) return -1;
    if (right.targetDate) return 1;
    return left.title.localeCompare(right.title, "zh-CN");
  });
}

export function ProjectOverviewClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const translateUi = useTranslate();
  const { language } = useAppearance();
  const t = useTranslate();
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const navigation = useMemo(() => parseProjectPageState("overview", projectId, new URLSearchParams(searchParams.toString())), [projectId, searchParams]);
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshotPendingProjectId, setSnapshotPendingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const currentProjectId = useRef(projectId);
  const snapshotPending = snapshotPendingProjectId === projectId;

  useLayoutEffect(() => {
    currentProjectId.current = projectId;
    return () => {
      requestSequence.current += 1;
      activeController.current?.abort();
    };
  }, [projectId]);

  useEffect(() => {
    if (loading || data?.project.id !== projectId || (navigation.focus !== "current-state" && navigation.focus !== "attention-details")) return;
    const target = document.getElementById(navigation.focus);
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }, [data, loading, navigation.focus, projectId]);

  const load = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    const sequence = ++requestSequence.current;
    const requestedProjectId = projectId;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const [projectPayload, itemsPayload, snapshotPayload, governancePayload, worldPayload] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: "no-store", signal: controller.signal }).then((response) => readJson<{ project: Project }>(response, t("项目加载失败"))),
        fetch(`/api/projects/${projectId}/items?page=1&pageSize=1`, { cache: "no-store", signal: controller.signal }).then((response) => readJson<{ counts: OverviewData["itemCounts"] }>(response, t("项目事实加载失败"))),
        fetch(`/api/projects/${projectId}/snapshots`, { cache: "no-store", signal: controller.signal }).then((response) => readJson<{ snapshot: SnapshotRecord | null; stale: boolean }>(response, t("项目快照加载失败"))),
        fetch(`/api/projects/${projectId}/governance`, { cache: "no-store", signal: controller.signal }).then((response) => readJson<{ summary: GovernanceSummary }>(response, t("项目提醒加载失败"))),
        fetch(`/api/projects/${projectId}/world`, { cache: "no-store", signal: controller.signal }).then((response) => readJson<{ state: WorldSummary }>(response, t("项目状态加载失败"))),
      ]);
      const [planResult, factsResult, jobsResult] = await Promise.allSettled([
        fetch(`/api/projects/${projectId}/plan`, { cache: "no-store", signal: controller.signal }).then((response) => readJson<OverviewPlan>(response, t("项目目标和计划暂不可用"))),
        fetch(`/api/projects/${projectId}/items?reviewStatus=confirmed&page=1&pageSize=5`, { cache: "no-store", signal: controller.signal }).then((response) => readJson<{ items: ConfirmedFact[] }>(response, t("最近确认事实暂不可用"))),
        fetch(`/api/projects/${projectId}/jobs`, { cache: "no-store", signal: controller.signal }).then((response) => readJson<{ jobs: OverviewJob[] }>(response, t("项目活动暂不可用"))),
      ]);
      if (controller.signal.aborted || sequence !== requestSequence.current || currentProjectId.current !== requestedProjectId) return;

      setData({
        project: projectPayload.project,
        itemCounts: itemsPayload.counts,
        snapshot: snapshotPayload.snapshot,
        snapshotStale: snapshotPayload.stale,
        governance: governancePayload.summary,
        world: worldPayload.state,
        plan: planResult.status === "fulfilled" ? planResult.value : null,
        planError: planResult.status === "rejected" ? t(planResult.reason instanceof Error ? planResult.reason.message : "项目目标和计划暂不可用") : null,
        recentFacts: factsResult.status === "fulfilled" ? factsResult.value.items : [],
        factsError: factsResult.status === "rejected" ? t(factsResult.reason instanceof Error ? factsResult.reason.message : "最近确认事实暂不可用") : null,
        jobs: jobsResult.status === "fulfilled" ? jobsResult.value.jobs : [],
        activityError: jobsResult.status === "rejected" ? t(jobsResult.reason instanceof Error ? jobsResult.reason.message : "项目活动暂不可用") : null,
      });
      setMessage(null);
    } catch (cause) {
      if (controller.signal.aborted || sequence !== requestSequence.current || currentProjectId.current !== requestedProjectId) return;
      setError(t(cause instanceof Error ? cause.message : "项目概览加载失败"));
    } finally {
      if (!controller.signal.aborted && sequence === requestSequence.current && currentProjectId.current === requestedProjectId) setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load({ showLoading: true }), 0);
    return () => {
      window.clearTimeout(timer);
      requestSequence.current += 1;
      activeController.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if ((navigation.focus !== "current-state" && navigation.focus !== "attention-details" && navigation.focus !== "task-runs") || loading || data?.project.id !== projectId) return;
    const focusId = navigation.focus;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(focusId);
      target?.scrollIntoView({ block: "start" });
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [data, loading, navigation.focus, projectId]);

  const currentData = data?.project.id === projectId ? data : null;
  const summary = useMemo(() => currentData === null ? null : summarizeProjectOverview(currentData), [currentData]);
  const currentObjective = useMemo(() => {
    const candidates = currentData?.plan?.objectives.filter((objective) => objective.status === "active" || objective.status === "draft") ?? [];
    return candidates.sort((left, right) => Number(right.status === "active") - Number(left.status === "active") || right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }, [currentData]);
  const objectiveWorkItems = useMemo(() => currentObjective ? currentData?.plan?.workItems.filter((item) => item.objectiveId === currentObjective.id && item.status !== "cancelled") ?? [] : [], [currentData, currentObjective]);
  const nextWorkItems = useMemo(() => orderedNextWork(currentData?.plan?.workItems ?? []).slice(0, 3), [currentData]);
  const recentActivity = useMemo(() => {
    if (!currentData) return [];
    const jobs: ProjectJobActivity[] = currentData.jobs.map((job) => ({
      id: `job:${job.id}`,
      label: t(activityJobLabels[job.kind]),
      detail: `${t(jobStatusLabels[job.status])}${job.reconciliationRequired ? ` · ${t("需要核对")}` : job.stage ? ` · ${t(job.stage)}` : ""}`,
      createdAt: job.createdAt,
      href: `/projects/${projectId}/jobs/${job.id}`,
    }));
    const audits: ProjectJobActivity[] = (currentData.plan?.audits ?? []).map((audit) => ({
      id: `audit:${audit.id}`,
      label: t("计划动态"),
      detail: `${t(audit.event)} · ${audit.actor.displayName?.trim() || audit.actor.username}`,
      createdAt: audit.createdAt,
      href: `/projects/${projectId}/plan#plan-history`,
    }));
    return [...jobs, ...audits].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 5);
  }, [currentData, projectId, t]);

  const overviewReturnTo = buildProjectHref(projectId, "overview", { focus: "current-state" });
  const projectCandidateHref = buildProjectHref(projectId, "materials", { status: "candidate", focus: "items-heading", from: "overview", returnTo: overviewReturnTo });
  const aiReviewHref = buildProjectHref(projectId, "materialsReview", { focus: "review-queue", from: "overview", returnTo: overviewReturnTo });
  const candidateCount = summary?.candidates ?? 0;
  const aiReviewCount = currentData?.governance.pendingReviews.total ?? 0;
  const pendingUsesProjectCandidates = candidateCount > aiReviewCount;
  const pendingDetailHref = pendingUsesProjectCandidates ? projectCandidateHref : aiReviewHref;
  const nextStep = (() => {
    if (currentData === null || summary === null) return null;
    const returnTo = buildProjectHref(projectId, "overview", { focus: "current-state" });
    if (currentData.project._count.sources === 0 && currentData.project._count.assets === 0) return { title: t("添加第一份项目资料"), detail: t("输入文本，或上传图片、文档和文件夹。"), href: buildProjectHref(projectId, "materials", { view: "add", from: "overview", returnTo }), action: t("添加资料") };
    if (summary.pendingContent > 0) return { title: t("审核待确认内容"), detail: t("这里只核对仍待处理、尚未自动形成事实的内容。"), href: pendingDetailHref, action: t("开始审核") };
    if (!currentData.governance.index.compatible) return { title: t("智能问答"), detail: t("选择项目范围，核对资料后开始或继续提问。"), href: `/ask?scope=project&projectId=${encodeURIComponent(projectId)}`, action: t("打开智能问答") };
    return { title: t("查询项目或生成简报"), detail: t("当前项目已经具备可引用的智能查询基础。"), href: buildProjectHref(projectId, "intelligence", { focus: "agent-investigation", from: "overview", returnTo }), action: t("打开简报与调查") };
  })();

  const attentionVisible = summary !== null && (summary.attentionTotal > 0 || currentData?.world.status === "at_risk" || (currentData?.plan?.health.counts.blocked ?? 0) > 0);
  const attentionDetail = currentData && summary ? t("待核对 {pending} · 失败任务 {failed} · 受阻工作 {blocked}").replace("{pending}", String(summary.pendingContent)).replace("{failed}", String(summary.failedJobs)).replace("{blocked}", String(currentData.plan?.health.counts.blocked ?? t("暂不可用"))) : "";
  const activeWorkCount = currentData?.plan?.workItems.filter((item) => item.status !== "completed" && item.status !== "cancelled").length;
  const blockedWorkCount = currentData?.plan?.workItems.filter((item) => item.status === "blocked").length;

  async function generateSnapshot() {
    if (currentData === null || summary === null || summary.confirmed === 0 || snapshotPending) return;
    const requestedProjectId = projectId;
    setSnapshotPendingProjectId(requestedProjectId);
    setError(null);
    setMessage(null);
    try {
      await readJson<{ snapshot: SnapshotRecord }>(await fetch(`/api/projects/${requestedProjectId}/snapshots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }), t("项目快照生成失败"));
      if (currentProjectId.current !== requestedProjectId) return;
      await load();
      if (currentProjectId.current === requestedProjectId) setMessage(t("项目状态快照已更新。"));
    } catch (cause) {
      if (currentProjectId.current === requestedProjectId) setError(t(cause instanceof Error ? cause.message : "项目快照生成失败"));
    } finally {
      if (currentProjectId.current === requestedProjectId) setSnapshotPendingProjectId(null);
    }
  }

  return (
    <main className={styles.page} aria-label={t("项目概览")}>
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="overview" isSystemAdmin={isSystemAdmin} />
      <div data-page-content className={styles.content}>
        {loading && currentData === null ? <OverviewSkeleton /> : currentData === null || summary === null || nextStep === null ? (
          <div className={styles.error} role="alert"><span><UiErrorText text={error ?? "项目概览加载失败"} /></span><button type="button" onClick={() => void load({ showLoading: true })}><UiText text={"重试"} /></button></div>
        ) : (
          <>
            <section className={styles.heading}>
              <div className={styles.headingCopy}>
                <p className={styles.eyebrow}><UiText text={"PROJECT OVERVIEW"} /></p>
                <h1>{currentData.project.name}</h1>
                <p className={styles.subtitle}>{currentData.project.description || t("尚未填写项目说明。")}</p>
              </div>
              <span className={`${styles.statusPill} ${worldStatusMeta[currentData.world.status].tone}`}>{t(currentData.project.archivedAt ? "已归档" : worldStatusMeta[currentData.world.status].label)}</span>
            </section>

            {currentData.project.archivedAt ? <p className={styles.archiveNotice}><UiText text={"项目已归档，当前概览为只读状态。"} /></p> : null}
            {error ? <p role="alert" className={styles.inlineError}><UiErrorText text={error} /></p> : null}
            {message ? <p role="status" className={styles.inlineSuccess}><UiFeedbackText text={message} /></p> : null}

            <section className={styles.metrics} aria-label={t("项目关键指标")}>
              <MetricCard label={t("进行中工作")} value={currentData.planError ? "—" : activeWorkCount ?? 0} detail={currentData.planError ? t("项目计划暂不可用") : currentData.plan ? `${blockedWorkCount ?? 0} ${t("项受阻")}` : t("项目计划尚未设置")} href={`/projects/${projectId}/plan`} />
              <MetricCard label={t("待核对内容")} value={summary.pendingContent} detail={t("项目候选与 AI 审核队列")} href={pendingDetailHref} />
              <MetricCard label={t("已确认事实")} value={summary.confirmed} detail={`${t("全部条目")} ${currentData.project._count.items}`} href={buildProjectHref(projectId, "materials", { status: "confirmed", focus: "confirmed-facts", from: "overview", returnTo: overviewReturnTo })} />
              <MetricCard label={t("项目资料")} value={currentData.project._count.sources} detail={`${t("文件")} ${currentData.project._count.assets} ${t("份")}`} href={buildProjectHref(projectId, "materials", { focus: "sources-heading", from: "overview", returnTo: overviewReturnTo })} />
            </section>

            {attentionVisible ? <Link href={buildProjectHref(projectId, "overview", { focus: "attention-details" })} className={styles.attentionBar}>
              <span className={styles.attentionMark} aria-hidden="true">!</span>
              <span><strong>{t(currentData.world.status === "at_risk" ? "项目状态存在风险" : "有事项需要关注")}</strong><small>{attentionDetail}</small></span>
              <span className={styles.attentionArrow}><UiText text={"查看详情 →"} /></span>
            </Link> : null}

            <section className={styles.overviewGrid}>
              <div className={styles.mainColumn}>
                <article id="current-state" tabIndex={-1} aria-label={translateUi("项目当前状态")} className={styles.goalPanel}>
                  <div className={styles.panelHeading}><div><p className={styles.eyebrow}><UiText text={"CURRENT OBJECTIVE"} /></p><h2><UiText text={"当前目标"} /></h2></div><Link href={`/projects/${projectId}/plan`} className={styles.textLink}><UiText text={"查看计划 →"} /></Link></div>
                  {currentData.planError ? <p className={styles.panelEmpty}><UiText text={"目标数据暂不可用。"} /><UiErrorText text={currentData.planError} /></p> : currentObjective ? <>
                    <div className={styles.goalMeta}>{t(objectiveStatusLabel(currentObjective.status))}{currentObjective.targetDate ? ` · ${t("目标日期")} ${formatDate(currentObjective.targetDate, language)}` : ` · ${t("目标日期未设置")}`}</div>
                    <h3 className={styles.goalTitle}>{currentObjective.title}</h3>
                    <p className={styles.goalDescription}>{currentObjective.description || t("尚未填写目标说明。")}</p>
                    {objectiveWorkItems.length > 0 ? <div className={styles.progressRow}>
                      <span className={styles.progressTrack}><span style={{ width: `${Math.round(objectiveWorkItems.filter((item) => item.status === "completed").length / objectiveWorkItems.length * 100)}%` }} /></span>
                      <span>{objectiveWorkItems.filter((item) => item.status === "completed").length} / {objectiveWorkItems.length} {" "}<UiText text={"项已完成"} /></span>
                    </div> : <p className={styles.panelEmpty}><UiText text={"还没有关联到此目标的工作项。"} /></p>}
                  </> : <div className={styles.emptyGoal}><h3><UiText text={"尚未设置当前目标"} /></h3><p><UiText text={"项目目标可在计划中创建并启动。"} /></p><Link href={`/projects/${projectId}/plan`}><UiText text={"前往项目计划 →"} /></Link></div>}
                  <div className={styles.worldSummary}>
                    <span className={`${styles.statusPill} ${worldStatusMeta[currentData.world.status].tone}`}>{t(worldStatusMeta[currentData.world.status].label)}</span>
                    <p>{t(worldStatusMeta[currentData.world.status].detail)}</p>
                    <Link href={`/projects/${projectId}/world`}><UiText text={"高级状态治理 →"} /></Link>
                  </div>
                </article>

                <section className={styles.nextTasks} aria-labelledby="next-work-heading">
                  <div className={styles.panelHeading}><div><p className={styles.eyebrow}><UiText text={"NEXT WORK"} /></p><h2 id="next-work-heading"><UiText text={"接下来推进"} /></h2></div><Link href={`/projects/${projectId}/plan`} className={styles.textLink}><UiText text={"全部工作 →"} /></Link></div>
                  {currentData.planError ? <p className={styles.panelEmpty}><UiText text={"计划工作暂不可用，稍后重试。"} /></p> : nextWorkItems.length === 0 ? <p className={styles.panelEmpty}><UiText text={"暂无待推进工作。"} /></p> : <div className={styles.workList}>{nextWorkItems.map((item) => <Link key={item.id} href={`/projects/${projectId}/plan?focus=${encodeURIComponent(item.id)}&status=${encodeURIComponent(item.status)}`} className={styles.workItem}>
                    <span className={`${styles.workDot} ${item.status === "blocked" ? styles.workBlocked : item.status === "inProgress" ? styles.workActive : ""}`} aria-hidden="true" />
                    <span className={styles.workCopy}><strong>{item.title}</strong><small>{t(workStatusLabels[item.status])} · {item.assignee?.displayName?.trim() || item.assignee?.username || t("未分配")}{item.targetDate ? ` · ${formatDate(item.targetDate, language)}` : ` · ${t("未设置期限")}`}</small></span>
                    <span className={styles.arrow} aria-hidden="true">→</span>
                  </Link>)}</div>}
                </section>

                <section className={styles.factsPanel} aria-labelledby="recent-facts-heading">
                  <div className={styles.panelHeading}><div><p className={styles.eyebrow}><UiText text={"SOURCE-GROUNDED FACTS"} /></p><h2 id="recent-facts-heading"><UiText text={"最近确认的项目事实"} /></h2></div><Link href={buildProjectHref(projectId, "materials", { status: "confirmed", focus: "confirmed-facts", from: "overview", returnTo: overviewReturnTo })} className={styles.textLink}><UiText text={"查看全部 →"} /></Link></div>
                  {currentData.factsError ? <p className={styles.panelEmpty}><UiErrorText text={currentData.factsError} /></p> : currentData.recentFacts.length === 0 ? <p className={styles.panelEmpty}><UiText text={"还没有已确认事实。"} /></p> : <div className={styles.factList}>{currentData.recentFacts.map((fact) => <Link key={fact.id} href={`/projects/${projectId}/materials/sources/${fact.sourceId}`} className={styles.factItem}>
                    <span className={styles.factText}><strong>{fact.title}</strong><small>{fact.sourceExcerpt || fact.content}</small></span>
                    <span className={styles.factSource}>{t(fact.source.kind)} · {formatDate(fact.updatedAt, language)}</span>
                  </Link>)}</div>}
                </section>
              </div>

              <aside className={styles.sideColumn}>
                <section className={styles.activityPanel}>
                  <div className={styles.panelHeading}><div><p className={styles.eyebrow}><UiText text={"RECENT ACTIVITY"} /></p><h2><UiText text={"最近动态"} /></h2></div></div>
                  {currentData.activityError && recentActivity.length === 0 ? <p className={styles.panelEmpty}><UiErrorText text={currentData.activityError} /></p> : recentActivity.length === 0 ? <p className={styles.panelEmpty}><UiText text={"还没有近期项目活动。"} /></p> : <div className={styles.activityList}>{recentActivity.map((activity) => <Link key={activity.id} href={activity.href} className={styles.activityItem}>
                    <span className={styles.activityDot} aria-hidden="true" />
                    <span><strong>{activity.label}</strong><small>{activity.detail}</small><time dateTime={activity.createdAt}>{formatDate(activity.createdAt, language)}</time></span>
                  </Link>)}</div>}
                  <Link href={buildProjectHref(projectId, "overview", { focus: "task-runs", from: "overview", returnTo: overviewReturnTo })} className={styles.textLink}><UiText text={"查看任务运行记录 →"} /></Link>
                </section>

                <section className={styles.continuePanel} aria-labelledby="continue-heading">
                  <div className={styles.panelHeading}><div><p className={styles.eyebrow}><UiText text={"CONTINUE"} /></p><h2 id="continue-heading"><UiText text={"从这里继续"} /></h2></div></div>
                  <Link href={buildProjectHref(projectId, "materials", { view: "add", from: "overview", returnTo: overviewReturnTo })} className={styles.quickLink}><span><UiText text={"添加新的项目资料"} /></span><span aria-hidden="true">→</span></Link>
                  <Link href={`/ask?scope=project&projectId=${encodeURIComponent(projectId)}`} className={styles.quickLink}><span><UiText text={"打开智能问答"} /></span><span aria-hidden="true">→</span></Link>
                  <Link href={`/projects/${projectId}/plan`} className={styles.quickLink}><span><UiText text={"打开项目计划"} /></span><span aria-hidden="true">→</span></Link>
                  <Link href={nextStep.href} className={styles.recommendedStep}><span><UiText text={"推荐下一步"} /></span><strong>{nextStep.title}</strong><small>{nextStep.detail}</small></Link>
                </section>
              </aside>
            </section>

            <details id="attention-details" tabIndex={-1} className={styles.governanceDetails} open={navigation.focus === "attention-details" || navigation.focus === "task-runs"}>
              <summary><UiText text={"更多运行与治理信息"} />{" "}<span><UiText text={"待核对"} />{" "}{summary.pendingContent} {" "}<UiText text={"· 失败任务"} />{" "}{summary.failedJobs} {" "}<UiText text={"· 仓库问题"} />{" "}{summary.githubIssues}</span></summary>
              <ProjectGovernanceSections projectId={projectId} navigation={navigation} />
            </details>

            <div className={styles.snapshotFooter}>
              <span>{currentData.snapshot ? `${t("最近状态快照：")} ${formatDate(currentData.snapshot.generatedAt, language)}${currentData.snapshotStale ? ` · ${t("有新确认内容")}` : ""}` : t("尚未生成项目状态快照")}</span>
              <button type="button" onClick={() => void generateSnapshot()} disabled={snapshotPending || summary.confirmed === 0 || currentData.project.archivedAt !== null}>{snapshotPending ? t("更新中…") : currentData.snapshot ? t("更新状态快照") : t("生成状态快照")}</button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function OverviewSkeleton() {
  const t = useTranslate();
  return <div className={styles.skeletonPage} aria-label={t("正在加载项目概览")}><div className={styles.skeletonHeading} /><div className={styles.skeletonMetrics}>{[1, 2, 3, 4].map((item) => <div key={item} />)}</div><div className={styles.skeletonMain}><div /><div /></div></div>;
}

function MetricCard({ label, value, detail, href }: { label: string; value: number | string; detail: string; href: string }) {
  return <Link href={href} className={styles.metricCard}><div><p>{label}</p><strong>{value}</strong></div><span>{detail}</span><b aria-hidden="true">→</b></Link>;
}
