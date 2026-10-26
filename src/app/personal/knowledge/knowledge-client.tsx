"use client";
import { UiFeedbackText, UiErrorText } from "@/components/ui-error-text";


import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AppHeader } from "@/components/app-header";
import { UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import { ShellIcon } from "@/components/shell-icon";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { useInquiryOperation } from "@/components/inquiry-operation";
import { PersonalWorkspaceNav } from "@/components/personal-workspace-nav";
import { PARENT_PAGE_LINK_CLASS_NAME } from "@/components/parent-page-link";
import { buildPersonalKnowledgeHistoryHref, PersonalKnowledgeQaPanel } from "./personal-knowledge-qa-panel";
import { PersonalKnowledgeNextSteps } from "./personal-knowledge-next-steps";
const PersonalProjectSearchPanel = dynamic(() => import("./personal-project-search-panel").then(module => module.PersonalProjectSearchPanel), { loading: () => <p role="status"><UiText text="正在加载…" /></p> });
const PersonalSemanticIndexPanel = dynamic(() => import("./personal-semantic-index-panel").then(module => module.PersonalSemanticIndexPanel), { loading: () => <p role="status"><UiText text="正在加载…" /></p> });
const PersonalSemanticSearchPanel = dynamic(() => import("./personal-semantic-search-panel").then(module => module.PersonalSemanticSearchPanel), { loading: () => <p role="status"><UiText text="正在加载…" /></p> });
import { PersonalKnowledgeEditor, validateKnowledgeDraft, type KnowledgeDraft } from "./personal-knowledge-editor";
import styles from "./personal-knowledge.module.css";

/** Keep list requests bounded and aligned with the service default page size. */
const PAGE_SIZE = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Accept only a document identifier before using the owner-scoped detail API. */
function parseDocumentQuery(value: string | null): string | null {
  return value !== null && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/** A list item omits the body unless the search endpoint supplies an excerpt. */
type KnowledgeSummary = Readonly<{
  id: string;
  version: number;
  isDefaultMemory: boolean;
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

/** The detail pane has one read-only state and two explicit write states. */
type EditorMode = "view" | "edit" | "create";
type WorkspaceSection = "library" | "search";
type LibraryScreen = "list" | "view";
type KnowledgeFilter = "all" | "memory";
type KnowledgeModal = "editor" | "import" | null;
type SearchTool = "semantic" | "index" | "project";
type VisionProviderOption = Readonly<{
  id: string;
  name: string;
  modelId: string;
  billingMode: "platform" | "byok";
  quotaMultiplierBps: number | null;
  isDefault: boolean;
}>;
/** Formats exposed by the server export endpoint. */
type ExportFormat = "markdown" | "text";

const emptyDraft: KnowledgeDraft = { title: "", content: "", isDefaultMemory: false };

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
function formatDate(value: string, language: "zh-CN" | "en"): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (language === "en" ? "Unknown time" : "时间未知") : new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
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
  const { language } = useAppearance();
  const t = useTranslate();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedDocumentId = parseDocumentQuery(searchParams.get("document"));
  const [acceptedDocumentId, setAcceptedDocumentId] = useState(requestedDocumentId);
  const requestedDocumentIdRef = useRef(requestedDocumentId);
  const acceptedDocumentIdRef = useRef(requestedDocumentId);
  const [documents, setDocuments] = useState<KnowledgeSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [knowledgeFilter, setKnowledgeFilter] = useState<KnowledgeFilter>("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [draft, setDraft] = useState<KnowledgeDraft>(emptyDraft);
  const [mode, setMode] = useState<EditorMode>("view");
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>("library");
  const [libraryScreen, setLibraryScreen] = useState<LibraryScreen>(requestedDocumentId === null ? "list" : "view");
  const createFromQueryHandled = useRef(false);
  const startCreateRef = useRef<() => void>(() => {});
  const [knowledgeModal, setKnowledgeModalState] = useState<KnowledgeModal>(null);
  const [queryReconcileVersion, setQueryReconcileVersion] = useState(0);
  const [searchTool, setSearchTool] = useState<SearchTool>("semantic");
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [forcePdfVision, setForcePdfVision] = useState(false);
  const [visionProviders, setVisionProviders] = useState<readonly VisionProviderOption[]>([]);
  const [visionProviderId, setVisionProviderId] = useState("");
  const [visionProviderLoadState, setVisionProviderLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [visionProviderLoadError, setVisionProviderLoadError] = useState<string | null>(null);
  const [visionProviderReloadToken, setVisionProviderReloadToken] = useState(0);
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
  const knowledgeDialogRef = useRef<HTMLDialogElement | null>(null);
  const detailDialogRef = useRef<HTMLDialogElement | null>(null);
  const detailDialogOpen = libraryScreen === "view" && workspaceSection === "library";
  useInquiryOperation(detailDialogOpen, detailDialogRef);
  useInquiryOperation(knowledgeModal !== null, knowledgeDialogRef);
  const knowledgeModalRef = useRef<KnowledgeModal>(null);
  const modalReturnScreenRef = useRef<LibraryScreen>("list");
  const detailHistoryEntryRef = useRef(false);

  const editorDirty = mode === "create"
    ? draft.title !== emptyDraft.title || draft.content !== emptyDraft.content || draft.isDefaultMemory !== emptyDraft.isDefaultMemory
    : mode === "edit" && document !== null && (draft.title !== document.title || draft.content !== document.content || draft.isDefaultMemory !== document.isDefaultMemory);

  useEffect(() => {
    if (!editorDirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [editorDirty]);

  useEffect(() => {
    if (knowledgeModal !== "import") return;
    const controller = new AbortController();
    void fetch("/api/personal/knowledge/vision-providers", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response, "视觉模型列表加载失败"));
        return await response.json() as { providers: VisionProviderOption[] };
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const providers = payload.providers;
        setVisionProviders(providers);
        setVisionProviderId(providers.find((provider) => provider.isDefault)?.id ?? providers[0]?.id ?? "");
        setVisionProviderLoadState("ready");
      }).catch((cause: unknown) => {
        if (controller.signal.aborted || cause instanceof DOMException && cause.name === "AbortError") return;
        setVisionProviderLoadError(cause instanceof Error ? cause.message : "视觉模型列表加载失败");
        setVisionProviderLoadState("error");
      });
    return () => controller.abort();
  }, [knowledgeModal, visionProviderReloadToken]);

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
  const navigationPendingRef = useRef(false);
  const queryNavigationPendingRef = useRef(false);
  const expectedDocumentQueryRef = useRef<Readonly<{ value: string | null }> | null>(null);
  const reconcileDocumentQueryRef = useRef<() => Promise<boolean>>(async () => false);

  useEffect(() => {
    requestedDocumentIdRef.current = requestedDocumentId;
  }, [requestedDocumentId]);

  useEffect(() => {
    if (knowledgeModal === null) return;
    const previousOverflow = window.document.body.style.overflow;
    window.document.body.style.overflow = "hidden";
    return () => { window.document.body.style.overflow = previousOverflow; };
  }, [knowledgeModal]);

  useEffect(() => {
    const detailDialog = detailDialogRef.current;
    if (!detailDialog) return;
    if (libraryScreen === "view" && workspaceSection === "library") {
      if (!detailDialog.open) detailDialog.showModal();
      window.requestAnimationFrame(() => detailDialog.querySelector<HTMLButtonElement>("[data-detail-close]")?.focus());
    } else if (detailDialog.open) {
      detailDialog.close();
    }
  }, [libraryScreen, workspaceSection]);

  async function confirmWithKnowledgeModal(
    options: Parameters<typeof confirm>[0],
    reopen: "always" | "on-cancel" = "always",
  ): Promise<boolean> {
    const dialogElement = knowledgeDialogRef.current;
    const detailElement = detailDialogRef.current;
    const wasOpen = dialogElement?.open === true;
    const detailWasOpen = detailElement?.open === true;
    if (wasOpen) dialogElement.close();
    if (detailWasOpen) detailElement.close();
    const result = await confirm(options);
    if (detailWasOpen && detailElement?.isConnected && !detailElement.open) detailElement.showModal();
    if (wasOpen && knowledgeModalRef.current !== null && (reopen === "always" || !result.confirmed)) {
      dialogElement?.showModal();
    }
    return result.confirmed;
  }

  async function confirmDiscardDraft(): Promise<boolean> {
    if (!editorDirty) return true;
    return confirmWithKnowledgeModal({
      eyebrow: t("尚未保存的个人知识"),
      title: t("离开编辑页面？"),
      description: t("当前修改还没有保存。离开后这些修改会丢失。"),
      confirmLabel: t("放弃修改并离开"),
      cancelLabel: t("继续编辑"),
    }, "on-cancel");
  }

  function setKnowledgeModal(next: KnowledgeModal): void {
    knowledgeModalRef.current = next;
    setKnowledgeModalState(next);
    const dialogElement = knowledgeDialogRef.current;
    if (!dialogElement) return;
    if (next === null) {
      if (dialogElement.open) dialogElement.close();
    } else if (!dialogElement.open) {
      dialogElement.showModal();
    }
  }

  function openKnowledgeModal(next: Exclude<KnowledgeModal, null>): void {
    if (knowledgeModalRef.current === null) modalReturnScreenRef.current = libraryScreen;
    if (next === "import") {
      setVisionProviderLoadState("loading");
      setVisionProviderLoadError(null);
    }
    invalidateListRequest();
    setListLoading(false);
    setKnowledgeModal(next);
  }

  async function requestCloseKnowledgeModal(): Promise<void> {
    const currentModal = knowledgeModalRef.current;
    if (currentModal === null || saving || importing) return;
    if (currentModal === "editor" && !await confirmDiscardDraft()) return;
    if (currentModal === "editor" && (mode === "edit" || mode === "create")) restoreSavedDraft();
    setKnowledgeModal(null);
    setMessage(null);
    setLibraryScreen(modalReturnScreenRef.current);
    if (modalReturnScreenRef.current === "list") void loadDocuments();
  }

  function restoreSavedDraft(): void {
    setDraft(document ? { title: document.title, content: document.content, isDefaultMemory: document.isDefaultMemory } : emptyDraft);
    setMode("view");
  }

  async function openWorkspaceSection(section: WorkspaceSection): Promise<void> {
    if (section === workspaceSection && (section !== "library" || libraryScreen === "list")) return;
    if (saving || !await confirmDiscardDraft()) return;
    if (knowledgeModalRef.current !== null) setKnowledgeModal(null);
    if (mode === "edit" || mode === "create") restoreSavedDraft();
    setMessage(null);
    setWorkspaceSection(section);
    if (section === "library") {
      setLibraryScreen("list");
      void loadDocuments();
    }
  }

  function clearDocumentQuery(usePush = false): void {
    const destination = new URL(window.location.href);
    destination.searchParams.delete("document");
    expectedDocumentQueryRef.current = parseDocumentQuery(new URL(window.location.href).searchParams.get("document")) === null
      ? null
      : { value: null };
    acceptedDocumentIdRef.current = null;
    setAcceptedDocumentId(null);
    detailHistoryEntryRef.current = false;
    const href = `${destination.pathname}${destination.search}${destination.hash}`;
    if (usePush) router.push(href, { scroll: false });
    else router.replace(href, { scroll: false });
  }

  async function openSearchTool(tool: SearchTool): Promise<void> {
    if (saving || !await confirmDiscardDraft()) return;
    if (knowledgeModalRef.current !== null) setKnowledgeModal(null);
    if (libraryScreen === "view") clearDocumentQuery(true);
    invalidateListRequest();
    invalidateMutationRequests();
    setSelectedDocumentId(null);
    clearDetailState();
    setSearchTool(tool);
    setWorkspaceSection("search");
    setLibraryScreen("list");
    setMessage(null);
  }

  async function returnToList(): Promise<void> {
    if (saving || !await confirmDiscardDraft()) return;
    if (mode === "edit" || mode === "create") restoreSavedDraft();
    // Only list-row selection creates this controlled same-route history entry; deep links fall back to deterministic list-state cleanup below.
    if (detailHistoryEntryRef.current) {
      detailHistoryEntryRef.current = false;
      router.back();
      return;
    }
    setMessage(null);
    acceptedDocumentIdRef.current = null;
    setAcceptedDocumentId(null);
    setSelectedDocumentId(null);
    clearDetailState();
    clearDocumentQuery();
    setLibraryScreen("list");
    void loadDocuments(null);
  }

  function handleInternalNavigation(event: MouseEvent<HTMLElement>): void {
    if (!editorDirty || saving || navigationPendingRef.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
    const destination = new URL(anchor.href, window.location.href);
    if (destination.origin !== window.location.origin || `${destination.pathname}${destination.search}${destination.hash}` === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    event.preventDefault();
    navigationPendingRef.current = true;
    void confirmDiscardDraft().then((canLeave) => {
      if (!canLeave) return;
      restoreSavedDraft();
      if (knowledgeModalRef.current !== null) setKnowledgeModal(null);
      router.push(`${destination.pathname}${destination.search}${destination.hash}`);
    }).finally(() => {
      navigationPendingRef.current = false;
    });
  }

  function updateDraft(nextDraft: KnowledgeDraft): void {
    setDraft(nextDraft);
    if (message?.tone === "error") setMessage(null);
  }

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

  useEffect(() => {
    reconcileDocumentQueryRef.current = async () => {
      function restoreAcceptedDocumentQuery(): void {
        const destination = new URL(window.location.href);
        const acceptedId = acceptedDocumentIdRef.current;
        const currentId = parseDocumentQuery(destination.searchParams.get("document"));
        if (acceptedId === null) destination.searchParams.delete("document");
        else destination.searchParams.set("document", acceptedId);
        expectedDocumentQueryRef.current = currentId === acceptedId ? null : { value: acceptedId };
        router.replace(`${destination.pathname}${destination.search}${destination.hash}`, { scroll: false });
      }

      // A save already in flight owns the editor. Restore the prior URL and let
      // the user navigate again after the save has completed.
      if (saving || importing || !await confirmDiscardDraft()) {
        restoreAcceptedDocumentQuery();
        return false;
      }

      // The browser URL can change again while the confirmation is open. Apply
      // the latest requested ID only after the user has confirmed leaving.
      const nextDocumentId = requestedDocumentIdRef.current;
      if (nextDocumentId === acceptedDocumentIdRef.current) return false;

      invalidateListRequest();
      invalidateMutationRequests();
      setSelectedDocumentId(null);
      clearDetailState();
      acceptedDocumentIdRef.current = nextDocumentId;
      setAcceptedDocumentId(nextDocumentId);
      setWorkspaceSection("library");
      setKnowledgeModal(null);
      setLibraryScreen(nextDocumentId === null ? "list" : "view");
      // A query arriving from direct navigation or browser Back/Forward is not
      // a row click we own. Closing it should clear the query in place instead
      // of navigating away from the user's previous page.
      detailHistoryEntryRef.current = false;
      setMessage(null);
      return true;
    };
  });

  useEffect(() => {
    const expectedQuery = expectedDocumentQueryRef.current;
    if (expectedQuery !== null) {
      if (requestedDocumentId === expectedQuery.value) expectedDocumentQueryRef.current = null;
      else return;
    }
    if (requestedDocumentId === acceptedDocumentIdRef.current || queryNavigationPendingRef.current) return;
    queryNavigationPendingRef.current = true;
    void reconcileDocumentQueryRef.current().then((accepted) => {
      queryNavigationPendingRef.current = false;
      // A second browser navigation may have arrived while the first prompt
      // was open. Reconcile it after this confirmation finishes.
      if (accepted && requestedDocumentIdRef.current !== acceptedDocumentIdRef.current) {
        setQueryReconcileVersion((version) => version + 1);
      }
    }).catch(() => {
      queryNavigationPendingRef.current = false;
    });
  }, [queryReconcileVersion, requestedDocumentId]);

  const loadDocuments = useCallback(async (preferredDocumentId: string | null = acceptedDocumentId) => {
    listRequestRef.current?.controller.abort();
    const request = { token: ++requestTokenRef.current, controller: new AbortController() };
    listRequestRef.current = request;
    setListLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (searchQuery) params.set("query", searchQuery);
      if (cursor) params.set("cursor", cursor);
      if (knowledgeFilter === "memory") params.set("isDefaultMemory", "true");
      const response = await fetch(`/api/personal/knowledge?${params.toString()}`, { cache: "no-store", signal: request.controller.signal });
      if (!response.ok) throw new Error(await readError(response, "个人知识加载失败"));
      const result = unwrapList(await response.json());
      if (listRequestRef.current?.token !== request.token || request.controller.signal.aborted) return;
      setDocuments(result.documents);
      setNextCursor(result.nextCursor);
      setListError(null);
      // A list refresh may finish while the user is writing. Keep it from
      // resetting the selected document or replacing the current draft.
      if (knowledgeModalRef.current !== null) return;
      const currentSelectedId = selectedIdRef.current;
      const nextSelectedId = preferredDocumentId
        ?? (currentSelectedId && result.documents.some((item) => item.id === currentSelectedId)
        ? currentSelectedId
        : null);
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
  }, [acceptedDocumentId, cursor, knowledgeFilter, searchQuery]);

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
      setDraft({ title: next.title, content: next.content, isDefaultMemory: next.isDefaultMemory });
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
    setLibraryScreen("list");
    clearDetailState();
  }

  /** Apply the server-side general-memory filter and start a fresh cursor chain. */
  function selectKnowledgeFilter(nextFilter: KnowledgeFilter): void {
    if (nextFilter === knowledgeFilter) return;
    invalidateListRequest();
    invalidateMutationRequests();
    setKnowledgeFilter(nextFilter);
    setCursor(null);
    setCursorStack([]);
    setSelectedDocumentId(null);
    clearDetailState();
    setLibraryScreen("list");
    setMessage(null);
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
    openKnowledgeModal("editor");
    invalidateMutationRequests();
    setSelectedDocumentId(null);
    clearDetailState("create");
    setDraft(emptyDraft);
    setWorkspaceSection("library");
    setMessage(null);
  }

  useEffect(() => {
    startCreateRef.current = startCreate;
  });

  useEffect(() => {
    if (searchParams.get("new") !== "1") {
      createFromQueryHandled.current = false;
      return;
    }
    if (createFromQueryHandled.current) return;
    createFromQueryHandled.current = true;
    startCreateRef.current();
    const next = new URLSearchParams(searchParams.toString());
    next.delete("new");
    const query = next.toString();
    router.replace(query ? `/personal/knowledge?${query}` : "/personal/knowledge", { scroll: false });
  }, [router, searchParams]);

  function startEdit(documentToEdit: KnowledgeDocument): void {
    openKnowledgeModal("editor");
    setDraft({ title: documentToEdit.title, content: documentToEdit.content, isDefaultMemory: documentToEdit.isDefaultMemory });
    setMode("edit");
    setWorkspaceSection("library");
    setMessage(null);
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    setMessage(null);
    try {
      const postFile = (action?: "prepare" | "execute", value?: string) => {
        const data = new FormData(); data.set("file", file);
        if (forcePdfVision && /\.pdf$/iu.test(file.name)) data.set("forceVision", "true");
        if (action) { data.set("action", action); data.set(action === "prepare" ? "providerId" : "attemptId", value ?? ""); }
        return fetch("/api/personal/knowledge/import", { method: "POST", body: data });
      };
      let response = await postFile();
      if (response.status === 422) {
        const payload = await response.clone().json() as { error?: { code?: string } };
        if (payload.error?.code === "PERSONAL_KNOWLEDGE_IMPORT_VISION_REQUIRED") {
          if (!visionProviderId) {
            throw new Error(t(visionProviderLoadState === "error"
              ? "视觉模型列表暂时无法加载，请重试后再导入图片或扫描 PDF。"
              : "尚无可用视觉模型。管理员需配置已验证的平台视觉路由，或先添加个人视觉模型。"));
          }
          const preparedResponse = await postFile("prepare", visionProviderId);
          if (!preparedResponse.ok) throw new Error(await readError(preparedResponse, "无法准备视觉识别"));
          const prepared = await preparedResponse.json() as { confirmation: {
            attemptId: string;
            providerName: string;
            modelId: string;
            pageCount: number;
            billingMode: "platform" | "byok";
            quotaMultiplierBps: number | null;
            maxOutputTokens: number;
            pages: Array<{ pageIndex: number; locatorLabel: string }>;
          } };
          const confirmation = prepared.confirmation;
          const pageList = confirmation.pages.map((page) => `• ${page.locatorLabel}`).join("\n");
          const billingDescription = confirmation.billingMode === "platform"
            ? `${t("由平台额度支付，额度倍率")} ${(confirmation.quotaMultiplierBps ?? 10_000) / 10_000}×。`
            : t("使用个人 BYOK 模型，服务商可能另行计费。");
          const decision = await confirmWithKnowledgeModal({
            eyebrow: t("个人知识识别"), title: t("发送图片或扫描页给视觉模型？"),
            description: `${t("本次将以下")} ${confirmation.pageCount} ${t("页发送给")} ${confirmation.providerName} (${confirmation.modelId}) ${t("识别：")}\n${pageList}\n${billingDescription}\n${t("每页最多输出")} ${confirmation.maxOutputTokens.toLocaleString(language === "en" ? "en-US" : "zh-CN")} tokens.\n${t("识别结果仅作为待核对预览。")}`,
            confirmLabel: t("确认发送"), cancelLabel: t("返回"),
          });
          if (!decision) return;
          response = await postFile("execute", confirmation.attemptId);
        }
      }
      if (!response.ok) throw new Error(await readError(response, "文件内容提取失败"));
      const payload = await response.json() as { preview: Pick<KnowledgeDraft, "title" | "content"> };
      startCreate();
      setKnowledgeModal("editor");
      setDraft({ ...payload.preview, isDefaultMemory: false });
      setMessage({ tone: "success", text: "已提取文件内容，请核对后保存到个人知识库。" });
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "文件内容提取失败" });
    } finally { setImporting(false); }
  }

  /** Select a list row and reset detail state before its request begins. */
  function selectDocument(documentId: string): void {
    setWorkspaceSection("library");
    if (documentId === selectedIdRef.current && mode === "view") {
      setLibraryScreen("view");
      return;
    }
    invalidateMutationRequests();
    setSelectedDocumentId(documentId);
    clearDetailState();
    setMode("view");
    setLibraryScreen("view");
    setMessage(null);
    acceptedDocumentIdRef.current = documentId;
    setAcceptedDocumentId(documentId);
    detailHistoryEntryRef.current = true;
    const destination = new URL(window.location.href);
    destination.searchParams.set("document", documentId);
    expectedDocumentQueryRef.current = parseDocumentQuery(new URL(window.location.href).searchParams.get("document")) === documentId
      ? null
      : { value: documentId };
    router.push(`${destination.pathname}${destination.search}${destination.hash}`, { scroll: false });
  }

  /** Create or revise a document using the currently rendered version fence. */
  async function saveDraft(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const validationError = validateKnowledgeDraft(draft);
    if (validationError) {
      setMessage({ tone: "error", text: validationError });
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
      if (isCreate) {
        setCurrentDocument(null);
        setDraft(emptyDraft);
        setSelectedDocumentId(null);
        acceptedDocumentIdRef.current = null;
        setAcceptedDocumentId(null);
        detailHistoryEntryRef.current = false;
        clearDocumentQuery();
      } else {
        setCurrentDocument(next);
        setDraft({ title: next.title, content: next.content, isDefaultMemory: next.isDefaultMemory });
        setSelectedDocumentId(next.id);
      }
      setMode("view");
      setWorkspaceSection("library");
      setLibraryScreen(isCreate ? "list" : modalReturnScreenRef.current);
      setKnowledgeModal(null);
      clearHistoryState();
      setMessage({ tone: "success", text: isCreate ? "个人知识已创建。" : "个人知识已保存为新版本。" });
      await loadDocuments(isCreate ? null : next.id);
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
      eyebrow: t("删除个人知识"),
      title: language === "en" ? `Delete “${target.title}”?` : `删除「${target.title}」？`,
      description: t("删除后内容会从个人知识列表隐藏，历史版本也不会再从普通页面打开。此操作不能恢复。"),
      confirmLabel: t("确认删除"),
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
      setLibraryScreen("list");
      clearDocumentQuery();
      setMessage({ tone: "success", text: "个人知识已删除。" });
      await loadDocuments(null);
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
    <main className={styles.page} onClickCapture={handleInternalNavigation}>
      <AppHeader username={username} active="personalKnowledge" isSystemAdmin={isSystemAdmin} />
      <PersonalWorkspaceNav active="knowledge" />
      <div data-page-content className={styles.content}>
        <header className={styles.heading}>
          <div>
            <h1><UiText text="我的知识" /></h1>
            <p><UiText text="维护个人知识、通用记忆与知识图谱。" /></p>
          </div>
          <div className={styles.headingActions}>
            <Link href={buildPersonalKnowledgeHistoryHref()} className={`${styles.button} app-action-button`}><UiText text="历史会话" /></Link>
            <button type="button" onClick={() => openKnowledgeModal("import")} className={`${styles.button} app-action-button`}><UiText text="导入文件" /></button>
            <button type="button" onClick={startCreate} className={`${styles.buttonPrimary} app-action-button`}><UiText text="新建知识" /></button>
          </div>
        </header>

        {message && knowledgeModal === null && (!editing || message.tone === "success") ? <div role={message.tone === "error" ? "alert" : "status"} className={`${styles.feedback} ${message.tone === "error" ? styles.feedbackError : styles.feedbackSuccess}`}><UiFeedbackText text={message.text} /></div> : null}

        {workspaceSection === "library" ? <>
          <nav className={styles.tabs} aria-label={t("知识栏目")} data-sticky-page-tabs>
            <button type="button" aria-current={knowledgeFilter === "all" ? "page" : undefined} aria-pressed={knowledgeFilter === "all"} onClick={() => selectKnowledgeFilter("all")} className={`${styles.tab} ${knowledgeFilter === "all" ? styles.activeTab : ""}`}><UiText text="全部知识" /></button>
            <button type="button" aria-current={knowledgeFilter === "memory" ? "page" : undefined} aria-pressed={knowledgeFilter === "memory"} onClick={() => selectKnowledgeFilter("memory")} className={`${styles.tab} ${knowledgeFilter === "memory" ? styles.activeTab : ""}`}><UiText text="通用记忆" /></button>
          </nav>

          {knowledgeFilter === "memory" ? <p className={styles.notice}><UiText text="仅显示你明确标记为通用记忆的内容；这些约定会用于你发起的项目 AI 请求。" /></p> : null}

          <section aria-label={t(knowledgeFilter === "memory" ? "通用记忆列表" : "全部知识列表")}>
            <div className={styles.toolbar}>
              <form onSubmit={submitSearch} className={styles.searchForm}>
                <label className="min-w-0 flex-1">
                  <span className="sr-only"><UiText text="搜索个人知识标题或正文" /></span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索个人知识标题或正文")} maxLength={240} className={styles.searchInput} />
                </label>
                <button type="submit" className={`${styles.button} app-action-button`}><UiText text="搜索" /></button>
              </form>
              <div className={styles.toolbarActions}>
                <button type="button" onClick={() => void openSearchTool("semantic")} className={`${styles.button} app-action-button`}><UiText text="智能检索与索引" /></button>
              </div>
            </div>

            {listError ? <div role="alert" className={`${styles.feedback} ${styles.feedbackError}`}><p><UiErrorText text={listError} /></p><button type="button" onClick={() => void loadDocuments()} className="mt-2 font-semibold underline"><UiText text="重新加载" /></button></div> : null}
            {listLoading ? <p className="py-5 text-sm text-slate-500" role="status" aria-live="polite"><UiText text="正在加载知识…" /></p> : documents.length === 0 ? <EmptyList searchQuery={searchQuery} filter={knowledgeFilter} onCreate={startCreate} /> : <div className={styles.list}>
              {documents.map((item) => <button key={item.id} type="button" aria-haspopup="dialog" aria-current={item.id === selectedId ? "true" : undefined} onClick={() => selectDocument(item.id)} className={`${styles.row} ${item.id === selectedId ? styles.selectedRow : ""}`}>
                <span className={styles.rowBody}>
                  <span className={styles.rowTitle}>{item.title}</span>
                  <span className={styles.rowExcerpt}>{item.excerpt ?? `${t("已保存")} ${formatBytes(item.byteCount)}${language === "en" ? ". " : "，"}${t("打开查看正文。")}`}</span>
                </span>
                <span className={styles.rowMeta}>
                  {item.isDefaultMemory ? <span className={styles.memoryBadge}><UiText text="通用记忆" /></span> : null}
                  <span className={styles.versionBadge}><UiText text={"v"} />{item.version}</span>
                  <span>{t("更新于")} {formatDate(item.updatedAt, language)}</span>
                </span>
              </button>)}
            </div>}

            {documents.length > 0 ? <nav className={styles.pager} aria-label={t("个人知识分页")}><span>{language === "en" ? `Page ${pageNumber}` : `第 ${pageNumber} 页`}</span><div className={styles.rowActions}><button type="button" onClick={goPrevious} disabled={cursorStack.length === 0 || listLoading} className={`${styles.button} app-action-button`}><UiText text="上一页" /></button><button type="button" onClick={goNext} disabled={!nextCursor || listLoading} className={`${styles.button} app-action-button`}><UiText text="下一页" /></button></div></nav> : null}
          </section>
        </> : null}

        {workspaceSection === "search" ? <section className={styles.searchTools}>
          <div className={styles.heading}>
            <div><h1><UiText text="智能检索与索引" /></h1><p><UiText text="搜索个人知识，管理语义索引，或查找项目来源。" /></p></div>
            <button type="button" onClick={() => void openWorkspaceSection("library")} className={PARENT_PAGE_LINK_CLASS_NAME}><ShellIcon name="back" className="app-icon--compact" /><UiText text="返回知识列表" /></button>
          </div>
          <nav className={styles.tabs} aria-label={t("智能检索工具")}>
            <button type="button" aria-current={searchTool === "semantic" ? "page" : undefined} onClick={() => setSearchTool("semantic")} className={`${styles.tab} ${searchTool === "semantic" ? styles.activeTab : ""}`}><UiText text="个人语义搜索" /></button>
            <button type="button" aria-current={searchTool === "index" ? "page" : undefined} onClick={() => setSearchTool("index")} className={`${styles.tab} ${searchTool === "index" ? styles.activeTab : ""}`}><UiText text="索引管理" /></button>
            <button type="button" aria-current={searchTool === "project" ? "page" : undefined} onClick={() => setSearchTool("project")} className={`${styles.tab} ${searchTool === "project" ? styles.activeTab : ""}`}><UiText text="项目来源搜索" /></button>
          </nav>
          <div>{searchTool === "semantic" ? <PersonalSemanticSearchPanel onManageIndex={() => setSearchTool("index")} /> : searchTool === "index" ? <PersonalSemanticIndexPanel onOpenSemanticSearch={() => setSearchTool("semantic")} /> : <PersonalProjectSearchPanel />}</div>
        </section> : null}
      </div>

      <dialog
        ref={detailDialogRef}
        data-inquiry-surface="knowledge-detail"
        aria-label={t("个人知识详情")}
        aria-modal="true"
        tabIndex={-1}
        onCancel={(event) => { event.preventDefault(); void returnToList(); }}
        onClick={(event: MouseEvent<HTMLDialogElement>) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) void returnToList();
        }}
        className={styles.detailDialog}
      >
        <div className={styles.detailContent}>
          {detailLoading ? <p role="status" className="py-8 text-sm text-slate-500"><UiText text="正在加载知识详情…" /></p> : document ? <>
            <DocumentDetail language={language} document={document} revisions={revisions} historyOpen={historyOpen} historyLoading={historyLoading} historyNextCursor={historyNextCursor} historyError={historyError} expandedRevisionVersion={expandedRevisionVersion} revisionContent={revisionContent} revisionLoading={revisionLoading} revisionError={revisionError} exporting={exporting} deleting={deleting} onClose={() => void returnToList()} onEdit={() => startEdit(document)} onDelete={() => void deleteDocument()} onExport={(format) => void exportDocument(format)} onHistory={() => { if (historyOpen) clearHistoryState(); else void loadHistory(); }} onReloadHistory={() => void loadHistory()} onLoadMoreHistory={() => { if (historyNextCursor) void loadHistory(historyNextCursor, true); }} onToggleRevision={toggleRevision} />
            <PersonalKnowledgeNextSteps key={`${document.id}:${document.version}`} content={document.content} onOpenSemanticIndex={() => void openSearchTool("index")} />
          </> : <>{message?.tone === "error" ? <div role="alert" className={`${styles.feedback} ${styles.feedbackError}`}><UiFeedbackText text={message.text} /></div> : null}<EmptyDetail onCreate={startCreate} /></>}
        </div>
      </dialog>

        <dialog
          ref={knowledgeDialogRef}
        data-inquiry-surface="knowledge-editor"
          aria-labelledby="knowledge-modal-title"
          aria-modal="true"
          tabIndex={-1}
          onCancel={(event) => { event.preventDefault(); void requestCloseKnowledgeModal(); }}
          onKeyDown={(event: KeyboardEvent<HTMLDialogElement>) => {
            if (event.key !== "Tab" || !event.currentTarget.open) return;
            const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])")]
              .filter((element) => element.getClientRects().length > 0 && element.closest("[hidden], [inert], [aria-hidden='true']") === null && getComputedStyle(element).visibility !== "hidden");
            if (focusable.length === 0) {
              event.preventDefault();
              event.currentTarget.focus();
              return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = window.document.activeElement;
            const outsideDialog = !(active instanceof Node) || !event.currentTarget.contains(active);
            if (event.shiftKey && (outsideDialog || active === event.currentTarget || active === first)) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && (outsideDialog || active === event.currentTarget || active === last)) {
              event.preventDefault();
              first.focus();
            }
          }}
          onClick={(event: MouseEvent<HTMLDialogElement>) => {
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
              void requestCloseKnowledgeModal();
            }
          }}
          className={styles.knowledgeDialog}
          data-variant={knowledgeModal === "editor" ? mode : knowledgeModal ?? undefined}
        >
          {knowledgeModal === "editor" ? <div className="h-dvh max-h-dvh min-h-0">
            <PersonalKnowledgeEditor mode={mode === "create" ? "create" : "edit"} draft={draft} saving={saving} error={message?.tone === "error" ? message.text : null} notice={message?.tone === "success" ? message.text : null} onDraftChange={updateDraft} onCancel={() => void requestCloseKnowledgeModal()} onSubmit={saveDraft} />
          </div> : null}
          {knowledgeModal === "import" ? <div className="flex h-dvh max-h-dvh min-h-0 flex-col">
          <div data-dialog-header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-7">
              <div><h2 id="knowledge-modal-title" className="text-xl font-semibold"><UiText text="导入知识" /></h2></div>
              <button data-dialog-close type="button" onClick={() => void requestCloseKnowledgeModal()} disabled={importing} aria-label={t("关闭导入弹窗")} className="app-icon-button"><ShellIcon name="close" className="app-icon--control" /></button>
            </div>
            <div data-dialog-body className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-7">
              <p className="max-w-2xl text-sm leading-6 text-slate-500"><UiText text="选择文本、Markdown、JSON、PDF、DOCX 或图片。提取结果会转入编辑弹窗，核对后再保存。" /></p>
              {message?.tone === "error" ? <div role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><UiFeedbackText text={message.text} /></div> : null}
              <div className="mt-5 border-t border-slate-100 pt-4">
                <label className="block text-sm font-semibold text-slate-700"><UiText text="选择文件" />
                  <input type="file" accept=".txt,.md,.json,.pdf,.docx,.png,.jpg,.jpeg,.webp" disabled={importing} onChange={(event) => void importFile(event)} className="mt-2 block w-full text-sm disabled:opacity-50" />
                </label>
                {importing ? <p role="status" className="mt-3 text-sm text-indigo-700"><UiText text="正在提取文件内容…" /></p> : null}
              </div>
              <div className="mt-5 border-t border-slate-100 pt-4 text-sm text-slate-600">
                <label className="block font-semibold text-slate-700"><UiText text="图片及扫描 PDF 识别模型" />
                  <select value={visionProviderId} disabled={importing || visionProviderLoadState !== "ready"} onChange={(event) => setVisionProviderId(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal disabled:bg-slate-100">
                    <option value=""><UiText text="选择视觉模型" /></option>
                    {visionProviders.map((provider) => <option key={provider.id} value={provider.id}>{t(provider.billingMode === "platform" ? "平台额度" : "个人 BYOK")} · {provider.name} · {provider.modelId}</option>)}
                  </select>
                </label>
                <p className="mt-3 text-xs leading-5"><UiText text="遇到图片或扫描页时，会在发送前显示模型与页数，并请你单独确认。一次最多识别 3 页扫描内容；识别结果仅作为待核对预览，确认保存后才进入知识库。" /></p>
                {visionProviderLoadState === "loading" ? <p role="status" className="mt-2 text-xs text-slate-500"><UiText text="正在读取可用视觉模型…" /></p> : null}
                {visionProviderLoadState === "error" ? <div role="alert" className="mt-2 text-xs text-rose-700"><p><UiErrorText text={visionProviderLoadError ?? "视觉模型列表加载失败"} /></p><button type="button" onClick={() => { setVisionProviderLoadState("loading"); setVisionProviderLoadError(null); setVisionProviderReloadToken((value) => value + 1); }} className="mt-1 font-semibold underline"><UiText text="重新加载" /></button></div> : null}
                {visionProviderLoadState === "ready" && !visionProviders.some((provider) => provider.billingMode === "platform") ? <p className="mt-2 text-xs text-amber-700"><UiText text="平台视觉模型暂不可用，请管理员配置并验证 visionExtract 路由；你也可以选择个人 BYOK 模型。文本文件和可提取文字的 PDF 仍可导入。" /></p> : null}
                {visionProviderLoadState === "ready" && visionProviders.length === 0 ? <p className="mt-2 text-xs text-amber-700"><UiText text="当前没有可用视觉模型。可先等待管理员配置平台路由，或添加个人视觉模型。" /></p> : null}
                <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-slate-700"><input type="checkbox" checked={forcePdfVision} onChange={(event) => setForcePdfVision(event.target.checked)} className="mt-0.5 shrink-0" /><span><UiText text="PDF 含扫描正文或图片时，使用视觉模型逐页补充识别（最多 3 页）。即使页眉有可复制文字，也建议勾选；发送前会再次确认。" /></span></label>
              </div>
            </div>
            <div data-dialog-footer className="shrink-0 border-t border-slate-100 px-5 py-3 text-right sm:px-7">
              <button type="button" onClick={() => void requestCloseKnowledgeModal()} disabled={importing} className="app-action-button rounded-xl border border-slate-200 font-semibold text-slate-600 disabled:opacity-50"><UiText text="完成" /></button>
            </div>
          </div> : null}
        </dialog>
      {dialog}
    </main>
  );
}

