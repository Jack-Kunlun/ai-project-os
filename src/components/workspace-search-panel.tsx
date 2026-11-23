"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslate } from "./appearance-provider";
import { OperationPanel } from "./operation-panel";
import type { WorkspaceOption } from "./workspace-scope";

type WorkspaceSearchResponse = Readonly<{
  availableWorkspaces: WorkspaceOption[];
  hasMore: boolean;
  nextCursor: string | null;
}>;

export function WorkspaceSearchPanel({
  open,
  onOpenChange,
  onSelect,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (space: WorkspaceOption) => void;
}>) {
  const t = useTranslate();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceOption[]>([]);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const searchController = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => searchController.current?.abort(), []);

  async function searchWorkspaces(cursor: string | null = null) {
    if (searchLoading) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearchLoading(true);
    setSearchError(false);
    try {
      const params = new URLSearchParams({ search: searchQuery.trim() });
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
    searchInput.current?.focus();
    setSearchCursor(null);
    setSearchResults([]);
    setSearchSubmitted(false);
    void searchWorkspaces();
  }

  return (
    <div className="hidden">
      <OperationPanel
        title="查找其他工作区"
        triggerLabel="查找其他工作区"
        triggerAppearance="row"
        open={open}
        onOpenChange={onOpenChange}
      >
        <form onSubmit={handleSearchSubmit} className="space-y-3">
          <label className="block text-sm font-medium text-app-text">{t("搜索工作区名称")}
            <input
              ref={searchInput}
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
          {searchResults.map((space) => <li key={space.id}><button type="button" onClick={() => onSelect(space)} className="app-button-secondary w-full rounded-control px-3 py-2 text-left text-sm">{space.name}</button></li>)}
        </ul> : null}
        {searchHasMore && searchCursor ? <button type="button" onClick={() => void searchWorkspaces(searchCursor)} disabled={searchLoading} className="app-button-secondary mt-4 rounded-control px-4 py-2 text-sm font-semibold disabled:opacity-50">{t("下一页")}</button> : null}
      </OperationPanel>
    </div>
  );
}
