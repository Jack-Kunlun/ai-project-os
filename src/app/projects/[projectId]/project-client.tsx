"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { isProjectSnapshotStale } from "@/lib/project-snapshot-stale";
import type { SnapshotRecord } from "@/lib/project-snapshot";

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
    kind: "document" | "screenshot" | "github" | "git" | "web" | "manual" | "mcp";
    externalRef: string | null;
    contentHash: string;
    capturedAt: string | null;
    ingestedAt: string;
  };
};

type ProjectSource = {
  id: string;
  kind: "document" | "screenshot" | "github" | "git" | "web" | "manual" | "mcp";
  externalRef: string | null;
  contentText: string;
  contentHash: string;
  capturedAt: string | null;
  ingestedAt: string;
};

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

type ErrorPayload = {
  error?: { message?: string };
};

const labels = {
  sources: { title: "Sources", subtitle: "项目资料来源", icon: "01" },
  items: { title: "Items", subtitle: "事实与判断条目", icon: "02" },
  snapshots: { title: "Snapshot", subtitle: "项目当前状态", icon: "03" },
} as const;

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
  try {
    const payload = (await response.json()) as ErrorPayload;
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function getProject(projectId: string): Promise<Project> {
  const response = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
  const payload = (await response.json()) as { project?: Project; error?: { message?: string } };
  if (!response.ok || !payload.project) {
    throw new Error(payload.error?.message ?? "项目加载失败");
  }
  return payload.project;
}

async function getSources(projectId: string): Promise<ProjectSource[]> {
  const response = await fetch(`/api/projects/${projectId}/sources`, { cache: "no-store" });
  const payload = (await response.json()) as { sources?: ProjectSource[]; error?: { message?: string } };
  if (!response.ok || !payload.sources) {
    throw new Error(payload.error?.message ?? "项目资料加载失败");
  }
  return payload.sources;
}

async function getItems(projectId: string): Promise<ProjectItem[]> {
  const response = await fetch(`/api/projects/${projectId}/items`, { cache: "no-store" });
  const payload = (await response.json()) as { items?: ProjectItem[]; error?: { message?: string } };
  if (!response.ok || !payload.items) {
    throw new Error(payload.error?.message ?? "项目条目加载失败");
  }
  return payload.items;
}

async function getSnapshot(projectId: string): Promise<SnapshotRecord | null> {
  const response = await fetch(`/api/projects/${projectId}/snapshots`, { cache: "no-store" });
  const payload = (await response.json()) as { snapshot?: SnapshotRecord | null; error?: { message?: string } };
  if (!response.ok || !("snapshot" in payload)) {
    throw new Error(payload.error?.message ?? "项目快照加载失败");
  }
  return payload.snapshot ?? null;
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

export function ProjectDetailClient({ username }: { username: string }) {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [sources, setSources] = useState<ProjectSource[]>([]);
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceSuccess, setSourceSuccess] = useState<string | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [itemSuccess, setItemSuccess] = useState<string | null>(null);
  const [isSourcesLoading, setIsSourcesLoading] = useState(true);
  const [isItemsLoading, setIsItemsLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<SnapshotRecord | null>(null);
  const [isSnapshotLoading, setIsSnapshotLoading] = useState(true);
  const [isGeneratingSnapshot, setIsGeneratingSnapshot] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotSuccess, setSnapshotSuccess] = useState<string | null>(null);
  const [isCreatingSource, setIsCreatingSource] = useState(false);
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null);
  const [isSavingItem, setIsSavingItem] = useState(false);
  const [itemActionId, setItemActionId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [sourceContent, setSourceContent] = useState("");
  const [sourceExternalRef, setSourceExternalRef] = useState("");
  const [sourceCapturedAt, setSourceCapturedAt] = useState("");
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
    if (!projectId) return;

    let cancelled = false;

    void getProject(projectId)
      .then((loadedProject) => {
        if (!cancelled) setProject(loadedProject);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "项目加载失败");
      });

    void getSources(projectId)
      .then((loadedSources) => {
        if (!cancelled) {
          setSources(loadedSources);
          setItemForm((current) => ({
            ...current,
            sourceId: current.sourceId && loadedSources.some((source) => source.id === current.sourceId)
              ? current.sourceId
              : loadedSources[0]?.id ?? "",
          }));
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setSourceError(loadError instanceof Error ? loadError.message : "项目资料加载失败");
      })
      .finally(() => {
        if (!cancelled) setIsSourcesLoading(false);
      });

    void getItems(projectId)
      .then((loadedItems) => {
        if (!cancelled) setItems(loadedItems);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setItemError(loadError instanceof Error ? loadError.message : "项目条目加载失败");
      })
      .finally(() => {
        if (!cancelled) setIsItemsLoading(false);
      });

    void getSnapshot(projectId)
      .then((loadedSnapshot) => {
        if (!cancelled) setSnapshot(loadedSnapshot);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setSnapshotError(loadError instanceof Error ? loadError.message : "项目快照加载失败");
      })
      .finally(() => {
        if (!cancelled) setIsSnapshotLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function reloadProjectAndSources(): Promise<void> {
    if (!projectId) return;

    setIsSourcesLoading(true);
    setIsItemsLoading(true);
    setIsSnapshotLoading(true);
    const [projectResult, sourcesResult, itemsResult, snapshotResult] = await Promise.allSettled([
      getProject(projectId),
      getSources(projectId),
      getItems(projectId),
      getSnapshot(projectId),
    ]);

    if (projectResult.status === "fulfilled") {
      setProject(projectResult.value);
      setError(null);
    } else {
      setError(projectResult.reason instanceof Error ? projectResult.reason.message : "项目加载失败");
    }

    if (sourcesResult.status === "fulfilled") {
      setSources(sourcesResult.value);
      setItemForm((current) => ({
        ...current,
        sourceId: current.sourceId && sourcesResult.value.some((source) => source.id === current.sourceId)
          ? current.sourceId
          : sourcesResult.value[0]?.id ?? "",
      }));
      setSourceError(null);
    } else {
      setSourceError(sourcesResult.reason instanceof Error ? sourcesResult.reason.message : "项目资料加载失败");
    }

    if (itemsResult.status === "fulfilled") {
      setItems(itemsResult.value);
      setItemError(null);
    } else {
      setItemError(itemsResult.reason instanceof Error ? itemsResult.reason.message : "项目条目加载失败");
    }

    if (snapshotResult.status === "fulfilled") {
      setSnapshot(snapshotResult.value);
      setSnapshotError(null);
    } else {
      setSnapshotError(snapshotResult.reason instanceof Error ? snapshotResult.reason.message : "项目快照加载失败");
    }

    setIsSourcesLoading(false);
    setIsItemsLoading(false);
    setIsSnapshotLoading(false);
  }

  async function handleSourceSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !sourceContent.trim()) return;

    let capturedAt: string | undefined;
    if (sourceCapturedAt) {
      const capturedDate = new Date(sourceCapturedAt);
      if (Number.isNaN(capturedDate.getTime())) {
        setSourceError("资料时间格式无效");
        setSourceSuccess(null);
        return;
      }
      capturedAt = capturedDate.toISOString();
    }

    setIsCreatingSource(true);
    setSourceError(null);
    setSourceSuccess(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contentText: sourceContent,
          externalRef: sourceExternalRef,
          capturedAt,
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response, "资料保存失败"));
      }

      setSourceContent("");
      setSourceExternalRef("");
      setSourceCapturedAt("");
      await reloadProjectAndSources();
      setSourceSuccess("候选资料已保存。");
    } catch (createError) {
      setSourceError(createError instanceof Error ? createError.message : "资料保存失败");
    } finally {
      setIsCreatingSource(false);
    }
  }

  async function handleDeleteSource(source: ProjectSource) {
    if (!projectId || deletingSourceId) return;
    if (!window.confirm("这会永久删除这条候选资料，且仅适用于尚未被 Item 引用的来源。确定继续吗？")) return;

    setDeletingSourceId(source.id);
    setSourceError(null);
    setSourceSuccess(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/sources/${source.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(await readError(response, "资料删除失败"));
      }

      await reloadProjectAndSources();
      setSourceSuccess("候选资料已删除。");
    } catch (deleteError) {
      setSourceError(deleteError instanceof Error ? deleteError.message : "资料删除失败");
    } finally {
      setDeletingSourceId(null);
    }
  }

  function handleEditItem(item: ProjectItem) {
    if (item.reviewStatus === "superseded" || itemActionId || isSavingItem) return;

    setItemError(null);
    setItemSuccess(null);
    setEditingItemId(item.id);
    setItemForm({
      type: item.type,
      sourceId: item.sourceId,
      title: item.title,
      content: item.content,
      sourceExcerpt: item.sourceExcerpt ?? "",
      occurredAt: toDateTimeLocal(item.occurredAt),
      expectedUpdatedAt: item.updatedAt,
    });
  }

  function handleCancelEdit() {
    setEditingItemId(null);
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

  async function handleItemSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || isSavingItem) return;

    if (!itemForm.sourceId) {
      setItemError("请先接入并选择一条 Source，再保存 Item。");
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
    if (!projectId || itemActionId || isSavingItem || editingItemId) return;

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
    } catch (actionError) {
      setItemError(actionError instanceof Error ? actionError.message : "条目状态更新失败");
    } finally {
      setItemActionId(null);
    }
  }

  async function handleGenerateSnapshot() {
    if (!projectId || isGeneratingSnapshot || isSnapshotLoading || confirmedItems.length === 0) return;

    setIsGeneratingSnapshot(true);
    setSnapshotError(null);
    setSnapshotSuccess(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/snapshots`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new Error(await readError(response, "快照生成失败"));
      }

      const payload = (await response.json()) as { snapshot?: SnapshotRecord };
      if (!payload.snapshot) {
        throw new Error("快照生成响应无效");
      }

      setSnapshot(payload.snapshot);
      setSnapshotSuccess("最新快照已生成，内容按本次确认状态固定保存。");
      await reloadProjectAndSources();
    } catch (generationError) {
      setSnapshotError(generationError instanceof Error ? generationError.message : "快照生成失败");
    } finally {
      setIsGeneratingSnapshot(false);
    }
  }

  const selectedSource = sources.find((source) => source.id === itemForm.sourceId) ?? null;
  const isEditingItem = editingItemId !== null;
  const confirmedItems = items.filter((item) => item.reviewStatus === "confirmed");

  if (error) {
    return <ProjectShell username={username} projectId={projectId}><div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">{error}</div></ProjectShell>;
  }

  if (!project) {
    return <ProjectShell username={username} projectId={projectId}><div className="h-40 animate-pulse rounded-3xl bg-slate-100" aria-label="正在加载项目" /></ProjectShell>;
  }

  return (
    <ProjectShell username={username} projectId={projectId}>
      <div className="flex flex-col gap-6 border-b border-slate-200/80 pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href="/projects" className="text-sm font-medium text-indigo-600 hover:text-indigo-700">← 返回项目列表</Link>
          <p className="mt-8 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Project workspace</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-slate-950">{project.name}</h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">{project.description || "项目描述尚未补充。先接入来源，再人工创建并确认条目，最后手动生成可追溯快照。"}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2"><Link href={`/projects/${projectId}/control`} className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700">智能控制台</Link><Link href={`/projects/${projectId}/memory`} className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700">智能记忆</Link><Link href={`/projects/${projectId}/intelligence`} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-500">项目智能体</Link></div>
      </div>

      <section className="mt-8 grid gap-4 md:grid-cols-3">
        <PlaceholderCard {...labels.sources} count={project._count.sources} detail="已接入人工候选资料；内容仍需后续确认，不等同于可信事实。" />
        <PlaceholderCard {...labels.items} count={project._count.items} detail="可人工创建、编辑并确认条目；每条 Item 都保留 Source 追溯。" />
        <PlaceholderCard {...labels.snapshots} count={project._count.snapshots} detail="历史快照保留在数据库；页面只展示最新一份，并标注是否需要手动重新生成。" />
      </section>

      <SnapshotPanel
        snapshot={snapshot}
        snapshotCount={project._count.snapshots}
        currentConfirmedItems={confirmedItems}
        isLoading={isSnapshotLoading}
        isGenerating={isGeneratingSnapshot}
        error={snapshotError}
        success={snapshotSuccess}
        onGenerate={() => void handleGenerateSnapshot()}
      />

      <section aria-labelledby="sources-heading" className="mt-10 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 border-b border-slate-100 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Source intake</p>
            <h2 id="sources-heading" className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">项目资料</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">手工接入原始候选资料，保留精确内容与 SHA-256，供人工创建条目时引用和追溯。</p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">{isSourcesLoading ? "读取中…" : `${sources.length} 条候选资料`}</span>
        </div>

        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900" role="note">
          <strong className="font-semibold">安全提示：</strong>这里只保存候选资料，不代表已确认的事实或 AI 摘要。不要录入密码、Token、私密连接串，也不要使用带凭据的 URL。
        </div>

        {sourceError ? (
          <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert">{sourceError}</div>
        ) : null}
        {sourceSuccess ? (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700" role="status" aria-live="polite">{sourceSuccess}</div>
        ) : null}

        <div className="mt-8 grid gap-8 lg:grid-cols-[0.72fr_1.28fr]">
          <form onSubmit={handleSourceSubmit} className="rounded-2xl bg-slate-950 p-6 text-white shadow-lg shadow-slate-950/10" aria-labelledby="source-form-heading">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Manual source</p>
            <h3 id="source-form-heading" className="mt-3 text-xl font-semibold tracking-tight">接入一条候选资料</h3>

            <label className="mt-6 block text-sm font-medium text-slate-200" htmlFor="source-external-ref">来源链接 <span className="font-normal text-slate-500">（可选）</span></label>
            <input
              id="source-external-ref"
              type="url"
              value={sourceExternalRef}
              onChange={(event) => setSourceExternalRef(event.target.value)}
              placeholder="https://example.com/document"
              maxLength={2048}
              autoComplete="url"
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30"
            />

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="source-captured-at">资料时间 <span className="font-normal text-slate-500">（可选）</span></label>
            <input
              id="source-captured-at"
              type="datetime-local"
              value={sourceCapturedAt}
              onChange={(event) => setSourceCapturedAt(event.target.value)}
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition [color-scheme:dark] focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30"
            />

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="source-content">原始资料内容 <span className="text-rose-300">（必填）</span></label>
            <textarea
              id="source-content"
              value={sourceContent}
              onChange={(event) => setSourceContent(event.target.value)}
              placeholder="粘贴项目日报、会议记录或其他原始资料……"
              maxLength={100000}
              rows={10}
              required
              className="mt-2 w-full resize-y rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30"
            />
            <p className="mt-2 text-xs leading-5 text-slate-500">保留原文空格与换行；内容预览只做确定性截取，不会生成摘要。</p>
            <button
              type="submit"
              disabled={isCreatingSource || !sourceContent.trim()}
              className="mt-5 flex w-full items-center justify-center rounded-xl bg-indigo-400 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCreatingSource ? "保存中…" : "保存候选资料"}
            </button>
          </form>

          <div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Traceable inputs</p>
                <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">已接入资料</h3>
              </div>
              <span className="text-xs text-slate-400">按最近接入排序</span>
            </div>

            {isSourcesLoading ? (
              <div className="mt-5 space-y-3" aria-label="正在加载项目资料">
                {[1, 2].map((item) => <div key={item} className="h-40 animate-pulse rounded-2xl bg-slate-100" />)}
              </div>
            ) : sources.length === 0 ? (
              <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center">
                <p className="text-sm font-medium text-slate-700">还没有候选资料</p>
                <p className="mt-2 text-sm leading-6 text-slate-500">从左侧接入第一条原始内容，之后可以在这里查看精确 hash 与原文。</p>
              </div>
            ) : (
              <ul className="mt-5 space-y-4" aria-label="项目候选资料列表">
                {sources.map((source) => (
                  <li key={source.id} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-700">{source.kind}</span>
                        <span className="text-xs text-slate-500">资料时间：{formatSourceDate(source.capturedAt)}</span>
                        <span className="text-xs text-slate-400">接入于：{formatSourceDate(source.ingestedAt)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleDeleteSource(source)}
                        disabled={deletingSourceId !== null}
                        className="shrink-0 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={`删除候选资料 ${sourcePreview(source.contentText).slice(0, 24)}`}
                      >
                        {deletingSourceId === source.id ? "删除中…" : "删除"}
                      </button>
                    </div>

                    {source.externalRef ? (
                      <a href={source.externalRef} target="_blank" rel="noopener noreferrer" className="mt-4 block truncate text-sm font-medium text-indigo-600 underline decoration-indigo-200 underline-offset-4 hover:text-indigo-700" title={source.externalRef}>
                        {source.externalRef}
                      </a>
                    ) : (
                      <p className="mt-4 text-sm text-slate-400">未提供外部链接</p>
                    )}

                    <p className="mt-4 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">内容预览（非 AI 摘要）</p>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{sourcePreview(source.contentText)}</p>

                    <details className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
                      <summary className="cursor-pointer text-sm font-medium text-slate-700">查看原文</summary>
                      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-slate-100 pt-3 text-sm leading-6 text-slate-600">{source.contentText}</pre>
                    </details>

                    <div className="mt-4 border-t border-slate-200 pt-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">SHA-256</p>
                      <code className="mt-2 block break-all text-xs leading-5 text-slate-600">{source.contentHash}</code>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="items-heading" className="mt-10 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
        <div className="flex flex-col gap-4 border-b border-slate-100 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Item review</p>
            <h2 id="items-heading" className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">项目条目</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">手工记录 decision、progress、issue 或 risk，并通过精确原文摘录回溯到当前项目 Source。</p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">{isItemsLoading ? "读取中…" : `${items.length} 条条目`}</span>
        </div>

        {itemError ? (
          <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert" aria-live="polite">{itemError}</div>
        ) : null}
        {itemSuccess ? (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700" role="status" aria-live="polite">{itemSuccess}</div>
        ) : null}

        <div className="mt-8 grid gap-8 lg:grid-cols-[0.78fr_1.22fr]">
          <form onSubmit={handleItemSubmit} className="rounded-2xl bg-slate-950 p-6 text-white shadow-lg shadow-slate-950/10" aria-labelledby="item-form-heading">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Manual item</p>
            <h3 id="item-form-heading" className="mt-3 text-xl font-semibold tracking-tight text-white">{isEditingItem ? "编辑项目条目" : "新增项目条目"}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-400">{isEditingItem ? "编辑后条目会回到待确认状态；Source 归属保持不变。" : "先选择当前项目的 Source，再填写可以被原文精确支持的条目。"}</p>

            <label className="mt-6 block text-sm font-medium text-slate-200" htmlFor="item-source">Source <span className="text-rose-300">（必选）</span></label>
            <select
              id="item-source"
              value={itemForm.sourceId}
              onChange={(event) => setItemForm((current) => ({ ...current, sourceId: event.target.value }))}
              disabled={isEditingItem || isSavingItem || sources.length === 0}
              required
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition [color-scheme:dark] focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="" className="bg-slate-950">选择当前项目的 Source</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id} className="bg-slate-950">
                  {source.kind} · {sourcePreview(source.contentText).slice(0, 52)}
                </option>
              ))}
            </select>
            {isEditingItem ? <p className="mt-2 text-xs text-slate-500">编辑时 Source 不可更换。</p> : null}

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="item-type">类型 <span className="text-rose-300">（必选）</span></label>
            <select
              id="item-type"
              value={itemForm.type}
              onChange={(event) => setItemForm((current) => ({ ...current, type: event.target.value as ProjectItem["type"] }))}
              disabled={isSavingItem}
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition [color-scheme:dark] focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {itemTypes.map((itemType) => <option key={itemType.value} value={itemType.value} className="bg-slate-950">{itemType.label}</option>)}
            </select>

            <label className="mt-4 block text-sm font-medium text-slate-200" htmlFor="item-title">标题 <span className="text-rose-300">（必填）</span></label>
            <input
              id="item-title"
              value={itemForm.title}
              onChange={(event) => setItemForm((current) => ({ ...current, title: event.target.value }))}
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
              onChange={(event) => setItemForm((current) => ({ ...current, content: event.target.value }))}
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
              onChange={(event) => setItemForm((current) => ({ ...current, sourceExcerpt: event.target.value }))}
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
              onChange={(event) => setItemForm((current) => ({ ...current, occurredAt: event.target.value }))}
              disabled={isSavingItem}
              className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none transition [color-scheme:dark] focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/30 disabled:cursor-not-allowed disabled:opacity-60"
            />

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                type="submit"
                disabled={isSavingItem || isItemsLoading || !itemForm.sourceId || sources.length === 0}
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

          <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Selected source</p>
            <h3 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">所选 Source 原文</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">复制下方原文中的连续片段到“精确原文摘录”，服务端会验证它确实来自当前 Source。</p>
            {selectedSource ? (
              <div className="mt-5 rounded-xl border border-indigo-100 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="rounded-full bg-indigo-100 px-2.5 py-1 font-semibold uppercase tracking-wide text-indigo-700">{selectedSource.kind}</span>
                  <span>接入于：{formatSourceDate(selectedSource.ingestedAt)}</span>
                </div>
                <pre className="mt-4 max-h-[34rem] overflow-auto whitespace-pre-wrap break-words border-t border-slate-100 pt-4 text-sm leading-6 text-slate-700">{selectedSource.contentText}</pre>
              </div>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-indigo-200 bg-white/70 px-5 py-10 text-center text-sm leading-6 text-slate-500">
                {sources.length === 0 ? "请先在上方项目资料区域接入 Source。" : "请选择一条 Source 查看原文。"}
              </div>
            )}
          </div>
        </div>

        <div className="mt-10 border-t border-slate-100 pt-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">All project items</p>
              <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">全部项目条目</h3>
            </div>
            <span className="text-xs text-slate-400">按最近更新时间排序</span>
          </div>

          {isItemsLoading ? (
            <div className="mt-5 space-y-4" aria-label="正在加载项目条目">
              {[1, 2].map((item) => <div key={item} className="h-56 animate-pulse rounded-2xl bg-slate-100" />)}
            </div>
          ) : items.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center">
              <p className="text-sm font-medium text-slate-700">还没有项目条目</p>
              <p className="mt-2 text-sm leading-6 text-slate-500">从上方选择 Source 并保存第一条 decision、progress、issue 或 risk。</p>
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
                  onEdit={handleEditItem}
                  onAction={handleItemAction}
                />
              ))}
            </ul>
          )}
        </div>
      </section>
    </ProjectShell>
  );
}

function ItemCard({
  item,
  itemActionId,
  isSavingItem,
  editingItemId,
  onEdit,
  onAction,
}: {
  item: ProjectItem;
  itemActionId: string | null;
  isSavingItem: boolean;
  editingItemId: string | null;
  onEdit: (item: ProjectItem) => void;
  onAction: (item: ProjectItem, action: ItemAction) => void;
}) {
  const isActionPending = itemActionId === item.id;
  const actionsDisabled = Boolean(itemActionId) || isSavingItem || editingItemId !== null;
  const requiresAiWorkbench =
    item.aiCandidateClaim !== null || item.webAiCandidate?.reviewStatus === "candidate";

  return (
    <li className={`rounded-2xl border p-5 ${item.reviewStatus === "superseded" ? "border-slate-200 bg-slate-50/70" : "border-slate-200 bg-white"}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${itemTypeClass(item.type)}`}>
              {item.type} · {itemTypeLabels[item.type]}
            </span>
            <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${itemStatusClass(item.reviewStatus)}`}>
              {itemStatusLabels[item.reviewStatus]}
            </span>
            {item.aiCandidateClaim ? (
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700">
                AI 候选 · {item.aiCandidateClaim.reviewStatus === "candidate" ? "待审阅" : item.aiCandidateClaim.reviewStatus === "accepted" ? "已接受" : "已驳回"}
              </span>
            ) : null}
            {item.webAiCandidate ? (
              <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700">
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
              onClick={() => onEdit(item)}
              disabled={actionsDisabled}
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
            {requiresAiWorkbench && item.reviewStatus === "candidate" ? "请在 AI 工作台审阅" : "只读"}
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

function SnapshotPanel({
  snapshot,
  snapshotCount,
  currentConfirmedItems,
  isLoading,
  isGenerating,
  error,
  success,
  onGenerate,
}: {
  snapshot: SnapshotRecord | null;
  snapshotCount: number;
  currentConfirmedItems: ProjectItem[];
  isLoading: boolean;
  isGenerating: boolean;
  error: string | null;
  success: string | null;
  onGenerate: () => void;
}) {
  const hasConfirmedItems = currentConfirmedItems.length > 0;
  const isStale = snapshot ? isProjectSnapshotStale(snapshot.payload, currentConfirmedItems) : false;
  const sectionDefinitions = [
    { key: "decisions" as const, label: "决策", english: "Decisions" },
    { key: "progress" as const, label: "进展", english: "Progress" },
    { key: "issues" as const, label: "问题", english: "Issues" },
    { key: "risks" as const, label: "风险", english: "Risks" },
  ];

  return (
    <section aria-labelledby="snapshot-heading" className="mt-10 rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-8">
      <div className="flex flex-col gap-5 border-b border-slate-100 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Project snapshot</p>
          <h2 id="snapshot-heading" className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">最新项目快照</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">快照只组装已确认 Item，并保存为本次读取点的不可变历史状态；不会自动生成或做优先级判断。</p>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">该快照始终只展示人工确认状态；AI 候选在人工接受前不会进入项目事实。</p>
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={isLoading || isGenerating || !hasConfirmedItems}
          className="shrink-0 rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isGenerating ? "生成中…" : "生成最新快照"}
        </button>
      </div>

      <div className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50/70 px-5 py-4 text-sm leading-6 text-indigo-900" role="note">
        {!hasConfirmedItems
          ? snapshot
            ? "当前没有已确认 Item，不能生成新的当前状态。页面中的旧 Snapshot 仅表示过去的读取点；请先在 Items 中核对并确认至少一条内容，再生成新的 Snapshot。"
            : "当前没有已确认 Item，不能生成当前状态。请先在项目条目中确认至少一条内容，之后才能生成快照。"
          : snapshot
            ? "生成快照不会覆盖历史记录；页面只展示最新一份，更新确认内容后需要手动重新生成。"
            : "当前已有已确认 Item，但还没有快照。点击右上角按钮生成第一份项目状态。"}
      </div>

      {error ? <div className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700" role="alert">{error}</div> : null}
      {success ? <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700" role="status" aria-live="polite">{success}</div> : null}

      {isLoading ? (
        <div className="mt-6 space-y-4" aria-label="正在加载项目快照">
          <div className="h-28 animate-pulse rounded-2xl bg-slate-100" />
          <div className="h-48 animate-pulse rounded-2xl bg-slate-100" />
        </div>
      ) : snapshot ? (
        <div className="mt-7">
          {isStale ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900" role="status">
              <p><strong className="font-semibold">这份旧 Snapshot 只是历史读取点。</strong> 当前已确认 Item 与它不一致（可能新增、移除或重新确认了 Item），不能把它当作当前项目状态。</p>
              <ol className="mt-3 list-decimal space-y-1 pl-5">
                <li><a href="#items-heading" className="font-semibold text-amber-950 underline decoration-amber-400 underline-offset-4">前往 Items 编辑区域</a>，编辑后的条目会回到待确认状态。</li>
                <li>核对对应 Source 的原文摘录，确认修正后的内容确实被原文支持。</li>
                <li>重新确认条目，再点击“生成最新快照”读取新的当前状态。</li>
              </ol>
              <p className="mt-3">系统不会自动覆盖历史快照，也不会调用 LLM 判断优先级。</p>
            </div>
          ) : null}

          <div className="mt-5 flex flex-col gap-3 border-b border-slate-100 pb-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-xl font-semibold tracking-tight text-slate-950">截至 {formatSourceDate(snapshot.payload.readAt)} 的已确认项目状态</h3>
              <p className="mt-2 text-sm text-slate-500">生成于 {formatSourceDate(snapshot.generatedAt)} · 已保留 {snapshotCount} 份历史快照 · 本份确认 Item {snapshot.payload.counts.confirmed} 条</p>
            </div>
            <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">读取点：{formatSourceDate(snapshot.payload.readAt)}</span>
          </div>

          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/80 p-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">Focus</p>
                <h4 className="mt-2 text-lg font-semibold text-slate-950">已确认问题与风险</h4>
              </div>
              <span className="rounded-full bg-white/80 px-3 py-1.5 text-xs font-medium text-amber-800">{snapshot.payload.counts.focus} 条</span>
            </div>
            <p className="mt-3 text-sm leading-6 text-amber-900">按 Issues 后 Risks 的确定性顺序展示，不表示优先级，也不是 AI 判断。</p>
            {snapshot.payload.focus.itemIds.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-amber-300 bg-white/60 px-4 py-5 text-sm text-amber-800">本次快照没有已确认的问题或风险。</p>
            ) : (
              <div className="mt-4 space-y-4">
                {[...snapshot.payload.sections.issues, ...snapshot.payload.sections.risks].map((item) => <SnapshotItemCard key={item.id} item={item} />)}
              </div>
            )}
          </div>

          <div className="mt-6 grid gap-5 xl:grid-cols-2">
            {sectionDefinitions.map((section) => {
              const sectionItems = snapshot.payload.sections[section.key];
              return (
                <section key={section.key} aria-labelledby={`snapshot-${section.key}-heading`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">{section.english}</p>
                      <h4 id={`snapshot-${section.key}-heading`} className="mt-1 text-lg font-semibold text-slate-950">{section.label}</h4>
                    </div>
                    <span className="rounded-full bg-white px-3 py-1.5 text-xs font-medium text-slate-600">{sectionItems.length} 条</span>
                  </div>
                  {sectionItems.length === 0 ? (
                    <p className="mt-4 rounded-xl border border-dashed border-slate-200 bg-white px-4 py-5 text-sm text-slate-500">本次没有已确认的{section.label}。</p>
                  ) : (
                    <div className="mt-4 space-y-4">{sectionItems.map((item) => <SnapshotItemCard key={item.id} item={item} />)}</div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center">
          {hasConfirmedItems ? (
            <>
              <p className="text-sm font-medium text-slate-700">已有 {currentConfirmedItems.length} 条已确认 Item，但还没有快照</p>
              <p className="mt-2 text-sm leading-6 text-slate-500">生成快照后，这些已确认状态会按照当前读取点固定保存，并继续保留 Source 追溯。</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-slate-700">还没有可生成的项目状态</p>
              <p className="mt-2 text-sm leading-6 text-slate-500">先创建并确认至少一条 Item，再回来生成 Snapshot。</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SnapshotItemCard({ item }: { item: SnapshotRecord["payload"]["sections"]["decisions"][number] }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-indigo-700">{item.type}</span>
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">已确认</span>
      </div>
      <h5 className="mt-3 text-base font-semibold tracking-tight text-slate-950">{item.title}</h5>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{item.content}</p>

      <div className="mt-4 border-t border-slate-100 pt-4">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">精确原文摘录</p>
        <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-indigo-200 pl-3 text-sm leading-6 text-slate-600">{item.provenance.sourceExcerpt}</blockquote>
      </div>

      <dl className="mt-4 grid gap-3 border-t border-slate-100 pt-4 text-xs text-slate-500 sm:grid-cols-2">
        <div><dt className="font-semibold uppercase tracking-[0.12em] text-slate-400">发生时间</dt><dd className="mt-1">{formatSourceDate(item.occurredAt)}</dd></div>
        <div><dt className="font-semibold uppercase tracking-[0.12em] text-slate-400">确认时间</dt><dd className="mt-1">{formatSourceDate(item.confirmedAt)}</dd></div>
        <div>
          <dt className="font-semibold uppercase tracking-[0.12em] text-slate-400">Source 链接</dt>
          <dd className="mt-1 min-w-0">{item.provenance.externalRef ? <a href={item.provenance.externalRef} target="_blank" rel="noopener noreferrer" className="block truncate text-indigo-600 underline decoration-indigo-200 underline-offset-4 hover:text-indigo-700" title={item.provenance.externalRef}>{item.provenance.externalRef}</a> : "未提供外部链接"}</dd>
        </div>
        <div><dt className="font-semibold uppercase tracking-[0.12em] text-slate-400">Source SHA-256</dt><dd className="mt-1 break-all font-mono text-xs leading-5 text-slate-600">{item.provenance.contentHash}</dd></div>
      </dl>
    </article>
  );
}

function ProjectShell({ children, username, projectId }: { children: ReactNode; username: string; projectId: string }) {
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="overview" />
      <div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
        <div className="py-10">{children}</div>
      </div>
    </main>
  );
}

function PlaceholderCard({ title, subtitle, icon, count, detail }: { title: string; subtitle: string; icon: string; count: number; detail: string }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-xs font-semibold text-slate-500">{icon}</span>
        <span className="text-3xl font-semibold tracking-tight text-slate-950">{count}</span>
      </div>
      <h2 className="mt-8 text-lg font-semibold text-slate-950">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
      <p className="mt-5 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-400">{detail}</p>
    </div>
  );
}
