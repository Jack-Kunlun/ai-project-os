export const PROJECT_INTELLIGENCE_RUNTIME_DECISION_CODES = [
  "run_forbidden",
  "platform_route_blocked",
  "personal_route_blocked",
  "platform_quota_advisory_blocked",
  "index_missing",
  "legacy_index",
  "index_incompatible",
  "inputs_changed",
  "ready",
] as const;

export type ProjectIntelligenceRuntimeDecisionCode =
  typeof PROJECT_INTELLIGENCE_RUNTIME_DECISION_CODES[number];

export type ProjectIntelligencePayer = "platform_caller" | "personal_connection_owner" | "mixed";
export type ProjectIntelligenceOperationPayer = Exclude<ProjectIntelligencePayer, "mixed">;
export type ProjectIntelligenceRouteSource = "platform_default" | "personal_delegation";
export type ProjectIntelligenceDecisionRouteSource = ProjectIntelligenceRouteSource | "mixed";
export type ProjectIntelligencePermission = "owner" | "edit" | "view";
export type ProjectIntelligenceIndexState =
  | "routeMissing"
  | "providerUnavailable"
  | "indexMissing"
  | "legacyIndex"
  | "routeIncompatible"
  | "inputsChanged"
  | "ready"
  | "generationProviderUnavailable";

export type ProjectIntelligenceRouteErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ROUTE_INVALID"
  | "PLATFORM_ROUTE_UNAVAILABLE"
  | "AI_PROVIDER_CONFIGURATION_DRIFT"
  | "PERSONAL_ROUTE_UNAVAILABLE"
  | "AI_ROUTE_LOCK_BUSY";

export type ProjectIntelligenceRuntimeRoute = Readonly<{
  available: boolean;
  source: ProjectIntelligenceRouteSource | null;
  payer: ProjectIntelligenceOperationPayer | null;
  errorCode: ProjectIntelligenceRouteErrorCode | null;
}>;

export type ProjectIntelligenceNextAction =
  | Readonly<{ kind: "request_edit_access"; label: string; href: null }>
  | Readonly<{ kind: "contact_project_admin"; label: string; href: null }>
  | Readonly<{ kind: "contact_platform_admin"; label: string; href: null }>
  | Readonly<{ kind: "create_memory_index"; label: string; href: string }>
  | Readonly<{ kind: "rebuild_memory_index"; label: string; href: string }>
  | Readonly<{ kind: "run_project_ai"; label: string; href: "#project-brief" }>;

type RuntimeDecisionBase = Readonly<{
  canRun: boolean;
  title: string;
  detail: string;
  routeSource: ProjectIntelligenceDecisionRouteSource | null;
  payer: ProjectIntelligencePayer | null;
  payerLabel: "平台额度，由当前发起人扣减" | "个人连接承担" | "混合承担：平台额度与个人连接" | null;
  nextAction: ProjectIntelligenceNextAction;
}>;

export type ProjectIntelligenceRuntimeDecision =
  | (RuntimeDecisionBase & Readonly<{
    code: "run_forbidden";
    reason: "view_only" | "archived";
    canRun: false;
    routeSource: null;
    payer: null;
    payerLabel: null;
    nextAction: Extract<ProjectIntelligenceNextAction, { kind: "request_edit_access" | "contact_project_admin" }>;
  }>)
  | (RuntimeDecisionBase & Readonly<{
    code: "platform_route_blocked";
    canRun: false;
    routeSource: "platform_default";
    payer: "platform_caller";
    payerLabel: "平台额度，由当前发起人扣减";
    nextAction: Extract<ProjectIntelligenceNextAction, { kind: "contact_platform_admin" }>;
  }>)
  | (RuntimeDecisionBase & Readonly<{
    code: "personal_route_blocked";
    canRun: false;
    routeSource: "personal_delegation";
    payer: "personal_connection_owner";
    payerLabel: "个人连接承担";
    nextAction: Extract<ProjectIntelligenceNextAction, { kind: "contact_project_admin" }>;
  }>)
  | (RuntimeDecisionBase & Readonly<{
    code: "platform_quota_advisory_blocked";
    canRun: false;
    routeSource: "platform_default";
    payer: "platform_caller";
    payerLabel: "平台额度，由当前发起人扣减";
    nextAction: Extract<ProjectIntelligenceNextAction, { kind: "contact_platform_admin" }>;
  }>)
  | (RuntimeDecisionBase & Readonly<{
    code: "index_missing";
    canRun: false;
    nextAction: Extract<ProjectIntelligenceNextAction, { kind: "create_memory_index" }>;
  }>)
  | (RuntimeDecisionBase & Readonly<{
    code: "legacy_index" | "index_incompatible" | "inputs_changed";
    canRun: false;
    nextAction: Extract<ProjectIntelligenceNextAction, { kind: "rebuild_memory_index" }>;
  }>)
  | (RuntimeDecisionBase & Readonly<{
    code: "ready";
    canRun: true;
    nextAction: Extract<ProjectIntelligenceNextAction, { kind: "run_project_ai" }>;
  }>);

