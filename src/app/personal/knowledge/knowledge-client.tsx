"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { PersonalWorkspaceNav } from "@/components/personal-workspace-nav";

/** Keep list requests bounded and aligned with the service default page size. */
const PAGE_SIZE = 20;

/** A list item omits the body unless the search endpoint supplies an excerpt. */
type KnowledgeSummary = Readonly<{
  id: string;
  version: number;
  title: string;
  contentHash: string;
  byteCount: number;
  createdAt: string;
  updatedAt: string;
  revisionCreatedAt: string;
  excerpt?: string;
}>;

/** The current immutable revision returned by the document detail endpoint. */
type KnowledgeDocument = KnowledgeSummary & Readonly<{ content: string }>;

/** A historical revision list item contains metadata; its body is loaded on demand. */
type KnowledgeRevision = Readonly<{
  id: string;
  version: number;
  title: string;
  contentHash: string;
  byteCount: number;
  createdAt: string;
}>;

/** The single historical body returned by the version detail endpoint. */
type KnowledgeRevisionDetail = KnowledgeRevision & Readonly<{ content: string }>;

/** Form values are kept separate from the server document until the user saves. */
type KnowledgeDraft = Readonly<{ title: string; content: string }>;
/** The detail pane has one read-only state and two explicit write states. */
type EditorMode = "view" | "edit" | "create";
/** Formats exposed by the server export endpoint. */
type ExportFormat = "markdown" | "text";

const emptyDraft: KnowledgeDraft = { title: "", content: "" };

/** Keep server error details useful while hiding malformed or unexpected payloads. */
async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  const message = payload?.error?.message;
  if (typeof message === "string" && message.trim().length > 0) return message;
  const code = payload?.error?.code;
  if (code === "PERSONAL_KNOWLEDGE_VERSION_CONFLICT") return "内容已被其他页面更新，请刷新后再保存。";
  if (code === "PERSONAL_KNOWLEDGE_ACCOUNT_DISABLED") return "当前账号已停用，不能继续操作。";
  if (code === "PERSONAL_KNOWLEDGE_DOCUMENT_NOT_FOUND") return "内容不存在，或当前账号已不能访问。";
  if (code === "PERSONAL_KNOWLEDGE_INVALID_INPUT") return "标题或正文未通过校验，请检查输入。";
  return fallback;
}

