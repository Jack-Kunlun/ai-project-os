export const SYSTEM_FAILURE_INBOX_WINDOW_DAYS = 7 as const;
export const SYSTEM_FAILURE_INBOX_DEFAULT_PAGE_SIZE = 20 as const;
export const SYSTEM_FAILURE_INBOX_MAX_PAGE_SIZE = 50 as const;

export const SYSTEM_FAILURE_INBOX_SOURCES = [
  "providerHeld",
  "workerBackgroundJob",
  "indexGeneration",
  "connection",
  "automationRun",
  "controlledAction",
] as const;

export type SystemFailureInboxSource = (typeof SYSTEM_FAILURE_INBOX_SOURCES)[number];

export const SYSTEM_FAILURE_INBOX_SOURCE_LABELS: Readonly<Record<SystemFailureInboxSource, string>> = {
  providerHeld: "平台 Provider 待核对",
  workerBackgroundJob: "Worker / 后台任务",
  indexGeneration: "索引生成",
  connection: "个人连接",
  automationRun: "自动化运行",
  controlledAction: "受控动作",
};

export const SYSTEM_FAILURE_INBOX_LIFECYCLES = ["observed_failure", "requires_reconciliation", "requires_owner_review"] as const;
export type SystemFailureInboxLifecycle = (typeof SYSTEM_FAILURE_INBOX_LIFECYCLES)[number];

export const SYSTEM_FAILURE_INBOX_LIFECYCLE_LABELS: Readonly<Record<SystemFailureInboxLifecycle, string>> = {
  observed_failure: "近期观测失败",
  requires_reconciliation: "需要人工对账",
  requires_owner_review: "需责任人复核",
};

export type SystemFailureInboxResponsibility =
  | "平台管理员"
  | "系统管理员"
  | "业务责任方"
  | "连接所有者"
  | "自动化规则所有者";

export type SystemFailureInboxEntry = Readonly<{
  entryId: string;
  source: SystemFailureInboxSource;
  lifecycle: SystemFailureInboxLifecycle;
  occurredAt: string;
  safeErrorCode: string;
  responsibility: SystemFailureInboxResponsibility;
  reason: string;
  nextStep: string;
  destination: string | null;
}>;

export type SystemFailureInboxList = Readonly<{
  entries: readonly SystemFailureInboxEntry[];
  nextCursor: string | null;
  observedAt: string;
  window: Readonly<{ days: typeof SYSTEM_FAILURE_INBOX_WINDOW_DAYS; from: string; to: string }>;
  pageSize: number;
  partialSources: readonly SystemFailureInboxSource[];
}>;

export type SystemFailureInboxQuery = Readonly<{
  source?: SystemFailureInboxSource;
  lifecycle?: SystemFailureInboxLifecycle;
  cursor?: string;
  pageSize: number;
}>;
