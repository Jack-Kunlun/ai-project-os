"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { jobStatusLabels, type DashboardPayload, type DashboardQuota, type JobKind, type RecentJob, type WorkspaceProject } from "@/lib/workspace-summary";
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

type PersonalDashboardSnapshot = Readonly<{
  loading: boolean;
  knowledgeCount: number | null;
  knowledgeBytes: number | null;
  knowledgeIndex: string | null;
  modelCount: number | null;
  gitCount: number | null;
  mcpCount: number | null;
}>;

type DashboardAttention = Readonly<{
  id: string;
  title: string;
  detail: string;
  href: string;
  tone: "danger" | "warning" | "neutral";
}>;

const emptyPersonalSnapshot: PersonalDashboardSnapshot = {
  loading: true,
  knowledgeCount: null,
  knowledgeBytes: null,
  knowledgeIndex: null,
  modelCount: null,
  gitCount: null,
  mcpCount: null,
};

async function readPersonalJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok) throw new Error("个人数据暂不可用");
  return response.json();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatQuotaExpiry(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function jobHref(job: Pick<RecentJob, "id" | "project">): string {
  return job.project ? `/projects/${job.project.id}/jobs/${job.id}` : "/dashboard";
}

function buildAttentionItems(payload: DashboardPayload): DashboardAttention[] {
  const items: DashboardAttention[] = [];
  const seen = new Set<string>();
  const add = (item: DashboardAttention) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };

  for (const job of payload.recentJobs) {
    if (job.status !== "failed" && job.status !== "unknown" && !job.reconciliationRequired) continue;
    const projectName = job.project?.name ?? "项目任务";
    add({
      id: `job:${job.id}`,
      title: `${jobLabels[job.kind]}${job.reconciliationRequired ? "需要核对" : job.status === "failed" ? "执行失败" : "结果待确认"}`,
      detail: `${projectName} · ${jobStatusLabels[job.status]} · ${formatDate(job.createdAt)}`,
      href: jobHref(job),
      tone: job.status === "failed" || job.status === "unknown" ? "danger" : "warning",
    });
  }

  for (const entry of payload.operations) {
    if (entry.health.status === "empty") continue;
    const signal = entry.health.signals[0];
    add({
      id: `plan:${entry.project.id}`,
      title: signal?.title ?? `${entry.project.name}的计划需要关注`,
      detail: `${entry.project.name} · 逾期 ${entry.health.counts.overdue} · 受阻 ${entry.health.counts.blocked}`,
      href: signal ? `/projects/${entry.project.id}/plan?focus=${encodeURIComponent(signal.workItemId)}${signal.kind === "blocked" ? "&status=blocked" : ""}` : `/projects/${entry.project.id}/plan`,
      tone: entry.health.status === "atRisk" ? "danger" : "warning",
    });
  }

  for (const entry of payload.worlds) {
    const statusLabel = entry.world.status === "at_risk" ? "项目状态存在风险" : entry.world.status === "needs_attention" ? "项目状态需要关注" : "项目资料不足以判断状态";
    add({
      id: `world:${entry.project.id}`,
      title: `${entry.project.name} · ${statusLabel}`,
      detail: `事实 ${entry.world.counts.activeFacts} · 问题 ${entry.world.counts.issues} · 风险 ${entry.world.counts.risks} · 冲突 ${entry.world.counts.activeConflicts}`,
      href: `/projects/${entry.project.id}#current-state`,
      tone: entry.world.status === "at_risk" ? "danger" : entry.world.status === "needs_attention" ? "warning" : "neutral",
    });
  }

  if (payload.summary.pendingAssetReviews > 0) {
    add({
      id: "asset-reviews",
      title: `${payload.summary.pendingAssetReviews} 条文件识别结果待核对`,
      detail: "打开项目列表，进入对应项目的文件资料继续核对。",
      href: "/projects",
      tone: "warning",
    });
  }

  return items.slice(0, 4);
}

