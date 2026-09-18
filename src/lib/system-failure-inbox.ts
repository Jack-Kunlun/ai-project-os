import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type AutomationRunStatus, type BackgroundJobStatus, type IndexGenerationStatus, type MemoryIndexStatus, type PrismaClient, type ProjectActionStatus, type ProjectMcpActionDispatchAttemptStatus } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { getDb } from "@/lib/db";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
import { readWorkerHealth, type WorkerHealthSummary } from "@/lib/worker-health";
import type { SafeSessionUser } from "@/lib/auth";
import { safeAutomationFailureCode } from "@/lib/automation-result-projection";

import {
  SYSTEM_FAILURE_INBOX_DEFAULT_PAGE_SIZE,
  SYSTEM_FAILURE_INBOX_LIFECYCLES,
  SYSTEM_FAILURE_INBOX_MAX_PAGE_SIZE,
  SYSTEM_FAILURE_INBOX_SOURCES,
  SYSTEM_FAILURE_INBOX_WINDOW_DAYS,
} from "@/lib/system-failure-inbox-contract";
import type {
  SystemFailureInboxEntry,
  SystemFailureInboxLifecycle,
  SystemFailureInboxList,
  SystemFailureInboxQuery,
  SystemFailureInboxResponsibility,
  SystemFailureInboxSource,
} from "@/lib/system-failure-inbox-contract";

export {
  SYSTEM_FAILURE_INBOX_DEFAULT_PAGE_SIZE,
  SYSTEM_FAILURE_INBOX_LIFECYCLE_LABELS,
  SYSTEM_FAILURE_INBOX_LIFECYCLES,
  SYSTEM_FAILURE_INBOX_MAX_PAGE_SIZE,
  SYSTEM_FAILURE_INBOX_SOURCE_LABELS,
  SYSTEM_FAILURE_INBOX_SOURCES,
  SYSTEM_FAILURE_INBOX_WINDOW_DAYS,
} from "@/lib/system-failure-inbox-contract";
export type {
  SystemFailureInboxEntry,
  SystemFailureInboxLifecycle,
  SystemFailureInboxList,
  SystemFailureInboxQuery,
  SystemFailureInboxResponsibility,
  SystemFailureInboxSource,
} from "@/lib/system-failure-inbox-contract";

export const SYSTEM_FAILURE_INBOX_MAX_ROWS_PER_SOURCE = 100 as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const CURSOR_CONTEXT = "ai-project-os:system-failure-inbox-cursor:v1";
const FILTER_CONTEXT = "ai-project-os:system-failure-inbox-filter:v1";
const AUTOMATION_FAILURE_PAUSE_THRESHOLD = 3;

const catalog: Readonly<Record<SystemFailureInboxSource, Readonly<{
  responsibility: SystemFailureInboxResponsibility;
  reason: string;
  nextStep: string;
}>>> = {
  providerHeld: {
    responsibility: "平台管理员",
    reason: "平台 Provider 探测已安全挂起，账本状态需要人工核对；本收件箱不展示连接凭据或模型调用正文。",
    nextStep: "在平台模型治理入口核对该 Provider 的控制面状态。",
  },
  workerBackgroundJob: {
    responsibility: "系统管理员",
    reason: "Worker 心跳或后台任务状态未形成可确认的安全终态；收件箱不展示任务载荷、结果或外部请求细节。",
    nextStep: "核对 Worker 与后台任务的安全状态。",
  },
  indexGeneration: {
    responsibility: "业务责任方",
    reason: "索引生成状态与预期边界未完成核对或近期构建失败；索引条目优先于其关联后台任务展示。",
    nextStep: "由业务责任方在用户侧处理；管理员后台不提供业务详情入口。",
  },
  connection: {
    responsibility: "连接所有者",
    reason: "个人 Git 或 MCP 连接当前报告错误；系统管理员只看到类别和静态提示，不读取个人身份、地址、凭据或工具定义。",
    nextStep: "由连接所有者在个人连接设置中处理该连接。",
  },
  automationRun: {
    responsibility: "自动化规则所有者",
    reason: "近期自动化运行失败；连续失败导致规则暂停时需要所有者复核，系统不会自动重试。",
    nextStep: "由自动化规则所有者核对规则与来源配置。",
  },
  controlledAction: {
    responsibility: "业务责任方",
    reason: "受控动作或 MCP 调度尝试未能得到可确认的安全终态；不展示工具、参数、端点、载荷或结果正文。",
    nextStep: "由业务责任方在用户侧处理；管理员后台不提供业务详情入口。",
  },
};

