"use client";
import "../app/user-workspace.css";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppearanceControls } from "./appearance-controls";
import { HeaderAccount } from "./header-account";
import { WorkspacePicker,selectWorkspace,useWorkspaceSelection } from "./workspace-scope";
import { BrandMark } from "./brand-mark";
import { useTranslate, UiText } from "./appearance-provider";
import { NotificationBell } from "@/components/notification-bell";
import { ShellIcon } from "./shell-icon";
import {
  getActiveGlobalNavigation,
  getProjectNavigationHref,
  getProjectRouteContext,
  getProjectSwitchHref,
  getUserPageLabel,
  USER_GLOBAL_NAVIGATION,
  USER_PROJECT_NAVIGATION,
  USER_PROJECTS_CHANGED_EVENT,
  USER_CURRENT_PROJECT_CHANGED_EVENT,
} from "@/lib/user-navigation";
import styles from "./user-shell.module.css";

const PROJECT_LIST_PAGE_SIZE = 50;
const LAST_PROJECT_STORAGE_KEY = "ai-project-os:user-shell:project-id";
const EMPTY_PROJECTS: readonly ProjectOption[] = [];

type ProjectOption = Readonly<{ id: string; name: string; archived: boolean; workspaceId?:string }>;
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
      projects.push({ id: candidate.id, name: candidate.name, archived: view === "archived",workspaceId:typeof candidate.workspaceId === "string"?candidate.workspaceId:undefined });
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

