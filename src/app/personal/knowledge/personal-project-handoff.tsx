"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { OperationPanel } from "@/components/operation-panel";
import { safeResponseError } from "@/lib/safe-error-presentation";

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROJECT_PAGE_SIZE = 50;

type ProjectOption = Readonly<{
  id: string;
  name: string;
  archivedAt: string | null;
  canEdit?: boolean;
}>;

type ProjectPage = Readonly<{
  projects?: readonly unknown[];
  pagination?: Readonly<{ totalPages?: number }>;
}>;

function isProjectOption(value: unknown): value is ProjectOption {
  if (typeof value !== "object" || value === null) return false;
  const project = value as Partial<ProjectOption>;
  return typeof project.id === "string"
    && PROJECT_ID_PATTERN.test(project.id)
    && typeof project.name === "string"
    && (project.archivedAt === null || typeof project.archivedAt === "string")
    && (project.canEdit === undefined || typeof project.canEdit === "boolean");
}

/** List accessible active projects; honor explicit edit restrictions when the API exposes them. */
export function filterActiveProjects(projects: readonly unknown[]): ProjectOption[] {
  return projects.filter(isProjectOption)
    .filter((project) => project.archivedAt === null && project.canEdit !== false);
}

/** Keep personal knowledge content out of navigation; the destination opens the manual source form. */
export function buildProjectMaterialsAddHref(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error("Invalid project id");
  const query = new URLSearchParams({ view: "add", kind: "manual" });
  return `/projects/${encodeURIComponent(projectId)}/materials?${query.toString()}`;
}

/** Keep clipboard errors visible to the UI instead of treating an attempted copy as success. */
export async function copyPersonalKnowledgeBody(
  content: string,
  clipboard: Pick<Clipboard, "writeText"> | null = typeof navigator === "undefined" ? null : navigator.clipboard,
): Promise<void> {
  if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("clipboard_unavailable");
  await clipboard.writeText(content);
}

async function readProjects(signal: AbortSignal): Promise<ProjectOption[]> {
  const allProjects: unknown[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const query = new URLSearchParams({ view: "active", page: String(page), pageSize: String(PROJECT_PAGE_SIZE) });
    const response = await fetch(`/api/projects?${query.toString()}`, { cache: "no-store", signal });
    if (!response.ok) throw new Error((await safeResponseError(response, "进行中项目列表加载失败")).message);
    const payload = await response.json() as ProjectPage;
    if (!Array.isArray(payload.projects)) throw new Error("项目列表返回格式无效");
    allProjects.push(...payload.projects);
    const reportedTotalPages = payload.pagination?.totalPages;
    totalPages = Number.isSafeInteger(reportedTotalPages) && reportedTotalPages! > 0 ? reportedTotalPages! : 1;
    page += 1;
  } while (page <= totalPages && !signal.aborted);

  return filterActiveProjects(allProjects);
}

/** Guide an explicit copy into project material; saving still requires project edit permission. */
export function PersonalProjectHandoff({ content }: Readonly<{ content: string }>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<readonly ProjectOption[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "fallback">("idle");
  const fallbackTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const projectsRequestRef = useRef<AbortController | null>(null);
  const selectedProject = projects.find((project) => project.id === projectId) ?? null;

  function loadProjects(): void {
    projectsRequestRef.current?.abort();
    const controller = new AbortController();
    projectsRequestRef.current = controller;
    setProjectsLoading(true);
    setProjectsError(null);
    setProjects([]);
    setProjectId("");
    setCopyState("idle");
    void readProjects(controller.signal).then((nextProjects) => {
      if (!controller.signal.aborted) setProjects(nextProjects);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted || cause instanceof Error && cause.name === "AbortError") return;
      setProjectsError(cause instanceof Error ? cause.message : "进行中项目列表加载失败");
      setProjects([]);
    }).finally(() => {
      if (!controller.signal.aborted) {
        setProjectsLoading(false);
        if (projectsRequestRef.current === controller) projectsRequestRef.current = null;
      }
    });
  }

  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);
    if (nextOpen) {
      loadProjects();
    } else {
      projectsRequestRef.current?.abort();
      projectsRequestRef.current = null;
      setProjectsLoading(false);
    }
  }

  useEffect(() => () => projectsRequestRef.current?.abort(), []);

  async function copyBody(): Promise<void> {
    try {
      await copyPersonalKnowledgeBody(content);
      setCopyState("copied");
    } catch {
      setCopyState("fallback");
    }
  }

  function selectFallbackBody(): void {
    fallbackTextareaRef.current?.select();
  }

  return (
    <OperationPanel
      title="复制到项目资料"
      triggerLabel="放入项目资料"
      description="复制只会在你明确操作后发生，原内容仍保存在个人知识库。项目资料按项目权限共享；个人通用记忆是另一项设置，只供你发起的项目 AI 参考。"
      open={open}
      onOpenChange={handleOpenChange}
      className="inline-flex"
    >
      {projectsLoading ? <p className="text-sm text-slate-600" role="status">正在加载你可访问的进行中项目…</p> : null}
      {projectsError !== null ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert"><p>{projectsError}</p><button type="button" onClick={loadProjects} className="mt-2 min-h-10 rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-700">重新加载项目</button></div> : null}
      {!projectsLoading && projectsError === null && projects.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm leading-6 text-slate-600"><p>没有可访问的进行中项目。你可以先把内容留在个人知识库，或检查项目权限；归档项目不会显示在这里。</p><Link href="/projects" onClick={() => setOpen(false)} className="mt-3 inline-flex min-h-9 items-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">前往我的项目</Link></div> : null}
      {!projectsLoading && projects.length > 0 ? (
        <div className="space-y-4">
          <label className="block text-sm font-semibold text-slate-700">目标项目
            <select aria-label="选择目标项目" value={projectId} onChange={(event) => { setProjectId(event.target.value); setCopyState("idle"); }} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-normal focus:border-indigo-400 focus:outline-none focus:ring-4 focus:ring-indigo-100">
              <option value="">请选择项目</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <p className="text-xs leading-5 text-slate-500">这里列出你可访问的进行中项目；保存资料需要编辑权限。选择目标后复制正文，再到项目的“添加来源”窗口粘贴并确认保存。</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void copyBody()} disabled={!selectedProject} className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40">复制正文</button>
            {selectedProject && (copyState === "copied" || copyState === "fallback") ? <Link href={buildProjectMaterialsAddHref(selectedProject.id)} onClick={() => setOpen(false)} className="inline-flex min-h-10 items-center rounded-lg border border-indigo-200 bg-white px-4 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">前往项目并粘贴</Link> : null}
          </div>
          {copyState === "copied" ? <p className="text-xs text-emerald-700" role="status">正文已复制。前往项目后，在“文本资料”中粘贴并保存。</p> : null}
          {copyState === "fallback" ? (
            <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3" role="alert">
              <p className="text-xs leading-5 text-amber-900">自动复制失败。先选择下方正文，再按 Ctrl+C 或 ⌘C 复制；复制后可前往项目粘贴。</p>
              <textarea ref={fallbackTextareaRef} aria-label="待手动复制的个人知识正文" readOnly value={content} rows={5} className="w-full resize-y rounded-lg border border-amber-200 bg-white p-3 text-xs leading-5 text-slate-700" />
              <button type="button" onClick={selectFallbackBody} className="min-h-9 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-900">选择正文</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </OperationPanel>
  );
}