/** Explain an empty list or search result and preserve the create entry point. */
function EmptyList({ searchQuery, filter, onCreate }: { searchQuery: string; filter: KnowledgeFilter; onCreate: () => void }): React.JSX.Element {
  const t = useTranslate();
  const title = t(searchQuery ? "没有匹配的知识" : filter === "memory" ? "还没有通用记忆" : "还没有个人知识");
  const description = t(searchQuery ? "换一个关键词，或清空搜索后查看全部内容。" : filter === "memory" ? "编辑知识并明确标记为通用记忆后，会显示在这里。" : "新建或导入一条知识，开始整理个人资料。");
  return <div className={styles.empty}><p className="font-semibold text-slate-700">{title}</p><p className="mt-2">{description}</p>{!searchQuery && filter === "all" ? <button type="button" onClick={onCreate} className={`${styles.buttonPrimary} app-action-button mt-4`}><UiText text="新建知识" /></button> : null}</div>;
}

/** Render the neutral detail state before a document has been selected. */
function EmptyDetail({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return <div className={styles.empty}><h2 className="font-semibold text-slate-700"><UiText text="这条知识暂不可用" /></h2><p className="mt-2"><UiText text="内容可能已删除，或当前账号已不能访问。" /></p><button type="button" onClick={onCreate} className={`${styles.buttonPrimary} app-action-button mt-4`}><UiText text="新建知识" /></button></div>;
}

type DocumentDetailProps = Readonly<{
  language: "zh-CN" | "en";
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
  onClose: () => void;
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
  language,
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
  onClose,
  onEdit,
  onDelete,
  onExport,
  onHistory,
  onReloadHistory,
  onLoadMoreHistory,
  onToggleRevision,
}: DocumentDetailProps): React.JSX.Element {
  const t = useTranslate();
  return (
    <article>
      <div data-dialog-header className="flex items-start justify-between gap-4 border-b border-slate-100 pb-5">
        <div className="min-w-0">
          <h2 id="personal-knowledge-detail-title" className="break-words text-xl font-semibold tracking-[-0.02em]">{document.title}</h2>
          {document.isDefaultMemory ? <span className="mt-2 inline-block rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700"><UiText text="个人通用记忆 · 项目 AI 可自动参考" /></span> : null}
          <p className="mt-2 text-xs text-slate-400">{t("版本")} {document.version} · {formatBytes(document.byteCount)} · {t("更新于")} {formatDate(document.updatedAt, language)}</p>
        </div>
        <button type="button" onClick={onClose} data-dialog-close data-detail-close aria-label={t("关闭窗口")} className="app-icon-button"><ShellIcon name="close" className="app-icon--control" /></button>
      </div>

      <div data-dialog-body>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onEdit} className={`${styles.buttonPrimary} app-action-button`}><UiText text="编辑" /></button>
        <button type="button" onClick={onDelete} disabled={deleting} className={`${styles.buttonDanger} app-action-button`}>{deleting ? t("删除中…") : t("删除")}</button>
        <button type="button" onClick={() => onExport("markdown")} disabled={exporting !== null} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-50">{t(exporting === "markdown" ? "导出中…" : "导出 Markdown")}</button>
        <button type="button" onClick={() => onExport("text")} disabled={exporting !== null} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-50">{t(exporting === "text" ? "导出中…" : "导出纯文本")}</button>
        <button type="button" onClick={onHistory} disabled={historyLoading} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-50">{t(historyLoading ? "读取历史中…" : historyOpen ? "收起版本历史" : "查看版本历史")}</button>
      </div>

      <div id="personal-knowledge-content" className="mt-5 scroll-mt-6 rounded-2xl border border-slate-200 bg-slate-50/70 px-5 py-5">
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-slate-700">{document.content}</pre>
      </div>

      <PersonalKnowledgeQaPanel key={`${document.id}:${document.version}`} documentId={document.id} version={document.version} />

      {historyOpen ? (
        <section className="mt-6 border-t border-slate-100 pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold"><UiText text="版本历史" /></h3>
              <p className="mt-1 text-xs text-slate-500"><UiText text="历史列表只读取元数据，展开版本时再读取正文。" /></p>
            </div>
            <span className="text-xs text-slate-400">{revisions.length} {t("个版本")}</span>
          </div>

          {historyError ? <div role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><p><UiErrorText text={historyError} /></p><button type="button" onClick={onReloadHistory} className="mt-2 font-semibold underline"><UiText text="重新加载历史" /></button></div> : null}
          {historyLoading && revisions.length === 0 ? <p className="mt-4 rounded-xl bg-slate-50 px-4 py-4 text-sm text-slate-500"><UiText text="正在读取版本历史…" /></p> : null}
          {!historyLoading && !historyError && revisions.length === 0 ? <p className="mt-4 rounded-xl bg-slate-50 px-4 py-4 text-sm text-slate-500"><UiText text="暂时没有版本记录。" /></p> : null}

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
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold text-slate-700">{t("版本")} {revision.version} · {revision.title}</span><span className="text-xs text-slate-400">{formatDate(revision.createdAt, language)} · {formatBytes(revision.byteCount)}</span></div>
                </button>
                {isExpanded ? <div className="border-t border-slate-100 px-4 py-4">
                  {revisionLoading && loadedBody === null ? <p className="text-xs text-slate-500"><UiText text="正在读取版本正文…" /></p> : null}
                  {revisionError && loadedBody === null ? <div role="alert" className="text-xs text-rose-700"><p><UiErrorText text={revisionError} /></p><button type="button" onClick={() => onToggleRevision(revision.version)} className="mt-2 font-semibold underline"><UiText text="重新读取正文" /></button></div> : null}
                  {loadedBody ? <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-6 text-slate-600">{loadedBody.content}</pre> : null}
                </div> : null}
              </div>;
            })}
          </div> : null}

          {historyNextCursor ? <button type="button" onClick={onLoadMoreHistory} disabled={historyLoading} className="mt-4 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-semibold text-slate-600 transition hover:border-indigo-200 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{t(historyLoading ? "读取中…" : "加载更多版本")}</button> : null}
        </section>
      ) : null}
      </div>
    </article>
  );
}