export function DashboardClient({ username, isSystemAdmin = false }: { username: string; isSystemAdmin?: boolean }) {
  const [payload, setPayload] = useState<DashboardPayload>(emptyPayload);
  const [personal, setPersonal] = useState<PersonalDashboardSnapshot>(emptyPersonalSnapshot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(await readError(response, "工作台加载失败"));
      const next = await response.json() as DashboardPayload;
      if (sequence !== requestSequence.current) return;
      setPayload(next);
      setError(null);
    } catch (loadError) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "工作台加载失败");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      requestSequence.current += 1;
      activeController.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    const endpoints = ["/api/personal/knowledge/overview", "/api/me/ai-providers", "/api/me/git-connections", "/api/me/mcp-connections"] as const;
    void Promise.allSettled(endpoints.map((path) => readPersonalJson(path, controller.signal))).then((results) => {
      if (controller.signal.aborted) return;
      const knowledge = results[0].status === "fulfilled" ? record(results[0].value) : null;
      const capacity = record(knowledge?.capacity);
      const index = record(knowledge?.index);
      const connectionCount = (position: 1 | 2 | 3, key: string): number | null => {
        const result = results[position];
        if (result.status !== "fulfilled") return null;
        const rows = record(result.value)?.[key];
        return Array.isArray(rows) ? rows.length : null;
      };
      setPersonal({
        loading: false,
        knowledgeCount: safeCount(capacity?.documentCount),
        knowledgeBytes: safeCount(capacity?.usedBytes),
        knowledgeIndex: typeof index?.label === "string" ? index.label : null,
        modelCount: connectionCount(1, "providers"),
        gitCount: connectionCount(2, "connections"),
        mcpCount: connectionCount(3, "connections"),
      });
    });
    return () => controller.abort();
  }, []);

  const nextStep = useMemo(() => {
    if (loading) return { label: "正在读取工作空间状态", detail: "正在读取可访问项目、任务和计划信号。", href: "/dashboard", action: "读取中…" };
    if (error) return { label: "暂时无法确认工作空间状态", detail: "请求失败时不推断项目健康度，请重试以获取最新状态。", href: "/dashboard", action: "重新读取" };
    const { summary, projects } = payload;
    const riskyWorld = payload.worlds.find((entry) => entry.world.status === "at_risk");
    if (riskyWorld) return { label: `核对「${riskyWorld.project.name}」的项目状态`, detail: `当前有 ${riskyWorld.world.counts.issues} 个问题、${riskyWorld.world.counts.risks} 个风险和 ${riskyWorld.world.counts.activeConflicts} 个事实冲突。`, href: `/projects/${riskyWorld.project.id}#current-state`, action: "打开项目概览" };
    const atRisk = payload.operations.find((entry) => entry.health.status === "atRisk");
    if (atRisk) {
      const signal = atRisk.health.signals[0];
      return { label: `处理「${atRisk.project.name}」的计划风险`, detail: `当前有 ${atRisk.health.counts.overdue} 项逾期、${atRisk.health.counts.blocked} 项受阻。`, href: signal ? `/projects/${atRisk.project.id}/plan#work-item-${signal.workItemId}` : `/projects/${atRisk.project.id}/plan`, action: "打开项目计划" };
    }
    if (summary.projects === 0) return { label: "创建第一个项目", detail: "项目会隔离资料、仓库、记忆和智能分析记录。", href: "/projects", action: "前往我的项目" };
    if (payload.state === "empty-plan") {
      const current = projects[0]!;
      return { label: `为「${current.name}」建立计划`, detail: "当前没有足够的计划工作项可判断运行状态，先添加一个目标明确的工作项。", href: `/projects/${current.id}/plan`, action: "打开项目计划" };
    }
    if (summary.pendingAssetReviews > 0) {
      return { label: "核对待确认的文件识别结果", detail: `${summary.pendingAssetReviews} 个文件正在等待人工确认，打开项目列表后进入对应项目核对。`, href: "/projects", action: "查看项目" };
    }
    const unindexed = projects.find((project) => project.memoryIndexPointer === null);
    if (unindexed) return { label: `为「${unindexed.name}」建立智能记忆`, detail: "先准备资料，再生成可用于检索和问答的语义索引。", href: `/projects/${unindexed.id}/memory`, action: "建立索引" };
    const current = projects[0]!;
    return { label: "项目智能能力已经就绪", detail: "可以生成状态简报，或针对当前项目开展一次只读调查。", href: `/projects/${current.id}/intelligence`, action: "进入项目智能体" };
  }, [error, loading, payload]);

  const attentionItems = useMemo(() => buildAttentionItems(payload), [payload]);

  return (
    <main className={styles.page}>
      <AppHeader username={username} active="dashboard" isSystemAdmin={isSystemAdmin} />
      <div className={styles.content}>
        <section className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>YOUR WORKSPACE</p>
            <h1>工作台</h1>
            <p className={styles.subtitle}>查看需要处理的事项，并从最近访问的项目继续工作。</p>
          </div>
          <Link href="/projects" className={styles.primaryButton}>我的项目 <span aria-hidden="true">→</span></Link>
        </section>

        {error ? <div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div> : null}

        <section className={styles.featureGrid} aria-label="工作台常用信息">
          <section className={styles.panel} aria-labelledby="attention-heading">
            <div className={styles.sectionHeading}>
              <div><p className={styles.eyebrow}>ATTENTION</p><h2 id="attention-heading">需要你关注</h2></div>
              {!loading && !error ? <span className={styles.count}>{attentionItems.length}</span> : null}
            </div>
            {loading ? <LoadingRows /> : error ? <p className={styles.empty}>状态读取失败，重试后再查看待办。</p> : attentionItems.length === 0 ? <p className={styles.empty}>暂无待处理事项。</p> : (
              <div className={styles.attentionList}>{attentionItems.map((item) => <Link key={item.id} href={item.href} className={styles.attentionItem}>
                <span className={`${styles.signal} ${styles[item.tone]}`} aria-hidden="true" />
                <span className={styles.itemCopy}><strong>{item.title}</strong><small>{item.detail}</small></span>
                <span className={styles.arrow} aria-hidden="true">→</span>
              </Link>)}</div>
            )}
            <Link href={error ? "/dashboard" : "/projects"} className={styles.textLink}>{error ? "重新读取工作台" : "查看项目"} →</Link>
          </section>

          <aside className={styles.commonPanel} aria-labelledby="common-actions-heading">
            <p className={styles.eyebrow}>我的工作</p>
            <h2 id="common-actions-heading">常用操作</h2>
            <p className={styles.commonIntro}>从个人知识、额度和连接继续；项目资料与计划在各自空间中管理。</p>
            {error ? <div className={styles.nextStep}><span>下一步暂不可用</span><strong>工作台状态读取失败</strong><button type="button" onClick={() => void load()}>重新读取</button></div> : <Link href={nextStep.href} className={styles.nextStep}>
              <span>推荐下一步</span><strong>{nextStep.label}</strong><small>{nextStep.detail}</small><b>{nextStep.action} →</b>
            </Link>}
            <div className={styles.quickLinks}>
              <PersonalAction title="个人知识库" detail={personal.loading ? "正在读取…" : personal.knowledgeCount === null || personal.knowledgeBytes === null ? "状态暂不可用" : `${personal.knowledgeCount} 篇文档 · ${formatBytes(personal.knowledgeBytes)}`} href="/personal/knowledge" />
              <PersonalAction title="我的连接" detail={personal.loading ? "正在读取…" : personal.modelCount === null || personal.gitCount === null || personal.mcpCount === null ? "部分连接状态暂不可用" : `模型 ${personal.modelCount} · Git ${personal.gitCount} · MCP ${personal.mcpCount}`} href="/personal/configuration" />
              <QuotaAction quota={payload.quota} loading={loading} unavailable={error !== null} />
            </div>
          </aside>
        </section>

        <section className={styles.projectsSection} aria-labelledby="recent-projects-heading">
          <div className={styles.sectionHeading}>
            <div><p className={styles.eyebrow}>项目动态</p><h2 id="recent-projects-heading">最近项目</h2></div>
            <Link href="/projects" className={styles.textLink}>查看全部项目 →</Link>
          </div>
          {loading ? <div className={styles.projectGrid}>{[1, 2, 3].map((item) => <div key={item} className={styles.projectSkeleton} />)}</div> : error ? <p className={styles.empty}>项目状态暂不可用，工作台请求失败时不会显示旧统计。</p> : payload.projects.length === 0 ? <div className={styles.emptyCard}><h3>还没有可访问的项目</h3><p>创建项目，或等待项目负责人授予访问权限。</p><Link href="/projects" className={styles.textLink}>前往我的项目 →</Link></div> : (
            <div className={styles.projectGrid}>{payload.projects.slice(0, 3).map((project) => <RecentProjectCard key={project.id} project={project} />)}</div>
          )}
        </section>
      </div>
    </main>
  );
}