export function UserShell({ username,isSystemAdmin=false }: Readonly<{ username: string;isSystemAdmin?:boolean }>): React.JSX.Element {
  const t=useTranslate(),workspaceId=useWorkspaceSelection(username);
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [projectList, setProjectList] = useState<ProjectListState>({ status: "loading" });
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectRefreshToken, setProjectRefreshToken] = useState(0);
  const [mobileNavigationPath, setMobileNavigationPath] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [workspaceName,setWorkspaceName]=useState("");
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCloseButtonRef = useRef<HTMLButtonElement>(null);
  const searchReturnFocusRef = useRef<HTMLElement | null>(null);
  const synchronizedProjectRoute = useRef<string | null>(null);

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

  const allAccessibleProjects = projectList.status === "ready" ? projectList.projects : EMPTY_PROJECTS;
  const accessibleProjects = useMemo(()=>workspaceId?allAccessibleProjects.filter(project=>project.workspaceId===workspaceId):allAccessibleProjects,[allAccessibleProjects,workspaceId]);
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

  useEffect(() => {
    const viewport = window.matchMedia("(max-width: 760px)");
    const handleViewportChange = (event: MediaQueryListEvent): void => {
      if (event.matches) return;
      setMobileNavigationPath(null);
      if (document.activeElement === mobileCloseButtonRef.current) {
        window.requestAnimationFrame(() => searchButtonRef.current?.focus());
      }
    };
    viewport.addEventListener("change", handleViewportChange);
    return () => viewport.removeEventListener("change", handleViewportChange);
  }, []);

  const activeGlobalKey = getActiveGlobalNavigation(pathname);
  const routeProject = routeContext ? allAccessibleProjects.find((project) => project.id === routeContext.projectId) : undefined;
  const selectedProject = routeContext
    ? routeProject ?? null
    : accessibleProjects.find((project) => project.id === selectedProjectId) ?? null;

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(USER_CURRENT_PROJECT_CHANGED_EVENT, { detail: { projectId: selectedProject?.id ?? null } }));
  }, [selectedProject?.id]);

  useEffect(() => {
    if (!routeContext) { synchronizedProjectRoute.current = null; return; }
    if (!routeProject?.workspaceId) return;
    const routeKey = `${routeProject.id}:${routeProject.workspaceId}`;
    if (synchronizedProjectRoute.current === routeKey) return;
    synchronizedProjectRoute.current = routeKey;
    // A notification or deep link may enter a different workspace. Do this
    // once per entered project, so a manual workspace switch can still leave it.
    if (workspaceId !== routeProject.workspaceId) selectWorkspace(username, routeProject.workspaceId);
  }, [routeContext, routeProject, username, workspaceId]);

  const searchDestinations = useMemo<SearchDestination[]>(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const globalDestinations = USER_GLOBAL_NAVIGATION.map((item) => ({
      label: t(item.label),
      detail: t("全局页面"),
      href: item.href,
    }));
    const projectDestinations = accessibleProjects.flatMap((project) => USER_PROJECT_NAVIGATION.map((item) => ({
      label: t(item.label),
      detail: project.name,
      href: getProjectNavigationHref(project.id, item.key),
      projectId: project.id,
      searchableText: `${project.name} ${t(item.label)}`.toLocaleLowerCase(),
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
  }, [accessibleProjects, searchQuery, selectedProject,t]);

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
    ? t("正在加载可访问项目…")
    : projectList.status === "error"
      ? t("项目列表暂不可用")
      : accessibleProjects.length === 0
        ? t("暂无可访问项目")
        : t("选择项目");

  return (
    <div className={styles.root} data-user-shell-root>
      <aside id="user-shell-navigation" className={`${styles.sidebar} ${mobileNavigationOpen ? styles.sidebarOpen : ""}`} aria-label={t("主导航")}>
        <div className={styles.brandRow}>
          <Link href="/dashboard" className={styles.brand} onClick={projectLinkClick} aria-label={t("AI Project OS 工作台")}>
            <BrandMark size={30} priority/>
            <span>AI Project OS</span>
          </Link>
            <button ref={mobileCloseButtonRef} type="button" className={`${styles.iconButton} ${styles.mobileClose}`} onClick={() => closeMobileNavigation(true)} aria-label={t("关闭导航")}>
            <ShellIcon className={styles.icon} name="close" />
          </button>
        </div>

        <WorkspacePicker username={username} onNameChange={setWorkspaceName}/>
        <div className={styles.sectionLabel}>{t("常用")}</div>
        <nav className={styles.globalNavigation} aria-label={t("全局入口")}>
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
                <ShellIcon className={styles.icon} name={item.key} />
                <span>{t(item.label)}</span>
              </Link>
            );
          })}
        </nav>

        <div className={styles.sectionDivider} />
        <div className={styles.projectHeading}>
          <span className={styles.sectionLabel}>{t("当前项目")}</span>
          <label className={styles.projectPicker}>
            <span className={styles.projectDot} aria-hidden="true">{selectedProject?.name.slice(0, 1) ?? "·"}</span>
            <select
              id="user-shell-project-picker"
              value={selectedProject?.id ?? ""}
              onChange={handleProjectSelect}
              disabled={projectList.status !== "ready" || accessibleProjects.length === 0}
              aria-label={t("切换当前项目")}
              aria-describedby="user-shell-project-status"
            >
              <option value="">{t(projectSelectLabel)}</option>
              {(routeProject&&!accessibleProjects.some(p=>p.id===routeProject.id)?[routeProject,...accessibleProjects]:accessibleProjects).map((project) => (
                <option key={project.id} value={project.id}>{project.name}{project.archived ? t("（已归档）") : ""}</option>
              ))}
            </select>
            <ShellIcon className={styles.icon} name="chevron" />
          </label>
        </div>
        <p id="user-shell-project-status" className={styles.projectStatus} role={projectList.status === "error" ? "status" : undefined}>
          {projectList.status === "loading" ? t("正在读取有权访问的项目。") : projectList.status === "error" ? t("无法读取项目列表，请稍后重试。") : accessibleProjects.length === 0 ? t("当前没有可访问的项目。") : selectedProject ? `当前项目：${selectedProject.name}` : t("选择项目以查看项目入口。")}
        </p>
        {projectList.status === "error" ? <button type="button" className={styles.retryButton} onClick={retryProjectList}><UiText text="重试读取项目列表"/></button> : null}

        <nav className={styles.projectNavigation} aria-label={selectedProject ? `${selectedProject.name} 项目导航` : t("当前项目导航")}>
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
                <ShellIcon className={styles.icon} name={item.key} />
                <span>{t(item.label)}</span>
              </Link>
            ) : (
              <span key={item.key} className={`${className} ${styles.navLinkDisabled}`} aria-disabled="true" title={t("先选择一个可访问项目")}>
                <ShellIcon className={styles.icon} name={item.key} />
                <span>{t(item.label)}</span>
              </span>
            );
          })}
        </nav>

        <div className={styles.sidebarBottom}>
          <div className={styles.sectionDivider}/><div className={styles.sectionLabel}>{t('空间与资源')}</div>
          <nav aria-label={t('空间与资源')}>
           {([['/personal/configuration',t('资源配置'),'resources'],['/credits',t('额度与账单'),'credits'],['/team',t('我的团队'),'team']] as const).map(([href,label,icon])=><Link key={href} href={href} className={`${styles.navLink} ${pathname===href?styles.navLinkActive:''}`} aria-current={pathname===href?'page':undefined} onClick={projectLinkClick}><ShellIcon className={styles.icon} name={icon}/><span>{t(label)}</span></Link>)}
          </nav>
        </div>
      </aside>

      <button
        type="button"
        className={`${styles.mobileBackdrop} ${mobileNavigationOpen ? styles.mobileBackdropOpen : ""}`}
        onClick={() => closeMobileNavigation(true)}
        aria-label={t("关闭导航")}
        tabIndex={mobileNavigationOpen ? 0 : -1}
      />

      <header className={styles.topbar}>
        <div className={styles.breadcrumb}>
          <button
            ref={mobileMenuButtonRef}
            type="button"
            className={`${styles.iconButton} ${styles.mobileMenu}`}
            onClick={() => setMobileNavigationPath(pathname)}
            aria-label={t("打开导航")}
            aria-controls="user-shell-navigation"
            aria-expanded={mobileNavigationOpen}
          >
            <ShellIcon className={styles.icon} name="menu" />
          </button>
          {workspaceName?<><span className={styles.workspaceCrumb}>{workspaceName}</span><span className={styles.breadcrumbDivider} aria-hidden="true">›</span></>:null}
          <span className={styles.breadcrumbLabel}>{t(getUserPageLabel(pathname))}</span>
          {selectedProject && routeContext ? <><span className={styles.breadcrumbDivider} aria-hidden="true">/</span><span className={styles.breadcrumbCurrent}>{selectedProject.name}</span></> : null}
        </div>
        <div className={styles.topActions}>
          <button ref={searchButtonRef} type="button" className={styles.searchButton} onClick={openSearch} aria-haspopup="dialog" aria-label={t("搜索与跳转")}>
            <ShellIcon className={styles.icon} name="search" />
            <span>{t("搜索与跳转")}</span>
            <kbd>⌘ K</kbd>
          </button>
          <NotificationBell active={pathname === "/notifications" || pathname.startsWith("/notifications/")} compact/>
          <Link href="/guide" className={styles.iconButton} aria-label={t("帮助")} title={t("帮助")}><ShellIcon className={styles.icon} name="help"/></Link>
          <AppearanceControls/>
          <HeaderAccount username={username} isSystemAdmin={isSystemAdmin}/>
        </div>
      </header>
      <div className={styles.contentSpacer} aria-hidden="true" />

      {searchOpen ? (
        <div className={styles.searchOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) closeSearch(); }}>
          <div data-inquiry-disabled className={styles.searchDialog} role="dialog" aria-modal="true" aria-labelledby="user-shell-search-title" onKeyDown={handleSearchKeyDown}>
            <div className={styles.searchDialogHeader}>
              <div>
                <h2 id="user-shell-search-title"><UiText text="搜索与跳转"/></h2>
                <p><UiText text="按页面名称或你有权访问的项目查找路由。"/></p>
              </div>
              <button type="button" className={styles.iconButton} onClick={closeSearch} aria-label={t("关闭搜索")}><ShellIcon className={styles.icon} name="close" /></button>
            </div>
            <label className={styles.searchInputWrap}>
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
                      <Link href={destination.href} onClick={() => { closeSearch(); setMobileNavigationPath(null); }}>
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
      ) : null}
    </div>
  );
}