export type ProjectIntelligenceRuntimeDecisionInput = Readonly<{
  projectId: string;
  permission: ProjectIntelligencePermission | null;
  archived: boolean;
  embeddingRoute: ProjectIntelligenceRuntimeRoute;
  projectAnalysisRoute: ProjectIntelligenceRuntimeRoute;
  indexState: ProjectIntelligenceIndexState;
  platformQuotaAvailable?: boolean | null;
}>;

function routeSourceLabel(source: ProjectIntelligenceRouteSource): "平台额度，由当前发起人扣减" | "个人连接承担" {
  return source === "platform_default" ? "平台额度，由当前发起人扣减" : "个人连接承担";
}

function routeMeta(input: ProjectIntelligenceRuntimeDecisionInput): Readonly<{
  routeSource: ProjectIntelligenceDecisionRouteSource | null;
  payer: ProjectIntelligencePayer | null;
  payerLabel: "平台额度，由当前发起人扣减" | "个人连接承担" | "混合承担：平台额度与个人连接" | null;
}> {
  const sources = new Set(
    [input.embeddingRoute, input.projectAnalysisRoute]
      .filter((route) => route.available && route.source !== null)
      .map((route) => route.source as ProjectIntelligenceRouteSource),
  );
  if (sources.has("platform_default") && sources.has("personal_delegation")) {
    return Object.freeze({
      routeSource: "mixed",
      payer: "mixed",
      payerLabel: "混合承担：平台额度与个人连接",
    });
  }
  const source = sources.values().next().value as ProjectIntelligenceRouteSource | undefined;
  if (source === undefined) {
    // Route blocks are evaluated before route metadata. Keep this branch
    // fail-closed if a future state reaches it without a public source.
    return Object.freeze({
      routeSource: null,
      payer: null,
      payerLabel: null,
    });
  }
  return Object.freeze({ routeSource: source, payer: routePayer(source), payerLabel: routeSourceLabel(source) });
}

function routePayer(source: ProjectIntelligenceRouteSource): "platform_caller" | "personal_connection_owner" {
  return source === "platform_default" ? "platform_caller" : "personal_connection_owner";
}

function hasRouteBlock(route: ProjectIntelligenceRuntimeRoute): boolean {
  return !route.available
    || route.source === null
    || route.payer === null
    || route.errorCode !== null;
}

function hasPersonalRouteBlock(input: ProjectIntelligenceRuntimeDecisionInput): boolean {
  return [input.embeddingRoute, input.projectAnalysisRoute].some((route) =>
    hasRouteBlock(route) && (
      route.source === "personal_delegation"
      || route.errorCode === "PERSONAL_ROUTE_UNAVAILABLE"
    ));
}

function hasPlatformRouteBlock(input: ProjectIntelligenceRuntimeDecisionInput): boolean {
  return [input.embeddingRoute, input.projectAnalysisRoute].some((route) =>
    hasRouteBlock(route) && route.source !== "personal_delegation" && route.errorCode !== "PERSONAL_ROUTE_UNAVAILABLE"
  );
}

function projectMemoryHref(projectId: string): string {
  return `/projects/${projectId}/memory`;
}

