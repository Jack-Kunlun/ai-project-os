"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NotificationBell } from "@/components/notification-bell";
import {
  getActiveGlobalNavigation,
  getProjectNavigationHref,
  getProjectRouteContext,
  getProjectSwitchHref,
  getUserPageLabel,
  USER_GLOBAL_NAVIGATION,
  USER_PROJECT_NAVIGATION,
  USER_PROJECTS_CHANGED_EVENT,
  type UserProjectNavigationKey,
} from "@/lib/user-navigation";
import styles from "./user-shell.module.css";

const PROJECT_LIST_PAGE_SIZE = 50;
const LAST_PROJECT_STORAGE_KEY = "ai-project-os:user-shell:project-id";
const EMPTY_PROJECTS: readonly ProjectOption[] = [];

type ProjectOption = Readonly<{ id: string; name: string; archived: boolean }>;
type ProjectListState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "ready"; projects: readonly ProjectOption[] }>;
type SearchDestination = Readonly<{ label: string; detail: string; href: string }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchProjectView(view: "active" | "archived", signal: AbortSignal): Promise<ProjectOption[]> {
  const projects: ProjectOption[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const query = new URLSearchParams({ view, page: String(page), pageSize: String(PROJECT_LIST_PAGE_SIZE) });
    const response = await fetch(`/api/projects?${query.toString()}`, { cache: "no-store", signal });
    if (!response.ok) throw new Error("Project list request failed");

    const payload: unknown = await response.json();
    if (!isObject(payload) || !Array.isArray(payload.projects) || !isObject(payload.pagination)) {
      throw new Error("Project list response was invalid");
    }
    const returnedTotalPages = payload.pagination.totalPages;
    if (!Number.isSafeInteger(returnedTotalPages) || Number(returnedTotalPages) < 1) {
      throw new Error("Project list pagination was invalid");
    }
    totalPages = Number(returnedTotalPages);

    for (const candidate of payload.projects) {
      if (!isObject(candidate) || typeof candidate.id !== "string" || !candidate.id || typeof candidate.name !== "string") {
        throw new Error("Project list contained an invalid project");
      }
      projects.push({ id: candidate.id, name: candidate.name, archived: view === "archived" });
    }
    page += 1;
  }

  return projects;
}

async function fetchAccessibleProjects(signal: AbortSignal): Promise<ProjectOption[]> {
  const [active, archived] = await Promise.all([
    fetchProjectView("active", signal),
    fetchProjectView("archived", signal),
  ]);
  const seen = new Set<string>();
  return [...active, ...archived].filter((project) => {
    if (seen.has(project.id)) return false;
    seen.add(project.id);
    return true;
  });
}

function readStoredProjectId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberProjectId(projectId: string | null): void {
  try {
    if (projectId) window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
    else window.localStorage.removeItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    // Navigation still works when browser storage is unavailable.
  }
}

