"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import { ShellIcon } from "@/components/shell-icon";
import { useWorkspaceSelection } from "@/components/workspace-scope";
import { projectJobUnknownPresentation } from "@/lib/project-job-outcome-presentation";
import { USER_CURRENT_PROJECT_CHANGED_EVENT } from "@/lib/user-navigation";
import { jobStatusLabels, type DashboardPayload, type JobKind, type RecentJob, type WorkspaceProject } from "@/lib/workspace-summary";
import styles from "./dashboard-client.module.css";

const emptyPayload: DashboardPayload = {
  state: "zero-project",
  quota: { status: "unavailable", unit: "platform_credit" },
  summary: {
    projects: 0,
    confirmedItems: 0,
    repositories: 0,
    indexedProjects: 0,
    routedProjects: 0,
    activeJobs: 0,
    assets: 0,
    pendingAssetReviews: 0,
    atRiskProjects: 0,
    overdueWorkItems: 0,
    blockedWorkItems: 0,
    pendingRecommendations: 0,
    openImpactSuggestions: 0,
    pendingActionApprovals: 0,
    atRiskWorlds: 0,
    attentionWorlds: 0,
    insufficientDataWorlds: 0,
  },
  projects: [],
  recentJobs: [],
  operations: [],
  worlds: [],
};

type DashboardAttention = Readonly<{
  id: string;
  title: string;
  detail: string;
  href: string;
  tone: "danger" | "warning" | "neutral";
}>;

const jobLabels: Record<JobKind, string> = {
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

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string, language: "zh-CN" | "en"): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatGreetingDate(value: Date, language: "zh-CN" | "en"): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(value);
}

function jobHref(job: Pick<RecentJob, "id" | "project">): string {
  return job.project ? `/projects/${job.project.id}/jobs/${job.id}` : "/dashboard";
}

function buildAttentionItems(payload: DashboardPayload, t: (text: string) => string, language: "zh-CN" | "en"): DashboardAttention[] {
  const items: DashboardAttention[] = [];
  const seen = new Set<string>();
  const add = (item: DashboardAttention) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };

  for (const job of payload.recentJobs) {
    if (job.status !== "failed" && job.status !== "unknown" && !job.reconciliationRequired) continue;
    const projectName = job.project?.name ?? t("项目任务");
    const unknownOutcome = projectJobUnknownPresentation(job);
    add({
      id: `job:${job.id}`,
      title: unknownOutcome ? `${t(jobLabels[job.kind])} · ${t(unknownOutcome.label)}` : `${t(jobLabels[job.kind])}${t(job.reconciliationRequired ? "调用记录需核对" : "执行失败")}`,
      detail: `${projectName} · ${t(unknownOutcome?.stageLabel ?? jobStatusLabels[job.status])} · ${formatDate(job.createdAt, language)}`,
      href: jobHref(job),
      tone: job.status === "failed" || job.status === "unknown" ? "danger" : "warning",
    });
  }

  for (const entry of payload.operations) {
    if (entry.health.status === "empty") continue;
    const signal = entry.health.signals[0];
    add({
      id: `plan:${entry.project.id}`,
      title: signal?.title ?? `${entry.project.name} · ${t("计划需要关注")}`,
      detail: `${entry.project.name} · ${t("逾期")} ${entry.health.counts.overdue} · ${t("受阻")} ${entry.health.counts.blocked}`,
      href: signal ? `/projects/${entry.project.id}/plan?focus=${encodeURIComponent(signal.workItemId)}${signal.kind === "blocked" ? "&status=blocked" : ""}` : `/projects/${entry.project.id}/plan`,
      tone: entry.health.status === "atRisk" ? "danger" : "warning",
    });
  }

  for (const entry of payload.worlds) {
    const statusLabel = t(entry.world.status === "at_risk" ? "项目状态存在风险" : entry.world.status === "needs_attention" ? "项目状态需要关注" : "项目资料不足以判断状态");
    add({
      id: `world:${entry.project.id}`,
      title: `${entry.project.name} · ${statusLabel}`,
      detail: `${t("事实")} ${entry.world.counts.activeFacts} · ${t("问题")} ${entry.world.counts.issues} · ${t("风险")} ${entry.world.counts.risks} · ${t("冲突")} ${entry.world.counts.activeConflicts}`,
      href: `/projects/${entry.project.id}#current-state`,
      tone: entry.world.status === "at_risk" ? "danger" : entry.world.status === "needs_attention" ? "warning" : "neutral",
    });
  }

  for (const project of payload.projects) {
    if (project.pendingReviewCount <= 0) continue;
    add({
      id: `asset-reviews:${project.id}`,
      title: `${project.name} · ${project.pendingReviewCount} ${t("份资料待核对")}`,
      detail: t("打开项目资料，继续核对识别结果。"),
      href: `/projects/${encodeURIComponent(project.id)}/materials/review`,
      tone: "warning",
    });
  }

  return items.slice(0, 4);
}

