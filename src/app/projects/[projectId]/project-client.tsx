"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { ListPagination } from "@/components/list-pagination";
import type { ListPagination as ListPaginationState } from "@/lib/list-pagination";
import { buildProjectHref, parseProjectPageState } from "@/lib/project-navigation";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { buildMaterialsReturnTo, isAddSourceView, parseMaterialKind, type MaterialKind } from "./materials/materials-navigation";
import { ProjectMaterialIntake } from "./project-material-intake";

type ProjectItem = {
  id: string;
  type: "decision" | "progress" | "issue" | "risk";
  reviewStatus: "candidate" | "confirmed" | "dismissed" | "superseded";
  title: string;
  content: string;
  sourceExcerpt: string | null;
  occurredAt: string | null;
  confirmedAt: string | null;
  sourceId: string;
  createdAt: string;
  updatedAt: string;
  aiCandidateClaim: {
    id: string;
    reviewStatus: "candidate" | "accepted" | "dismissed";
  } | null;
  webAiCandidate: {
    id: string;
    reviewStatus: "candidate" | "accepted" | "dismissed";
  } | null;
  source: {
    id: string;
    kind: "document" | "screenshot" | "github" | "git" | "web" | "manual";
    externalRef: string | null;
    contentHash: string;
    capturedAt: string | null;
    ingestedAt: string;
  };
};

type ProjectSourceSummary = {
  id: string;
  kind: "document" | "screenshot" | "github" | "git" | "web" | "manual";
  preview: string;
  capturedAt: string | null;
  ingestedAt: string;
};

type ProjectSource = ProjectSourceSummary & { contentText: string; contentHash: string };

type Project = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  _count: {
    sources: number;
    assets: number;
    items: number;
    scans: number;
    snapshots: number;
  };
};

type ItemCounts = { candidate: number; confirmed: number; dismissed: number; superseded: number };
type ProjectSourcePage = { sources: ProjectSourceSummary[]; pagination: ListPaginationState };
type ProjectItemPage = { items: ProjectItem[]; counts: ItemCounts; pagination: ListPaginationState };
const emptyPagination: ListPaginationState = { page: 1, pageSize: 20, total: 0, totalPages: 1 };

const itemTypes: Array<{ value: ProjectItem["type"]; label: string }> = [
  { value: "decision", label: "Decision · 决策" },
  { value: "progress", label: "Progress · 进展" },
  { value: "issue", label: "Issue · 问题" },
  { value: "risk", label: "Risk · 风险" },
];

const itemTypeLabels: Record<ProjectItem["type"], string> = {
  decision: "决策",
  progress: "进展",
  issue: "问题",
  risk: "风险",
};

const itemStatusLabels: Record<ProjectItem["reviewStatus"], string> = {
  candidate: "待确认",
  confirmed: "已确认",
  dismissed: "已驳回",
  superseded: "已替代",
};

type ItemFormState = {
  type: ProjectItem["type"];
  sourceId: string;
  title: string;
  content: string;
  sourceExcerpt: string;
  occurredAt: string;
  expectedUpdatedAt: string;
};

type ItemAction = "confirm" | "dismiss" | "reopen";

async function readError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

async function getProject(projectId: string): Promise<Project> {
  const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response, "项目加载失败"));
  const payload = (await response.json()) as { project?: Project };
  if (!payload.project) throw new Error("项目加载响应无效");
  return payload.project;
}

async function getSources(projectId: string, input: { page: number; search: string; kind: string }): Promise<ProjectSourcePage> {
  const query = new URLSearchParams({ page: String(input.page), pageSize: "20", kind: input.kind });
  if (input.search.trim()) query.set("search", input.search.trim());
  const response = await fetch(`/api/projects/${projectId}/sources?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response, "项目资料加载失败"));
  const payload = (await response.json()) as Partial<ProjectSourcePage>;
  if (!payload.sources || !payload.pagination) throw new Error("项目资料加载响应无效");
  return { sources: payload.sources, pagination: payload.pagination };
}

async function getSource(projectId: string, sourceId: string): Promise<ProjectSource> {
  const response = await fetch(`/api/projects/${projectId}/sources/${sourceId}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response, "资料原文加载失败"));
  const payload = (await response.json()) as { source?: ProjectSource };
  if (!payload.source) throw new Error("资料原文加载响应无效");
  return payload.source;
}

