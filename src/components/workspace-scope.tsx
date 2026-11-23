"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type SelectHTMLAttributes } from "react";
import { useRouter } from "next/navigation";
import { useTranslate } from "./appearance-provider";
import { OperationPanel } from "./operation-panel";
import { ShellIcon } from "./shell-icon";
import styles from "./user-shell.module.css";

const fallback = new Map<string, string>();
const changed = "ai-project-os:workspace-changed";
const key = (username: string) => `ai-project-os:workspace:${username}`;

type SidebarSelectProps = SelectHTMLAttributes<HTMLSelectElement> & Readonly<{
  initial: string;
  children: ReactNode;
}>;

export function SidebarSelect({ initial, children, onKeyDown, ...props }: SidebarSelectProps): React.JSX.Element {
  return (
    <label className={styles.projectPicker}>
      <span className={styles.projectDot} aria-hidden="true">{initial.slice(0, 1) || "·"}</span>
      <select
        {...props}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
          onKeyDown?.(event);
        }}
      >
        {children}
      </select>
      <ShellIcon className={styles.icon} name="chevron" />
    </label>
  );
}

export function selectWorkspace(username: string, id: string) {
  fallback.set(key(username), id);
  try { localStorage.setItem(key(username), id); } catch { /* Storage may be unavailable. */ }
  window.dispatchEvent(new CustomEvent(changed, { detail: { username, id } }));
}

export function useWorkspaceSelection(username: string) {
  return useSyncExternalStore(
    (callback) => {
      window.addEventListener(changed, callback);
      window.addEventListener("storage", callback);
      return () => {
        window.removeEventListener(changed, callback);
        window.removeEventListener("storage", callback);
      };
    },
    () => {
      try { return localStorage.getItem(key(username)) || ""; } catch { return fallback.get(key(username)) || ""; }
    },
    () => "",
  );
}

type Space = { id: string; name: string; personal?: boolean; unavailable?: boolean };
type WorkspaceSearchResponse = { availableWorkspaces: Space[]; hasMore: boolean; nextCursor: string | null };

