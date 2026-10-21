"use client";
import { UiErrorText } from "@/components/ui-error-text";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useRef, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import {  UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import { ShellIcon } from "@/components/shell-icon";
import { ListPagination } from "@/components/list-pagination";
import { modalBackdropClassName, modalFooterClassName, modalHeaderClassName, modalSurfaceClassName } from "@/components/modal-styles";
import { useInquiryOperation } from "@/components/inquiry-operation";
import { useWorkspaceSelection } from "@/components/workspace-scope";
import type { ListPagination as ListPaginationState } from "@/lib/list-pagination";
import { jobStatusLabels, type JobKind, type WorkspaceProject } from "@/lib/workspace-summary";
import styles from "./projects-client.module.css";
import { notifyUserProjectsChanged } from "@/lib/user-navigation";

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
      <div className={styles.content}>
        <section className={styles.heading}>
          <div>
            <p className={styles.eyebrow}><UiText text={"PROJECTS"} /></p>
            <h1><UiText text="我的项目" /></h1>
            <p className={styles.subtitle}><UiText text="项目资料、共识与工作都保存在各自的空间中。" /></p>
          </div>
          {payload.canCreateProject ? <button type="button" onClick={() => { setCreateWorkspaceId(workspaceId); setCreateOpen(true); }} className={styles.primaryButton}>＋ <UiText text="新建项目" /></button> : null}
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
              {!search.trim() && view === "active" && payload.canCreateProject ? <button type="button" onClick={() => { setCreateWorkspaceId(workspaceId); setCreateOpen(true); }} className={styles.primaryButton}><UiText text="创建第一个项目" /></button> : null}
            </div>
          ) : (
            <><div className={styles.projectGrid}>
              {payload.projects.map((project) => <ProjectCard key={project.id} project={project} language={language} t={t} />)}
            </div>{payload.pagination.totalPages > 1 ? <ListPagination {...payload.pagination} onPageChange={setPage} disabled={loading} /> : null}</>
          )}
        </section>
      </div>

      {createOpen && payload.canCreateProject ? <CreateProjectDialog workspaceId={createWorkspaceId} onClose={() => setCreateOpen(false)} onCreated={load} /> : null}
    </main>
  );
}

function ProjectCard({ project, language, t }: { project: WorkspaceProject; language: "zh-CN" | "en"; t: (text: string) => string }) {
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
        <Link href={`/projects/${project.id}`} aria-label={`${t("查看项目")} ${project.name}`}><UiText text="进入项目 →" /></Link>
      </div>
    </article>
  );
}

function SmallStat({ label, value }: { label: string; value: number }) {
  return <div className={styles.stat}><strong>{value}</strong><span>{label}</span></div>;
}

function CreateProjectDialog({ workspaceId, onClose, onCreated }: { workspaceId: string; onClose: () => void; onCreated: () => Promise<void> }) {
  const t = useTranslate();
  const dialogRef = useRef<HTMLElement | null>(null);
  useInquiryOperation(true, dialogRef);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) { if (event.key === "Escape" && !pending) onClose(); }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setPending(true); setError(null);
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description, workspaceId }) });
      if (!response.ok) throw new Error(t(await readError(response, "项目创建失败")));
      await onCreated();
      notifyUserProjectsChanged();
      onClose();
    } catch (submitError) {
      setError(t(submitError instanceof Error ? submitError.message : "项目创建失败"));
    } finally {
      setPending(false);
    }
  }

  return <div className={`fixed inset-0 z-50 flex items-end justify-center ${modalBackdropClassName} p-0 sm:items-center sm:p-6`} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="create-project-title" className={`flex max-h-[calc(100dvh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl ${modalSurfaceClassName}`}>
      <header data-dialog-header className={`${modalHeaderClassName} flex shrink-0 items-start justify-between gap-4 px-7 py-5 sm:px-8`}>
        <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600"><UiText text={"New project"} /></p><h2 id="create-project-title" className="mt-1 text-lg font-semibold text-slate-950"><UiText text="创建项目空间" /></h2></div>
        <button data-dialog-close type="button" onClick={onClose} disabled={pending} className="app-icon-button" aria-label={t("关闭")}><ShellIcon name="close" className="app-icon--control" /></button>
      </header>
      <div data-dialog-body className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 py-5 sm:px-8">
        <p className="text-sm leading-6 text-slate-600"><UiText text="项目会隔离自己的资料、仓库和智能记忆；模型能力由平台默认模型或个人双确认委托提供。" /></p>
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"><UiText text="创建到当前已选工作空间。提交后项目会出现在当前工作空间的项目列表中。" /></p>
        <form id="projects-create-form" onSubmit={submit} className="mt-5">
          <label htmlFor="projects-project-name" className="text-sm font-semibold text-slate-700"><UiText text="项目名称" /></label>
          <input id="projects-project-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required placeholder={t("例如：AI Project OS")} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" />
          <label htmlFor="projects-project-description" className="mt-5 block text-sm font-semibold text-slate-700"><UiText text="项目描述" /> <span className="font-normal text-slate-400"><UiText text="（可选）" /></span></label>
          <textarea id="projects-project-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={4} placeholder={t("这个项目在解决什么问题？当前最重要的目标是什么？")} className="mt-2 w-full resize-none rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" />
          {error ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><UiErrorText text={error} /></p> : null}
        </form>
      </div>
      <footer data-dialog-footer className={`${modalFooterClassName} flex justify-end gap-3 px-7 py-5 sm:px-8`}>
        <button data-dialog-close type="button" onClick={onClose} disabled={pending} className="rounded-lg border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-600"><UiText text="取消" /></button>
        <button type="submit" form="projects-create-form" disabled={pending || !name.trim()} className="rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? t("创建中…") : t("创建项目")}</button>
      </footer>
    </section>
  </div>;
}