async function getItems(projectId: string, input: { page: number; search: string; type: string; reviewStatus: string }): Promise<ProjectItemPage> {
  const query = new URLSearchParams({ page: String(input.page), pageSize: "20", type: input.type, reviewStatus: input.reviewStatus });
  if (input.search.trim()) query.set("search", input.search.trim());
  const response = await fetch(`/api/projects/${projectId}/items?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response, "项目条目加载失败"));
  const payload = (await response.json()) as Partial<ProjectItemPage>;
  if (!payload.items || !payload.pagination || !payload.counts) throw new Error("项目条目加载响应无效");
  return { items: payload.items, counts: payload.counts, pagination: payload.pagination };
}

function formatSourceDate(value: string | null): string {
  if (!value) return "未填写";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间无效";

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function sourcePreview(contentText: string): string {
  const compact = contentText.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
}

function toDateTimeLocal(value: string | null): string {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIsoDateTime(value: string): string | null {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function itemTypeClass(type: ProjectItem["type"]): string {
  switch (type) {
    case "decision":
      return "bg-violet-100 text-violet-700";
    case "progress":
      return "bg-sky-100 text-sky-700";
    case "issue":
      return "bg-rose-100 text-rose-700";
    case "risk":
      return "bg-amber-100 text-amber-700";
  }
}

function itemStatusClass(status: ProjectItem["reviewStatus"]): string {
  switch (status) {
    case "candidate":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "confirmed":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "dismissed":
      return "border-slate-200 bg-slate-100 text-slate-600";
    case "superseded":
      return "border-slate-200 bg-slate-50 text-slate-400";
  }
}

function itemActionText(action: ItemAction): string {
  switch (action) {
    case "confirm":
      return "确认";
    case "dismiss":
      return "驳回";
    case "reopen":
      return "重新打开";
  }
}

export function ProjectDetailClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigation = useMemo(() => parseProjectPageState("materials", projectId, new URLSearchParams(searchParams.toString())), [projectId, searchParams]);
  const focusSourceId = navigation.focus;
  const isAddSourceOpen = isAddSourceView(navigation.view);
  const queryMaterialKind = parseMaterialKind(navigation.kind);
  const intakeKind: MaterialKind = queryMaterialKind === "all" ? "manual" : queryMaterialKind;
  const [project, setProject] = useState<Project | null>(null);
  const [sources, setSources] = useState<ProjectSourceSummary[]>([]);
  const [sourceDetails, setSourceDetails] = useState<Record<string, ProjectSource>>({});
  const [sourcePagination, setSourcePagination] = useState<ListPaginationState>(emptyPagination);
  const sourceSearch = navigation.search ?? "";
  const deferredSourceSearch = useDeferredValue(sourceSearch);
  const sourceKind: MaterialKind = queryMaterialKind;
  const sourcePage = navigation.page ?? 1;
  const [isSourceDetailLoading, setIsSourceDetailLoading] = useState(false);
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [itemCounts, setItemCounts] = useState<ItemCounts>({ candidate: 0, confirmed: 0, dismissed: 0, superseded: 0 });
  const [itemPagination, setItemPagination] = useState<ListPaginationState>(emptyPagination);
  const [itemSearch, setItemSearch] = useState("");
  const deferredItemSearch = useDeferredValue(itemSearch);
  const [itemType, setItemType] = useState("all");
  const [itemStatus, setItemStatus] = useState("all");
  const [itemPage, setItemPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceSuccess, setSourceSuccess] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [itemSuccess, setItemSuccess] = useState<string | null>(null);
  const [isSourcesLoading, setIsSourcesLoading] = useState(true);
  const [isItemsLoading, setIsItemsLoading] = useState(true);
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null);
  const [isSavingItem, setIsSavingItem] = useState(false);
  const [itemActionId, setItemActionId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDraftDirty, setItemDraftDirty] = useState(false);
  const focusRestoredRef = useRef<string | null>(null);
  const focusCancelledRef = useRef<string | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();
  const [itemForm, setItemForm] = useState<ItemFormState>({
    type: "progress",
    sourceId: "",
    title: "",
    content: "",
    sourceExcerpt: "",
    occurredAt: "",
    expectedUpdatedAt: "",
  });

  useEffect(() => {
    if (!focusSourceId) {
      focusRestoredRef.current = null;
      focusCancelledRef.current = null;
      return;
    }
    const staticFocus = focusSourceId === "sources-heading";
    if (isSourcesLoading || !project || focusRestoredRef.current === focusSourceId || focusCancelledRef.current === focusSourceId || (!staticFocus && !sources.some((source) => source.id === focusSourceId))) return;
    const sourceId = focusSourceId;
    const findTarget = () => document.getElementById(staticFocus ? sourceId : `source-link-${sourceId}`);
    const initialTarget = findTarget();
    if (!(initialTarget instanceof HTMLElement) || !initialTarget.isConnected) return;

    let userCancelled = false;
    let firstFrame = 0;
    let secondFrame = 0;
    const removeFocusListeners = () => {
      document.removeEventListener("pointerdown", cancelFocusRestore, true);
      document.removeEventListener("keydown", cancelFocusRestore, true);
    };
    const cancelFocusRestore = () => {
      userCancelled = true;
      focusCancelledRef.current = sourceId;
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      removeFocusListeners();
    };
    document.addEventListener("pointerdown", cancelFocusRestore, true);
    document.addEventListener("keydown", cancelFocusRestore, true);
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (userCancelled) {
          removeFocusListeners();
          return;
        }
        const target = findTarget();
        if (target instanceof HTMLElement && target.isConnected) {
          target.scrollIntoView({ block: "center" });
          target.focus({ preventScroll: true });
          if (document.activeElement === target) focusRestoredRef.current = sourceId;
        }
        removeFocusListeners();
      });
    });
    return () => {
      userCancelled = true;
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      removeFocusListeners();
    };
  }, [focusSourceId, isSourcesLoading, project, sources]);

  function replaceMaterialsQuery(input: { view?: "add" | null; search?: string; kind?: MaterialKind; page?: number }): void {
    const href = buildProjectHref(projectId, "materials", {
      search: input.search ?? navigation.search,
      kind: input.kind ?? queryMaterialKind,
      page: input.page ?? navigation.page,
      view: input.view === undefined ? navigation.view : input.view,
      focus: navigation.focus,
      from: navigation.from,
      returnTo: navigation.returnTo,
    });
    router.replace(href, { scroll: false });
  }

  const loadProject = useCallback(async () => {
    try {
      setProject(await getProject(projectId));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "项目加载失败");
    }
  }, [projectId]);

  const loadSources = useCallback(async () => {
    setIsSourcesLoading(true);
    try {
      const loaded = await getSources(projectId, { page: sourcePage, search: deferredSourceSearch, kind: sourceKind });
      setSources(loaded.sources);
      setSourcePagination(loaded.pagination);
      setItemForm((current) => ({ ...current, sourceId: current.sourceId || loaded.sources[0]?.id || "" }));
      setSourceError(null);
    } catch (loadError) {
      setSourceError(loadError instanceof Error ? loadError.message : "项目资料加载失败");
    } finally {
      setIsSourcesLoading(false);
    }
  }, [deferredSourceSearch, projectId, sourceKind, sourcePage]);

  const loadSourceDetail = useCallback(async (sourceId: string): Promise<ProjectSource | null> => {
    const cached = sourceDetails[sourceId];
    if (cached) return cached;
    setIsSourceDetailLoading(true);
    try {
      const source = await getSource(projectId, sourceId);
      setSourceDetails((current) => ({ ...current, [source.id]: source }));
      return source;
    } catch (loadError) {
      setSourceError(loadError instanceof Error ? loadError.message : "资料原文加载失败");
      return null;
    } finally {
      setIsSourceDetailLoading(false);
    }
  }, [projectId, sourceDetails]);

  const loadItems = useCallback(async () => {
    setIsItemsLoading(true);
    try {
      const loaded = await getItems(projectId, { page: itemPage, search: deferredItemSearch, type: itemType, reviewStatus: itemStatus });
      setItems(loaded.items);
      setItemCounts(loaded.counts);
      setItemPagination(loaded.pagination);
      if (itemPage > loaded.pagination.totalPages) setItemPage(loaded.pagination.totalPages);
      setItemError(null);
    } catch (loadError) {
      setItemError(loadError instanceof Error ? loadError.message : "项目条目加载失败");
    } finally {
      setIsItemsLoading(false);
    }
  }, [deferredItemSearch, itemPage, itemStatus, itemType, projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void loadProject(), 0); return () => window.clearTimeout(timer); }, [loadProject]);
  useEffect(() => { const timer = window.setTimeout(() => void loadSources(), 0); return () => window.clearTimeout(timer); }, [loadSources]);
  useEffect(() => { const timer = window.setTimeout(() => void loadItems(), 0); return () => window.clearTimeout(timer); }, [loadItems]);
  useEffect(() => {
    if (!itemForm.sourceId || sourceDetails[itemForm.sourceId]) return;
    const timer = window.setTimeout(() => void loadSourceDetail(itemForm.sourceId), 0);
    return () => window.clearTimeout(timer);
  }, [itemForm.sourceId, loadSourceDetail, sourceDetails]);

  const reloadProjectAndSources = useCallback(async (): Promise<void> => {
    await Promise.all([loadProject(), loadSources(), loadItems()]);
  }, [loadItems, loadProject, loadSources]);

  async function handleDeleteSource(source: ProjectSourceSummary) {
    if (!projectId || deletingSourceId) return;
    const confirmation = await confirm({
      eyebrow: "Project materials",
      title: "删除这条原始资料？",
      description: "此操作会永久删除尚未被项目条目引用的原始资料；已经被引用的资料会由服务端拒绝删除。",
      confirmLabel: "确认删除",
      tone: "danger",
    });
    if (!confirmation.confirmed) return;

    setDeletingSourceId(source.id);
    setSourceError(null);
    setSourceSuccess(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/sources/${source.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readError(response, "资料删除失败"));
      }

      await reloadProjectAndSources();
      setSourceSuccess("原始资料已删除。");
    } catch (deleteError) {
      setSourceError(deleteError instanceof Error ? deleteError.message : "资料删除失败");
    } finally {
      setDeletingSourceId(null);
    }
  }

  async function handleEditItem(item: ProjectItem) {
    if (item.reviewStatus === "superseded" || itemActionId || isSavingItem || editingItemId === item.id) return;

    if (itemDraftDirty) {
      const confirmation = await confirm({
        eyebrow: "Project item",
        title: "放弃当前未保存内容？",
        description: "切换到另一条项目条目会清空当前表单中的未保存内容。",
        confirmLabel: "放弃并编辑",
        cancelLabel: "继续编辑",
        tone: "warning",
      });
      if (!confirmation.confirmed) return;
    }

    setItemError(null);
    setItemSuccess(null);
    const source = await loadSourceDetail(item.sourceId);
    if (!source) {
      setItemError("资料原文加载失败");
      return;
    }
    setEditingItemId(item.id);
    setItemDraftDirty(false);
    setItemForm({
      type: item.type,
      sourceId: item.sourceId,
      title: item.title,
      content: item.content,
      sourceExcerpt: item.sourceExcerpt ?? "",
      occurredAt: toDateTimeLocal(item.occurredAt),
      expectedUpdatedAt: item.updatedAt,
    });
    window.setTimeout(() => {
      document.getElementById("project-item-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("item-title")?.focus();
    }, 0);
  }

  function handleCancelEdit() {
    setEditingItemId(null);
    setItemDraftDirty(false);
    setItemForm({
      type: "progress",
      sourceId: sources[0]?.id ?? "",
      title: "",
      content: "",
      sourceExcerpt: "",
      occurredAt: "",
      expectedUpdatedAt: "",
    });
  }

  function updateItemForm(updater: (current: ItemFormState) => ItemFormState) {
    setItemDraftDirty(true);
    setItemForm(updater);
  }

  async function handleItemSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || isSavingItem) return;

    if (!itemForm.sourceId) {
      setItemError("请先添加并选择一条原始资料，再保存事实候选。");
      setItemSuccess(null);
      return;
    }

    const occurredAt = toIsoDateTime(itemForm.occurredAt);
    if (itemForm.occurredAt && !occurredAt) {
      setItemError("发生时间格式无效");
      setItemSuccess(null);
      return;
    }

    setIsSavingItem(true);
    setItemError(null);
    setItemSuccess(null);

    try {
      const isEditing = editingItemId !== null;
      const body = isEditing
        ? {
            action: "edit" as const,
            type: itemForm.type,
            title: itemForm.title,
            content: itemForm.content,
            sourceExcerpt: itemForm.sourceExcerpt,
            occurredAt,
            expectedUpdatedAt: itemForm.expectedUpdatedAt,
          }
        : {
            type: itemForm.type,
            sourceId: itemForm.sourceId,
            title: itemForm.title,
            content: itemForm.content,
            sourceExcerpt: itemForm.sourceExcerpt,
            occurredAt,
          };
      const endpoint = isEditing
        ? `/api/projects/${projectId}/items/${editingItemId}`
        : `/api/projects/${projectId}/items`;
      const response = await fetch(endpoint, {
        method: isEditing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(await readError(response, isEditing ? "条目更新失败" : "条目保存失败"));
      }

      const payload = (await response.json()) as { item?: ProjectItem };
      if (!payload.item) {
        throw new Error(isEditing ? "条目更新响应无效" : "条目保存响应无效");
      }

      const savedItem = payload.item;
      setItems((current) => {
        const next = isEditing
          ? current.map((item) => (item.id === savedItem.id ? savedItem : item))
          : [savedItem, ...current];
        return next.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      });

      if (isEditing) {
        setEditingItemId(null);
        setItemDraftDirty(false);
        setItemForm({
          type: "progress",
          sourceId: itemForm.sourceId,
          title: "",
          content: "",
          sourceExcerpt: "",
          occurredAt: "",
          expectedUpdatedAt: "",
        });
        setItemSuccess("条目已更新，已回到候选状态。");
      } else {
        setItemDraftDirty(false);
        setItemForm({
          type: "progress",
          sourceId: itemForm.sourceId,
          title: "",
          content: "",
          sourceExcerpt: "",
          occurredAt: "",
          expectedUpdatedAt: "",
        });
        setProject((current) => current ? {
          ...current,
          _count: { ...current._count, items: current._count.items + 1 },
        } : current);
        setItemSuccess("候选条目已保存。");
      }

      await reloadProjectAndSources();
    } catch (saveError) {
      setItemError(saveError instanceof Error ? saveError.message : "条目保存失败");
    } finally {
      setIsSavingItem(false);
    }
  }

  async function handleItemAction(item: ProjectItem, action: ItemAction) {
    if (!projectId || itemActionId || isSavingItem || editingItemId === item.id) return;

    setItemActionId(item.id);
    setItemError(null);
    setItemSuccess(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/items/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, expectedUpdatedAt: item.updatedAt }),
      });

      if (!response.ok) {
        throw new Error(await readError(response, "条目状态更新失败"));
      }

      const payload = (await response.json()) as { item?: ProjectItem };
      if (!payload.item) {
        throw new Error("条目状态更新响应无效");
      }

      const updatedItem = payload.item;
      setItems((current) => current
        .map((currentItem) => currentItem.id === updatedItem.id ? updatedItem : currentItem)
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()));
      setItemSuccess(action === "confirm" ? "条目已确认。" : action === "dismiss" ? "条目已驳回。" : "条目已重新打开，回到候选状态。");
      await Promise.all([loadItems(), loadProject()]);
    } catch (actionError) {
      setItemError(actionError instanceof Error ? actionError.message : "条目状态更新失败");
    } finally {
      setItemActionId(null);
    }
  }

  const selectedSource = sourceDetails[itemForm.sourceId] ?? sources.find((source) => source.id === itemForm.sourceId) ?? null;
  const sourceOptions = selectedSource && !sources.some((source) => source.id === selectedSource.id) ? [selectedSource, ...sources] : sources;
  const isEditingItem = editingItemId !== null;
  const materialReviewHref = buildProjectHref(projectId, "materialsReview", {
    focus: "review-queue",
    from: "materials",
    returnTo: buildProjectHref(projectId, "materials", {
      search: sourceSearch,
      kind: sourceKind,
      page: sourcePage,
      focus: "sources-heading",
    }),
  });

  if (error) {
    return <ProjectShell username={username} projectId={projectId} isSystemAdmin={isSystemAdmin}><div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">{error}</div></ProjectShell>;
  }

  if (!project) {
    return <ProjectShell username={username} projectId={projectId} isSystemAdmin={isSystemAdmin}><div className="h-40 animate-pulse rounded-3xl bg-slate-100" aria-label="正在加载项目" /></ProjectShell>;
  }

  return (
    <ProjectShell username={username} projectId={projectId} isSystemAdmin={isSystemAdmin}>
      {navigation.returnTo ? <Link href={navigation.returnTo} className="mb-6 inline-flex text-sm font-semibold text-indigo-700">← 返回来源页面</Link> : null}
      <div className="border-b border-slate-200/80 pb-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Project materials</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-slate-950">{project.name} · 原始资料</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">先收集可追溯的原始资料，再审核 AI 候选，最后形成已确认事实与 AI 可引用记忆。</p>
          </div>
          <div className="flex flex-wrap gap-3" aria-label="资料主要操作">
            <button id="add-source-trigger" type="button" onClick={() => replaceMaterialsQuery({ view: "add" })} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">添加来源</button>
            <Link href={materialReviewHref} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-3 text-sm font-semibold text-indigo-700 transition hover:border-indigo-300 hover:bg-indigo-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">审核 AI 候选</Link>
          </div>
        </div>
      </div>

      <section id="source-library" aria-labelledby="sources-heading" className="mt-10 scroll-mt-44 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 border-b border-slate-100 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Source library</p>
            <h2 id="sources-heading" tabIndex={-1} className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 outline-none focus:ring-4 focus:ring-indigo-100">原始资料来源库</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">这里保存文本、文件、网页和仓库发布的原始内容。它们是可追溯输入，不等同于 AI 候选、已确认事实或 AI 可引用记忆。</p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">{isSourcesLoading ? "读取中…" : `${sourcePagination.total} 条原始资料`}</span>
        </div>

        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900" role="note">
          <strong className="font-semibold">安全提示：</strong>这里只保存原始资料，不代表已确认事实或 AI 摘要。不要录入密码、Token、私密连接串，也不要使用带凭据的 URL。
        </div>

        {sourceError ? (
          <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert">{sourceError}</div>
        ) : null}
        {sourceSuccess ? (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700" role="status" aria-live="polite">{sourceSuccess}</div>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center">
          <label className="min-w-0 flex-1"><span className="sr-only">搜索原始资料</span><input value={sourceSearch} onChange={(event) => { replaceMaterialsQuery({ search: event.target.value, page: 1 }); }} placeholder="搜索正文、来源链接或内容哈希" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /></label>
          <label className="sm:w-48"><span className="sr-only">按原始资料类型筛选</span><select value={sourceKind} onChange={(event) => { const value = parseMaterialKind(event.target.value); replaceMaterialsQuery({ kind: value, page: 1 }); }} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none focus:border-indigo-300"><option value="all">全部资料类型</option><option value="manual">手工文本</option><option value="document">文档</option><option value="screenshot">图片或截图</option><option value="web">网页</option><option value="github">GitHub</option><option value="git">Git 仓库</option></select></label>
        </div>

        <div className="mt-8 min-w-0">
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Traceable inputs</p>
                <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">原始资料清单</h3>
              </div>
              <span className="text-xs text-slate-400">按最近接入排序</span>
            </div>

            {isSourcesLoading ? (
              <div className="mt-5 space-y-3" aria-label="正在加载项目资料">
                {[1, 2].map((item) => <div key={item} className="h-40 animate-pulse rounded-2xl bg-slate-100" />)}
              </div>
            ) : sources.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center">
                <p className="text-sm font-medium text-slate-700">{sourceSearch.trim() || sourceKind !== "all" ? "没有匹配的原始资料" : "还没有原始资料"}</p>
                <p className="mt-2 text-sm leading-6 text-slate-500">{sourceSearch.trim() || sourceKind !== "all" ? "调整关键词或资料类型后重试。" : "使用上方“添加来源”收集文本、文件、网页或代码仓库资料。"}</p>
              </div>
            ) : (
              <ul className="mt-5 min-w-0 space-y-4" aria-label="项目原始资料列表">
                {sources.map((source) => (
                  <li key={source.id} className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-[12px] font-semibold uppercase tracking-wide text-indigo-700">{source.kind}</span>
                          <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-semibold text-slate-600">原始资料</span>
                        </div>
                        <h4 className="mt-3 line-clamp-2 text-sm font-semibold leading-6 text-slate-900">{source.preview || "未提供文字预览"}</h4>
                        <p className="mt-2 text-xs text-slate-500">{source.kind === "manual" ? "手工输入资料" : "外部来源已绑定"} · 最近接入于 {formatSourceDate(source.ingestedAt)}</p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
                        <Link id={`source-link-${source.id}`} href={`/projects/${encodeURIComponent(projectId)}/materials/sources/${encodeURIComponent(source.id)}?returnTo=${encodeURIComponent(buildMaterialsReturnTo(projectId, { search: sourceSearch, kind: sourceKind, page: sourcePage, focus: source.id }))}`} className="inline-flex min-h-9 items-center justify-center rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500">查看详情</Link>
                        <button
                          type="button"
                          onClick={() => void handleDeleteSource(source)}
                          disabled={deletingSourceId !== null}
                          className="inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`删除原始资料 ${source.preview.slice(0, 24)}`}
                        >
                          {deletingSourceId === source.id ? "删除中…" : "删除"}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <ListPagination {...sourcePagination} onPageChange={(page) => { replaceMaterialsQuery({ page }); }} disabled={isSourcesLoading} />
          </div>
        </div>
      </section>

      <section id="confirmed-facts" aria-labelledby="items-heading" className="mt-10 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 border-b border-slate-100 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Confirmed facts</p>
            <h2 id="items-heading" className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">已确认事实</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">人工记录或审核项目事实，并通过精确原文摘录回溯到原始资料。只有已确认事实才可能进入后续 AI 可引用记忆流程。</p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">{isItemsLoading ? "读取中…" : `${itemCounts.confirmed} 已确认 · ${itemCounts.candidate} 待确认`}</span>
        </div>

        {itemError ? (
          <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert" aria-live="polite">{itemError}</div>
        ) : null}
        {itemSuccess ? (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700" role="status" aria-live="polite">{itemSuccess}</div>
        ) : null}

        <div className="mt-8 grid min-w-0 items-stretch grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
          <form id="project-item-form" onSubmit={handleItemSubmit} className="min-w-0 max-w-full rounded-2xl bg-slate-950 p-6 text-white shadow-lg shadow-slate-950/10" aria-labelledby="item-form-heading">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Fact candidate</p>
            <h3 id="item-form-heading" className="mt-3 text-xl font-semibold tracking-tight text-white">{isEditingItem ? "编辑事实候选" : "补充事实候选"}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-400">{isEditingItem ? "编辑后会回到待确认状态；原始资料归属保持不变。" : "选择当前项目的原始资料，填写可以被原文精确支持的事实候选。"}</p>

            <label className="mt-6 block text-sm font-medium text-slate-200" htmlFor="item-source">Source <span className="text-rose-300">（必选）</span></label>
              <select
              id="item-source"
              value={itemForm.sourceId}
              onChange={(event) => updateItemForm((current) => ({ ...current, sourceId: event.target.value }))}
              disabled={isEditingItem || isSavingItem || sourceOptions.length === 0}
              required
              className="mt-2 w-full min-w-0 max-w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition [color-scheme:dark] focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
                <option value="" className="bg-slate-950">选择当前项目的原始资料</option>
              {sourceOptions.map((source) => (
                <option key={source.id} value={source.id} className="bg-slate-950">
                  {source.kind} · {sourcePreview(source.preview).slice(0, 52)}
                </option>
              ))}
            </select>
            {isEditingItem ? <p className="mt-2 text-xs text-slate-500">编辑时 Source 不可更换。</p> : null}

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="item-type">类型 <span className="text-rose-300">（必选）</span></label>
            <select
              id="item-type"
              value={itemForm.type}
              onChange={(event) => updateItemForm((current) => ({ ...current, type: event.target.value as ProjectItem["type"] }))}
              disabled={isSavingItem}
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition [color-scheme:dark] focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {itemTypes.map((itemType) => <option key={itemType.value} value={itemType.value} className="bg-slate-950">{itemType.label}</option>)}
            </select>

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="item-title">标题 <span className="text-rose-300">（必填）</span></label>
            <input
              id="item-title"
              value={itemForm.title}
              onChange={(event) => updateItemForm((current) => ({ ...current, title: event.target.value }))}
              maxLength={160}
              required
              disabled={isSavingItem}
              placeholder="例如：本周确定采用 cursor pagination"
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30 disabled:cursor-not-allowed disabled:opacity-60"
            />

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="item-content">内容 <span className="text-rose-300">（必填）</span></label>
            <textarea
              id="item-content"
              value={itemForm.content}
              onChange={(event) => updateItemForm((current) => ({ ...current, content: event.target.value }))}
              maxLength={20000}
              rows={5}
              required
              disabled={isSavingItem}
              placeholder="描述事实、进展、问题或风险……"
              className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30 disabled:cursor-not-allowed disabled:opacity-60"
            />

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="item-source-excerpt">精确原文摘录 <span className="text-rose-300">（必填）</span></label>
            <textarea
              id="item-source-excerpt"
              value={itemForm.sourceExcerpt}
              onChange={(event) => updateItemForm((current) => ({ ...current, sourceExcerpt: event.target.value }))}
              maxLength={10000}
              rows={5}
              required
              disabled={isSavingItem}
              placeholder="从下方所选 Source 原文复制一段完全一致的文字"
              className="mt-2 w-full resize-y rounded-xl border border-indigo-300/30 bg-indigo-300/10 px-4 py-3 font-mono text-sm leading-6 text-white outline-none transition placeholder:font-sans placeholder:text-slate-500 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30 disabled:cursor-not-allowed disabled:opacity-60"
            />

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="item-occurred-at">发生时间 <span className="font-normal text-slate-500">（可选）</span></label>
            <input
              id="item-occurred-at"
              type="datetime-local"
              value={itemForm.occurredAt}
              onChange={(event) => updateItemForm((current) => ({ ...current, occurredAt: event.target.value }))}
              disabled={isSavingItem}
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition [color-scheme:dark] focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30 disabled:cursor-not-allowed disabled:opacity-60"
            />

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                type="submit"
                disabled={isSavingItem || isItemsLoading || !itemForm.sourceId || sourceOptions.length === 0}
                className="flex flex-1 items-center justify-center rounded-xl bg-indigo-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingItem ? "保存中…" : isEditingItem ? "保存编辑" : "保存候选条目"}
              </button>
              {isEditingItem ? (
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  disabled={isSavingItem}
                  className="rounded-xl border border-white/15 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  取消编辑
                </button>
              ) : null}
            </div>
          </form>

          <div className="min-w-0 max-w-full rounded-2xl border border-indigo-100 bg-indigo-50/60 p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Selected source</p>
            <h3 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">所选原始资料</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">复制下方原文中的连续片段到“精确原文摘录”，服务端会验证它确实来自当前原始资料。</p>
            {selectedSource && "contentText" in selectedSource ? (
              <div className="mt-5 min-w-0 max-w-full rounded-xl border border-indigo-100 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="rounded-full bg-indigo-100 px-2.5 py-1 font-semibold uppercase tracking-wide text-indigo-700">{selectedSource.kind}</span>
                  <span>接入于：{formatSourceDate(selectedSource.ingestedAt)}</span>
                </div>
                <pre className="mt-4 min-w-0 max-w-full max-h-[34rem] overflow-auto whitespace-pre-wrap border-t border-slate-100 pt-4 text-sm leading-6 text-slate-700 [overflow-wrap:anywhere]">{selectedSource.contentText}</pre>
              </div>
            ) : selectedSource ? (
              <div className="mt-5 rounded-xl border border-dashed border-indigo-200 bg-white/70 px-5 py-10 text-center text-sm leading-6 text-slate-500">
                {isSourceDetailLoading ? "正在加载资料原文…" : "正在准备资料原文…"}
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-indigo-200 bg-white/70 px-5 py-10 text-center text-sm leading-6 text-slate-500">
                {sources.length === 0 ? "请先在上方添加一条原始资料。" : "请选择一条原始资料查看完整内容。"}
              </div>
            )}
          </div>
        </div>

        <div className="mt-10 border-t border-slate-100 pt-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">All project items</p>
              <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">事实与候选记录</h3>
            </div>
            <span className="text-xs text-slate-400">按最近更新时间排序</span>
          </div>

          <div className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-[minmax(0,1fr)_180px_180px]">
            <label><span className="sr-only">搜索项目条目</span><input value={itemSearch} onChange={(event) => { setItemSearch(event.target.value); setItemPage(1); }} placeholder="搜索标题、内容或证据摘录" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /></label>
            <label><span className="sr-only">按条目类型筛选</span><select value={itemType} onChange={(event) => { setItemType(event.target.value); setItemPage(1); }} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none focus:border-indigo-300"><option value="all">全部类型</option><option value="decision">决策</option><option value="progress">进展</option><option value="issue">问题</option><option value="risk">风险</option></select></label>
            <label><span className="sr-only">按审核状态筛选</span><select value={itemStatus} onChange={(event) => { setItemStatus(event.target.value); setItemPage(1); }} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none focus:border-indigo-300"><option value="all">全部状态</option><option value="candidate">待确认</option><option value="confirmed">已确认</option><option value="dismissed">已驳回</option><option value="superseded">已替代</option></select></label>
          </div>

          {isItemsLoading ? (
            <div className="mt-5 space-y-4" aria-label="正在加载项目条目">
              {[1, 2].map((item) => <div key={item} className="h-56 animate-pulse rounded-2xl bg-slate-100" />)}
            </div>
          ) : items.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center">
              <p className="text-sm font-medium text-slate-700">{itemSearch.trim() || itemType !== "all" || itemStatus !== "all" ? "没有匹配的项目条目" : "还没有项目条目"}</p>
              <p className="mt-2 text-sm leading-6 text-slate-500">{itemSearch.trim() || itemType !== "all" || itemStatus !== "all" ? "调整关键词、类型或状态后重试。" : "从上方选择原始资料并保存第一条决策、进展、问题或风险候选。"}</p>
            </div>
          ) : (
            <ul className="mt-5 space-y-4" aria-label="全部项目条目列表">
              {items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  itemActionId={itemActionId}
                  isSavingItem={isSavingItem}
                  editingItemId={editingItemId}
                  materialReviewHref={materialReviewHref}
                  onEdit={handleEditItem}
                  onAction={handleItemAction}
                />
              ))}
              </ul>
          )}
          <ListPagination {...itemPagination} onPageChange={setItemPage} disabled={isItemsLoading} />
        </div>
      </section>
      <ProjectMaterialIntake projectId={projectId} onChanged={reloadProjectAndSources} open={isAddSourceOpen} kind={intakeKind} onClose={() => replaceMaterialsQuery({ view: null })} />
      {dialog}
    </ProjectShell>
  );
}

function ItemCard({
  item,
  itemActionId,
  isSavingItem,
  editingItemId,
  materialReviewHref,
  onEdit,
  onAction,
}: {
  item: ProjectItem;
  itemActionId: string | null;
  isSavingItem: boolean;
  editingItemId: string | null;
  materialReviewHref: string;
  onEdit: (item: ProjectItem) => Promise<void>;
  onAction: (item: ProjectItem, action: ItemAction) => void;
}) {
  const isActionPending = itemActionId === item.id;
  const actionsDisabled = isActionPending || isSavingItem || editingItemId === item.id;
  const editDisabled = Boolean(itemActionId) || isSavingItem || editingItemId === item.id;
  const requiresAiWorkbench =
    item.aiCandidateClaim !== null || item.webAiCandidate?.reviewStatus === "candidate";

  return (
    <li className={`rounded-2xl border p-5 ${item.reviewStatus === "superseded" ? "border-slate-200 bg-slate-50/70" : "border-slate-200 bg-white"}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold uppercase tracking-wide ${itemTypeClass(item.type)}`}>
              {item.type} · {itemTypeLabels[item.type]}
            </span>
            <span className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold ${itemStatusClass(item.reviewStatus)}`}>
              {itemStatusLabels[item.reviewStatus]}
            </span>
            {item.aiCandidateClaim ? (
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[12px] font-semibold text-indigo-700">
                AI 候选 · {item.aiCandidateClaim.reviewStatus === "candidate" ? "待审阅" : item.aiCandidateClaim.reviewStatus === "accepted" ? "已接受" : "已驳回"}
              </span>
            ) : null}
            {item.webAiCandidate ? (
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[12px] font-semibold text-indigo-700">
                AI 候选 · {item.webAiCandidate.reviewStatus === "candidate" ? "待审阅" : item.webAiCandidate.reviewStatus === "accepted" ? "已接受" : "已驳回"}
              </span>
            ) : null}
          </div>
          <h4 className="mt-3 text-lg font-semibold tracking-tight text-slate-950">{item.title}</h4>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{item.content}</p>
        </div>

        {item.reviewStatus !== "superseded" && !requiresAiWorkbench ? (
          <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
            <button
              type="button"
              onClick={() => void onEdit(item)}
              disabled={editDisabled}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              编辑
            </button>
            {item.reviewStatus === "candidate" ? (
              <>
                <button
                  type="button"
                  onClick={() => void onAction(item, "confirm")}
                  disabled={actionsDisabled}
                  className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isActionPending ? "处理中…" : itemActionText("confirm")}
                </button>
                <button
                  type="button"
                  onClick={() => void onAction(item, "dismiss")}
                  disabled={actionsDisabled}
                  className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isActionPending ? "处理中…" : itemActionText("dismiss")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void onAction(item, "reopen")}
                disabled={actionsDisabled}
                className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isActionPending ? "处理中…" : itemActionText("reopen")}
              </button>
            )}
          </div>
        ) : (
          <span className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-400">
            {requiresAiWorkbench && item.reviewStatus === "candidate" ? <Link href={materialReviewHref} className="text-indigo-700 underline decoration-indigo-200 underline-offset-4 hover:text-indigo-900">前往审核 AI 候选</Link> : "只读"}
          </span>
        )}
      </div>

      <div className="mt-5 grid gap-4 border-t border-slate-100 pt-5 lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">精确原文摘录</p>
          <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-indigo-200 pl-3 text-sm leading-6 text-slate-600">
            {item.sourceExcerpt || "未提供精确原文摘录"}
          </blockquote>
        </div>

        <dl className="grid gap-3 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-1">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Source 链接</dt>
            <dd className="mt-1 min-w-0">
              {item.source.externalRef ? (
                <a href={item.source.externalRef} target="_blank" rel="noopener noreferrer" className="block truncate text-indigo-600 underline decoration-indigo-200 underline-offset-4 hover:text-indigo-700" title={item.source.externalRef}>{item.source.externalRef}</a>
              ) : "未提供外部链接"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Source SHA-256</dt>
            <dd className="mt-1 break-all font-mono text-xs leading-5 text-slate-600">{item.source.contentHash}</dd>
          </div>
        </dl>
      </div>

      <dl className="mt-5 grid gap-3 border-t border-slate-100 pt-5 text-xs text-slate-500 sm:grid-cols-3">
        <div><dt className="font-semibold uppercase tracking-[0.12em] text-slate-400">发生时间</dt><dd className="mt-1">{formatSourceDate(item.occurredAt)}</dd></div>
        <div><dt className="font-semibold uppercase tracking-[0.12em] text-slate-400">确认时间</dt><dd className="mt-1">{formatSourceDate(item.confirmedAt)}</dd></div>
        <div><dt className="font-semibold uppercase tracking-[0.12em] text-slate-400">更新时间</dt><dd className="mt-1">{formatSourceDate(item.updatedAt)}</dd></div>
      </dl>
    </li>
  );
}

function ProjectShell({ children, username, projectId, isSystemAdmin }: { children: ReactNode; username: string; projectId: string; isSystemAdmin: boolean }) {
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="materials" isSystemAdmin={isSystemAdmin} />
      <div className="mx-auto max-w-6xl px-6 pb-16 pt-10 sm:px-10 lg:px-12">{children}</div>
    </main>
  );
}
