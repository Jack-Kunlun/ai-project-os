/**
 * Canonical project navigation contract.
 *
 * The browser may carry state between the project pages, but the state is
 * always rebuilt from this finite route/query allowlist.  Callers should use
 * `buildProjectHref` for links and `parseProjectPageState` for client state;
 * `safeProjectReturnTo` is the only supported way to restore a return link.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;
const SEARCH_MAX_LENGTH = 120;
const RETURN_TO_MAX_LENGTH = 2_048;
const BASE_ORIGIN = "https://ai-project-os.invalid";

export const PROJECT_NAVIGATION_ROUTES = [
  "overview",
  "plan",
  "materials",
  "materialsReview",
  "governance",
  "assets",
  "repositories",
  "externalSources",
  "memory",
  "world",
  "tools",
  "control",
  "intelligence",
  "automations",
  "actions",
  "job",
] as const;

export type ProjectNavigationRoute = typeof PROJECT_NAVIGATION_ROUTES[number];
export type ProjectNavigationSource =
  | "dashboard"
  | "overview"
  | "notifications"
  | "plan"
  | "materials"
  | "governance"
  | "control"
  | "intelligence"
  | "automations"
  | "actions";

export const PROJECT_JOB_STATUS_VALUES = ["queued", "waitingConsent", "running", "succeeded", "failed", "unknown", "cancelled"] as const;
export type ProjectJobStatus = typeof PROJECT_JOB_STATUS_VALUES[number];

export const PROJECT_PLAN_STATUS_VALUES = ["proposed", "planned", "inProgress", "blocked", "completed", "cancelled"] as const;
export type ProjectPlanStatus = typeof PROJECT_PLAN_STATUS_VALUES[number];

const SOURCE_VALUES: readonly ProjectNavigationSource[] = [
  "dashboard",
  "overview",
  "notifications",
  "plan",
  "materials",
  "governance",
  "control",
  "intelligence",
  "automations",
  "actions",
];
const NOTIFICATION_VIEW_VALUES = ["all", "unread", "pending", "system"] as const;
const MATERIAL_KIND_VALUES = ["all", "document", "screenshot", "github", "git", "web", "manual"] as const;
const ASSET_KIND_VALUES = ["all", "text", "document", "spreadsheet", "presentation", "image"] as const;
const ASSET_STATUS_VALUES = ["all", "uploaded", "parsing", "waitingVision", "awaitingReview", "ready", "failed"] as const;
const REVIEW_TYPE_VALUES = ["all", "decision", "progress", "issue", "risk"] as const;
const FOCUS_ANCHORS = new Set([
  "current-state",
  "task-runs",
  "ai-usage",
  "agent-investigation",
  "project-brief",
  "runtime-readiness",
  "automation-preview",
  "review-queue",
  "impact-signals",
  "sources-heading",
  "items-heading",
  "project-item-form",
]);
const AUTOMATION_KIND_VALUES = ["repositorySync", "memoryQuality", "memoryIndex", "projectBrief", "webSourceSync", "projectPlanHealth"] as const;
const OPERATION_KIND_VALUES = [
  "assetExtract",
  "githubScan",
  "githubMaterialSync",
  "githubProjectSync",
  "gitRepositorySync",
  "memoryIndex",
  "autoExtract",
  "semanticSearch",
  "ragAnswer",
  "projectBrief",
  "projectAgent",
] as const;

type QueryKey = "status" | "kind" | "tab" | "filter" | "view" | "focus" | "cursor" | "search" | "run" | "action" | "page" | "from" | "returnTo";

type RouteDefinition = Readonly<{
  suffix: string | null;
  queryKeys: readonly QueryKey[];
}>;

const ROUTE_DEFINITIONS: Readonly<Record<ProjectNavigationRoute, RouteDefinition>> = Object.freeze({
  overview: { suffix: "", queryKeys: ["focus", "from", "returnTo"] },
  plan: { suffix: "/plan", queryKeys: ["status", "focus", "from", "returnTo"] },
  materials: { suffix: "/materials", queryKeys: ["view", "search", "kind", "page", "focus", "from", "returnTo"] },
  materialsReview: { suffix: "/materials/review", queryKeys: ["search", "filter", "cursor", "focus", "from", "returnTo"] },
  governance: { suffix: "/governance", queryKeys: ["status", "kind", "search", "cursor", "focus", "from", "returnTo"] },
  assets: { suffix: "/assets", queryKeys: ["status", "kind", "search", "page", "focus", "from", "returnTo"] },
  repositories: { suffix: "/repositories", queryKeys: ["status", "search", "cursor", "focus", "from", "returnTo"] },
  externalSources: { suffix: "/external-sources", queryKeys: ["status", "kind", "search", "page", "focus", "from", "returnTo"] },
  memory: { suffix: "/memory", queryKeys: ["tab", "status", "kind", "search", "cursor", "focus", "from", "returnTo"] },
  world: { suffix: "/world", queryKeys: ["status", "kind", "search", "cursor", "focus", "from", "returnTo"] },
  tools: { suffix: "/tools", queryKeys: ["status", "kind", "search", "cursor", "focus", "from", "returnTo"] },
  control: { suffix: "/control", queryKeys: ["tab", "focus", "from", "returnTo"] },
  intelligence: { suffix: "/intelligence", queryKeys: ["tab", "focus", "from", "returnTo"] },
  automations: { suffix: "/automations", queryKeys: ["run", "from", "view", "cursor", "focus", "returnTo"] },
  actions: { suffix: "/actions", queryKeys: ["status", "kind", "action", "from", "returnTo"] },
  job: { suffix: null, queryKeys: ["status", "kind", "search", "view", "cursor", "focus", "from", "returnTo"] },
});

export type ProjectNavigationInput = Readonly<{
  jobId?: string;
  status?: string | null;
  kind?: string | null;
  tab?: string | null;
  filter?: string | null;
  view?: string | null;
  focus?: string | null;
  cursor?: string | null;
  search?: string | null;
  run?: string | null;
  action?: string | null;
  page?: string | number | null;
  from?: ProjectNavigationSource | null;
  returnTo?: string | null;
}>;

export type ProjectNavigationState = Readonly<{
  route: ProjectNavigationRoute;
  jobId: string | null;
  status: string | null;
  kind: string | null;
  tab: string | null;
  filter: string | null;
  view: string | null;
  focus: string | null;
  cursor: string | null;
  search: string | null;
  run: string | null;
  action: string | null;
  page: number | null;
  from: ProjectNavigationSource | null;
  returnTo: string | null;
}>;

function isUuid(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && UUID_PATTERN.test(value);
}

function isCursor(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && CURSOR_PATTERN.test(value);
}

function isSource(value: string | null | undefined): value is ProjectNavigationSource {
  return value !== null && value !== undefined && SOURCE_VALUES.includes(value as ProjectNavigationSource);
}

function isAllowedFocus(value: string | null | undefined): value is string {
  return isUuid(value) || (value !== null && value !== undefined && FOCUS_ANCHORS.has(value));
}

function isNonEmptySearch(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim().length > 0 && value.trim().length <= SEARCH_MAX_LENGTH;
}

function isAllowedStatus(route: ProjectNavigationRoute, value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  if (route === "plan") return PROJECT_PLAN_STATUS_VALUES.includes(value as ProjectPlanStatus);
  if (route === "governance" || route === "job") return PROJECT_JOB_STATUS_VALUES.includes(value as ProjectJobStatus);
  if (route === "assets") return ASSET_STATUS_VALUES.includes(value as (typeof ASSET_STATUS_VALUES)[number]);
  if (route === "actions") return value === "pending" || value === "approved" || value === "rejected" || value === "cancelled" || value === "completed";
  return false;
}

function isAllowedKind(route: ProjectNavigationRoute, value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  if (route === "materials") return MATERIAL_KIND_VALUES.includes(value as (typeof MATERIAL_KIND_VALUES)[number]);
  if (route === "assets") return ASSET_KIND_VALUES.includes(value as (typeof ASSET_KIND_VALUES)[number]);
  if (route === "automations") return AUTOMATION_KIND_VALUES.includes(value as (typeof AUTOMATION_KIND_VALUES)[number]);
  if (route === "governance" || route === "job") return OPERATION_KIND_VALUES.includes(value as (typeof OPERATION_KIND_VALUES)[number]);
  return false;
}

function isAllowedTab(route: ProjectNavigationRoute, value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  if (route === "control") return value === "model" || value === "jobs";
  if (route === "intelligence") return value === "readiness" || value === "brief" || value === "investigation";
  if (route === "memory") return value === "overview" || value === "index" || value === "quality";
  return false;
}

function isAllowedFilter(route: ProjectNavigationRoute, value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  return route === "materialsReview" && REVIEW_TYPE_VALUES.includes(value as (typeof REVIEW_TYPE_VALUES)[number]);
}

function isAllowedView(route: ProjectNavigationRoute, value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  if (route === "materials") return value === "add";
  if (route === "job" || route === "automations") return NOTIFICATION_VIEW_VALUES.includes(value as (typeof NOTIFICATION_VIEW_VALUES)[number]);
  return false;
}

function readUnique(params: URLSearchParams, key: string): string | null | undefined {
  const values = params.getAll(key);
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] ?? "" : null;
}

function canonicalProjectPath(projectId: string, route: ProjectNavigationRoute, jobId?: string): string | null {
  if (!isUuid(projectId)) return null;
  const encodedProjectId = encodeURIComponent(projectId);
  const definition = ROUTE_DEFINITIONS[route];
  if (route === "job") {
    return isUuid(jobId) ? `/projects/${encodedProjectId}/jobs/${jobId}` : null;
  }
  return `/projects/${encodedProjectId}${definition.suffix ?? ""}`;
}

function canonicalParamValue(route: ProjectNavigationRoute, key: QueryKey, value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  if (key === "from") return isSource(value) ? value : null;
  if (key === "focus" || key === "run" || key === "action") return key === "focus" ? (isAllowedFocus(value) ? value : null) : (isUuid(value) ? value : null);
  if (key === "cursor") return isCursor(value) ? value : null;
  if (key === "status") return isAllowedStatus(route, value) ? value : null;
  if (key === "kind") return isAllowedKind(route, value) ? value : null;
  if (key === "tab") return isAllowedTab(route, value) ? value : null;
  if (key === "view") return isAllowedView(route, value) ? value : null;
  if (key === "filter") return isAllowedFilter(route, value) ? value : null;
  if (key === "page") return /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? String(Number(value)) : null;
  if (key === "search") return isNonEmptySearch(value) ? value.trim() : null;
  return null;
}

function parseState(
  route: ProjectNavigationRoute,
  projectId: string,
  params: URLSearchParams,
  strict: boolean,
  jobId: string | null = null,
): ProjectNavigationState | null {
  const definition = ROUTE_DEFINITIONS[route];
  const allowedKeys = new Set<string>(definition.queryKeys);
  for (const key of new Set(params.keys())) {
    if (!allowedKeys.has(key) || params.getAll(key).length !== 1) return null;
  }

  const values: Partial<Record<QueryKey, string | null>> = {};
  for (const key of definition.queryKeys) {
    if (key === "returnTo") continue;
    const value = readUnique(params, key);
    if (value === null) return null;
    const normalized = canonicalParamValue(route, key, value);
    if (value !== undefined && normalized === null) {
      if (strict) return null;
      continue;
    }
    if (normalized !== null) values[key] = normalized;
  }

  const returnValue = readUnique(params, "returnTo");
  if (returnValue === null) return null;
  const from = (values.from ?? null) as ProjectNavigationSource | null;
  const returnTo = returnValue === undefined ? null : safeProjectReturnTo(projectId, returnValue, { from });
  if (returnValue !== undefined && returnTo === null) return null;

  return Object.freeze({
    route,
    jobId: route === "job" ? jobId : null,
    status: values.status ?? null,
    kind: values.kind ?? null,
    tab: values.tab ?? null,
    filter: values.filter ?? null,
    view: values.view ?? null,
    focus: values.focus ?? null,
    cursor: values.cursor ?? null,
    search: values.search ?? null,
    run: values.run ?? null,
    action: values.action ?? null,
    page: values.page === undefined || values.page === null ? null : Number(values.page),
    from,
    returnTo,
  });
}

/** Build a canonical same-project or global project-context link. */
export function buildProjectHref(projectId: string, route: ProjectNavigationRoute, input: ProjectNavigationInput = {}): string {
  const path = canonicalProjectPath(projectId, route, input.jobId);
  if (path === null) return "/projects";
  const params = new URLSearchParams();
  const definition = ROUTE_DEFINITIONS[route];
  for (const key of definition.queryKeys) {
    if (key === "returnTo") continue;
    const rawValue = key === "page" ? input.page : input[key];
    const value = canonicalParamValue(route, key, rawValue === undefined || rawValue === null ? rawValue : String(rawValue));
    if (key === "page" && value === "1") continue;
    if (value !== null) params.set(key, value);
  }
  if (input.returnTo) {
    const from = isSource(input.from) ? input.from : null;
    const returnTo = safeProjectReturnTo(projectId, input.returnTo, { from });
    if (returnTo !== null) params.set("returnTo", returnTo);
  }
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

/** Parse a project page's query state; invalid values simply do not apply. */
export function parseProjectPageState(route: ProjectNavigationRoute, projectId: string, params: URLSearchParams): ProjectNavigationState {
  return parseState(route, projectId, params, false) ?? Object.freeze({
    route,
    jobId: null,
    status: null,
    kind: null,
    tab: null,
    filter: null,
    view: null,
    focus: null,
    cursor: null,
    search: null,
    run: null,
    action: null,
    page: null,
    from: null,
    returnTo: null,
  });
}

function globalReturnHref(value: string): string | null {
  if (value === "/dashboard") return value;
  let parsed: URL;
  try {
    parsed = new URL(value, BASE_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== BASE_ORIGIN || parsed.pathname !== "/notifications" || parsed.hash) return null;
  const allowed = new Set(["view", "cursor", "focus"]);
  for (const key of new Set(parsed.searchParams.keys())) {
    if (!allowed.has(key) || parsed.searchParams.getAll(key).length !== 1) return null;
  }
  const view = parsed.searchParams.get("view");
  const cursor = parsed.searchParams.get("cursor");
  const focus = parsed.searchParams.get("focus");
  if (view !== null && !NOTIFICATION_VIEW_VALUES.includes(view as (typeof NOTIFICATION_VIEW_VALUES)[number])) return null;
  if (cursor !== null && !isCursor(cursor)) return null;
  if (focus !== null && !isUuid(focus)) return null;
  const params = new URLSearchParams();
  if (view !== null) params.set("view", view);
  if (cursor !== null) params.set("cursor", cursor);
  if (focus !== null) params.set("focus", focus);
  const query = params.toString();
  return `/notifications${query ? `?${query}` : ""}`;
}

function projectRouteFromPath(projectId: string, pathname: string): { route: ProjectNavigationRoute; jobId?: string } | null {
  const prefix = `/projects/${encodeURIComponent(projectId)}`;
  for (const route of PROJECT_NAVIGATION_ROUTES) {
    const suffix = ROUTE_DEFINITIONS[route].suffix;
    if (route !== "job" && pathname === `${prefix}${suffix ?? ""}`) return { route };
  }
  const jobPrefix = `${prefix}/jobs/`;
  if (!pathname.startsWith(jobPrefix)) return null;
  const jobId = pathname.slice(jobPrefix.length);
  return jobId.length > 0 && !jobId.includes("/") && isUuid(jobId) ? { route: "job", jobId } : null;
}

/**
 * Restore only a route generated for this project (or an explicitly allowed
 * dashboard/notification source). Absolute, protocol-relative, cross-project,
 * hash-bearing, duplicate and unknown state is rejected.
 */
export function safeProjectReturnTo(
  projectId: string,
  value: string | null | undefined,
  options: Readonly<{ from?: ProjectNavigationSource | null }> = {},
): string | null {
  if (!value || value.length > RETURN_TO_MAX_LENGTH || value.includes("\\") || value.includes("://") || value.startsWith("//") || !value.startsWith("/")) return null;
  const global = globalReturnHref(value);
  if (global !== null) {
    if (global === "/dashboard") return options.from === "dashboard" ? global : null;
    return options.from === "notifications" ? global : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value, BASE_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== BASE_ORIGIN || parsed.hash) return null;
  const target = projectRouteFromPath(projectId, parsed.pathname);
  if (target === null) return null;
  if (parsed.searchParams.has("returnTo")) return null;
  const state = parseState(target.route, projectId, parsed.searchParams, true, target.jobId ?? null);
  if (state === null) return null;
  return buildProjectHref(projectId, target.route, {
    jobId: target.jobId ?? undefined,
    status: state.status,
    kind: state.kind,
    tab: state.tab,
    filter: state.filter,
    view: state.view,
    focus: state.focus,
    cursor: state.cursor,
    search: state.search,
    run: state.run,
    action: state.action,
    page: state.page,
    from: state.from,
  });
}

/** Strictly parse a complete same-project href for contract tests and callers. */
export function parseProjectHref(projectId: string, value: string): ProjectNavigationState | null {
  if (!value || value.length > RETURN_TO_MAX_LENGTH || value.includes("\\") || value.includes("://") || value.startsWith("//") || !value.startsWith("/")) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, BASE_ORIGIN);
  } catch {
    return null;
  }
  if (parsed.origin !== BASE_ORIGIN || parsed.hash) return null;
  const target = projectRouteFromPath(projectId, parsed.pathname);
  if (target === null) return null;
  return parseState(target.route, projectId, parsed.searchParams, true, target.jobId ?? null);
}

export { UUID_PATTERN as PROJECT_UUID_PATTERN };