export const SYSTEM_FAILURE_INBOX_CATALOG = catalog;

export function safeFailureErrorCode(value: unknown): string {
  return typeof value === "string" && SAFE_ERROR_CODE.test(value) ? value : "UNCLASSIFIED_FAILURE";
}

function opaqueEntryId(source: SystemFailureInboxSource, id: string): string {
  return createHash("sha256")
    .update("ai-project-os:system-failure-inbox-entry:v1", "utf8")
    .update("\0", "utf8")
    .update(source, "utf8")
    .update("\0", "utf8")
    .update(id, "utf8")
    .digest("base64url");
}

function safeDestination(value: string | null): string | null {
  return value !== null && value.startsWith("/") && !value.startsWith("//") ? value : null;
}

type FailureInboxCandidate = Readonly<{
  source: SystemFailureInboxSource;
  id: string;
  lifecycle: SystemFailureInboxLifecycle;
  occurredAt: Date;
  safeErrorCode?: unknown;
  responsibility?: SystemFailureInboxResponsibility;
  destination: string | null;
}>;

export function buildSystemFailureInboxEntry(candidate: FailureInboxCandidate): SystemFailureInboxEntry {
  if (!Number.isFinite(candidate.occurredAt.getTime())) throw new Error("SYSTEM_FAILURE_INBOX_DATE_INVALID");
  const sourceCatalog = catalog[candidate.source];
  return Object.freeze({
    entryId: opaqueEntryId(candidate.source, candidate.id),
    source: candidate.source,
    lifecycle: candidate.lifecycle,
    occurredAt: candidate.occurredAt.toISOString(),
    safeErrorCode: safeFailureErrorCode(candidate.safeErrorCode),
    responsibility: candidate.responsibility ?? sourceCatalog.responsibility,
    reason: sourceCatalog.reason,
    nextStep: sourceCatalog.nextStep,
    destination: safeDestination(candidate.destination),
  });
}

type SystemFailureInboxSortKey = Pick<SystemFailureInboxEntry, "occurredAt" | "source" | "entryId">;

function compareSystemFailureInboxOrder(left: SystemFailureInboxSortKey, right: SystemFailureInboxSortKey): number {
  const occurredAt = right.occurredAt.localeCompare(left.occurredAt);
  if (occurredAt !== 0) return occurredAt;
  const source = left.source.localeCompare(right.source);
  if (source !== 0) return source;
  return right.entryId.localeCompare(left.entryId);
}

export function compareSystemFailureInboxEntries(left: SystemFailureInboxEntry, right: SystemFailureInboxEntry): number {
  return compareSystemFailureInboxOrder(left, right);
}

const querySchema = z.object({
  source: z.enum(SYSTEM_FAILURE_INBOX_SOURCES).optional(),
  lifecycle: z.enum(SYSTEM_FAILURE_INBOX_LIFECYCLES).optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
  pageSize: z.coerce.number().int().min(1).max(SYSTEM_FAILURE_INBOX_MAX_PAGE_SIZE).default(SYSTEM_FAILURE_INBOX_DEFAULT_PAGE_SIZE),
}).strict();

export function parseSystemFailureInboxQuery(input: Readonly<Record<string, string | undefined>>): SystemFailureInboxQuery {
  return querySchema.parse(input) as SystemFailureInboxQuery;
}