export function UserShell({ username }: Readonly<{ username: string }>): React.JSX.Element {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [projectList, setProjectList] = useState<ProjectListState>({ status: "loading" });
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectRefreshToken, setProjectRefreshToken] = useState(0);
  const [mobileNavigationPath, setMobileNavigationPath] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const searchReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchAccessibleProjects(controller.signal)
      .then((projects) => { if (!controller.signal.aborted) setProjectList({ status: "ready", projects }); })
      .catch(() => {
        if (!controller.signal.aborted) setProjectList({ status: "error" });
      });
    return () => controller.abort();
  }, [projectRefreshToken]);

  useEffect(() => {
    const refresh = () => setProjectRefreshToken((previous) => previous + 1);
    window.addEventListener(USER_PROJECTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(USER_PROJECTS_CHANGED_EVENT, refresh);
  }, []);

  const accessibleProjects = projectList.status === "ready" ? projectList.projects : EMPTY_PROJECTS;
  const routeContext = useMemo(() => getProjectRouteContext(pathname), [pathname]);
  const mobileNavigationOpen = mobileNavigationPath === pathname;

  useEffect(() => {
    if (projectList.status !== "ready") return;

    const routeProjectId = routeContext?.projectId;
    if (routeProjectId) {
      const selectedFromRoute = accessibleProjects.find((project) => project.id === routeProjectId);
      rememberProjectId(selectedFromRoute?.id ?? null);
      return;
    }

    const storedProjectId = readStoredProjectId();
    const selectedFromStorage = storedProjectId ? accessibleProjects.find((project) => project.id === storedProjectId) : undefined;
    if (selectedFromStorage) rememberProjectId(selectedFromStorage.id);
    else if (storedProjectId) rememberProjectId(null);
    const frame = window.requestAnimationFrame(() => setSelectedProjectId(selectedFromStorage?.id ?? null));
    return () => window.cancelAnimationFrame(frame);
  }, [accessibleProjects, projectList.status, routeContext]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      return () => {
        const target = searchReturnFocusRef.current;
        if (target?.isConnected) target.focus();
      };
    }
    return undefined;
  }, [searchOpen]);

  useEffect(() => {
    if (!mobileNavigationOpen || !window.matchMedia("(max-width: 760px)").matches) return;
    const frame = window.requestAnimationFrame(() => mobileCloseButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mobileNavigationOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const openSearch = useCallback(() => {
    searchReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : searchButtonRef.current;
    setMobileNavigationPath(null);
    setSearchOpen(true);
  }, []);

  const closeMobileNavigation = useCallback((restoreFocus = false): void => {
    setMobileNavigationPath(null);
    if (restoreFocus) window.requestAnimationFrame(() => mobileMenuButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    function handleGlobalKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
        return;
      }
      if (event.key !== "Escape") return;
      if (searchOpen) closeSearch();
      else if (mobileNavigationOpen) {
        closeMobileNavigation(true);
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, [closeMobileNavigation, closeSearch, mobileNavigationOpen, openSearch, searchOpen]);

  const activeGlobalKey = getActiveGlobalNavigation(pathname);
  const routeProject = routeContext ? accessibleProjects.find((project) => project.id === routeContext.projectId) : undefined;
  const selectedProject = routeContext
    ? routeProject ?? null
    : accessibleProjects.find((project) => project.id === selectedProjectId) ?? null;

  const searchDestinations = useMemo<SearchDestination[]>(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const globalDestinations = USER_GLOBAL_NAVIGATION.map((item) => ({
      label: item.label,
      detail: "全局页面",
      href: item.href,
    }));
    const projectDestinations = accessibleProjects.flatMap((project) => USER_PROJECT_NAVIGATION.map((item) => ({
      label: item.label,
      detail: project.name,
      href: getProjectNavigationHref(project.id, item.key),
      projectId: project.id,
      searchableText: `${project.name} ${item.label}`.toLocaleLowerCase(),
    })));

    if (!normalizedQuery) {
      const currentProjectDestinations = selectedProject
        ? projectDestinations.filter((destination) => destination.projectId === selectedProject.id)
        : [];
      return [...globalDestinations, ...currentProjectDestinations].slice(0, 12).map(({ label, detail, href }) => ({ label, detail, href }));
    }

    const matchingGlobal = globalDestinations.filter((destination) => `${destination.label} ${destination.detail}`.toLocaleLowerCase().includes(normalizedQuery));
    const matchingProjects = projectDestinations.filter((destination) => destination.searchableText.includes(normalizedQuery));
    return [...matchingGlobal, ...matchingProjects].slice(0, 30);
  }, [accessibleProjects, searchQuery, selectedProject]);

  function selectProject(projectId: string): void {
    const project = accessibleProjects.find((candidate) => candidate.id === projectId);
    if (!project) return;
    setSelectedProjectId(project.id);
    rememberProjectId(project.id);
    setMobileNavigationPath(null);
    router.push(getProjectSwitchHref(project.id, pathname));
  }

  function handleProjectSelect(event: React.ChangeEvent<HTMLSelectElement>): void {
    if (event.currentTarget.value) selectProject(event.currentTarget.value);
  }

  function projectLinkClick(): void {
    setMobileNavigationPath(null);
  }

  function retryProjectList(): void {
    setProjectList({ status: "loading" });
    setProjectRefreshToken((previous) => previous + 1);
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
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

  const projectSelectLabel = projectList.status === "loading"
    ? "正在加载可访问项目…"
    : projectList.status === "error"
      ? "项目列表暂不可用"
      : accessibleProjects.length === 0
        ? "暂无可访问项目"
        : "选择项目";

  return (
    <div className={styles.root} data-user-shell-root>
      <aside id="user-shell-navigation" className={`${styles.sidebar} ${mobileNavigationOpen ? styles.sidebarOpen : ""}`} aria-label="主导航">
        <div className={styles.brandRow}>
          <Link href="/dashboard" className={styles.brand} onClick={projectLinkClick} aria-label="AI Project OS 工作台">
            <span className={styles.brandMark} aria-hidden="true">OS</span>
            <span>AI Project OS</span>
          </Link>
            <button ref={mobileCloseButtonRef} type="button" className={`${styles.iconButton} ${styles.mobileClose}`} onClick={() => closeMobileNavigation(true)} aria-label="关闭导航">
            <ShellIcon name="close" />
          </button>
        </div>

        <nav className={styles.globalNavigation} aria-label="全局入口">
          {USER_GLOBAL_NAVIGATION.map((item) => {
            const active = activeGlobalKey === item.key;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}
                onClick={projectLinkClick}
              >
                <ShellIcon name={item.key} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className={styles.sectionDivider} />
        <div className={styles.projectHeading}>
          <span className={styles.sectionLabel}>当前项目</span>
          <label className={styles.projectPicker}>
            <span className={styles.projectDot} aria-hidden="true">{selectedProject?.name.slice(0, 1) ?? "·"}</span>
            <select
              value={selectedProject?.id ?? ""}
              onChange={handleProjectSelect}
              disabled={projectList.status !== "ready" || accessibleProjects.length === 0}
              aria-label="切换当前项目"
              aria-describedby="user-shell-project-status"
            >
              <option value="">{projectSelectLabel}</option>
              {accessibleProjects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}{project.archived ? "（已归档）" : ""}</option>
              ))}
            </select>
            <ShellIcon name="chevron" />
          </label>
        </div>
        <p id="user-shell-project-status" className={styles.projectStatus} role={projectList.status === "error" ? "status" : undefined}>
          {projectList.status === "loading" ? "正在读取有权访问的项目。" : projectList.status === "error" ? "无法读取项目列表，请稍后重试。" : accessibleProjects.length === 0 ? "当前没有可访问的项目。" : selectedProject ? `当前项目：${selectedProject.name}` : "选择项目以查看项目入口。"}
        </p>
        {projectList.status === "error" ? <button type="button" className={styles.retryButton} onClick={retryProjectList}>重试读取项目列表</button> : null}

        <nav className={styles.projectNavigation} aria-label={selectedProject ? `${selectedProject.name} 项目导航` : "当前项目导航"}>
          {USER_PROJECT_NAVIGATION.map((item) => {
            const active = routeContext?.section === item.key && routeContext.projectId === selectedProject?.id;
            const className = `${styles.navLink} ${styles.projectNavLink} ${active ? styles.navLinkActive : ""}`;
            return selectedProject ? (
              <Link
                key={item.key}
                href={getProjectNavigationHref(selectedProject.id, item.key)}
                aria-current={active ? "page" : undefined}
                className={className}
                onClick={projectLinkClick}
              >
                <ShellIcon name={item.key} />
                <span>{item.label}</span>
              </Link>
            ) : (
              <span key={item.key} className={`${className} ${styles.navLinkDisabled}`} aria-disabled="true" title="先选择一个可访问项目">
                <ShellIcon name={item.key} />
                <span>{item.label}</span>
              </span>
            );
          })}
        </nav>

        <div className={styles.sidebarBottom}>
          <div className={styles.sidebarUtilities}>
            <Link href="/team" className={styles.utilityLink} onClick={projectLinkClick} aria-current={pathname === "/team" || pathname.startsWith("/team/") ? "page" : undefined}>
              <ShellIcon name="team" />
              <span>空间与团队</span>
            </Link>
            <Link href="/guide" className={styles.utilityLink} onClick={projectLinkClick} aria-current={pathname === "/guide" || pathname.startsWith("/guide/") ? "page" : undefined}>
              <ShellIcon name="help" />
              <span>帮助</span>
            </Link>
          </div>
          <Link href="/profile" className={styles.accountLink} onClick={projectLinkClick} aria-label={`账户设置，${username}`} aria-current={pathname === "/profile" || pathname.startsWith("/profile/") ? "page" : undefined}>
            <span className={styles.avatar} aria-hidden="true">{username.slice(0, 1).toUpperCase()}</span>
            <span className={styles.accountLabel}>{username} · 账户</span>
            <ShellIcon name="chevron" />
          </Link>
        </div>
      </aside>

      <button
        type="button"
        className={`${styles.mobileBackdrop} ${mobileNavigationOpen ? styles.mobileBackdropOpen : ""}`}
        onClick={() => closeMobileNavigation(true)}
        aria-label="关闭导航"
        tabIndex={mobileNavigationOpen ? 0 : -1}
      />

      <header className={styles.topbar}>
        <div className={styles.breadcrumb}>
          <button
            ref={mobileMenuButtonRef}
            type="button"
            className={`${styles.iconButton} ${styles.mobileMenu}`}
            onClick={() => setMobileNavigationPath(pathname)}
            aria-label="打开导航"
            aria-controls="user-shell-navigation"
            aria-expanded={mobileNavigationOpen}
          >
            <ShellIcon name="menu" />
          </button>
          <span>{getUserPageLabel(pathname)}</span>
          {selectedProject && routeContext ? <><span className={styles.breadcrumbDivider} aria-hidden="true">/</span><span className={styles.breadcrumbCurrent}>{selectedProject.name}</span></> : null}
        </div>
        <div className={styles.topActions}>
          <button ref={searchButtonRef} type="button" className={styles.searchButton} onClick={openSearch} aria-haspopup="dialog" aria-label="搜索与跳转">
            <ShellIcon name="search" />
            <span>搜索与跳转</span>
            <kbd>⌘ K</kbd>
          </button>
          <NotificationBell active={pathname === "/notifications" || pathname.startsWith("/notifications/")} />
        </div>
      </header>
      <div className={styles.contentSpacer} aria-hidden="true" />

      {searchOpen ? (
        <div className={styles.searchOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) closeSearch(); }}>
          <div className={styles.searchDialog} role="dialog" aria-modal="true" aria-labelledby="user-shell-search-title" onKeyDown={handleSearchKeyDown}>
            <div className={styles.searchDialogHeader}>
              <div>
                <h2 id="user-shell-search-title">搜索与跳转</h2>
                <p>按页面名称或你有权访问的项目查找路由。</p>
              </div>
              <button type="button" className={styles.iconButton} onClick={closeSearch} aria-label="关闭搜索"><ShellIcon name="close" /></button>
            </div>
            <label className={styles.searchInputWrap}>
              <ShellIcon name="search" />
              <input
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                placeholder="搜索入口或项目名称"
                aria-label="搜索页面入口和项目"
              />
              <kbd>ESC</kbd>
            </label>
            <p className={styles.searchScopeNote}>仅搜索页面入口和项目名称，不搜索正文内容。</p>
            <div className={styles.searchResults}>
              {searchDestinations.length > 0 ? (
                <ul aria-label="可访问页面">
                  {searchDestinations.map((destination) => (
                    <li key={`${destination.href}-${destination.detail}`}>
                      <Link href={destination.href} onClick={() => { closeSearch(); setMobileNavigationPath(null); }}>
                        <span>{destination.label}</span>
                        <small>{destination.detail}</small>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.searchEmpty} role="status">没有匹配的可访问页面或项目。</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ShellIconName = UserProjectNavigationKey | "dashboard" | "ask" | "projects" | "knowledge" | "team" | "help" | "chevron" | "close" | "menu" | "search";

function ShellIcon({ name }: Readonly<{ name: ShellIconName }>): React.JSX.Element {
  const paths: Record<ShellIconName, React.ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    ask: <><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8 8 0 0 1-3.4-.75L4 20l1.3-3.3A7.2 7.2 0 0 1 4 12c0-4.4 3.6-8 8-8s8 3.1 8 7.5Z" /><path d="M8 11h8M8 14h5" /></>,
    projects: <><path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /><path d="M3 9h18" /></>,
    knowledge: <><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H20v19H7.5A2.5 2.5 0 0 1 5 18.5Z" /><path d="M5 18.5A2.5 2.5 0 0 1 7.5 16H20M9 6h7M9 9h7" /></>,
    plan: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" /></>,
    materials: <><path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /><path d="M3 9h18" /></>,
    overview: <><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="5" rx="1" /><rect x="13" y="10" width="8" height="11" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /></>,
    intelligence: <><path d="M3 19h18M5 16l4-5 3 2 6-8" /><path d="M15 5h3v3" /></>,
    automations: <><path d="m13 2-3 8h7l-6 12 2-9H6l7-11Z" /></>,
    governance: <><path d="M12 3 4 7v5c0 5 3.4 8.2 8 10 4.6-1.8 8-5 8-10V7l-8-4Z" /><path d="m9 12 2 2 4-4" /></>,
    team: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M18 14a4 4 0 0 1 3 4v2" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.4 2.4 0 1 1 3.8 1.9c-.9.6-1.5 1-1.5 2.3M12 17h.01" /></>,
    chevron: <path d="m7 10 5 5 5-5" />,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={styles.icon} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
