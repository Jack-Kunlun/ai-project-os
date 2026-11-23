"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { UiText, useTranslate } from "./appearance-provider";
import { ShellIcon } from "./shell-icon";
import {
  getProjectNavigationHref,
  USER_GLOBAL_NAVIGATION,
  USER_PROJECT_NAVIGATION,
} from "@/lib/user-navigation";
import styles from "./user-shell.module.css";

type SearchProject = Readonly<{ id: string; name: string }>;
type SearchDestination = Readonly<{ label: string; detail: string; href: string }>;

export function UserShellSearchDialog({
  projects,
  selectedProjectId,
  onClose,
  onNavigate,
}: Readonly<{
  projects: readonly SearchProject[];
  selectedProjectId: string | null;
  onClose: () => void;
  onNavigate: () => void;
}>) {
  const t = useTranslate();
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const searchDestinations = useMemo<SearchDestination[]>(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const globalDestinations = USER_GLOBAL_NAVIGATION.map((item) => ({
      label: t(item.label),
      detail: t("全局页面"),
      href: item.href,
    }));
    const projectDestinations = projects.flatMap((project) => USER_PROJECT_NAVIGATION.map((item) => ({
      label: t(item.label),
      detail: project.name,
      href: getProjectNavigationHref(project.id, item.key),
      projectId: project.id,
      searchableText: `${project.name} ${t(item.label)}`.toLocaleLowerCase(),
    })));

    if (!normalizedQuery) {
      const currentProjectDestinations = selectedProjectId
        ? projectDestinations.filter((destination) => destination.projectId === selectedProjectId)
        : [];
      return [...globalDestinations, ...currentProjectDestinations].slice(0, 12).map(({ label, detail, href }) => ({ label, detail, href }));
    }

    const matchingGlobal = globalDestinations.filter((destination) => `${destination.label} ${destination.detail}`.toLocaleLowerCase().includes(normalizedQuery));
    const matchingProjects = projectDestinations.filter((destination) => destination.searchableText.includes(normalizedQuery));
    return [...matchingGlobal, ...matchingProjects].slice(0, 30);
  }, [projects, searchQuery, selectedProjectId, t]);

  function handleSearchKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusableElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]'),
    ).filter((element) => element.offsetParent !== null);
    if (focusableElements.length === 0) {
      event.preventDefault();
      searchInputRef.current?.focus();
      return;
    }
    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div className={styles.searchOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div data-inquiry-disabled className={`app-dialog-surface app-dialog-surface--modal ${styles.searchDialog}`} role="dialog" aria-modal="true" aria-labelledby="user-shell-search-title" onKeyDown={handleSearchKeyDown}>
        <div data-dialog-header className={`app-dialog-header ${styles.searchDialogHeader}`}>
          <div>
            <h2 id="user-shell-search-title"><UiText text="搜索与跳转"/></h2>
            <p><UiText text="按页面名称或你有权访问的项目查找路由。"/></p>
          </div>
          <button type="button" className={styles.iconButton} onClick={onClose} aria-label={t("关闭搜索")}><ShellIcon className={styles.icon} name="close" /></button>
        </div>
        <div data-dialog-body className={`app-dialog-content ${styles.searchDialogBody}`}>
          <label className={`app-field app-field-group ${styles.searchInputWrap}`}>
            <ShellIcon className={styles.icon} name="search" />
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={t("搜索入口或项目名称")}
              aria-label={t("搜索页面入口和项目")}
            />
            <kbd>ESC</kbd>
          </label>
          <p className={styles.searchScopeNote}><UiText text="仅搜索页面入口和项目名称，不搜索正文内容。"/></p>
          <div className={styles.searchResults}>
            {searchDestinations.length > 0 ? (
              <ul aria-label={t("可访问页面")}>
                {searchDestinations.map((destination) => (
                  <li key={`${destination.href}-${destination.detail}`}>
                    <Link href={destination.href} onClick={onNavigate}>
                      <span>{destination.label}</span>
                      <small>{destination.detail}</small>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.searchEmpty} role="status"><UiText text="没有匹配的可访问页面或项目。"/></p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