type CursorPayload = Readonly<{
  version: 1;
  filterHash: string;
  observedAt: string;
  occurredAt: string;
  source: SystemFailureInboxSource;
  entryId: string;
}>;

function canonicalFilters(query: Pick<SystemFailureInboxQuery, "source" | "lifecycle" | "pageSize">): string {
  return JSON.stringify({
    source: query.source ?? null,
    lifecycle: query.lifecycle ?? null,
    pageSize: query.pageSize,
  });
}

async function signingKey(override?: Uint8Array): Promise<Uint8Array> {
  return override ?? await loadOrCreateMasterKey();
}

async function filterHash(query: Pick<SystemFailureInboxQuery, "source" | "lifecycle" | "pageSize">, key?: Uint8Array): Promise<string> {
  return createHmac("sha256", await signingKey(key))
    .update(FILTER_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(canonicalFilters(query), "utf8")
    .digest("hex");
}

async function cursorSignature(encodedPayload: string, key?: Uint8Array): Promise<string> {
  return createHmac("sha256", await signingKey(key))
    .update(CURSOR_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

async function encodeCursor(entry: SystemFailureInboxEntry, observedAt: string, expectedFilterHash: string, key?: Uint8Array): Promise<string> {
  const payload: CursorPayload = {
    version: 1,
    filterHash: expectedFilterHash,
    observedAt,
    occurredAt: entry.occurredAt,
    source: entry.source,
    entryId: entry.entryId,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${await cursorSignature(encodedPayload, key)}`;
}

async function decodeCursor(value: string | undefined, key?: Uint8Array): Promise<CursorPayload | null> {
  if (value === undefined) return null;
  const [encodedPayload, signature, ...rest] = value.split(".");
  if (
    encodedPayload === undefined
    || signature === undefined
    || rest.length > 0
    || !/^[A-Za-z0-9_-]+$/u.test(encodedPayload)
    || !/^[A-Za-z0-9_-]+$/u.test(signature)
  ) throw new ApiError(400, "SYSTEM_FAILURE_INBOX_CURSOR_INVALID", "失败收件箱分页游标无效");
  const expectedSignature = await cursorSignature(encodedPayload, key);
  const supplied = Buffer.from(signature, "base64url");
  const expected = Buffer.from(expectedSignature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ApiError(400, "SYSTEM_FAILURE_INBOX_CURSOR_INVALID", "失败收件箱分页游标无效");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "SYSTEM_FAILURE_INBOX_CURSOR_INVALID", "失败收件箱分页游标无效");
  }
  const result = z.object({
    version: z.literal(1),
    filterHash: z.string().length(64),
    observedAt: z.string().datetime({ offset: true }),
    occurredAt: z.string().datetime({ offset: true }),
    source: z.enum(SYSTEM_FAILURE_INBOX_SOURCES),
    entryId: z.string().regex(ENTRY_ID_PATTERN),
  }).strict().safeParse(parsed);
  if (!result.success) throw new ApiError(400, "SYSTEM_FAILURE_INBOX_CURSOR_INVALID", "失败收件箱分页游标无效");
  return result.data;
}

function cursorCompare(entry: SystemFailureInboxEntry, cursor: Pick<CursorPayload, "occurredAt" | "source" | "entryId">): number {
  return compareSystemFailureInboxOrder(entry, cursor);
}

const providerHeldSelect = {
  id: true,
  status: true,
  safeErrorCode: true,
  updatedAt: true,
} satisfies Prisma.PlatformProviderProbeAttemptSelect;

const backgroundJobSelect = {
  id: true,
  status: true,
  failureCode: true,
  reconciliationRequired: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.BackgroundJobSelect;

const memoryIndexGenerationSelect = {
  id: true,
  jobId: true,
  status: true,
  failureCode: true,
  reconciliationRequired: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.MemoryIndexGenerationSelect;

const indexGenerationSelect = {
  id: true,
  status: true,
  failureCode: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.IndexGenerationSelect;

const gitConnectionSelect = {
  id: true,
  status: true,
  lastErrorCode: true,
  updatedAt: true,
} satisfies Prisma.GitConnectionSelect;

const mcpConnectionSelect = {
  id: true,
  status: true,
  lastErrorCode: true,
  updatedAt: true,
} satisfies Prisma.McpConnectionSelect;

const automationRunSelect = {
  id: true,
  automationRuleId: true,
  status: true,
  failureCode: true,
  createdAt: true,
  completedAt: true,
  rule: { select: { status: true, consecutiveFailures: true } },
} satisfies Prisma.AutomationRunSelect;

const automationRuleSelect = {
  id: true,
  status: true,
  consecutiveFailures: true,
  updatedAt: true,
} satisfies Prisma.AutomationRuleSelect;

const projectActionSelect = {
  id: true,
  status: true,
  failureCode: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.ProjectActionSelect;

const mcpDispatchAttemptSelect = {
  id: true,
  actionId: true,
  status: true,
  safeErrorCode: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.ProjectMcpActionDispatchAttemptSelect;

type FailureInboxDb = PrismaClient;
type InternalCandidate = Readonly<{
  source: SystemFailureInboxSource;
  id: string;
  lifecycle: SystemFailureInboxLifecycle;
  occurredAt: Date;
  safeErrorCode?: unknown;
  responsibility?: SystemFailureInboxResponsibility;
  destination: string | null;
}>;

function recentCompleted(completedAt: Date | null, from: Date, now: Date): boolean {
  return completedAt !== null && completedAt >= from && completedAt <= now;
}

function workerCandidates(health: WorkerHealthSummary | null, now: Date): InternalCandidate[] {
  if (health === null) {
    return [{
      source: "workerBackgroundJob",
      id: "worker-health-unavailable",
      lifecycle: "requires_reconciliation",
      occurredAt: now,
      safeErrorCode: "WORKER_HEALTH_UNAVAILABLE",
      responsibility: "系统管理员",
      destination: null,
    }];
  }
  if (health.status !== "missing" && health.status !== "stale" && health.status !== "degraded") return [];
  const occurredAt = health.heartbeatAgeMs === null ? now : new Date(now.getTime() - health.heartbeatAgeMs);
  return [{
    source: "workerBackgroundJob",
    id: `worker-health:${health.status}`,
    lifecycle: health.status === "degraded" ? "requires_owner_review" : "requires_reconciliation",
    occurredAt,
    safeErrorCode: `WORKER_${health.status.toUpperCase()}`,
    responsibility: "系统管理员",
    destination: null,
  }];
}

function failureInboxCandidates(
  rows: Readonly<{
    providerHeld: readonly Prisma.PlatformProviderProbeAttemptGetPayload<{ select: typeof providerHeldSelect }>[];
    backgroundJobs: readonly Prisma.BackgroundJobGetPayload<{ select: typeof backgroundJobSelect }>[];
    memoryIndexes: readonly Prisma.MemoryIndexGenerationGetPayload<{ select: typeof memoryIndexGenerationSelect }>[];
    indexes: readonly Prisma.IndexGenerationGetPayload<{ select: typeof indexGenerationSelect }>[];
    gitConnections: readonly { id: string; status: string; lastErrorCode: string | null; updatedAt: Date }[];
    mcpConnections: readonly { id: string; status: string; lastErrorCode: string | null; updatedAt: Date }[];
    automationRules: readonly Prisma.AutomationRuleGetPayload<{ select: typeof automationRuleSelect }>[];
    automationRuns: readonly Prisma.AutomationRunGetPayload<{ select: typeof automationRunSelect }>[];
    actions: readonly Prisma.ProjectActionGetPayload<{ select: typeof projectActionSelect }>[];
    mcpAttempts: readonly Prisma.ProjectMcpActionDispatchAttemptGetPayload<{ select: typeof mcpDispatchAttemptSelect }>[];
    worker: WorkerHealthSummary | null;
  }>,
  from: Date,
  now: Date,
): InternalCandidate[] {
  const candidates: InternalCandidate[] = [];
  for (const row of rows.providerHeld) {
    candidates.push({ source: "providerHeld", id: row.id, lifecycle: "requires_reconciliation", occurredAt: row.updatedAt, safeErrorCode: row.safeErrorCode, destination: "/admin/models" });
  }

  const indexJobIds = new Set(rows.memoryIndexes.filter((row) => row.jobId !== null).map((row) => row.jobId!));
  for (const row of rows.backgroundJobs) {
    if (indexJobIds.has(row.id)) continue;
    const lifecycle = failureInboxStatusForBackgroundJob(row.status, row.reconciliationRequired);
    if (lifecycle === null) continue;
    if (row.status === "failed" && !row.reconciliationRequired && !recentCompleted(row.completedAt, from, now)) continue;
    candidates.push({
      source: "workerBackgroundJob",
      id: row.id,
      lifecycle,
      occurredAt: row.completedAt ?? row.createdAt,
      safeErrorCode: row.failureCode,
      responsibility: "业务责任方",
      destination: null,
    });
  }
  for (const row of rows.memoryIndexes) {
    const lifecycle = failureInboxStatusForMemoryIndex(row.status, row.reconciliationRequired);
    if (lifecycle === null) continue;
    if (row.status === "failed" && !row.reconciliationRequired && !recentCompleted(row.completedAt, from, now)) continue;
    candidates.push({
      source: "indexGeneration",
      id: `memory:${row.id}`,
      lifecycle,
      occurredAt: row.completedAt ?? row.createdAt,
      safeErrorCode: row.failureCode,
      destination: null,
    });
  }
  for (const row of rows.indexes) {
    const lifecycle = failureInboxStatusForIndex(row.status);
    if (lifecycle === null) continue;
    if (row.status === "failed" && !recentCompleted(row.completedAt, from, now)) continue;
    candidates.push({
      source: "indexGeneration",
      id: `index:${row.id}`,
      lifecycle,
      occurredAt: row.completedAt ?? row.createdAt,
      safeErrorCode: row.failureCode,
      destination: null,
    });
  }
  for (const row of [...rows.gitConnections, ...rows.mcpConnections]) {
    candidates.push({ source: "connection", id: row.id, lifecycle: "requires_owner_review", occurredAt: row.updatedAt, safeErrorCode: row.lastErrorCode, responsibility: "连接所有者", destination: null });
  }
  const pausedAutomationRuleIds = new Set(rows.automationRules.map((row) => row.id));
  for (const row of rows.automationRules) {
    candidates.push({
      source: "automationRun",
      id: `rule:${row.id}`,
      lifecycle: "requires_owner_review",
      occurredAt: row.updatedAt,
      safeErrorCode: "AUTOMATION_RULE_PAUSED",
      responsibility: "自动化规则所有者",
      destination: null,
    });
  }
  for (const row of rows.automationRuns) {
    if (pausedAutomationRuleIds.has(row.automationRuleId)) continue;
    const lifecycle = failureInboxStatusForAutomation(row.status, row.rule.status, row.rule.consecutiveFailures);
    if (lifecycle === null || !recentCompleted(row.completedAt, from, now)) continue;
    candidates.push({
      source: "automationRun",
      id: row.id,
      lifecycle,
      occurredAt: row.completedAt ?? row.createdAt,
      safeErrorCode: safeAutomationFailureCode(row.failureCode) ?? "AUTOMATION_EXECUTION_FAILED",
      responsibility: "自动化规则所有者",
      destination: null,
    });
  }
  for (const row of rows.actions) {
    const lifecycle = failureInboxStatusForAction(row.status);
    if (lifecycle === null || !recentCompleted(row.completedAt, from, now)) continue;
    candidates.push({
      source: "controlledAction",
      id: `action:${row.id}`,
      lifecycle,
      occurredAt: row.completedAt ?? row.createdAt,
      safeErrorCode: row.failureCode,
      destination: null,
    });
  }
  for (const row of rows.mcpAttempts) {
    const lifecycle = failureInboxStatusForMcpAttempt(row.status);
    if (lifecycle === null) continue;
    if (row.status !== "unknown" && !recentCompleted(row.completedAt, from, now)) continue;
    candidates.push({
      source: "controlledAction",
      id: `mcp-attempt:${row.id}`,
      lifecycle,
      occurredAt: row.completedAt ?? row.createdAt,
      safeErrorCode: row.safeErrorCode,
      destination: null,
    });
  }
  candidates.push(...workerCandidates(rows.worker, now));
  return candidates;
}

export type SystemFailureInboxListOptions = Readonly<{
  now?: Date;
  cursorKey?: Uint8Array;
}>;

type BoundedRows<T> = Readonly<{ rows: readonly T[]; partial: boolean }>;

function boundRows<T>(rows: readonly T[]): BoundedRows<T> {
  return { rows: rows.slice(0, SYSTEM_FAILURE_INBOX_MAX_ROWS_PER_SOURCE), partial: rows.length > SYSTEM_FAILURE_INBOX_MAX_ROWS_PER_SOURCE };
}

function dedupeInternalCandidates(candidates: readonly InternalCandidate[]): InternalCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function listSystemFailureInbox(
  actor: Pick<SafeSessionUser, "id"> | string,
  query: SystemFailureInboxQuery,
  db: FailureInboxDb = getDb(),
  options: SystemFailureInboxListOptions = {},
): Promise<SystemFailureInboxList> {
  const actorId = typeof actor === "string" ? actor : actor.id;
  if (!UUID_PATTERN.test(actorId)) throw new ApiError(403, "SYSTEM_FAILURE_INBOX_ADMIN_REQUIRED", "需要系统管理员权限");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new ApiError(400, "SYSTEM_FAILURE_INBOX_INVALID_INPUT", "失败收件箱测量时间无效");
  const from = new Date(now.getTime() - SYSTEM_FAILURE_INBOX_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
  const expectedFilterHash = await filterHash(query, options.cursorKey);
  const cursor = await decodeCursor(query.cursor, options.cursorKey);
  if (cursor !== null && cursor.filterHash !== expectedFilterHash) throw new ApiError(400, "SYSTEM_FAILURE_INBOX_CURSOR_FILTER_MISMATCH", "失败收件箱分页游标与筛选条件不匹配");

  const queryLimit = SYSTEM_FAILURE_INBOX_MAX_ROWS_PER_SOURCE + 1;
  const [
    providerHeldRaw,
    backgroundCurrentRaw,
    backgroundRecentRaw,
    memoryCurrentRaw,
    memoryRecentRaw,
    indexCurrentRaw,
    indexRecentRaw,
    gitConnectionsRaw,
    mcpConnectionsRaw,
    automationRulesRaw,
    automationRunsRaw,
    actionsRaw,
    mcpCurrentRaw,
    mcpRecentRaw,
    worker,
  ] = await Promise.all([
    db.platformProviderProbeAttempt.findMany({
      where: { status: "held", providerConnection: { is: { scope: "platform", ownerUserId: null } } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: queryLimit,
      select: providerHeldSelect,
    }),
    db.backgroundJob.findMany({
      where: { OR: [{ status: "unknown" }, { reconciliationRequired: true }] },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: queryLimit,
      select: backgroundJobSelect,
    }),
    db.backgroundJob.findMany({
      where: { status: "failed", reconciliationRequired: false, completedAt: { gte: from, lte: now } },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: queryLimit,
      select: backgroundJobSelect,
    }),
    db.memoryIndexGeneration.findMany({
      where: { OR: [{ status: "unknown" }, { reconciliationRequired: true }] },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: queryLimit,
      select: memoryIndexGenerationSelect,
    }),
    db.memoryIndexGeneration.findMany({
      where: { status: "failed", reconciliationRequired: false, completedAt: { gte: from, lte: now } },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: queryLimit,
      select: memoryIndexGenerationSelect,
    }),
    db.indexGeneration.findMany({
      where: { status: "unknown" },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: queryLimit,
      select: indexGenerationSelect,
    }),
    db.indexGeneration.findMany({
      where: { status: "failed", completedAt: { gte: from, lte: now } },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: queryLimit,
      select: indexGenerationSelect,
    }),
    db.gitConnection.findMany({ where: { status: "error" }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: queryLimit, select: gitConnectionSelect }),
    db.mcpConnection.findMany({ where: { status: "error" }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: queryLimit, select: mcpConnectionSelect }),
    db.automationRule.findMany({ where: { status: "paused", consecutiveFailures: { gte: AUTOMATION_FAILURE_PAUSE_THRESHOLD } }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: queryLimit, select: automationRuleSelect }),
    db.automationRun.findMany({ where: { status: "failed", completedAt: { gte: from, lte: now } }, orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: queryLimit, select: automationRunSelect }),
    db.projectAction.findMany({ where: { status: "failed", completedAt: { gte: from, lte: now } }, orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: queryLimit, select: projectActionSelect }),
    db.projectMcpActionDispatchAttempt.findMany({ where: { status: "unknown" }, orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: queryLimit, select: mcpDispatchAttemptSelect }),
    db.projectMcpActionDispatchAttempt.findMany({ where: { status: { in: ["failed", "expired", "invalidated"] }, completedAt: { gte: from, lte: now } }, orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: queryLimit, select: mcpDispatchAttemptSelect }),
    readWorkerHealth(db, { now }).catch(() => null),
  ]);

  const providerHeld = boundRows(providerHeldRaw);
  const backgroundCurrent = boundRows(backgroundCurrentRaw);
  const backgroundRecent = boundRows(backgroundRecentRaw);
  const memoryCurrent = boundRows(memoryCurrentRaw);
  const memoryRecent = boundRows(memoryRecentRaw);
  const indexCurrent = boundRows(indexCurrentRaw);
  const indexRecent = boundRows(indexRecentRaw);
  const gitConnections = boundRows(gitConnectionsRaw);
  const mcpConnections = boundRows(mcpConnectionsRaw);
  const automationRules = boundRows(automationRulesRaw);
  const automationRuns = boundRows(automationRunsRaw);
  const actions = boundRows(actionsRaw);
  const mcpCurrent = boundRows(mcpCurrentRaw);
  const mcpRecent = boundRows(mcpRecentRaw);
  const partial = new Set<SystemFailureInboxSource>();
  if (providerHeld.partial) partial.add("providerHeld");
  if (backgroundCurrent.partial || backgroundRecent.partial) partial.add("workerBackgroundJob");
  if (memoryCurrent.partial || memoryRecent.partial || indexCurrent.partial || indexRecent.partial) partial.add("indexGeneration");
  if (gitConnections.partial || mcpConnections.partial) partial.add("connection");
  if (automationRules.partial || automationRuns.partial) partial.add("automationRun");
  if (actions.partial || mcpCurrent.partial || mcpRecent.partial) partial.add("controlledAction");

  const internal = dedupeInternalCandidates(failureInboxCandidates({
    providerHeld: providerHeld.rows,
    backgroundJobs: [...backgroundCurrent.rows, ...backgroundRecent.rows],
    memoryIndexes: [...memoryCurrent.rows, ...memoryRecent.rows],
    indexes: [...indexCurrent.rows, ...indexRecent.rows],
    gitConnections: gitConnections.rows,
    mcpConnections: mcpConnections.rows,
    automationRules: automationRules.rows,
    automationRuns: automationRuns.rows,
    actions: actions.rows,
    mcpAttempts: [...mcpCurrent.rows, ...mcpRecent.rows],
    worker,
  }, from, now));
  const entries = internal
    .map((candidate) => {
      try {
        return buildSystemFailureInboxEntry({
          source: candidate.source,
          id: candidate.id,
          lifecycle: candidate.lifecycle,
          occurredAt: candidate.occurredAt,
          safeErrorCode: candidate.safeErrorCode,
          responsibility: candidate.responsibility,
          destination: candidate.destination,
        });
      } catch {
        return null;
      }
    })
    .filter((entry): entry is SystemFailureInboxEntry => entry !== null)
    .filter((entry) => query.source === undefined || entry.source === query.source)
    .filter((entry) => query.lifecycle === undefined || entry.lifecycle === query.lifecycle)
    .sort(compareSystemFailureInboxEntries);
  const afterCursor = cursor === null ? entries : entries.filter((entry) => cursorCompare(entry, cursor) > 0);
  const page = afterCursor.slice(0, query.pageSize);
  const last = page.at(-1);
  const nextCursor = afterCursor.length > query.pageSize && last !== undefined
    ? await encodeCursor(last, now.toISOString(), expectedFilterHash, options.cursorKey)
    : null;
  const partialSources = SYSTEM_FAILURE_INBOX_SOURCES.filter((source) => partial.has(source) && (query.source === undefined || query.source === source));
  return Object.freeze({
    entries: Object.freeze(page),
    nextCursor,
    observedAt: now.toISOString(),
    window: Object.freeze({ days: SYSTEM_FAILURE_INBOX_WINDOW_DAYS, from: from.toISOString(), to: now.toISOString() }),
    pageSize: query.pageSize,
    partialSources: Object.freeze(partialSources),
  });
}

export async function assertSystemFailureInboxAdmin(
  actor: Pick<SafeSessionUser, "id" | "role">,
  db: FailureInboxDb = getDb(),
): Promise<void> {
  if (actor.role !== "admin" || !UUID_PATTERN.test(actor.id)) throw new ApiError(403, "SYSTEM_FAILURE_INBOX_ADMIN_REQUIRED", "需要系统管理员权限");
  const stored = await db.appUser.findUnique({ where: { id: actor.id }, select: { id: true, role: true, disabledAt: true } });
  if (stored === null || stored.role !== "admin" || stored.disabledAt !== null) throw new ApiError(403, "SYSTEM_FAILURE_INBOX_ADMIN_REQUIRED", "需要启用中的系统管理员权限");
}

export function failureInboxStatusForBackgroundJob(status: BackgroundJobStatus, reconciliationRequired: boolean): SystemFailureInboxLifecycle | null {
  if (status === "unknown" || reconciliationRequired) return "requires_reconciliation";
  if (status === "failed") return "observed_failure";
  return null;
}

export function failureInboxStatusForMemoryIndex(status: MemoryIndexStatus, reconciliationRequired: boolean): SystemFailureInboxLifecycle | null {
  if (status === "unknown" || reconciliationRequired) return "requires_reconciliation";
  if (status === "failed") return "observed_failure";
  return null;
}

export function failureInboxStatusForIndex(status: IndexGenerationStatus): SystemFailureInboxLifecycle | null {
  if (status === "unknown") return "requires_reconciliation";
  if (status === "failed") return "observed_failure";
  return null;
}

export function failureInboxStatusForAutomation(
  status: AutomationRunStatus,
  ruleStatus: "active" | "paused",
  consecutiveFailures: number,
): SystemFailureInboxLifecycle | null {
  if (status !== "failed") return null;
  return ruleStatus === "paused" && consecutiveFailures >= AUTOMATION_FAILURE_PAUSE_THRESHOLD ? "requires_owner_review" : "observed_failure";
}

export function failureInboxStatusForAction(status: ProjectActionStatus): SystemFailureInboxLifecycle | null {
  return status === "failed" ? "observed_failure" : null;
}

export function failureInboxStatusForMcpAttempt(status: ProjectMcpActionDispatchAttemptStatus): SystemFailureInboxLifecycle | null {
  if (status === "unknown") return "requires_reconciliation";
  if (status === "failed" || status === "expired" || status === "invalidated") return "observed_failure";
  return null;
}
