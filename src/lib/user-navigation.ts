/** Direct user-facing destinations shown in the persistent application shell. */
export const USER_PROJECTS_CHANGED_EVENT = "ai-project-os:user-projects-changed";

export function notifyUserProjectsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(USER_PROJECTS_CHANGED_EVENT));
}

export const USER_GLOBAL_NAVIGATION = [
  { key: "dashboard", label: "工作台", href: "/dashboard" },
  { key: "ask", label: "智能问答", href: "/ask" },
  { key: "projects", label: "我的项目", href: "/personal/projects" },
  { key: "knowledge", label: "我的知识", href: "/personal/knowledge" },
] as const;

export type UserGlobalNavigationKey = (typeof USER_GLOBAL_NAVIGATION)[number]["key"];

/** The six project destinations that remain visible in the shell. */
export const USER_PROJECT_NAVIGATION = [
  { key: "plan", label: "项目计划", segment: "plan" },
  { key: "materials", label: "项目资料", segment: "materials" },
  { key: "overview", label: "项目概览", segment: "" },
  { key: "intelligence", label: "简报与调查", segment: "intelligence" },
  { key: "automations", label: "项目自动化", segment: "automations" },
  { key: "governance", label: "项目管理", segment: "governance" },
] as const;

export type UserProjectNavigationKey = (typeof USER_PROJECT_NAVIGATION)[number]["key"];

export type ProjectRouteContext = Readonly<{
  projectId: string;
  section: UserProjectNavigationKey;
}>;

const projectDetailSections: Readonly<Record<string, UserProjectNavigationKey>> = {
  plan: "plan",
  materials: "materials",
  assets: "materials",
  "external-sources": "materials",
  intelligence: "intelligence",
  control: "intelligence",
  memory: "intelligence",
  "memory-quality": "governance",
  world: "governance",
  automations: "automations",
  governance: "governance",
  actions: "governance",
  "mcp-actions": "governance",
  "mcp-export": "governance",
  members: "governance",
  configuration: "governance",
  repositories: "governance",
  tools: "governance",
  jobs: "governance",
  "github-syncs": "governance",
};

const userShellExcludedRoots = new Set(["admin", "system", "settings", "login", "register", "recover", "setup", "accept-invitation"]);

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function getProjectRouteContext(pathname: string): ProjectRouteContext | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "projects" || !segments[1]) return null;

  const projectId = decodePathSegment(segments[1]);
  if (!projectId) return null;

  const section = segments[2] ? projectDetailSections[segments[2]] ?? "overview" : "overview";
  return { projectId, section };
}

export function getProjectNavigationHref(projectId: string, section: UserProjectNavigationKey): string {
  const item = USER_PROJECT_NAVIGATION.find((candidate) => candidate.key === section);
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return item?.segment ? `${base}/${item.segment}` : base;
}

/**
 * Switch projects at the current main section and drop page-specific query
 * state such as cursors, run IDs, source IDs, and filters.
 */
export function getProjectSwitchHref(projectId: string, pathname: string): string {
  return getProjectNavigationHref(projectId, getProjectRouteContext(pathname)?.section ?? "overview");
}

export function getActiveGlobalNavigation(pathname: string): UserGlobalNavigationKey | null {
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return "dashboard";
  if (pathname === "/ask" || pathname.startsWith("/ask/")) return "ask";
  if (pathname === "/projects" || pathname === "/personal/projects" || pathname.startsWith("/personal/projects/")) return "projects";
  if (pathname === "/personal/knowledge" || pathname.startsWith("/personal/knowledge/")) return "knowledge";
  return null;
}

export function isUserShellPath(pathname: string): boolean {
  const root = pathname.split("/").filter(Boolean)[0] ?? "";
  return !userShellExcludedRoots.has(root);
}

export function getUserPageLabel(pathname: string): string {
  const globalItem = USER_GLOBAL_NAVIGATION.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
  if (globalItem) return globalItem.label;
  if (pathname === "/projects") return "我的项目";

  const projectContext = getProjectRouteContext(pathname);
  if (projectContext) {
    return USER_PROJECT_NAVIGATION.find((item) => item.key === projectContext.section)?.label ?? "项目概览";
  }

  if (pathname === "/personal") return "个人空间";
  if (pathname === "/personal/configuration") return "个人配置";
  if (pathname === "/personal/models") return "个人模型";
  if (pathname === "/personal/connections/git" || pathname === "/personal/connections/mcp") return "个人连接";
  if (pathname === "/team" || pathname.startsWith("/team/")) return "空间与团队";
  if (pathname === "/profile" || pathname.startsWith("/profile/")) return "账户设置";
  if (pathname === "/guide" || pathname.startsWith("/guide/")) return "帮助";
  if (pathname === "/notifications" || pathname.startsWith("/notifications/")) return "通知中心";
  if (pathname === "/credits" || pathname.startsWith("/credits/")) return "用量与额度";
  if (pathname === "/connections" || pathname.startsWith("/connections/")) return "连接管理";
  return "AI Project OS";
}