function forbiddenDecision(
  reason: "view_only" | "archived",
): ProjectIntelligenceRuntimeDecision {
  if (reason === "archived") {
    return Object.freeze({
      code: "run_forbidden",
      reason,
      canRun: false,
      title: "项目已归档",
      detail: "归档项目只能查看，不能运行项目简报或只读调查。",
      routeSource: null,
      payer: null,
      payerLabel: null,
      nextAction: Object.freeze({ kind: "contact_project_admin", label: "联系项目管理员", href: null }),
    });
  }
  return Object.freeze({
    code: "run_forbidden",
    reason,
    canRun: false,
    title: "当前账号仅可查看",
    detail: "需要项目编辑权限才能运行项目简报或只读调查。",
    routeSource: null,
    payer: null,
    payerLabel: null,
    nextAction: Object.freeze({ kind: "request_edit_access", label: "申请编辑权限", href: null }),
  });
}

export function decideProjectIntelligenceRuntime(
  input: ProjectIntelligenceRuntimeDecisionInput,
): ProjectIntelligenceRuntimeDecision {
  if (input.permission !== "owner" && input.permission !== "edit") {
    return forbiddenDecision("view_only");
  }
  if (input.archived) {
    return forbiddenDecision("archived");
  }
  const meta = routeMeta(input);
  if (hasPlatformRouteBlock(input) || ["routeMissing", "providerUnavailable", "generationProviderUnavailable"].includes(input.indexState)) {
    return Object.freeze({
      code: "platform_route_blocked",
      canRun: false,
      title: "平台默认模型暂不可用",
      detail: "管理员配置的免费托管模型未通过当前运行校验，暂时不能执行项目 AI。",
      routeSource: "platform_default",
      payer: "platform_caller",
      payerLabel: "平台额度，由当前发起人扣减",
      nextAction: Object.freeze({ kind: "contact_platform_admin", label: "联系平台管理员", href: null }),
    });
  }
  if (hasPersonalRouteBlock(input)) {
    return Object.freeze({
      code: "personal_route_blocked",
      canRun: false,
      title: "个人连接暂不可用",
      detail: "个人连接或授权已失效，当前不能执行项目 AI；此版本暂不提供个人连接配置入口。",
      routeSource: "personal_delegation",
      payer: "personal_connection_owner",
      payerLabel: "个人连接承担",
      nextAction: Object.freeze({ kind: "contact_project_admin", label: "联系项目管理员", href: null }),
    });
  }
  if (input.platformQuotaAvailable === false) {
    return Object.freeze({
      code: "platform_quota_advisory_blocked",
      canRun: false,
      title: "平台额度暂不可用",
      detail: "当前发起人的平台免费额度已用尽或已过期，暂时不能执行项目 AI。",
      routeSource: "platform_default",
      payer: "platform_caller",
      payerLabel: "平台额度，由当前发起人扣减",
      nextAction: Object.freeze({ kind: "contact_platform_admin", label: "联系平台管理员", href: null }),
    });
  }
  if (input.indexState === "indexMissing") {
    return Object.freeze({
      code: "index_missing",
      canRun: false,
      title: "需要建立项目记忆",
      detail: "先建立当前项目的已确认事实索引，之后才能执行项目简报或只读调查。",
      ...meta,
      nextAction: Object.freeze({ kind: "create_memory_index", label: "建立项目记忆", href: projectMemoryHref(input.projectId) }),
    });
  }
  if (input.indexState === "legacyIndex" || input.indexState === "routeIncompatible" || input.indexState === "inputsChanged") {
    const detail = input.indexState === "legacyIndex"
      ? "当前索引来自旧版本，需重建后才能用于项目 AI。"
      : input.indexState === "routeIncompatible"
        ? "当前向量路由已变化，需重建索引以保持证据一致。"
        : "项目资料已变化，需重建索引后才能保证回答使用最新证据。";
    return Object.freeze({
      code: input.indexState === "legacyIndex" ? "legacy_index" : input.indexState === "routeIncompatible" ? "index_incompatible" : "inputs_changed",
      canRun: false,
      title: "项目记忆需要更新",
      detail,
      ...meta,
      nextAction: Object.freeze({ kind: "rebuild_memory_index", label: "重建项目记忆", href: projectMemoryHref(input.projectId) }),
    });
  }
  const quotaHint = input.platformQuotaAvailable === true ? "已观察到有剩余额度；" : "";
  return Object.freeze({
    code: "ready",
    canRun: true,
    title: "项目智能体已就绪",
    detail: `${quotaHint}配置已就绪，提交时仍复核额度、并发与授权。`,
    ...meta,
    nextAction: Object.freeze({ kind: "run_project_ai", label: "开始项目简报", href: "#project-brief" }),
  });
}
