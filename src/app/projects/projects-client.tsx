"use client";
import { UiErrorText } from "@/components/ui-error-text";

import Link from "next/link";
import { ProjectDialog } from "@/components/lazy-project-dialog";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { AppHeader } from "@/components/app-header";
import {  UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import { ShellIcon } from "@/components/shell-icon";
import { ListPagination } from "@/components/list-pagination";
import { useWorkspaceSelection } from "@/components/workspace-scope";
import type { ListPagination as ListPaginationState } from "@/lib/list-pagination";
import { jobStatusLabels, type JobKind, type WorkspaceProject } from "@/lib/workspace-summary";
import styles from "./projects-client.module.css";



type ProjectsView = "active" | "archived";
type ProjectsPayload = {
  view: ProjectsView;
  canCreateProject: boolean;
  counts: { active: number; archived: number };
  pagination: ListPaginationState;
  projects: WorkspaceProject[];
};

const emptyPayload: ProjectsPayload = { view: "active", canCreateProject: false, counts: { active: 0, archived: 0 }, pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 }, projects: [] };

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
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function ProjectsClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const { language } = useAppearance();
  const t = useTranslate();
  const workspaceId = useWorkspaceSelection(username);
  const [payload, setPayload] = useState<ProjectsPayload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [createWorkspaceId, setCreateWorkspaceId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ project: WorkspaceProject; workspaceId: string } | null>(null);
  const [view, setView] = useState<ProjectsView>("active");
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const previousWorkspaceId = useRef(workspaceId);

  const load = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (!workspaceId) {
      setLoading(true);
      return;
    }
    const sequence = ++requestSequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    if (showLoading) setLoading(true);
    try {
      const query = new URLSearchParams({ view, page: String(page), pageSize: "20", workspaceId });
      if (deferredSearch.trim()) query.set("search", deferredSearch.trim());
      const response = await fetch(`/api/projects?${query}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(t(await readError(response, "项目列表加载失败")));
      const next = await response.json() as ProjectsPayload;
      if (sequence !== requestSequence.current) return;
      setPayload(next);
      if (page > next.pagination.totalPages) setPage(next.pagination.totalPages);
      setError(null);
    } catch (loadError) {
      if (controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(t(loadError instanceof Error ? loadError.message : "项目列表加载失败"));
    } finally {
      if (sequence === requestSequence.current && showLoading) setLoading(false);
    }
  }, [deferredSearch, page, t, view, workspaceId]);

  useEffect(() => {
    if (previousWorkspaceId.current === workspaceId) return;
    previousWorkspaceId.current = workspaceId;
    setPage(1);
    setDeleteTarget(null);
    setPayload(emptyPayload);
    setError(null);
    setLoading(true);
  }, [workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load({ showLoading: true }), 0);
    return () => {
      window.clearTimeout(timer);
      requestSequence.current += 1;
      activeController.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!payload.canCreateProject || !workspaceId || typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      const url = new URL(window.location.href);
      if (url.searchParams.get("create") !== "1") return;
      setCreateWorkspaceId(workspaceId);
      setCreateOpen(true);
      url.searchParams.delete("create");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [payload.canCreateProject, workspaceId]);

  return (
    <main className={styles.page}>
      <AppHeader username={username} active="projects" isSystemAdmin={isSystemAdmin} />
      <div data-page-content className={styles.content}>
        <section className={styles.heading}>
          <div>
            <p className={styles.eyebrow}><UiText text={"PROJECTS"} /></p>
            <h1><UiText text="我的项目" /></h1>
            <p className={styles.subtitle}><UiText text="项目资料、共识与工作都保存在各自的空间中。" /></p>
          </div>
          {payload.canCreateProject ? <button type="button" onClick={() => { setCreateWorkspaceId(workspaceId); setCreateOpen(true); }} className={`${styles.primaryButton} app-action-button`}>＋ <UiText text="新建项目" /></button> : null}
        </section>

        {error ? <div className={styles.error} role="alert"><span><UiErrorText text={error} /></span><button type="button" onClick={() => void load({ showLoading: true })}><UiText text="重试" /></button></div> : null}
        <section className={styles.listSection} aria-label={t("项目列表")}>
          <div className={styles.toolbar}>
            <div className={styles.filters} role="group" aria-label={t("项目状态")}>
              <button type="button" aria-pressed={view === "active"} onClick={() => { setView("active"); setPage(1); }} className={view === "active" ? styles.selectedFilter : styles.filterButton}><UiText text="进行中" /> <span>{loading || error ? "—" : payload.counts.active}</span></button>
              <button type="button" aria-pressed={view === "archived"} onClick={() => { setView("archived"); setPage(1); }} className={view === "archived" ? styles.selectedFilter : styles.filterButton}><UiText text="已归档" /> <span>{loading || error ? "—" : payload.counts.archived}</span></button>
              <span className={styles.matchCount}>{loading ? t("正在读取…") : error ? t("结果暂不可用") : `${t("匹配")} ${payload.pagination.total} ${t("个")}`}</span>
            </div>
            <label className={styles.searchBox}>
              <span className="sr-only"><UiText text="搜索项目" /></span>
              <ShellIcon name="search" className="app-icon--control" />
              <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={t("搜索项目")} />
            </label>
          </div>

          {loading ? (
            <div className={styles.projectGrid} role="status" aria-label={t("正在读取项目")}>{[1, 2, 3].map((item) => <div key={item} className={styles.projectSkeleton} />)}</div>
          ) : error ? (
            <div className={styles.emptyState}><h2><UiText text="项目列表暂不可用" /></h2><p><UiText text="请求失败时不会使用旧数据填充列表。" /></p><button type="button" onClick={() => void load({ showLoading: true })}><UiText text="重新读取" /></button></div>
          ) : payload.projects.length === 0 ? (
            <div className={styles.emptyState}>
              <h2><UiText text={search.trim() ? "没有匹配的项目" : view === "active" ? payload.canCreateProject ? "还没有进行中的项目" : "等待工作区授权" : "还没有归档项目"} /></h2>
              <p><UiText text={search.trim() ? "换一个项目名称或描述关键词试试。" : view === "active" ? payload.canCreateProject ? "创建项目后，就可以添加资料、建立计划并继续工作。" : "请联系当前工作区 Owner/Admin 授予你创建项目或访问项目的权限。" : "归档项目会集中显示在这里；项目数据仍可恢复使用。"} /></p>
              {!search.trim() && view === "active" && payload.canCreateProject ? <button type="button" onClick={() => { setCreateWorkspaceId(workspaceId); setCreateOpen(true); }} className={`${styles.primaryButton} app-action-button`}><UiText text="创建第一个项目" /></button> : null}
            </div>
          ) : (
            <><div className={styles.projectGrid}>
              {payload.projects.map((project) => <ProjectCard key={project.id} project={project} language={language} t={t} onDelete={() => setDeleteTarget({ project, workspaceId })} />)}
            </div>{payload.pagination.totalPages > 1 ? <ListPagination {...payload.pagination} onPageChange={setPage} disabled={loading} /> : null}</>
          )}
        </section>
      </div>

      {deleteTarget?.workspaceId === workspaceId ? <ProjectDialog kind="lifecycle" project={deleteTarget.project} action="delete" onClose={() => setDeleteTarget(null)} onRefresh={() => void load({ showLoading: true })} onChanged={() => {
        setDeleteTarget(current => current?.project.id === deleteTarget.project.id && current.workspaceId === deleteTarget.workspaceId ? null : current);
        if (previousWorkspaceId.current === deleteTarget.workspaceId) void load({ showLoading: true });
      }} /> : null}
      {createOpen && payload.canCreateProject ? <ProjectDialog kind="create" workspaceId={createWorkspaceId} onClose={() => setCreateOpen(false)} onCreated={load} /> : null}
    </main>
  );
}

function ProjectCard({ project, language, t, onDelete }: { project: WorkspaceProject; language: "zh-CN" | "en"; t: (text: string) => string; onDelete: () => void }) {
  const archived = project.archivedAt !== null;
  const latestJob = project.backgroundJobs[0];

  return (
    <article className={`${styles.projectCard} ${archived ? styles.archivedCard : ""}`}>
      <div className={styles.cardHeading}>
        <div className={styles.projectIdentity}><span aria-hidden="true" className={styles.projectMark}>{project.name.slice(0, 1)}</span><div><h2>{project.name}</h2><p>{project.description || t("尚未填写项目说明。")}</p></div></div>
        <span className={styles.projectStatus}>{t(archived ? "已归档" : project.memoryIndexPointer ? "记忆已建立" : "待建立记忆")}</span>
      </div>
      <div className={styles.projectStats}><SmallStat label={t("来源")} value={project._count.sources} /><SmallStat label={t("文件")} value={project._count.assets} /><SmallStat label={t("条目")} value={project._count.items} /><SmallStat label={t("仓库")} value={project._count.repositoryLinks} /></div>
      {archived ? <p className={styles.archiveNote}>{t("归档于")} {formatDate(project.archivedAt!, language)}{t("。项目数据仍可恢复使用。")}</p> : null}
      <div className={styles.cardFooter}>
        <span>{t("更新于")} {formatDate(project.updatedAt, language)}{latestJob ? ` · ${t(jobLabels[latestJob.kind])} ${t(jobStatusLabels[latestJob.status])}` : ""}</span>
        <div className={styles.cardActions}>
          {archived ? <button type="button" onClick={onDelete} className={styles.deleteButton} aria-label={`${t("永久删除")} ${project.name}`}><UiText text="永久删除" /></button> : null}
          <Link href={`/projects/${project.id}`} aria-label={`${t("查看项目")} ${project.name}`}><UiText text="进入项目 →" /></Link>
        </div>
      </div>
    </article>
  );
}

function SmallStat({ label, value }: { label: string; value: number }) {
  return <div className={styles.stat}><strong>{value}</strong><span>{label}</span></div>;
}
