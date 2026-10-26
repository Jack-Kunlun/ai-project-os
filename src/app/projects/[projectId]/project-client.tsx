"use client";
import { UiErrorText } from "@/components/ui-error-text";

import {  UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { ParentPageLink } from "@/components/parent-page-link";
import { OperationPanel } from "@/components/operation-panel";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { ListPagination } from "@/components/list-pagination";
import type { ListPagination as ListPaginationState } from "@/lib/list-pagination";
import { buildProjectHref, parseProjectPageState } from "@/lib/project-navigation";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { formatUiDateTimeOrFallback } from "@/lib/ui-date-format";
import styles from "./project-materials.module.css";
import { buildMaterialsReturnTo, buildProjectQuestionHref, isAddSourceView, MATERIAL_SOURCE_CATEGORIES, parseMaterialKind, parseProjectItemReviewStatus, type MaterialKind } from "./materials/materials-navigation";
import { ProjectMaterialIntake } from "./project-material-intake";
import { ProjectMaterialReviewQueue } from "./project-material-review-queue";
import { ProjectProcessingTasks } from "./project-processing-tasks";

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
  archivedAt: string | null;
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

async function getSources(projectId: string, input: { page: number; search: string; kind: string }, signal?: AbortSignal): Promise<ProjectSourcePage> {
  const query = new URLSearchParams({ page: String(input.page), pageSize: "20", kind: input.kind });
  if (input.search.trim()) query.set("search", input.search.trim());
  const response = await fetch(`/api/projects/${projectId}/sources?${query}`, { cache: "no-store", signal });
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

async function getItems(projectId: string, input: { page: number; search: string; type: string; reviewStatus: string }, signal?: AbortSignal): Promise<ProjectItemPage> {
  const query = new URLSearchParams({ page: String(input.page), pageSize: "20", type: input.type, reviewStatus: input.reviewStatus });
  if (input.search.trim()) query.set("search", input.search.trim());
  const response = await fetch(`/api/projects/${projectId}/items?${query}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(await readError(response, "项目条目加载失败"));
  const payload = (await response.json()) as Partial<ProjectItemPage>;
  if (!payload.items || !payload.pagination || !payload.counts) throw new Error("项目条目加载响应无效");
  return { items: payload.items, counts: payload.counts, pagination: payload.pagination };
}

function formatSourceDate(value: string | null, language: "zh-CN" | "en", t: (text: string) => string): string {
  const date = value ? new Date(value) : null;
  return formatUiDateTimeOrFallback(date, language, t(value ? "时间无效" : "未填写"), {
    dateStyle: "medium",
    timeStyle: "short",
  });
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
  return <ProjectDetailWorkspace key={projectId} projectId={projectId} username={username} isSystemAdmin={isSystemAdmin} />;
}

function ProjectDetailWorkspace({ projectId, username, isSystemAdmin }: { projectId: string; username: string; isSystemAdmin: boolean }) {
  const { language } = useAppearance();
  const translateUi = useTranslate();
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
  const itemStatus = parseProjectItemReviewStatus(navigation.status ?? (navigation.view === "review" ? "confirmed" : undefined));
  const materialsView = navigation.view === "tasks" || navigation.view === "review"
    ? navigation.view
    : !navigation.view && ((!focusSourceId && itemStatus !== "all") || focusSourceId === "confirmed-facts" || focusSourceId === "items-heading" || focusSourceId === "review-queue") ? "review" : "materials";
  const [isSourceDetailLoading, setIsSourceDetailLoading] = useState(false);
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [itemCounts, setItemCounts] = useState<ItemCounts>({ candidate: 0, confirmed: 0, dismissed: 0, superseded: 0 });
  const [itemPagination, setItemPagination] = useState<ListPaginationState>(emptyPagination);
  const [itemSearch, setItemSearch] = useState("");
  const deferredItemSearch = useDeferredValue(itemSearch);
  const [itemType, setItemType] = useState("all");
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
  const [itemEditorOpen, setItemEditorOpen] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDraftDirty, setItemDraftDirty] = useState(false);
  const focusRestoredRef = useRef<string | null>(null);
  const focusCancelledRef = useRef<string | null>(null);
  const sourceRequestIdRef = useRef(0);
  const sourceRequestControllerRef = useRef<AbortController | null>(null);
  const itemRequestIdRef = useRef(0);
  const itemRequestControllerRef = useRef<AbortController | null>(null);
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
    if (navigation.view !== "ask") return;
    router.replace(buildProjectQuestionHref(projectId), { scroll: false });
  }, [navigation.view, projectId, router]);

  useEffect(() => {
    if (!focusSourceId) {
      focusRestoredRef.current = null;
      focusCancelledRef.current = null;
      return;
    }
    const focusesItems = focusSourceId === "confirmed-facts" || focusSourceId === "items-heading";
    const staticFocus = focusSourceId === "sources-heading" || focusesItems;
    if ((focusesItems ? isItemsLoading : isSourcesLoading) || !project || focusRestoredRef.current === focusSourceId || focusCancelledRef.current === focusSourceId || (!staticFocus && !sources.some((source) => source.id === focusSourceId))) return;
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
  }, [focusSourceId, isItemsLoading, isSourcesLoading, project, sources]);

  function replaceMaterialsQuery(input: { view?: "add" | "review" | "tasks" | null; status?: ReturnType<typeof parseProjectItemReviewStatus>; search?: string; kind?: MaterialKind; page?: number }): void {
    const status = input.status ?? itemStatus;
    const href = buildProjectHref(projectId, "materials", {
      status: status === "all" ? null : status,
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
    const requestId = ++sourceRequestIdRef.current;
    sourceRequestControllerRef.current?.abort();
    const controller = new AbortController();
    sourceRequestControllerRef.current = controller;
    const isCurrentRequest = () => !controller.signal.aborted && sourceRequestIdRef.current === requestId;
    setIsSourcesLoading(true);
    setSourceError(null);
    try {
      const loaded = await getSources(projectId, { page: sourcePage, search: deferredSourceSearch, kind: sourceKind }, controller.signal);
      if (!isCurrentRequest()) return;
      setSources(loaded.sources);
      setSourcePagination(loaded.pagination);
      setItemForm((current) => ({ ...current, sourceId: current.sourceId || loaded.sources[0]?.id || "" }));
      setSourceError(null);
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      setSourceError(loadError instanceof Error ? loadError.message : "项目资料加载失败");
    } finally {
      if (isCurrentRequest()) {
        sourceRequestControllerRef.current = null;
        setIsSourcesLoading(false);
      }
    }
  }, [deferredSourceSearch, projectId, sourceKind, sourcePage]);

  const cancelSourceRequest = useCallback(() => {
    sourceRequestIdRef.current += 1;
    const controller = sourceRequestControllerRef.current;
    sourceRequestControllerRef.current = null;
    controller?.abort();
  }, []);

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
    const requestId = ++itemRequestIdRef.current;
    itemRequestControllerRef.current?.abort();
    const controller = new AbortController();
    itemRequestControllerRef.current = controller;
    const isCurrentRequest = () => !controller.signal.aborted && itemRequestIdRef.current === requestId;
    setIsItemsLoading(true);
    try {
      const loaded = await getItems(projectId, { page: itemPage, search: deferredItemSearch, type: itemType, reviewStatus: itemStatus }, controller.signal);
      if (!isCurrentRequest()) return;
      setItems(loaded.items);
      setItemCounts(loaded.counts);
      setItemPagination(loaded.pagination);
      if (itemPage > loaded.pagination.totalPages) setItemPage(loaded.pagination.totalPages);
      setItemError(null);
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      setItemError(loadError instanceof Error ? loadError.message : "项目条目加载失败");
    } finally {
      if (isCurrentRequest()) {
        itemRequestControllerRef.current = null;
        setIsItemsLoading(false);
      }
    }
  }, [deferredItemSearch, itemPage, itemStatus, itemType, projectId]);

  const cancelItemRequest = useCallback(() => {
    itemRequestIdRef.current += 1;
    const controller = itemRequestControllerRef.current;
    itemRequestControllerRef.current = null;
    controller?.abort();
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void loadProject(), 0); return () => window.clearTimeout(timer); }, [loadProject, materialsView]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadSources(), 0);
    return () => {
      window.clearTimeout(timer);
      cancelSourceRequest();
    };
  }, [cancelSourceRequest, loadSources, materialsView]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadItems(), 0);
    return () => {
      window.clearTimeout(timer);
      cancelItemRequest();
    };
  }, [cancelItemRequest, loadItems, materialsView]);
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
    if (item.reviewStatus === "superseded" || itemActionId || isSavingItem) return;
    if (editingItemId === item.id) { setItemEditorOpen(true); return; }

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
    setItemEditorOpen(true);
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
    setItemEditorOpen(false);
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

      setItemEditorOpen(false);
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
  const materialReviewHref = buildProjectHref(projectId, "materials", {
    view: "review",
    focus: "review-queue",
    from: "materials",
    returnTo: buildProjectHref(projectId, "materials", {
      status: itemStatus === "all" ? null : itemStatus,
      search: sourceSearch,
      kind: sourceKind,
      page: sourcePage,
      focus: "sources-heading",
    }),
  });

  if (error) {
    return <ProjectShell username={username} projectId={projectId} isSystemAdmin={isSystemAdmin}><div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700"><UiErrorText text={error} /></div></ProjectShell>;
  }

  if (!project) {
    return <ProjectShell username={username} projectId={projectId} isSystemAdmin={isSystemAdmin}><div className="h-40 animate-pulse rounded-3xl bg-slate-100" aria-label={translateUi("正在加载项目")} /></ProjectShell>;
  }

  return (
    <ProjectShell username={username} projectId={projectId} isSystemAdmin={isSystemAdmin}>
      {navigation.returnTo ? <div className="mb-6"><ParentPageLink href={navigation.returnTo} label="返回来源页面" /></div> : null}
      <div className={styles.pageHeader}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400"><UiText text={"Project materials"} /></p>
            <h1 aria-label={`${project.name} · ${translateUi("项目资料")}`} className="mt-2 text-3xl font-semibold tracking-[-0.03em] text-slate-950"><UiText text={"项目资料"} /></h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600"><UiText text={"查看有来源的资料、整理结果和后台识别任务。"} /></p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label={translateUi("资料主要操作")}>
            <button id="add-source-trigger" type="button" onClick={() => replaceMaterialsQuery({ view: "add" })} disabled={Boolean(project.archivedAt)} className={styles.primaryAction}><UiText text={"添加资料"} /></button>
          </div>
        </div>
      </div>

      <nav aria-label={translateUi("项目资料栏目")} className={styles.tabs} data-sticky-page-tabs>
        {([{ view: "materials", label: "资料" }, { view: "review", label: "整理结果" }, { view: "tasks", label: "识别任务" }] as const).map((tab) => <Link key={tab.view} href={buildProjectHref(projectId, "materials", { view: tab.view === "materials" ? null : tab.view, from: "materials", kind: sourceKind, search: sourceSearch, page: sourcePage })} scroll={false} aria-current={materialsView === tab.view ? "page" : undefined} className={`${styles.tab} ${materialsView === tab.view ? styles.tabActive : ""}`}><UiText text={tab.label} />{tab.view === "review" && itemCounts.candidate > 0 ? <span className={styles.countBadge}>{itemCounts.candidate}</span> : null}</Link>)}
      </nav>

      {materialsView === "tasks" ? <ProjectProcessingTasks key={projectId} projectId={projectId} onChanged={reloadProjectAndSources} /> : null}

      {materialsView === "materials" ? <section id="source-library" aria-labelledby="sources-heading" className={styles.sourceSection}>
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="sources-heading" tabIndex={-1} className="text-lg font-semibold text-slate-950 outline-none focus:ring-4 focus:ring-indigo-100"><UiText text={"资料来源"} /></h2>
            <p className="mt-1 text-xs leading-5 text-slate-500"><UiText text={"保留原文和来源，可查看版本并追溯整理结果。"} /></p>
          </div>
          <span className={styles.totalCount}>{isSourcesLoading ? <UiText text={"读取中…"} /> : sourceError ? <UiText text={"读取失败"} /> : `${sourcePagination.total} ${translateUi("条资料")}`}</span>
        </div>

        <p className={styles.safetyNote} role="note"><strong><UiText text={"安全提示："} /></strong><UiText text={"资料不会自动成为已确认事实；请勿提交密码、Token 或带凭据的链接。"} /></p>

        {sourceError ? <div className={styles.errorNotice} role="alert"><UiErrorText text={sourceError} /></div> : null}
        {sourceSuccess ? <div className={styles.successNotice} role="status" aria-live="polite"><UiText text={sourceSuccess} /></div> : null}

        <div className={styles.sourceLayout}>
          <nav aria-label={translateUi("按资料类型筛选")} className={styles.categoryNav}>
            {MATERIAL_SOURCE_CATEGORIES.map((category) => <button key={category.value} type="button" aria-pressed={sourceKind === category.value} onClick={() => replaceMaterialsQuery({ kind: category.value, page: 1 })} className={`${styles.categoryButton} ${sourceKind === category.value ? styles.categoryButtonActive : ""}`}><UiText text={category.label} /></button>)}
          </nav>
          <div className={styles.sourceContent}>
            <div className={styles.sourceTools}>
              <label className="min-w-0 flex-1"><span className="sr-only"><UiText text={"搜索原始资料"} /></span><input value={sourceSearch} onChange={(event) => { replaceMaterialsQuery({ search: event.target.value, page: 1 }); }} placeholder={translateUi("搜索资料内容、来源链接或哈希")} className={styles.searchInput} /></label>
              <span className="shrink-0 text-xs text-slate-400"><UiText text={"按最近接入排序"} /></span>
            </div>

            {isSourcesLoading ? <div role="status" className={styles.loadingRows} aria-label={translateUi("正在加载项目资料")}>{[1, 2, 3].map((item) => <div key={item} className={styles.loadingRow} aria-hidden="true" />)}</div>
              : sourceError ? null
                : sources.length === 0 ? <div className={styles.emptyState}>
                  <p className="text-sm font-medium text-slate-700">{sourceSearch.trim() || sourceKind !== "all" ? <UiText text={"没有匹配的资料"} /> : <UiText text={"还没有项目资料"} />}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{sourceSearch.trim() || sourceKind !== "all" ? <UiText text={"调整搜索词或资料类型后重试。"} /> : <UiText text={"可以添加文本、图片、文档、网页或代码仓库资料。"} />}</p>
                </div>
                  : <ul className={styles.sourceList} aria-label={translateUi("项目原始资料列表")}>
                    {sources.map((source) => (
                      <li key={source.id} className={styles.sourceRow}>
                        <div className={styles.sourceRowMain}>
                          <div className={styles.sourceMeta}><span className={styles.kindBadge}>{source.kind}</span><span>{source.kind === "manual" ? <UiText text={"手工文本"} /> : <UiText text={"来源已接入"} />}</span><time dateTime={source.ingestedAt}>{formatSourceDate(source.ingestedAt, language, translateUi)}</time></div>
                          <h3 className={styles.sourcePreview}>{source.preview || <UiText text={"未提供文字预览"} />}</h3>
                        </div>
                        <div className={styles.sourceActions}>
                          <Link id={`source-link-${source.id}`} href={`/projects/${encodeURIComponent(projectId)}/materials/sources/${encodeURIComponent(source.id)}?returnTo=${encodeURIComponent(buildMaterialsReturnTo(projectId, { status: itemStatus, search: sourceSearch, kind: sourceKind, page: sourcePage, focus: source.id }))}`} className={styles.detailAction}><UiText text={"查看详情"} /></Link>
                          <button type="button" onClick={() => void handleDeleteSource(source)} disabled={deletingSourceId !== null} className={styles.deleteAction} aria-label={`${translateUi("删除原始资料")} ${source.preview.slice(0, 24)}`}>{deletingSourceId === source.id ? <UiText text={"删除中…"} /> : <UiText text={"删除"} />}</button>
                        </div>
                      </li>
                    ))}
                  </ul>}
            {!sourceError ? <ListPagination {...sourcePagination} onPageChange={(page) => { replaceMaterialsQuery({ page }); }} disabled={isSourcesLoading} /> : null}
          </div>
        </div>
      </section> : null}

      {materialsView === "review" ? <><ProjectMaterialReviewQueue projectId={projectId} embedded onChanged={reloadProjectAndSources} /><section id="confirmed-facts" tabIndex={-1} aria-labelledby="items-heading" className="mt-6 scroll-mt-44 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm outline-none focus:ring-4 focus:ring-indigo-100 sm:p-8">
        <div className="flex flex-col gap-4 border-b border-slate-100 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600"><UiText text={"Confirmed facts"} /></p>
            <h2 id="items-heading" tabIndex={-1} className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 outline-none focus:ring-4 focus:ring-indigo-100"><UiText text={"已确认事实"} /></h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500"><UiText text={"查看 AI 自动整理和人工补充的事实，每条记录都能回溯原始资料；有冲突或不确定的内容单独进入待处理。"} /></p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">{isItemsLoading ? <UiText text={"读取中…"} /> : itemError ? <UiText text={"读取失败"} /> : `${itemCounts.confirmed} 已确认 · ${itemCounts.candidate} 待确认`}</span>
        </div>

        {itemError ? (
          <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert" aria-live="polite"><UiErrorText text={itemError} /></div>
        ) : null}
        {itemSuccess ? (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700" role="status" aria-live="polite"><UiText text={itemSuccess} /></div>
        ) : null}

        <OperationPanel title={isEditingItem ? translateUi("编辑事实") : translateUi("手动补充事实")} triggerLabel={isEditingItem ? "继续编辑事实" : "手动补充"} open={itemEditorOpen} onOpenChange={setItemEditorOpen} className="mt-6" description="自动整理后的事实可在下方查看；只有需要手动补充或纠正时才使用此操作区。">
          {itemError ? <p role="alert" className="mb-4 text-sm text-rose-700"><UiErrorText text={itemError} /></p> : null}
        <div className="grid min-w-0 items-stretch grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
          <form id="project-item-form" onSubmit={handleItemSubmit} className="min-w-0 max-w-full" aria-label={translateUi(isEditingItem ? "编辑事实候选" : "补充事实候选")}>
            <p className="mb-5 text-sm leading-6 text-slate-600">{isEditingItem ? <UiText text={"编辑后会回到待确认状态；原始资料归属保持不变。"} /> : <UiText text={"选择当前项目的原始资料，填写可以被原文精确支持的事实候选。"} />}</p>

            <label className="block text-sm font-medium text-slate-700" htmlFor="item-source"><UiText text={"Source"} />{" "}<span className="text-rose-600"><UiText text={"（必选）"} /></span></label>
              <select
              id="item-source"
              value={itemForm.sourceId}
              onChange={(event) => updateItemForm((current) => ({ ...current, sourceId: event.target.value }))}
              disabled={isEditingItem || isSavingItem || sourceOptions.length === 0}
              required
              className="mt-2 w-full min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
            >
                <option value=""><UiText text={"选择当前项目的原始资料"} /></option>
              {sourceOptions.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.kind} · {sourcePreview(source.preview).slice(0, 52)}
                </option>
              ))}
            </select>
            {isEditingItem ? <p className="mt-2 text-xs text-slate-500"><UiText text={"编辑时 Source 不可更换。"} /></p> : null}

            <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="item-type"><UiText text={"类型"} />{" "}<span className="text-rose-600"><UiText text={"（必选）"} /></span></label>
            <select
              id="item-type"
              value={itemForm.type}
              onChange={(event) => updateItemForm((current) => ({ ...current, type: event.target.value as ProjectItem["type"] }))}
              disabled={isSavingItem}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
            >
              {itemTypes.map((itemType) => <option key={itemType.value} value={itemType.value}>{itemType.label}</option>)}
            </select>

            <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="item-title"><UiText text={"标题"} />{" "}<span className="text-rose-600"><UiText text={"（必填）"} /></span></label>
            <input
              id="item-title"
              value={itemForm.title}
              onChange={(event) => updateItemForm((current) => ({ ...current, title: event.target.value }))}
              maxLength={160}
              required
              disabled={isSavingItem}
              placeholder={translateUi("例如：本周确定采用 cursor pagination")}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
            />

            <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="item-content"><UiText text={"内容"} />{" "}<span className="text-rose-600"><UiText text={"（必填）"} /></span></label>
            <textarea
              id="item-content"
              value={itemForm.content}
              onChange={(event) => updateItemForm((current) => ({ ...current, content: event.target.value }))}
              maxLength={20000}
              rows={5}
              required
              disabled={isSavingItem}
              placeholder={translateUi("描述事实、进展、问题或风险……")}
              className="mt-2 w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
            />

            <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="item-source-excerpt"><UiText text={"精确原文摘录"} />{" "}<span className="text-rose-600"><UiText text={"（必填）"} /></span></label>
            <textarea
              id="item-source-excerpt"
              value={itemForm.sourceExcerpt}
              onChange={(event) => updateItemForm((current) => ({ ...current, sourceExcerpt: event.target.value }))}
              maxLength={10000}
              rows={5}
              required
              disabled={isSavingItem}
              placeholder={translateUi("从下方所选 Source 原文复制一段完全一致的文字")}
              className="mt-2 w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-3 font-mono text-sm leading-6 text-slate-900 outline-none transition placeholder:font-sans placeholder:text-slate-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
            />

            <label className="mt-4 block text-sm font-medium text-slate-700" htmlFor="item-occurred-at"><UiText text={"发生时间"} />{" "}<span className="font-normal text-slate-500"><UiText text={"（可选）"} /></span></label>
            <input
              id="item-occurred-at"
              type="datetime-local"
              value={itemForm.occurredAt}
              onChange={(event) => updateItemForm((current) => ({ ...current, occurredAt: event.target.value }))}
              disabled={isSavingItem}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
            />

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="submit"
                disabled={isSavingItem || isItemsLoading || !itemForm.sourceId || sourceOptions.length === 0}
                className="app-action-button app-action-button--compact rounded-xl bg-indigo-600 font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSavingItem ? <UiText text={"保存中…"} /> : isEditingItem ? <UiText text={"保存编辑"} /> : <UiText text={"保存候选条目"} />}
              </button>
              {isEditingItem ? (
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  disabled={isSavingItem}
                  className="app-action-button app-action-button--compact rounded-xl border border-slate-200 bg-white font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <UiText text={"取消编辑"} /></button>
              ) : null}
            </div>
          </form>

          <div className="min-w-0 max-w-full rounded-2xl border border-indigo-100 bg-indigo-50/60 p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600"><UiText text={"Selected source"} /></p>
            <h3 className="mt-3 text-xl font-semibold tracking-tight text-slate-950"><UiText text={"所选原始资料"} /></h3>
            <p className="mt-2 text-sm leading-6 text-slate-600"><UiText text={"复制下方原文中的连续片段到“精确原文摘录”，服务端会验证它确实来自当前原始资料。"} /></p>
            {selectedSource && "contentText" in selectedSource ? (
              <div className="mt-5 min-w-0 max-w-full rounded-xl border border-indigo-100 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="rounded-full bg-indigo-100 px-2.5 py-1 font-semibold uppercase tracking-wide text-indigo-700">{selectedSource.kind}</span>
                  <span><UiText text={"接入于："} />{formatSourceDate(selectedSource.ingestedAt, language, translateUi)}</span>
                </div>
                <pre className="mt-4 min-w-0 max-w-full max-h-[34rem] overflow-auto whitespace-pre-wrap border-t border-slate-100 pt-4 text-sm leading-6 text-slate-700 [overflow-wrap:anywhere]">{selectedSource.contentText}</pre>
              </div>
            ) : selectedSource ? (
              <div className="mt-5 rounded-xl border border-dashed border-indigo-200 bg-white/70 px-5 py-10 text-center text-sm leading-6 text-slate-500">
                {isSourceDetailLoading ? <UiText text={"正在加载资料原文…"} /> : <UiText text={"正在准备资料原文…"} />}
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-indigo-200 bg-white/70 px-5 py-10 text-center text-sm leading-6 text-slate-500">
                {sources.length === 0 ? <UiText text={"请先在上方添加一条原始资料。"} /> : <UiText text={"请选择一条原始资料查看完整内容。"} />}
              </div>
            )}
          </div>
        </div>

        </OperationPanel>

        <div className="mt-10 border-t border-slate-100 pt-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400"><UiText text={"All project items"} /></p>
              <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-950"><UiText text={"事实与候选记录"} /></h3>
            </div>
            <span className="text-xs text-slate-400"><UiText text={"按最近更新时间排序"} /></span>
          </div>

          <div className="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-[minmax(0,1fr)_180px_180px]">
            <label><span className="sr-only"><UiText text={"搜索项目条目"} /></span><input value={itemSearch} onChange={(event) => { setItemSearch(event.target.value); setItemPage(1); }} placeholder={translateUi("搜索标题、内容或证据摘录")} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /></label>
            <label><span className="sr-only"><UiText text={"按条目类型筛选"} /></span><select value={itemType} onChange={(event) => { setItemType(event.target.value); setItemPage(1); }} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none focus:border-indigo-300"><option value="all"><UiText text={"全部类型"} /></option><option value="decision"><UiText text={"决策"} /></option><option value="progress"><UiText text={"进展"} /></option><option value="issue"><UiText text={"问题"} /></option><option value="risk"><UiText text={"风险"} /></option></select></label>
            <label><span className="sr-only"><UiText text={"按审核状态筛选"} /></span><select value={itemStatus} onChange={(event) => { replaceMaterialsQuery({ status: parseProjectItemReviewStatus(event.target.value) }); setItemPage(1); }} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none focus:border-indigo-300"><option value="all"><UiText text={"全部状态"} /></option><option value="candidate"><UiText text={"待确认"} /></option><option value="confirmed"><UiText text={"已确认"} /></option><option value="dismissed"><UiText text={"已驳回"} /></option><option value="superseded"><UiText text={"已替代"} /></option></select></label>
          </div>

          {isItemsLoading ? (
            <div className="mt-5 space-y-4" aria-label={translateUi("正在加载项目条目")}>
              {[1, 2].map((item) => <div key={item} className="h-56 animate-pulse rounded-2xl bg-slate-100" />)}
            </div>
          ) : itemError ? null : items.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center">
              <p className="text-sm font-medium text-slate-700">{itemSearch.trim() || itemType !== "all" || itemStatus !== "all" ? <UiText text={"没有匹配的项目条目"} /> : <UiText text={"还没有项目条目"} />}</p>
              <p className="mt-2 text-sm leading-6 text-slate-500">{itemSearch.trim() || itemType !== "all" || itemStatus !== "all" ? <UiText text={"调整关键词、类型或状态后重试。"} /> : <UiText text={"从上方选择原始资料并保存第一条决策、进展、问题或风险候选。"} />}</p>
            </div>
          ) : (
            <ul className="mt-5 space-y-4" aria-label={translateUi("全部项目条目列表")}>
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
          {!itemError ? <ListPagination {...itemPagination} onPageChange={setItemPage} disabled={isItemsLoading} /> : null}
        </div>
      </section></> : null}
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
  const { language } = useAppearance();
  const translateUi = useTranslate();
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
              <UiText text={itemTypeLabels[item.type]} />
            </span>
            <span className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold ${itemStatusClass(item.reviewStatus)}`}>
              <UiText text={itemStatusLabels[item.reviewStatus]} />
            </span>
            {item.aiCandidateClaim ? (
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[12px] font-semibold text-indigo-700">
                <UiText text={"AI 候选 ·"} />{" "}{item.aiCandidateClaim.reviewStatus === "candidate" ? <UiText text={"待审阅"} /> : item.aiCandidateClaim.reviewStatus === "accepted" ? <UiText text={"已接受"} /> : <UiText text={"已驳回"} />}
              </span>
            ) : null}
            {item.webAiCandidate ? (
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[12px] font-semibold text-indigo-700">
                <UiText text={"AI 整理 ·"} />{" "}{item.webAiCandidate.reviewStatus === "candidate" ? <UiText text={"待审阅"} /> : item.webAiCandidate.reviewStatus === "accepted" ? <UiText text={"已接受"} /> : <UiText text={"已驳回"} />}
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
              <UiText text={"编辑"} /></button>
            {item.reviewStatus === "candidate" ? (
              <>
                <button
                  type="button"
                  onClick={() => void onAction(item, "confirm")}
                  disabled={actionsDisabled}
                  className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isActionPending ? <UiText text={"处理中…"} /> : itemActionText("confirm")}
                </button>
                <button
                  type="button"
                  onClick={() => void onAction(item, "dismiss")}
                  disabled={actionsDisabled}
                  className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isActionPending ? <UiText text={"处理中…"} /> : itemActionText("dismiss")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void onAction(item, "reopen")}
                disabled={actionsDisabled}
                className="rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isActionPending ? <UiText text={"处理中…"} /> : itemActionText("reopen")}
              </button>
            )}
          </div>
        ) : (
          <span className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-400">
            {requiresAiWorkbench && item.reviewStatus === "candidate" ? <Link href={materialReviewHref} className="text-indigo-700 underline decoration-indigo-200 underline-offset-4 hover:text-indigo-900"><UiText text={"前往审核 AI 候选"} /></Link> : <UiText text={"只读"} />}
          </span>
        )}
      </div>

      <div className="mt-5 grid gap-4 border-t border-slate-100 pt-5 lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400"><UiText text={"精确原文摘录"} /></p>
          <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-indigo-200 pl-3 text-sm leading-6 text-slate-600">
            {item.sourceExcerpt || <UiText text={"未提供精确原文摘录"} />}
          </blockquote>
        </div>

        <dl className="grid gap-3 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-1">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400"><UiText text={"Source 链接"} /></dt>
            <dd className="mt-1 min-w-0">
              {item.source.externalRef ? (
                <a href={item.source.externalRef} target="_blank" rel="noopener noreferrer" className="block truncate text-indigo-600 underline decoration-indigo-200 underline-offset-4 hover:text-indigo-700" title={item.source.externalRef}>{item.source.externalRef}</a>
              ) : <UiText text={"未提供外部链接"} />}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400"><UiText text={"Source SHA-256"} /></dt>
            <dd className="mt-1 break-all font-mono text-xs leading-5 text-slate-600">{item.source.contentHash}</dd>
          </div>
        </dl>
      </div>

      <dl className="mt-5 grid gap-3 border-t border-slate-100 pt-5 text-xs text-slate-500 sm:grid-cols-3">
        <div><dt className="font-semibold uppercase tracking-[0.12em] text-slate-400"><UiText text={"发生时间"} /></dt><dd className="mt-1">{formatSourceDate(item.occurredAt, language, translateUi)}</dd></div>
        <div><dt className="font-semibold uppercase tracking-[0.12em] text-slate-400"><UiText text={"确认时间"} /></dt><dd className="mt-1">{formatSourceDate(item.confirmedAt, language, translateUi)}</dd></div>
        <div><dt className="font-semibold uppercase tracking-[0.12em] text-slate-400"><UiText text={"更新时间"} /></dt><dd className="mt-1">{formatSourceDate(item.updatedAt, language, translateUi)}</dd></div>
      </dl>
    </li>
  );
}

function ProjectShell({ children, username, projectId, isSystemAdmin }: { children: ReactNode; username: string; projectId: string; isSystemAdmin: boolean }) {
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="materials" isSystemAdmin={isSystemAdmin} />
      <div data-page-content className={styles.content}>{children}</div>
    </main>
  );
}