export function WorkspacePicker({ username, onNameChange }: { username: string; onNameChange?: (name: string) => void }) {
  const t = useTranslate();
  const router = useRouter();
  const selected = useWorkspaceSelection(username);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Space[]>([]);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const searchController = useRef<AbortController | null>(null);
  const activeSpace = spaces.find((space) => space.id === selected);
  const optionLabel = t(failed ? "工作空间暂不可用" : "正在读取工作空间…");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const personalResponse = await fetch("/api/workspaces/current", { cache: "no-store", signal: controller.signal });
        if (!personalResponse.ok) throw Error();
        const personal = await personalResponse.json();
        if (controller.signal.aborted) return;
        const home = personal.overview.workspace;
        const available = Array.isArray(personal.availableWorkspaces) ? personal.availableWorkspaces : [];
        const list: Space[] = [{ id: home.id, name: home.name, personal: true }, ...available.filter((space: Space) => typeof space.id === "string" && typeof space.name === "string")];
        const unique = list.filter((space, index) => list.findIndex((candidate) => candidate.id === space.id) === index);
        let saved = "";
        try { saved = localStorage.getItem(key(username)) || ""; } catch { /* Storage may be unavailable. */ }
        if (saved && !unique.some((space) => space.id === saved)) {
          try {
            const selectedResponse = await fetch(`/api/workspaces/current?workspaceId=${encodeURIComponent(saved)}`, { cache: "no-store", signal: controller.signal });
            if (!selectedResponse.ok) throw Error();
            const selectedBody = await selectedResponse.json();
            if (controller.signal.aborted) return;
            const selectedWorkspace = selectedBody.selectedWorkspace as Space | null;
            if (selectedWorkspace && typeof selectedWorkspace.id === "string" && typeof selectedWorkspace.name === "string") unique.push(selectedWorkspace);
            else selectWorkspace(username, home.id);
          } catch {
            if (controller.signal.aborted) return;
            unique.push({ id: saved, name: t("工作区暂不可用"), unavailable: true });
            setFailed(true);
          }
        } else if (!saved) {
          selectWorkspace(username, home.id);
        }
        if (controller.signal.aborted) return;
        setSpaces(unique);
        if (!saved || unique.some((space) => space.id === saved && !space.unavailable)) setFailed(false);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [username, version, t]);

  useEffect(() => () => searchController.current?.abort(), []);

  useEffect(() => {
    onNameChange?.(activeSpace?.name || "");
  }, [activeSpace?.name, onNameChange]);

  function chooseWorkspace(space: Space) {
    if (!space.id || space.unavailable) return;
    setSpaces((current) => [space, ...current.filter((entry) => entry.id !== space.id)]);
    selectWorkspace(username, space.id);
    setSearchOpen(false);
    router.push("/dashboard");
  }

  async function searchWorkspaces(cursor: string | null = null) {
    const query = searchQuery.trim();
    if (searchLoading) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearchLoading(true);
    setSearchError(false);
    try {
      const params = new URLSearchParams({ search: query });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/workspaces/current?${params.toString()}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw Error();
      const result = await response.json() as WorkspaceSearchResponse;
      if (controller.signal.aborted) return;
      setSearchResults((current) => {
        const next = cursor ? [...current, ...result.availableWorkspaces] : result.availableWorkspaces;
        return next.filter((space, index) => next.findIndex((candidate) => candidate.id === space.id) === index);
      });
      setSearchCursor(result.nextCursor);
      setSearchHasMore(result.hasMore);
      setSearchSubmitted(true);
    } catch {
      if (!controller.signal.aborted) setSearchError(true);
    } finally {
      if (!controller.signal.aborted) setSearchLoading(false);
    }
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchCursor(null);
    setSearchResults([]);
    setSearchSubmitted(false);
    void searchWorkspaces();
  }

  return (
    <div className="workspace-switcher">
      <SidebarSelect
        initial={activeSpace?.name || username}
        value={activeSpace?.id ?? ""}
        aria-label={t("切换工作空间")}
        title={activeSpace?.name}
        disabled={!spaces.length}
        onChange={(event) => {
          const space = spaces.find((candidate) => candidate.id === event.currentTarget.value);
          if (space) chooseWorkspace(space);
        }}
      >
        {spaces.length === 0 ? <option value="">{optionLabel}</option> : null}
        {spaces.map((space) => (
          <option key={space.id} value={space.id} disabled={space.unavailable}>{space.name}</option>
        ))}
      </SidebarSelect>
      <OperationPanel
        title="查找其他工作区"
        triggerLabel="查找其他工作区"
        triggerAppearance="row"
        className="workspace-more"
        open={searchOpen}
        onOpenChange={setSearchOpen}
      >
        <form onSubmit={handleSearchSubmit} className="space-y-3">
          <label className="block text-sm font-medium text-app-text">{t("搜索工作区名称")}
            <input
              aria-label={t("搜索工作区名称")}
              value={searchQuery}
              onChange={(event) => {
                searchController.current?.abort();
                setSearchQuery(event.target.value);
                setSearchResults([]);
                setSearchCursor(null);
                setSearchHasMore(false);
                setSearchSubmitted(false);
                setSearchLoading(false);
                setSearchError(false);
              }}
              maxLength={100}
              className="app-field mt-2 min-h-11 w-full rounded-field border border-app-border px-3"
            />
          </label>
          <button type="submit" disabled={searchLoading} className="app-button-primary rounded-control px-4 py-2 text-sm font-semibold disabled:opacity-50">
            {searchLoading ? t("搜索中…") : t("搜索工作区名称")}
          </button>
        </form>
        {searchError ? <p role="alert" className="mt-4 rounded-field bg-app-danger-soft px-3 py-2 text-sm text-app-danger-ink">{t("工作区搜索失败，请重试")}</p> : null}
        {searchSubmitted && searchResults.length === 0 && !searchLoading ? <p className="mt-4 text-sm text-app-muted">{t("没有匹配的工作区")}</p> : null}
        {searchResults.length > 0 ? <ul className="mt-4 space-y-2" aria-label={t("工作区搜索结果")}>
          {searchResults.map((space) => <li key={space.id}><button type="button" onClick={() => chooseWorkspace(space)} className="app-button-secondary w-full rounded-control px-3 py-2 text-left text-sm">{space.name}</button></li>)}
        </ul> : null}
        {searchHasMore && searchCursor ? <button type="button" onClick={() => void searchWorkspaces(searchCursor)} disabled={searchLoading} className="app-button-secondary mt-4 rounded-control px-4 py-2 text-sm font-semibold disabled:opacity-50">{t("下一页")}</button> : null}
      </OperationPanel>
      {failed ? <button className="workspace-retry" onClick={() => setVersion((value) => value + 1)}>{t("重试")}</button> : null}
    </div>
  );
}