/** Render server timestamps consistently while preserving a safe fallback. */
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Format stored UTF-8 byte evidence without implying binary precision. */
function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1_024) return `${Math.max(0, value)} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

/** Accept the current detail envelope and the legacy direct-document shape. */
function unwrapDocument(payload: unknown): KnowledgeDocument {
  const value = typeof payload === "object" && payload !== null && "document" in payload
    ? (payload as { document: KnowledgeDocument }).document
    : payload as KnowledgeDocument;
  return value;
}

/** Normalize an absent list or cursor to an empty first page. */
function unwrapList(payload: unknown): Readonly<{ documents: KnowledgeSummary[]; nextCursor: string | null }> {
  const value = payload as { documents?: KnowledgeSummary[]; nextCursor?: string | null };
  return { documents: value.documents ?? [], nextCursor: value.nextCursor ?? null };
}

/** Normalize revision history into the local bounded-page shape. */
function unwrapRevisions(payload: unknown): Readonly<{ revisions: KnowledgeRevision[]; nextCursor: string | null }> {
  const value = payload as { revisions?: KnowledgeRevision[]; nextCursor?: string | null };
  return { revisions: value.revisions ?? [], nextCursor: value.nextCursor ?? null };
}

/** Accept the revision detail envelope and its direct legacy shape. */
function unwrapRevision(payload: unknown): KnowledgeRevisionDetail {
  const value = typeof payload === "object" && payload !== null && "revision" in payload
    ? (payload as { revision: KnowledgeRevisionDetail }).revision
    : payload as KnowledgeRevisionDetail;
  return value;
}

/** Distinguish an intentional request cancellation from a user-facing failure. */
function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

/** Read a safe server supplied download name and fall back on malformed encoding. */
function filenameFromDisposition(header: string | null, fallback: string): string {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return fallback;
    }
  }
  const plain = header?.match(/filename="?([^";]+)"?/iu)?.[1];
  return plain ?? fallback;
}

/**
 * Manage owner scoped text documents without requiring a project. Cursor
 * history is kept locally so the UI can move backward without guessing an
 * offset for a document list that may change between requests.
 */
export function KnowledgeClient({ username, isSystemAdmin = false }: { username: string; isSystemAdmin?: boolean }) {
  const [documents, setDocuments] = useState<KnowledgeSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [draft, setDraft] = useState<KnowledgeDraft>(emptyDraft);
  const [mode, setMode] = useState<EditorMode>("view");
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [revisions, setRevisions] = useState<KnowledgeRevision[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyNextCursor, setHistoryNextCursor] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDocumentId, setHistoryDocumentId] = useState<string | null>(null);
  const [expandedRevisionVersion, setExpandedRevisionVersion] = useState<number | null>(null);
  const [revisionContent, setRevisionContent] = useState<Readonly<{ documentId: string; documentVersion: number; revision: KnowledgeRevisionDetail }> | null>(null);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();

  /**
   * Every request has a token and, where supported, an AbortController. A
   * response must pass both checks before it can write state for the current
   * document; aborting alone is insufficient because a fetch may already have
   * resolved while a selection change is being committed.
   */
  const selectedIdRef = useRef<string | null>(null);
  const documentRef = useRef<KnowledgeDocument | null>(null);
  const listRequestRef = useRef<{ token: number; controller: AbortController } | null>(null);
  const detailRequestRef = useRef<{ token: number; controller: AbortController } | null>(null);
  const historyRequestRef = useRef<{ token: number; controller: AbortController } | null>(null);
  const revisionRequestRef = useRef<{ token: number; controller: AbortController } | null>(null);
  const mutationTokenRef = useRef(0);
  const requestTokenRef = useRef(0);

  /** Keep React state and the request-race ref on the same selected document. */
  function setSelectedDocumentId(nextId: string | null): void {
    selectedIdRef.current = nextId;
    setSelectedId(nextId);
  }

  /** Keep the mutation-time document ref aligned with the rendered document. */
  function setCurrentDocument(nextDocument: KnowledgeDocument | null): void {
    documentRef.current = nextDocument;
    setDocument(nextDocument);
  }

  /** Cancel list work and advance its token before changing list criteria. */
  function invalidateListRequest(): void {
    listRequestRef.current?.controller.abort();
    listRequestRef.current = null;
    requestTokenRef.current += 1;
  }

  /** Cancel the current detail request before the selected document changes. */
  function invalidateDetailRequest(): void {
    detailRequestRef.current?.controller.abort();
    detailRequestRef.current = null;
    requestTokenRef.current += 1;
  }

  /** Clear one expanded historical body and invalidate its in-flight request. */
  function clearRevisionState(): void {
    revisionRequestRef.current?.controller.abort();
    revisionRequestRef.current = null;
    setExpandedRevisionVersion(null);
    setRevisionContent(null);
    setRevisionLoading(false);
    setRevisionError(null);
  }

  /** Reset revision history when the selected document context changes. */
  function clearHistoryState(): void {
    historyRequestRef.current?.controller.abort();
    historyRequestRef.current = null;
    clearRevisionState();
    setRevisions([]);
    setHistoryNextCursor(null);
    setHistoryError(null);
    setHistoryDocumentId(null);
    setHistoryOpen(false);
    setHistoryLoading(false);
  }

  /** Prevent an older save/delete/export completion from updating current state. */
  function invalidateMutationRequests(): void {
    mutationTokenRef.current += 1;
    // Navigation invalidates pending writes as well as their disabled states.
    setSaving(false);
    setDeleting(false);
    setExporting(null);
  }

  /** Return the detail pane to a known state before selection or mode changes. */
  function clearDetailState(nextMode: EditorMode = "view"): void {
    invalidateDetailRequest();
    clearHistoryState();
    setCurrentDocument(null);
    setDraft(emptyDraft);
    setMode(nextMode);
    setDetailLoading(false);
  }

  const loadDocuments = useCallback(async () => {
    listRequestRef.current?.controller.abort();
    const request = { token: ++requestTokenRef.current, controller: new AbortController() };
    listRequestRef.current = request;
    setListLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (searchQuery) params.set("query", searchQuery);
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/personal/knowledge?${params.toString()}`, { cache: "no-store", signal: request.controller.signal });
      if (!response.ok) throw new Error(await readError(response, "个人知识加载失败"));
      const result = unwrapList(await response.json());
      if (listRequestRef.current?.token !== request.token || request.controller.signal.aborted) return;
      setDocuments(result.documents);
      setNextCursor(result.nextCursor);
      setListError(null);
      const currentSelectedId = selectedIdRef.current;
      const nextSelectedId = currentSelectedId && result.documents.some((item) => item.id === currentSelectedId)
        ? currentSelectedId
        : result.documents[0]?.id ?? null;
      if (nextSelectedId !== currentSelectedId) {
        mutationTokenRef.current += 1;
        detailRequestRef.current?.controller.abort();
        detailRequestRef.current = null;
        historyRequestRef.current?.controller.abort();
        historyRequestRef.current = null;
        revisionRequestRef.current?.controller.abort();
        revisionRequestRef.current = null;
        documentRef.current = null;
        setDocument(null);
        setDraft(emptyDraft);
        setMode("view");
        setDetailLoading(false);
        setRevisions([]);
        setHistoryNextCursor(null);
        setHistoryError(null);
        setHistoryDocumentId(null);
        setHistoryOpen(false);
        setHistoryLoading(false);
        setExpandedRevisionVersion(null);
        setRevisionContent(null);
        setRevisionLoading(false);
        setRevisionError(null);
        setSaving(false);
        setDeleting(false);
        setExporting(null);
      }
      setSelectedDocumentId(nextSelectedId);
    } catch (cause) {
      if (request.controller.signal.aborted || isAbortError(cause) || listRequestRef.current?.token !== request.token) return;
      setListError(cause instanceof Error ? cause.message : "个人知识加载失败");
    } finally {
      if (listRequestRef.current?.token === request.token) {
        listRequestRef.current = null;
        setListLoading(false);
      }
    }
  }, [cursor, searchQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDocuments(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDocuments]);

  const loadDocument = useCallback(async (documentId: string) => {
    detailRequestRef.current?.controller.abort();
    const request = { token: ++requestTokenRef.current, controller: new AbortController() };
    detailRequestRef.current = request;
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/personal/knowledge/${encodeURIComponent(documentId)}`, { cache: "no-store", signal: request.controller.signal });
      if (!response.ok) throw new Error(await readError(response, "内容加载失败"));
      const next = unwrapDocument(await response.json());
      if (detailRequestRef.current?.token !== request.token || request.controller.signal.aborted || selectedIdRef.current !== documentId) return;
      setCurrentDocument(next);
      setDraft({ title: next.title, content: next.content });
      setMode("view");
      setRevisions([]);
      setHistoryNextCursor(null);
      setHistoryError(null);
      setHistoryDocumentId(null);
      setHistoryOpen(false);
      clearRevisionState();
      setMessage(null);
    } catch (cause) {
      if (request.controller.signal.aborted || isAbortError(cause) || detailRequestRef.current?.token !== request.token || selectedIdRef.current !== documentId) return;
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "内容加载失败" });
    } finally {
      if (detailRequestRef.current?.token === request.token) {
        detailRequestRef.current = null;
        setDetailLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (selectedId === null) return;
    const timer = window.setTimeout(() => void loadDocument(selectedId), 0);
    return () => window.clearTimeout(timer);
  }, [loadDocument, selectedId]);

  useEffect(() => () => {
    listRequestRef.current?.controller.abort();
    detailRequestRef.current?.controller.abort();
    historyRequestRef.current?.controller.abort();
    revisionRequestRef.current?.controller.abort();
  }, []);

  /** Start a fresh cursor chain for the submitted search text. */
  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    invalidateListRequest();
    invalidateMutationRequests();
    setSearchQuery(search.trim());
    setCursor(null);
    setCursorStack([]);
    setSelectedDocumentId(null);
    clearDetailState();
  }

  /** Advance one keyset page while retaining the cursor needed to go back. */
  function goNext(): void {
    if (!nextCursor) return;
    invalidateListRequest();
    invalidateMutationRequests();
    setCursorStack((current) => [...current, cursor ?? ""]);
    setCursor(nextCursor);
    setSelectedDocumentId(null);
    clearDetailState();
  }

  /** Restore the previous cursor from the local navigation stack. */
  function goPrevious(): void {
    const previous = cursorStack.at(-1);
    if (previous === undefined) return;
    invalidateListRequest();
    invalidateMutationRequests();
    setCursorStack((current) => current.slice(0, -1));
    setCursor(previous || null);
    setSelectedDocumentId(null);
    clearDetailState();
  }

  /** Open a blank draft after invalidating requests tied to the old selection. */
  function startCreate(): void {
    invalidateMutationRequests();
    setSelectedDocumentId(null);
    clearDetailState("create");
    setDraft(emptyDraft);
    setMessage(null);
  }

  /** Select a list row and reset detail state before its request begins. */
  function selectDocument(documentId: string): void {
    if (documentId === selectedIdRef.current && mode === "view") return;
    invalidateMutationRequests();
    setSelectedDocumentId(documentId);
    clearDetailState();
    setMode("view");
    setMessage(null);
  }

  /** Create or revise a document using the currently rendered version fence. */
  async function saveDraft(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (draft.title.trim().length === 0 || draft.content.trim().length === 0) {
      setMessage({ tone: "error", text: "请填写标题和正文。" });
      return;
    }
    const isCreate = mode === "create";
    const target = documentRef.current;
    const targetId = selectedIdRef.current;
    if (!isCreate && (target === null || targetId !== target.id)) {
      setMessage({ tone: "error", text: "当前内容还没有完成加载，请重新选择后再保存。" });
      return;
    }
    const mutationToken = ++mutationTokenRef.current;
    const requestDraft = draft;
    setSaving(true);
    setMessage(null);
    try {
      const endpoint = isCreate ? "/api/personal/knowledge" : `/api/personal/knowledge/${encodeURIComponent(target!.id)}`;
      const body = isCreate ? requestDraft : { ...requestDraft, expectedVersion: target!.version };
      const response = await fetch(endpoint, {
        method: isCreate ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await readError(response, isCreate ? "内容创建失败" : "内容保存失败"));
      const next = unwrapDocument(await response.json());
      if (mutationTokenRef.current !== mutationToken || (!isCreate && selectedIdRef.current !== targetId)) return;
      setCurrentDocument(next);
      setDraft({ title: next.title, content: next.content });
      setSelectedDocumentId(next.id);
      setMode("view");
      clearHistoryState();
      setMessage({ tone: "success", text: isCreate ? "个人知识已创建。" : "个人知识已保存为新版本。" });
      await loadDocuments();
    } catch (cause) {
      if (mutationTokenRef.current !== mutationToken) return;
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "内容保存失败" });
    } finally {
      if (mutationTokenRef.current === mutationToken) setSaving(false);
    }
  }

  /** Confirm and soft-delete the current document with optimistic concurrency. */
  async function deleteDocument(): Promise<void> {
    const target = documentRef.current;
    const targetId = selectedIdRef.current;
    if (target === null || targetId !== target.id || deleting) return;
    const result = await confirm({
      eyebrow: "Delete personal knowledge",
      title: `删除「${target.title}」？`,
      description: "删除后内容会从个人知识列表隐藏，历史版本也不会再从普通页面打开。此操作不能恢复。",
      confirmLabel: "确认删除",
      tone: "danger",
    });
    if (!result.confirmed) return;
    if (selectedIdRef.current !== targetId || documentRef.current?.id !== targetId || documentRef.current.version !== target.version) {
      setMessage({ tone: "error", text: "当前内容已经变化，请重新选择后再删除。" });
      return;
    }
    const mutationToken = ++mutationTokenRef.current;
    setDeleting(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/personal/knowledge/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ expectedVersion: target.version }),
      });
      if (!response.ok) throw new Error(await readError(response, "内容删除失败"));
      if (mutationTokenRef.current !== mutationToken || selectedIdRef.current !== targetId) return;
      setSelectedDocumentId(null);
      clearDetailState();
      setMessage({ tone: "success", text: "个人知识已删除。" });
      await loadDocuments();
    } catch (cause) {
      if (mutationTokenRef.current !== mutationToken) return;
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "内容删除失败" });
    } finally {
      if (mutationTokenRef.current === mutationToken) setDeleting(false);
    }
  }

  /** Load one bounded revision page for the currently selected document. */
  async function loadHistory(cursorValue: string | null = null, append = false): Promise<void> {
    const target = documentRef.current;
    const targetId = selectedIdRef.current;
    if (target === null || targetId !== target.id) return;
    historyRequestRef.current?.controller.abort();
    const request = { token: ++requestTokenRef.current, controller: new AbortController() };
    historyRequestRef.current = request;
    setHistoryLoading(true);
    setHistoryOpen(true);
    setHistoryError(null);
    if (!append) {
      clearRevisionState();
      setRevisions([]);
      setHistoryNextCursor(null);
      setHistoryDocumentId(targetId);
    }
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursorValue) params.set("cursor", cursorValue);
      const response = await fetch(`/api/personal/knowledge/${encodeURIComponent(target.id)}/revisions?${params.toString()}`, {
        cache: "no-store",
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error(await readError(response, "版本历史加载失败"));
      const result = unwrapRevisions(await response.json());
      if (historyRequestRef.current?.token !== request.token || request.controller.signal.aborted || selectedIdRef.current !== targetId || documentRef.current?.id !== targetId || documentRef.current.version !== target.version) return;
      setRevisions((current) => append ? [...current, ...result.revisions] : result.revisions);
      setHistoryNextCursor(result.nextCursor);
      setHistoryDocumentId(targetId);
      setHistoryOpen(true);
      if (!append) {
        clearRevisionState();
      }
    } catch (cause) {
      if (request.controller.signal.aborted || isAbortError(cause) || historyRequestRef.current?.token !== request.token) return;
      setHistoryError(cause instanceof Error ? cause.message : "版本历史加载失败");
    } finally {
      if (historyRequestRef.current?.token === request.token) {
        historyRequestRef.current = null;
        setHistoryLoading(false);
      }
    }
  }

  /** Fetch one historical body only after the user expands its metadata row. */
  async function loadRevisionBody(revisionVersion: number): Promise<void> {
    const target = documentRef.current;
    const targetId = selectedIdRef.current;
    if (target === null || targetId !== target.id || historyDocumentId !== targetId) return;
    revisionRequestRef.current?.controller.abort();
    const request = { token: ++requestTokenRef.current, controller: new AbortController() };
    revisionRequestRef.current = request;
    setExpandedRevisionVersion(revisionVersion);
    setRevisionContent(null);
    setRevisionError(null);
    setRevisionLoading(true);
    try {
      const response = await fetch(`/api/personal/knowledge/${encodeURIComponent(target.id)}/revisions/${revisionVersion}`, {
        cache: "no-store",
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error(await readError(response, "版本正文加载失败"));
      const revision = unwrapRevision(await response.json());
      if (revisionRequestRef.current?.token !== request.token || request.controller.signal.aborted || selectedIdRef.current !== targetId || documentRef.current?.id !== targetId || documentRef.current.version !== target.version || historyDocumentId !== targetId) return;
      setRevisionContent({ documentId: targetId, documentVersion: target.version, revision });
    } catch (cause) {
      if (request.controller.signal.aborted || isAbortError(cause) || revisionRequestRef.current?.token !== request.token) return;
      setRevisionError(cause instanceof Error ? cause.message : "版本正文加载失败");
    } finally {
      if (revisionRequestRef.current?.token === request.token) {
        revisionRequestRef.current = null;
        setRevisionLoading(false);
      }
    }
  }

  /** Collapse the active revision or expand and load the requested version. */
  function toggleRevision(revisionVersion: number): void {
    if (expandedRevisionVersion === revisionVersion) {
      if (revisionError) {
        void loadRevisionBody(revisionVersion);
        return;
      }
      clearRevisionState();
      return;
    }
    void loadRevisionBody(revisionVersion);
  }

  /** Request an audited export and download the exact fenced response body. */
  async function exportDocument(format: ExportFormat): Promise<void> {
    const target = documentRef.current;
    const targetId = selectedIdRef.current;
    if (target === null || targetId !== target.id || exporting !== null) return;
    const mutationToken = ++mutationTokenRef.current;
    setExporting(format);
    setMessage(null);
    try {
      const response = await fetch(`/api/personal/knowledge/${encodeURIComponent(target.id)}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ expectedVersion: target.version, format }),
      });
      if (!response.ok) throw new Error(await readError(response, "内容导出失败"));
      const blob = await response.blob();
      if (mutationTokenRef.current !== mutationToken || selectedIdRef.current !== targetId || documentRef.current?.version !== target.version) return;
      const fallback = `personal-knowledge-${target.id.slice(0, 8)}.${format === "markdown" ? "md" : "txt"}`;
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = filenameFromDisposition(response.headers.get("content-disposition"), fallback);
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage({ tone: "success", text: `${format === "markdown" ? "Markdown" : "纯文本"}文件已导出。` });
    } catch (cause) {
      if (mutationTokenRef.current !== mutationToken) return;
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "内容导出失败" });
    } finally {
      if (mutationTokenRef.current === mutationToken) setExporting(null);
    }
  }

  const pageNumber = cursorStack.length + 1;
  const editing = mode === "edit" || mode === "create";

  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={username} active="personalKnowledge" isSystemAdmin={isSystemAdmin} />
      <PersonalWorkspaceNav active="knowledge" />
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10 lg:pt-10">
        <section className="rounded-[2rem] bg-slate-950 px-7 py-9 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-11">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Personal workspace</p>
          <div className="mt-3 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">个人知识</h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">这里属于你的个人工作区。无需创建项目即可保存、搜索和维护纯文本或 Markdown 知识；以后再按项目需要建立联动。</p>
            </div>
            <div className="grid gap-2 text-xs text-slate-300 sm:grid-cols-3 lg:w-[34rem]">
              <div className="rounded-2xl border border-white/10 bg-white/[0.07] px-4 py-3">无需项目</div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.07] px-4 py-3">纯文本版本</div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.07] px-4 py-3">随时导出</div>
            </div>
          </div>
        </section>

        {message ? <div role={message.tone === "error" ? "alert" : "status"} className={`mt-5 rounded-2xl px-5 py-4 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{message.text}</div> : null}

        <div className="mt-7 grid gap-6 xl:grid-cols-[minmax(300px,.76fr)_minmax(0,1.24fr)]">
          <section className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Knowledge list</p>
                <h2 className="mt-2 text-2xl font-semibold">我的内容</h2>
              </div>
              <button type="button" onClick={startCreate} className="shrink-0 rounded-xl bg-indigo-600 px-3.5 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-500">新建内容</button>
            </div>

            <form onSubmit={submitSearch} className="mt-5 flex gap-2">
              <label className="min-w-0 flex-1">
                <span className="sr-only">搜索个人知识</span>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或正文" maxLength={240} className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" />
              </label>
              <button type="submit" className="rounded-xl border border-slate-200 px-3.5 py-2.5 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700">搜索</button>
            </form>

            {listError ? <div role="alert" className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><p>{listError}</p><button type="button" onClick={() => void loadDocuments()} className="mt-2 font-semibold underline">重新加载</button></div> : null}
            {listLoading ? <div className="mt-5 space-y-3" aria-label="正在加载个人知识"><div className="h-20 animate-pulse rounded-2xl bg-slate-100" /><div className="h-20 animate-pulse rounded-2xl bg-slate-100" /><div className="h-20 animate-pulse rounded-2xl bg-slate-100" /></div> : documents.length === 0 ? <EmptyList searchQuery={searchQuery} onCreate={startCreate} /> : <div className="mt-5 space-y-2">{documents.map((item) => <button key={item.id} type="button" onClick={() => selectDocument(item.id)} className={`block w-full rounded-2xl border p-4 text-left transition ${item.id === selectedId && mode !== "create" ? "border-indigo-300 bg-indigo-50/60 ring-2 ring-indigo-100" : "border-slate-200 hover:border-indigo-200 hover:bg-slate-50"}`}><div className="flex items-start justify-between gap-3"><h3 className="min-w-0 truncate text-sm font-semibold text-slate-800">{item.title}</h3><span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-500">v{item.version}</span></div><p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{item.excerpt ?? `已保存 ${formatBytes(item.byteCount)}，点击查看正文。`}</p><p className="mt-2 text-xs text-slate-400">更新于 {formatDate(item.updatedAt)}</p></button>)}</div>}

            {documents.length > 0 ? <nav className="mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4" aria-label="个人知识分页"><span className="text-xs text-slate-400">第 {pageNumber} 页</span><div className="flex gap-2"><button type="button" onClick={goPrevious} disabled={cursorStack.length === 0 || listLoading} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">上一页</button><button type="button" onClick={goNext} disabled={!nextCursor || listLoading} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-40">下一页</button></div></nav> : null}
          </section>

          <section className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-7">
            {editing ? <EditorForm mode={mode} draft={draft} saving={saving} onDraftChange={setDraft} onCancel={() => { if (document) { setDraft({ title: document.title, content: document.content }); setMode("view"); } else { setMode("view"); } }} onSubmit={saveDraft} /> : detailLoading ? <div className="space-y-4" aria-label="正在加载内容"><div className="h-7 w-2/3 animate-pulse rounded bg-slate-100" /><div className="h-4 w-1/3 animate-pulse rounded bg-slate-100" /><div className="h-72 animate-pulse rounded-2xl bg-slate-100" /></div> : document ? <DocumentDetail document={document} revisions={revisions} historyOpen={historyOpen} historyLoading={historyLoading} historyNextCursor={historyNextCursor} historyError={historyError} expandedRevisionVersion={expandedRevisionVersion} revisionContent={revisionContent} revisionLoading={revisionLoading} revisionError={revisionError} exporting={exporting} deleting={deleting} onEdit={() => { setDraft({ title: document.title, content: document.content }); setMode("edit"); }} onDelete={() => void deleteDocument()} onExport={(format) => void exportDocument(format)} onHistory={() => { if (historyOpen) clearHistoryState(); else void loadHistory(); }} onReloadHistory={() => void loadHistory()} onLoadMoreHistory={() => { if (historyNextCursor) void loadHistory(historyNextCursor, true); }} onToggleRevision={toggleRevision} /> : <EmptyDetail onCreate={startCreate} />}
          </section>
        </div>
      </div>
      {dialog}
    </main>
  );
}

/** Explain an empty list or search result and preserve the create entry point. */
function EmptyList({ searchQuery, onCreate }: { searchQuery: string; onCreate: () => void }): React.JSX.Element {
  return <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-700">{searchQuery ? "没有匹配的个人知识" : "还没有个人知识"}</p><p className="mt-2 text-xs leading-5 text-slate-500">{searchQuery ? "换一个关键词，或清空搜索后查看全部内容。" : "无需创建项目，先把想法、资料摘要或规则保存下来。"}</p>{!searchQuery ? <button type="button" onClick={onCreate} className="mt-4 rounded-lg bg-slate-950 px-3.5 py-2 text-xs font-semibold text-white">创建第一条</button> : null}</div>;
}

/** Render the neutral detail state before a document has been selected. */
function EmptyDetail({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return <div className="flex min-h-[28rem] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 px-6 py-12 text-center"><span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-100 text-2xl text-indigo-700">✦</span><h2 className="mt-5 text-xl font-semibold text-slate-800">选择一条内容开始</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">个人知识独立于项目存在。可以先独立整理，之后再决定是否把它带入项目工作流。</p><button type="button" onClick={onCreate} className="mt-5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500">新建个人知识</button></div>;
}

/** Shared create/edit form with bounded fields and explicit pending state. */
function EditorForm({ mode, draft, saving, onDraftChange, onCancel, onSubmit }: { mode: "edit" | "create"; draft: KnowledgeDraft; saving: boolean; onDraftChange: (draft: KnowledgeDraft) => void; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }): React.JSX.Element {
  return <form onSubmit={onSubmit} className="space-y-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">{mode === "create" ? "New note" : "Edit note"}</p><h2 className="mt-2 text-2xl font-semibold">{mode === "create" ? "新建个人知识" : "编辑个人知识"}</h2></div><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-500">纯文本 / Markdown</span></div><p className="rounded-2xl bg-indigo-50 px-4 py-3 text-xs leading-5 text-indigo-800">内容只归属于当前个人工作区，不需要先创建项目。保存后会保留版本历史。</p><label className="block text-sm font-semibold text-slate-700">标题<input value={draft.title} onChange={(event) => onDraftChange({ ...draft, title: event.target.value })} required maxLength={240} placeholder="例如：产品想法与待验证假设" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /></label><label className="block text-sm font-semibold text-slate-700">正文<textarea value={draft.content} onChange={(event) => onDraftChange({ ...draft, content: event.target.value })} required maxLength={100000} rows={18} placeholder="记录你的知识、摘要、规则或下一步想法……" className="mt-2 min-h-[20rem] w-full resize-y rounded-xl border border-slate-200 px-4 py-3 text-sm leading-6 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /><span className="mt-1 block text-right text-xs font-normal text-slate-400">{draft.content.length.toLocaleString("zh-CN")} / 100,000 字符</span></label><div className="flex flex-wrap justify-end gap-3"><button type="button" onClick={onCancel} disabled={saving} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 disabled:opacity-50">取消</button><button type="submit" disabled={saving} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">{saving ? "保存中…" : mode === "create" ? "创建内容" : "保存新版本"}</button></div></form>;
}

type DocumentDetailProps = Readonly<{
  document: KnowledgeDocument;
  revisions: KnowledgeRevision[];
  historyOpen: boolean;
  historyLoading: boolean;
  historyNextCursor: string | null;
  historyError: string | null;
  expandedRevisionVersion: number | null;
  revisionContent: Readonly<{ documentId: string; documentVersion: number; revision: KnowledgeRevisionDetail }> | null;
  revisionLoading: boolean;
  revisionError: string | null;
  exporting: ExportFormat | null;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onExport: (format: ExportFormat) => void;
  onHistory: () => void;
  onReloadHistory: () => void;
  onLoadMoreHistory: () => void;
  onToggleRevision: (version: number) => void;
}>;

/** Present the current document, its immutable history, and owner actions. */
function DocumentDetail({
  document,
  revisions,
  historyOpen,
  historyLoading,
  historyNextCursor,
  historyError,
  expandedRevisionVersion,
  revisionContent,
  revisionLoading,
  revisionError,
  exporting,
  deleting,
  onEdit,
  onDelete,
  onExport,
  onHistory,
  onReloadHistory,
  onLoadMoreHistory,
  onToggleRevision,
}: DocumentDetailProps): React.JSX.Element {
  return (
    <article>
      <div className="flex flex-col gap-4 border-b border-slate-100 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Personal document</p>
          <h2 className="mt-2 break-words text-2xl font-semibold tracking-[-0.02em]">{document.title}</h2>
          <p className="mt-2 text-xs text-slate-400">版本 {document.version} · {formatBytes(document.byteCount)} · 更新于 {formatDate(document.updatedAt)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" onClick={onEdit} className="rounded-xl bg-indigo-600 px-3.5 py-2.5 text-xs font-semibold text-white transition hover:bg-indigo-500">编辑</button>
          <button type="button" onClick={onDelete} disabled={deleting} className="rounded-xl border border-rose-200 px-3.5 py-2.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:opacity-50">{deleting ? "删除中…" : "删除"}</button>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onExport("markdown")} disabled={exporting !== null} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-50">{exporting === "markdown" ? "导出中…" : "导出 Markdown"}</button>
        <button type="button" onClick={() => onExport("text")} disabled={exporting !== null} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-50">{exporting === "text" ? "导出中…" : "导出纯文本"}</button>
        <button type="button" onClick={onHistory} disabled={historyLoading} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-50">{historyLoading ? "读取历史中…" : historyOpen ? "收起版本历史" : "查看版本历史"}</button>
      </div>

      <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/70 px-5 py-5">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-slate-700">{document.content}</pre>
      </div>

      {historyOpen ? (
        <section className="mt-6 border-t border-slate-100 pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">版本历史</h3>
              <p className="mt-1 text-xs text-slate-500">历史列表只读取元数据，展开版本时再读取正文。</p>
            </div>
            <span className="text-xs text-slate-400">{revisions.length} 个版本</span>
          </div>

          {historyError ? <div role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><p>{historyError}</p><button type="button" onClick={onReloadHistory} className="mt-2 font-semibold underline">重新加载历史</button></div> : null}
          {historyLoading && revisions.length === 0 ? <p className="mt-4 rounded-xl bg-slate-50 px-4 py-4 text-sm text-slate-500">正在读取版本历史…</p> : null}
          {!historyLoading && !historyError && revisions.length === 0 ? <p className="mt-4 rounded-xl bg-slate-50 px-4 py-4 text-sm text-slate-500">暂时没有版本记录。</p> : null}

          {revisions.length > 0 ? <div className="mt-4 space-y-3">
            {revisions.map((revision) => {
              const isExpanded = expandedRevisionVersion === revision.version;
              const loadedBody = isExpanded
                && revisionContent?.documentId === document.id
                && revisionContent.documentVersion === document.version
                && revisionContent.revision.version === revision.version
                ? revisionContent.revision
                : null;
              return <div key={revision.id} className="rounded-2xl border border-slate-200 bg-white">
                <button type="button" aria-expanded={isExpanded} onClick={() => onToggleRevision(revision.version)} className="block w-full cursor-pointer px-4 py-3 text-left">
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold text-slate-700">版本 {revision.version} · {revision.title}</span><span className="text-xs text-slate-400">{formatDate(revision.createdAt)} · {formatBytes(revision.byteCount)}</span></div>
                </button>
                {isExpanded ? <div className="border-t border-slate-100 px-4 py-4">
                  {revisionLoading && loadedBody === null ? <p className="text-xs text-slate-500">正在读取版本正文…</p> : null}
                  {revisionError && loadedBody === null ? <div role="alert" className="text-xs text-rose-700"><p>{revisionError}</p><button type="button" onClick={() => onToggleRevision(revision.version)} className="mt-2 font-semibold underline">重新读取正文</button></div> : null}
                  {loadedBody ? <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-6 text-slate-600">{loadedBody.content}</pre> : null}
                </div> : null}
              </div>;
            })}
          </div> : null}

          {historyNextCursor ? <button type="button" onClick={onLoadMoreHistory} disabled={historyLoading} className="mt-4 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{historyLoading ? "读取中…" : "加载更多版本"}</button> : null}
        </section>
      ) : null}
    </article>
  );
}