function LoadingRows() {
  return <div className={styles.loadingRows} role="status" aria-label="正在读取待办">{[1, 2, 3].map((item) => <span key={item} />)}</div>;
}

function PersonalAction({ title, detail, href }: { title: string; detail: string; href: string }) {
  return <Link href={href} className={styles.quickLink}><span><strong>{title}</strong><small>{detail}</small></span><span aria-hidden="true">→</span></Link>;
}

function QuotaAction({ quota, loading, unavailable }: { quota: DashboardQuota; loading: boolean; unavailable: boolean }) {
  const detail = loading ? "正在读取额度…" : unavailable || quota.status === "unavailable" ? "暂时无法读取当前额度" : quota.availableCredits === 0 ? "当前可用额度为 0，实际执行前会再次核验额度。" : `可用于平台模型调用 · 单位 ${quota.unit}`;
  return <Link href="/credits" className={styles.quickLink}>
    <span><strong>当前额度 {loading ? "…" : unavailable || quota.status === "unavailable" ? "—" : quota.availableCredits.toLocaleString("zh-CN")}</strong><small>{detail}{!loading && !unavailable && quota.status === "available" && quota.nextExpiryAt ? ` · 最早到期 ${formatQuotaExpiry(quota.nextExpiryAt)}` : ""}</small></span>
    <span aria-hidden="true">→</span>
  </Link>;
}

function RecentProjectCard({ project }: { project: WorkspaceProject }) {
  const latestJob = project.backgroundJobs[0];
  return <Link href={`/projects/${project.id}`} className={styles.projectCard}>
    <div className={styles.projectCardHeading}><span className={styles.projectMark} aria-hidden="true">{project.name.slice(0, 1)}</span><span className={styles.projectStatus}>{project.memoryIndexPointer ? "记忆已建立" : "待建立记忆"}</span></div>
    <strong className={styles.projectName}>{project.name}</strong>
    <p className={styles.projectDescription}>{project.description || "尚未填写项目说明。"}</p>
    <div className={styles.projectCounts}><span>来源 <b>{project._count.sources}</b></span><span>文件 <b>{project._count.assets}</b></span><span>条目 <b>{project._count.items}</b></span><span>仓库 <b>{project._count.repositoryLinks}</b></span></div>
    <div className={styles.projectFooter}><span>更新于 {formatDate(project.updatedAt)}</span><span>{latestJob ? `${jobLabels[latestJob.kind]} · ${jobStatusLabels[latestJob.status]}` : "暂无近期任务"}</span></div>
  </Link>;
}