export function DashboardClient({ username, isSystemAdmin = false }: { username: string; isSystemAdmin?: boolean }) {
  const { language } = useAppearance();
  const t = useTranslate();
  const workspaceId = useWorkspaceSelection(username);
  const [payload, setPayload] = useState<DashboardPayload>(emptyPayload);
  const [payloadWorkspaceId, setPayloadWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<{ workspaceId: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setLoading(true);
      return;
    }
    const sequence = ++requestSequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setLoading(true);
    try {
      const response = await fetch(`/api/dashboard?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(t(await readError(response, "工作台加载失败")));
      const next = await response.json() as DashboardPayload;
      if (sequence !== requestSequence.current) return;
      setPayload(next);
      setPayloadWorkspaceId(workspaceId);
      setError(null);
    } catch (loadError) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(t(loadError instanceof Error ? loadError.message : "工作台加载失败"));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [t, workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      requestSequence.current += 1;
      activeController.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    void fetch("/api/workspaces/current", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("workspace unavailable");
      return response.json() as Promise<{ overview?: { workspace?: { id?: string; name?: string } }; availableWorkspaces?: Array<{ id?: string; name?: string }> }>;
    }).then((result) => {
      if (controller.signal.aborted) return;
      const spaces = [result.overview?.workspace, ...(Array.isArray(result.availableWorkspaces) ? result.availableWorkspaces : [])];
      const selected = spaces.find((space) => space?.id === workspaceId && typeof space.name === "string");
      setWorkspaceName(selected?.name ? { workspaceId, name: selected.name } : null);
    }).catch(() => {
      if (!controller.signal.aborted) setWorkspaceName(null);
    });
    return () => controller.abort();
  }, [workspaceId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const picker = document.getElementById("user-shell-project-picker") as HTMLSelectElement | null;
      setSelectedProjectId(picker?.value || null);
    });
    const onProjectChange = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null }>).detail;
      setSelectedProjectId(typeof detail?.projectId === "string" ? detail.projectId : null);
    };
    window.addEventListener(USER_CURRENT_PROJECT_CHANGED_EVENT, onProjectChange);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener(USER_CURRENT_PROJECT_CHANGED_EVENT, onProjectChange);
    };
  }, []);

  const attentionItems = useMemo(() => buildAttentionItems(payload, t, language), [language, payload, t]);
  const currentProject = payloadWorkspaceId === workspaceId ? payload.projects.find((project) => project.id === selectedProjectId && !project.archivedAt) ?? null : null;

  return (
    <main className={styles.page}>
      <AppHeader username={username} active="dashboard" isSystemAdmin={isSystemAdmin} />
      <div className={styles.content}>
        <section className={styles.heading}>
          <div>
            <p className={styles.eyebrow}><UiText text={"YOUR WORKSPACE"} /></p>
            <h1><UiText text="工作台" /></h1>
            <p className={styles.subtitle}><UiText text="查看待处理事项与最近访问的项目。" /></p>
          </div>
          <Link href="/projects?create=1" className={styles.primaryButton}><ShellIcon name="plus" className="app-icon--control" /> <UiText text="新建项目" /></Link>
        </section>

        <p className={styles.subtitle}>{formatGreetingDate(new Date(), language)}<span aria-hidden="true"> / </span>{(workspaceName?.workspaceId === workspaceId ? workspaceName.name : null) ?? t("当前工作空间")}</p>

        {error ? <div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={() => void load()}><UiText text="重试" /></button></div> : null}

        <section className={styles.featureGrid} aria-label={t("工作台常用信息")}>
          <section className={styles.panel} aria-labelledby="attention-heading">
            <div className={styles.sectionHeading}>
              <div className={styles.headingTitle}><p className={styles.eyebrow}><UiText text={"ATTENTION"} /></p><div className={styles.titleWithCount}><h2 id="attention-heading"><UiText text="需要你关注" /></h2>{!loading && !error ? <span className={`${styles.count} ${attentionItems.length > 0 ? styles.countActive : ""}`} aria-label={`${attentionItems.length} ${t("项待处理")}`}>{attentionItems.length}</span> : null}</div></div>
              <Link href="/notifications" className={styles.cardAction}><UiText text="通知中心" /><ShellIcon name="arrow" className={`${styles.actionArrow} app-icon--compact`} /></Link>
            </div>
            <p className={styles.actionDescription}><UiText text="查看待处理事项，及时跟进项目进展。" /></p>
            {loading ? <LoadingRows t={t} /> : error ? <p className={styles.empty}><UiText text="状态读取失败，重试后再查看待办。" /></p> : attentionItems.length === 0 ? <p className={styles.empty}><UiText text="暂无待处理事项。" /></p> : (
              <div className={styles.attentionList}>{attentionItems.map((item) => <Link key={item.id} href={item.href} className={styles.attentionItem}>
                <span className={`${styles.signal} ${styles[item.tone]}`} aria-hidden="true" />
                <span className={styles.itemCopy}><strong>{item.title}</strong><small>{item.detail}</small></span>
                <ShellIcon name="chevron" className={`${styles.arrow} app-icon--compact`} />
              </Link>)}</div>
            )}
          </section>

          <aside className={styles.commonPanel} aria-labelledby="common-actions-heading">
            <div className={styles.sectionHeading}>
              <div className={styles.headingTitle}><p className={styles.eyebrow}><UiText text="工作入口" /></p><h2 id="common-actions-heading"><UiText text="常用操作" /></h2></div>
              <Link href="/guide" className={styles.cardAction}><UiText text="了解使用流程" /><ShellIcon name="arrow" className={`${styles.actionArrow} app-icon--compact`} /></Link>
            </div>
            <p className={styles.actionDescription}><UiText text="选择一个入口，开始今天的工作。" /></p>
            <div className={styles.commonActions}>
              {currentProject ? <Link href={`/projects/${encodeURIComponent(currentProject.id)}/materials?view=add`} className={styles.actionCard}><ShellIcon name="upload" className={`${styles.actionIcon} app-icon--feature`} /><span className={styles.itemCopy}><strong><UiText text="添加项目资料" /></strong><small><UiText text="当前项目" /> · {currentProject.name}</small></span><ShellIcon name="chevron" className={`${styles.arrow} app-icon--compact`} /></Link> : <Link href="/projects" className={styles.actionCard}><ShellIcon name="upload" className={`${styles.actionIcon} app-icon--feature`} /><span className={styles.itemCopy}><strong><UiText text={selectedProjectId ? "选择其他项目" : "先选择项目"} /></strong><small><UiText text={selectedProjectId ? "当前项目无法用于添加资料，请选择其他项目。" : "选择或创建项目后，再将资料添加到当前项目。"} /></small></span><ShellIcon name="chevron" className={`${styles.arrow} app-icon--compact`} /></Link>}
              <Link href="/personal/knowledge?new=1" className={styles.actionCard}><ShellIcon name="book" className={`${styles.actionIcon} app-icon--feature`} /><span className={styles.itemCopy}><strong><UiText text="新建个人知识" /></strong><small><UiText text="保存方法、经验与约定" /></small></span><ShellIcon name="chevron" className={`${styles.arrow} app-icon--compact`} /></Link>
              <Link href="/ask" className={styles.actionCard}><ShellIcon name="message" className={`${styles.actionIcon} app-icon--feature`} /><span className={styles.itemCopy}><strong><UiText text="发起智能问答" /></strong><small><UiText text="基于可访问内容提问" /></small></span><ShellIcon name="chevron" className={`${styles.arrow} app-icon--compact`} /></Link>
            </div>
          </aside>
        </section>

        <section className={styles.projectsSection} aria-labelledby="recent-projects-heading">
          <div className={styles.sectionHeading}>
            <div><p className={styles.eyebrow}><UiText text="项目动态" /></p><h2 id="recent-projects-heading"><UiText text="最近项目" /></h2></div>
            <Link href="/projects" className={styles.textLink}><UiText text="查看全部项目 →" /></Link>
          </div>
          {loading ? <div className={styles.projectGrid}>{[1, 2, 3].map((item) => <div key={item} className={styles.projectSkeleton} />)}</div> : error ? <p className={styles.empty}><UiText text="项目状态暂不可用，工作台请求失败时不会显示旧统计。" /></p> : payload.projects.length === 0 ? <div className={styles.emptyCard}><h3><UiText text="还没有可访问的项目" /></h3><p><UiText text="创建项目，或等待项目负责人授予访问权限。" /></p><Link href="/projects" className={styles.textLink}><UiText text="前往我的项目 →" /></Link></div> : (
            <div className={styles.projectGrid}>{payload.projects.slice(0, 3).map((project) => <RecentProjectCard key={project.id} project={project} language={language} t={t} />)}</div>
          )}
        </section>
      </div>
    </main>
  );
}

function LoadingRows({ t }: { t: (text: string) => string }) {
  return <div className={styles.loadingRows} role="status" aria-label={t("正在读取待办")}>{[1, 2, 3].map((item) => <span key={item} />)}</div>;
}

function RecentProjectCard({ project, language, t }: { project: WorkspaceProject; language: "zh-CN" | "en"; t: (text: string) => string }) {
  const latestJob = project.backgroundJobs[0];
  return <Link href={`/projects/${project.id}`} className={styles.projectCard}>
    <div className={styles.projectCardHeading}><span className={styles.projectMark} aria-hidden="true">{project.name.slice(0, 1)}</span><span className={styles.projectStatus}>{t(project.memoryIndexPointer ? "记忆已建立" : "待建立记忆")}</span></div>
    <strong className={styles.projectName}>{project.name}</strong>
    <p className={styles.projectDescription}>{project.description || t("尚未填写项目说明。")}</p>
    <div className={styles.projectCounts}><span>{t("来源")} <b>{project._count.sources}</b></span><span>{t("文件")} <b>{project._count.assets}</b></span><span>{t("条目")} <b>{project._count.items}</b></span><span>{t("仓库")} <b>{project._count.repositoryLinks}</b></span></div>
    <div className={styles.projectFooter}><span>{t("更新于")} {formatDate(project.updatedAt, language)}</span><span>{latestJob ? `${t(jobLabels[latestJob.kind])} · ${t(projectJobUnknownPresentation(latestJob)?.label ?? jobStatusLabels[latestJob.status])}` : t("暂无近期任务")}</span></div>
  </Link>;
}
