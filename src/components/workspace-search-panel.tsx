"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslate } from "./appearance-provider";
import { ShellIcon } from "./shell-icon";
import type { WorkspaceOption } from "./workspace-scope";
import styles from "./workspace-picker.module.css";

type WorkspaceSearchResponse = Readonly<{
  availableWorkspaces: WorkspaceOption[];
  hasMore: boolean;
  nextCursor: string | null;
}>;

export default function WorkspaceSearchPanel({
  id,
  selectedId,
  onSelect,
}: Readonly<{
  id: string;
  selectedId: string;
  onSelect: (space: WorkspaceOption, restoreFocus?: boolean) => void;
}>) {
  const t = useTranslate();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceOption[]>([]);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(true);
  const [searchError, setSearchError] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchController = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const listboxId = `${id}-listbox`;

  const activeOptionId = activeIndex >= 0 && activeIndex < searchResults.length
    ? `${id}-option-${activeIndex}`
    : undefined;

  useEffect(() => {
    const frame = requestAnimationFrame(() => searchInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({ search: searchQuery.trim() });
          if (pageCursor) params.set("cursor", pageCursor);
          const response = await fetch(`/api/workspaces/current?${params.toString()}`, { cache: "no-store", signal: controller.signal });
          if (!response.ok) throw Error();
          const result = await response.json() as WorkspaceSearchResponse;
          if (controller.signal.aborted) return;
          const page = Array.isArray(result.availableWorkspaces)
            ? result.availableWorkspaces.filter((space) => typeof space.id === "string" && typeof space.name === "string")
            : [];
          setSearchResults((current) => pageCursor
            ? [...current.filter((space) => !page.some((candidate) => candidate.id === space.id)), ...page]
            : page);
          setSearchCursor(result.hasMore ? result.nextCursor : null);
          if (pageCursor === null) setActiveIndex(page.findIndex((space) => !space.unavailable));
        } catch {
          if (!controller.signal.aborted) setSearchError(true);
        } finally {
          if (!controller.signal.aborted) setSearchLoading(false);
        }
      })();
    }, pageCursor === null ? 200 : 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery, pageCursor, retryVersion]);

  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

  function changeQuery(value: string) {
    searchController.current?.abort();
    setSearchQuery(value);
    setPageCursor(null);
    setSearchResults([]);
    setSearchCursor(null);
    setSearchLoading(true);
    setSearchError(false);
    setActiveIndex(-1);
  }

  function retrySearch() {
    searchController.current?.abort();
    setSearchLoading(true);
    setSearchError(false);
    setRetryVersion((value) => value + 1);
  }

  function loadMore() {
    if (!searchCursor || searchLoading) return;
    searchController.current?.abort();
    setPageCursor(searchCursor);
    setSearchLoading(true);
    setSearchError(false);
  }

  function moveActive(direction: 1 | -1) {
    if (searchResults.length === 0) return;
    let index = activeIndex;
    for (let count = 0; count < searchResults.length; count += 1) {
      index = index === -1
        ? direction === 1 ? 0 : searchResults.length - 1
        : (index + direction + searchResults.length) % searchResults.length;
      if (!searchResults[index]?.unavailable) {
        setActiveIndex(index);
        return;
      }
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      const space = searchResults[activeIndex];
      if (space && !space.unavailable) {
        event.preventDefault();
        onSelect(space, true);
      }
    }
  }

  return (
    <div id={id} className={styles.dropdown} data-workspace-dropdown>
      <div className={styles.searchInputWrap}>
          <ShellIcon name="search" />
          <input
            ref={searchInput}
            role="combobox"
            aria-label={t("搜索工作区名称")}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            value={searchQuery}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            maxLength={100}
            placeholder={t("搜索工作区名称")}
            autoComplete="off"
            className="app-field"
          />
      </div>
      <div
        className={styles.results}
        role="region"
        aria-label={t("工作区搜索结果")}
        tabIndex={0}
      >
        {searchLoading ? <p role="status">{t("搜索中…")}</p> : null}
        {searchError ? (
          <div role="alert">
            <span>{t("工作区搜索失败，请重试")}</span>
            <button type="button" className={`app-button-secondary ${styles.action}`} onClick={retrySearch}>{t("重试")}</button>
          </div>
        ) : null}
        {!searchLoading && !searchError && searchResults.length === 0 ? (
          <p>{t("没有匹配的工作区")}</p>
        ) : null}
        <ul id={listboxId} role="listbox" aria-label={t("工作区搜索结果")} aria-busy={searchLoading}>
          {searchResults.map((space, index) => (
            <li
              key={space.id}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={space.id === selectedId}
              aria-disabled={space.unavailable || undefined}
              className={styles.option}
              data-active={activeIndex === index || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => { if (!space.unavailable) setActiveIndex(index); }}
              onClick={() => { if (!space.unavailable) onSelect(space); }}
              title={space.name}
            >
              <span>{space.name}</span>
              {space.id === selectedId ? <ShellIcon name="check" /> : null}
            </li>
          ))}
        </ul>
        {!searchError && searchCursor ? (
          <button type="button" className={`app-button-secondary ${styles.action}`} onClick={loadMore} aria-disabled={searchLoading}>
            {t("下一页")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
