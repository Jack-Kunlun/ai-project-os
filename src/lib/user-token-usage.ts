import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { accessibleProjectWhere } from "@/lib/access-control";
import { assertWebAiProjectAccess, type WebAiActor } from "@/lib/web-ai-access";
import { getDb } from "@/lib/db";
import {
  NO_TOKEN_USAGE,
  summarizeTokenUsage,
  summarizeTokenUsageBuckets,
  unknownTokenUsage,
  type TokenUsageSummary,
} from "@/lib/token-usage";

export const USER_TOKEN_USAGE_KINDS = ["all", "unifiedQuestion", "personalQuestion", "extraction", "semantic", "project"] as const;
export const USER_TOKEN_USAGE_STATUSES = ["all", "running", "succeeded", "failed", "unknown", "cancelled"] as const;
export const USER_TOKEN_USAGE_PAGE_SIZE_MAX = 50;

export type UserTokenUsageKind = (typeof USER_TOKEN_USAGE_KINDS)[number];
export type UserTokenUsageStatusFilter = (typeof USER_TOKEN_USAGE_STATUSES)[number];
export type UserTokenUsageSource = "unifiedQuestion" | "personalQuestion" | "extraction" | "semantic" | "project";
export type UserTokenUsageStatus = Exclude<UserTokenUsageStatusFilter, "all">;

export type UserTokenUsageFilter = Readonly<{
  kind: UserTokenUsageKind;
  status: UserTokenUsageStatusFilter;
  from: Date;
  until: Date;
  fromDate: string;
  toDate: string;
  projectId: string | null;
  pageSize: number;
  cursor: string | null;
}>;

export type UserTokenUsageEntry = Readonly<{
  id: string;
  source: UserTokenUsageSource;
  occurredAt: string;
  status: UserTokenUsageStatus;
  modelId: string;
  operation: string;
  scope: string | null;
  project: Readonly<{ id: string; name: string }> | null;
  usage: TokenUsageSummary;
}>;

export type UserTokenUsagePage = Readonly<{
  filters: Readonly<{
    kind: UserTokenUsageKind;
    status: UserTokenUsageStatusFilter;
    from: string;
    to: string;
    projectId: string | null;
    pageSize: number;
  }>;
  summary: TokenUsageSummary;
  entries: readonly UserTokenUsageEntry[];
  nextCursor: string | null;
}>;

type UsageDb = PrismaClient | Prisma.TransactionClient;
export type UserTokenUsageCursor = Readonly<{ at: string; source: UserTokenUsageSource; id: string }>;

const CURSOR_SCHEMA = z.object({
  at: z.string().datetime({ offset: true }),
  source: z.enum(["unifiedQuestion", "personalQuestion", "extraction", "semantic", "project"]),
  id: z.uuid(),
}).strict();

const DAY_MS = 24 * 60 * 60 * 1_000;
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const querySchema = z.object({
  kind: z.enum(USER_TOKEN_USAGE_KINDS).default("all"),
  status: z.enum(USER_TOKEN_USAGE_STATUSES).default("all"),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  projectId: z.uuid().optional(),
  pageSize: z.coerce.number().int().min(1).max(USER_TOKEN_USAGE_PAGE_SIZE_MAX).default(20),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

function parseDate(value: string, name: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, "INVALID_QUERY", `Invalid ${name} date`);
  }
  return parsed;
}

/** Parse only the supported, unique query fields for the authenticated usage feed. */
export function parseUserTokenUsageFilter(searchParams: URLSearchParams, now: Date): UserTokenUsageFilter {
  for (const key of new Set(searchParams.keys())) {
    if (searchParams.getAll(key).length !== 1) throw new ApiError(400, "INVALID_QUERY", `Query parameter ${key} must be unique`);
  }
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) throw new ApiError(400, "INVALID_QUERY", "Invalid usage query");
  const today = now.toISOString().slice(0, 10);
  const toDate = parsed.data.to ?? today;
  const toStart = parseDate(toDate, "to");
  if (toDate > today) throw new ApiError(400, "INVALID_QUERY", "Usage end date cannot be in the future");
  const fromDate = parsed.data.from ?? new Date(toStart.getTime() - 29 * DAY_MS).toISOString().slice(0, 10);
  const from = parseDate(fromDate, "from");
  if (from.getTime() > toStart.getTime()) throw new ApiError(400, "INVALID_QUERY", "Usage start date must not follow end date");
  const until = new Date(toStart.getTime() + DAY_MS);
  if (until.getTime() - from.getTime() > 366 * DAY_MS) throw new ApiError(400, "INVALID_QUERY", "Usage date range cannot exceed 366 days");
  return Object.freeze({
    kind: parsed.data.kind,
    status: parsed.data.status,
    from,
    until,
    fromDate,
    toDate,
    projectId: parsed.data.projectId?.toLowerCase() ?? null,
    pageSize: parsed.data.pageSize,
    cursor: parsed.data.cursor ?? null,
  });
}

const SOURCE_ORDER: readonly UserTokenUsageSource[] = ["unifiedQuestion", "personalQuestion", "extraction", "semantic", "project"];
const SOURCE_DATE_FIELD: Readonly<Record<UserTokenUsageSource, "createdAt" | "issuedAt">> = Object.freeze({
  unifiedQuestion: "createdAt",
  personalQuestion: "createdAt",
  extraction: "issuedAt",
  semantic: "createdAt",
  project: "createdAt",
});

function isSourceEnabled(filter: UserTokenUsageFilter, source: UserTokenUsageSource): boolean {
  if (filter.kind !== "all" && filter.kind !== source) return false;
  if (filter.projectId !== null && source !== "unifiedQuestion" && source !== "project") return false;
  return true;
}

function normalizedStatus(status: string): UserTokenUsageStatus {
  return USER_TOKEN_USAGE_STATUSES.includes(status as UserTokenUsageStatusFilter) && status !== "all"
    ? status as UserTokenUsageStatus
    : "unknown";
}

function sourceFilter(status: UserTokenUsageStatusFilter): { status?: UserTokenUsageStatus } {
  return status === "all" ? {} : { status };
}

// Personal Q&A and semantic ledgers have a closed four-value database enum.
// A cancelled filter must return no rows instead of passing an invalid enum
// value to Prisma; string-based extraction/project ledgers keep their status.
function enumSourceFilter(status: UserTokenUsageStatusFilter): {
  status?: Exclude<UserTokenUsageStatus, "cancelled"> | { in: never[] };
} {
  if (status === "cancelled") return { status: { in: [] } };
  return status === "all" ? {} : { status };
}

export function decodeUserTokenUsageCursor(value: string | null): UserTokenUsageCursor | null {
  if (value === null) return null;
  if (value.length > 512) throw new ApiError(400, "INVALID_QUERY", "Invalid usage cursor");
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = CURSOR_SCHEMA.safeParse(JSON.parse(decoded));
    if (!parsed.success) throw new Error("invalid cursor shape");
    return Object.freeze(parsed.data);
  } catch {
    throw new ApiError(400, "INVALID_QUERY", "Invalid usage cursor");
  }
}

export function encodeUserTokenUsageCursor(entry: Pick<UserTokenUsageEntry, "occurredAt" | "source" | "id">): string {
  return Buffer.from(JSON.stringify({ at: entry.occurredAt, source: entry.source, id: entry.id }), "utf8").toString("base64url");
}

/**
 * Build a strict-after keyset predicate for a globally ordered merged feed.
 * Each underlying ledger has its own timestamp column, but the source order
 * and UUID tie-break make equal-time rows stable across pages.
 */
export function userTokenUsageCursorWhere(source: UserTokenUsageSource, cursor: UserTokenUsageCursor): Record<string, unknown> {
  const field = SOURCE_DATE_FIELD[source];
  const sourceOrder = SOURCE_ORDER.indexOf(source);
  const cursorOrder = SOURCE_ORDER.indexOf(cursor.source);
  const at = new Date(cursor.at);
  if (sourceOrder < cursorOrder) return { [field]: { lt: at } };
  if (sourceOrder > cursorOrder) return { OR: [{ [field]: { lt: at } }, { [field]: { equals: at } }] };
  return {
    OR: [
      { [field]: { lt: at } },
      { AND: [{ [field]: { equals: at } }, { id: { lt: cursor.id } }] },
    ],
  };
}

function summaryFromBuckets(groups: readonly Readonly<{
  usageKnown: boolean;
  _count: { _all: number };
  _sum: { inputTokens: number | null; outputTokens: number | null };
}>[]): TokenUsageSummary {
  return summarizeTokenUsageBuckets(groups.map((row) => ({
    count: row._count._all,
    usageKnown: row.usageKnown,
    inputTokens: row.usageKnown ? row._sum.inputTokens : null,
    outputTokens: row.usageKnown ? row._sum.outputTokens : null,
  })));
}

function summaryFromRequestBuckets(groups: readonly Readonly<{
  usageKnown: boolean;
  _sum: { requestCount: number | null; inputTokens: number | null; outputTokens?: number | null };
}>[], inputOnly = false): TokenUsageSummary {
  const rows = groups.map((row) => ({
    count: row._sum.requestCount ?? 0,
    usageKnown: row.usageKnown,
    inputTokens: row.usageKnown ? row._sum.inputTokens : null,
    outputTokens: inputOnly || !row.usageKnown ? null : row._sum.outputTokens ?? null,
  }));
  if (!inputOnly) return summarizeTokenUsageBuckets(rows);

  let requestCount = 0;
  let knownRequestCount = 0;
  let inputTokens = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.count) || row.count < 0) return unknownTokenUsage();
    requestCount += row.count;
    if (row.usageKnown && row.inputTokens !== null && Number.isSafeInteger(row.inputTokens) && row.inputTokens >= 0) {
      knownRequestCount += row.count;
      inputTokens += row.inputTokens;
    }
  }
  if (!Number.isSafeInteger(requestCount) || !Number.isSafeInteger(knownRequestCount) || !Number.isSafeInteger(inputTokens)) return unknownTokenUsage();
  if (requestCount === 0) return NO_TOKEN_USAGE;
  const unknownRequestCount = requestCount - knownRequestCount;
  return Object.freeze({
    status: knownRequestCount === 0 ? "unknown" : unknownRequestCount > 0 ? "partial" : "known",
    requestCount,
    knownRequestCount,
    unknownRequestCount,
    inputTokens: knownRequestCount === 0 ? null : inputTokens,
    outputTokens: null,
    totalTokens: knownRequestCount === 0 ? null : inputTokens,
  });
}

function usageFromRecord(input: Readonly<{ usageKnown: boolean; inputTokens: number; outputTokens: number }>): TokenUsageSummary {
  return summarizeTokenUsage([{
    usageKnown: input.usageKnown,
    inputTokens: input.usageKnown ? input.inputTokens : null,
    outputTokens: input.usageKnown ? input.outputTokens : null,
  }]);
}

function usageFromInputOnlyRecord(input: Readonly<{ requestCount: number; usageKnown: boolean; inputTokens: number }>): TokenUsageSummary {
  return summaryFromRequestBuckets([{
    usageKnown: input.usageKnown,
    _sum: { requestCount: input.requestCount, inputTokens: input.inputTokens },
  }], true);
}

function mergeUsage(summaries: readonly TokenUsageSummary[]): TokenUsageSummary {
  const available = summaries.filter((summary) => summary.status !== "notAvailable");
  if (available.length === 0) return NO_TOKEN_USAGE;
  let requestCount = 0;
  let knownRequestCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasInput = false;
  let hasOutput = false;
  let outputIncomplete = false;
  let hasTotal = false;
  for (const summary of available) {
    requestCount += summary.requestCount;
    knownRequestCount += summary.knownRequestCount;
    if (summary.inputTokens !== null) { inputTokens += summary.inputTokens; hasInput = true; }
    if (summary.outputTokens !== null) { outputTokens += summary.outputTokens; hasOutput = true; }
    else if (summary.knownRequestCount > 0) outputIncomplete = true;
    if (summary.totalTokens !== null) { totalTokens += summary.totalTokens; hasTotal = true; }
  }
  if (!Number.isSafeInteger(requestCount) || !Number.isSafeInteger(knownRequestCount)
    || !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || !Number.isSafeInteger(totalTokens)) {
    return unknownTokenUsage();
  }
  const unknownRequestCount = requestCount - knownRequestCount;
  return Object.freeze({
    status: knownRequestCount === 0 ? "unknown" : unknownRequestCount > 0 ? "partial" : "known",
    requestCount,
    knownRequestCount,
    unknownRequestCount,
    inputTokens: hasInput ? inputTokens : null,
    outputTokens: hasOutput && !outputIncomplete ? outputTokens : null,
    totalTokens: hasTotal ? totalTokens : null,
  });
}

function projectAuditWhere(actor: WebAiActor, filter: UserTokenUsageFilter): Prisma.ProviderCallAuditWhereInput {
  const projectWhere: Prisma.ProjectWhereInput = {
    AND: [
      accessibleProjectWhere(actor),
      { workspace: { closedAt: null } },
      ...(filter.projectId === null ? [] : [{ id: filter.projectId }]),
    ],
  };
  return {
    AND: [
      { createdAt: { gte: filter.from, lt: filter.until }, ...sourceFilter(filter.status) },
      { job: { is: { project: { is: projectWhere } } } },
      { OR: [{ billingUserId: actor.id }, { job: { is: { requestedById: actor.id } } }] },
    ],
  };
}

type AccessibleProject = Readonly<{ id: string; name: string }>;

function postgresUuidArray(ids: readonly string[]) {
  return ids.length === 0
    ? Prisma.sql`ARRAY[]::uuid[]`
    : Prisma.sql`ARRAY[${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}]::uuid[]`;
}

function unifiedQuestionWhereSql(
  actor: WebAiActor,
  filter: UserTokenUsageFilter,
  accessibleProjectIds: readonly string[],
  cursor: UserTokenUsageCursor | null,
) {
  const status = filter.status === "all" ? Prisma.empty : Prisma.sql`AND a."status"::text = ${filter.status}`;
  const project = filter.projectId === null
    ? Prisma.empty
    : Prisma.sql`AND (${filter.projectId}::uuid = ANY(a."scopeProjectIds") OR c."projectId" = ${filter.projectId}::uuid)`;
  const cursorOrder = cursor === null ? -1 : SOURCE_ORDER.indexOf(cursor.source);
  const sourceOrder = SOURCE_ORDER.indexOf("unifiedQuestion");
  const cursorWhere = cursor === null
    ? Prisma.empty
    : sourceOrder < cursorOrder
      ? Prisma.sql`AND a."createdAt" < ${new Date(cursor.at)}`
      : sourceOrder > cursorOrder
        ? Prisma.sql`AND a."createdAt" <= ${new Date(cursor.at)}`
        : Prisma.sql`AND (a."createdAt" < ${new Date(cursor.at)} OR (a."createdAt" = ${new Date(cursor.at)} AND a."id" < ${cursor.id}::uuid))`;
  return Prisma.sql`
    FROM "UnifiedQuestionAudit" AS a
    INNER JOIN "UnifiedQuestionConfirmation" AS c
      ON c."ownerUserId" = a."ownerUserId" AND c."id" = a."confirmationId"
    WHERE a."ownerUserId" = ${actor.id}::uuid
      AND a."createdAt" >= ${filter.from}
      AND a."createdAt" < ${filter.until}
      AND a."scopeProjectIds" <@ ${postgresUuidArray(accessibleProjectIds)}
      AND (c."projectId" IS NULL OR c."projectId" = ANY(${postgresUuidArray(accessibleProjectIds)}))
      ${status}
      ${project}
      ${cursorWhere}
  `;
}

async function readAccessibleUnifiedProjects(actor: WebAiActor, filter: UserTokenUsageFilter, db: UsageDb): Promise<readonly AccessibleProject[]> {
  if (!isSourceEnabled(filter, "unifiedQuestion")) return Object.freeze([]);
  const status = filter.status === "all" ? Prisma.empty : Prisma.sql`AND a."status"::text = ${filter.status}`;
  const project = filter.projectId === null
    ? Prisma.empty
    : Prisma.sql`AND (${filter.projectId}::uuid = ANY(a."scopeProjectIds") OR c."projectId" = ${filter.projectId}::uuid)`;
  const candidates = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT scoped."projectId" AS "id"
    FROM (
      SELECT UNNEST(a."scopeProjectIds") AS "projectId"
      FROM "UnifiedQuestionAudit" AS a
      INNER JOIN "UnifiedQuestionConfirmation" AS c
        ON c."ownerUserId" = a."ownerUserId" AND c."id" = a."confirmationId"
      WHERE a."ownerUserId" = ${actor.id}::uuid
        AND a."createdAt" >= ${filter.from}
        AND a."createdAt" < ${filter.until}
        ${status}
        ${project}
      UNION
      SELECT c."projectId" AS "projectId"
      FROM "UnifiedQuestionAudit" AS a
      INNER JOIN "UnifiedQuestionConfirmation" AS c
        ON c."ownerUserId" = a."ownerUserId" AND c."id" = a."confirmationId"
      WHERE a."ownerUserId" = ${actor.id}::uuid
        AND a."createdAt" >= ${filter.from}
        AND a."createdAt" < ${filter.until}
        AND c."projectId" IS NOT NULL
        ${status}
        ${project}
    ) AS scoped
    WHERE scoped."projectId" IS NOT NULL
    GROUP BY scoped."projectId"
    ORDER BY scoped."projectId"
    LIMIT 1_001
  `);
  if (candidates.length > 1_000) {
    throw new ApiError(422, "USAGE_SCOPE_TOO_BROAD", "Usage scope spans more than 1,000 projects. Select one project or a shorter date range.");
  }
  if (candidates.length === 0) return Object.freeze([]);
  const rows = await db.project.findMany({
    where: {
      AND: [
        accessibleProjectWhere(actor),
        { workspace: { closedAt: null } },
        { id: { in: candidates.map((candidate) => candidate.id) } },
      ],
    },
    orderBy: { id: "asc" },
    select: { id: true, name: true },
  });
  return Object.freeze(rows);
}

type RawUnifiedUsageEntry = Readonly<{
  id: string;
  status: string;
  modelId: string;
  usageKnown: boolean;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
  scope: string;
  projectId: string | null;
  scopeProjectIds: string[];
}>;

type RawUnifiedUsageGroup = Readonly<{
  usageKnown: boolean;
  requestCount: bigint | number;
  inputTokens: bigint | number | null;
  outputTokens: bigint | number | null;
}>;

function safeDatabaseInteger(value: bigint | number | null): number | null {
  if (value === null) return null;
  const number = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(number) ? number : Number.MAX_SAFE_INTEGER + 1;
}

async function queryUnifiedQuestionEntries(
  actor: WebAiActor,
  filter: UserTokenUsageFilter,
  cursor: UserTokenUsageCursor | null,
  projects: readonly AccessibleProject[],
  db: UsageDb,
): Promise<readonly UserTokenUsageEntry[]> {
  if (!isSourceEnabled(filter, "unifiedQuestion")) return Object.freeze([]);
  const where = unifiedQuestionWhereSql(actor, filter, projects.map((project) => project.id), cursor);
  const rows = await db.$queryRaw<RawUnifiedUsageEntry[]>(Prisma.sql`
    SELECT a."id", a."status"::text AS "status", a."modelId", a."usageKnown", a."inputTokens", a."outputTokens",
      a."createdAt", c."scope", c."projectId", a."scopeProjectIds"
    ${where}
    ORDER BY a."createdAt" DESC, a."id" DESC
    LIMIT ${filter.pageSize + 1}
  `);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  return Object.freeze(rows.map((row) => {
    const singleScopeProjectId = row.scopeProjectIds.length === 1 ? row.scopeProjectIds[0] : null;
    const visibleProjectId = filter.projectId ?? row.projectId ?? singleScopeProjectId;
    return {
      id: row.id,
      source: "unifiedQuestion" as const,
      occurredAt: row.createdAt.toISOString(),
      status: normalizedStatus(row.status),
      modelId: row.modelId,
      operation: "unifiedQuestion",
      scope: row.scope,
      project: visibleProjectId ? projectById.get(visibleProjectId) ?? null : null,
      usage: usageFromRecord(row),
    };
  }));
}

async function queryUnifiedQuestionSummary(
  actor: WebAiActor,
  filter: UserTokenUsageFilter,
  projects: readonly AccessibleProject[],
  db: UsageDb,
): Promise<TokenUsageSummary> {
  if (!isSourceEnabled(filter, "unifiedQuestion")) return NO_TOKEN_USAGE;
  const where = unifiedQuestionWhereSql(actor, filter, projects.map((project) => project.id), null);
  const groups = await db.$queryRaw<RawUnifiedUsageGroup[]>(Prisma.sql`
    SELECT a."usageKnown", COUNT(*) AS "requestCount",
      SUM(a."inputTokens") AS "inputTokens", SUM(a."outputTokens") AS "outputTokens"
    ${where}
    GROUP BY a."usageKnown"
  `);
  return summaryFromBuckets(groups.map((row) => ({
    usageKnown: row.usageKnown,
    _count: { _all: safeDatabaseInteger(row.requestCount) ?? 0 },
    _sum: {
      inputTokens: safeDatabaseInteger(row.inputTokens),
      outputTokens: safeDatabaseInteger(row.outputTokens),
    },
  })));
}

async function queryEntries(
  actor: WebAiActor,
  filter: UserTokenUsageFilter,
  cursor: UserTokenUsageCursor | null,
  projects: readonly AccessibleProject[],
  db: UsageDb,
): Promise<readonly UserTokenUsageEntry[]> {
  const take = filter.pageSize + 1;
  const result: UserTokenUsageEntry[] = [];

  result.push(...await queryUnifiedQuestionEntries(actor, filter, cursor, projects, db));

  if (isSourceEnabled(filter, "personalQuestion")) {
    const base: Prisma.PersonalKnowledgeQaAuditWhereInput = {
      ownerUserId: actor.id,
      createdAt: { gte: filter.from, lt: filter.until },
      ...enumSourceFilter(filter.status),
    };
    const where: Prisma.PersonalKnowledgeQaAuditWhereInput = cursor === null
      ? base
      : { AND: [base, userTokenUsageCursorWhere("personalQuestion", cursor) as Prisma.PersonalKnowledgeQaAuditWhereInput] };
    const rows = await db.personalKnowledgeQaAudit.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: { id: true, status: true, modelId: true, usageKnown: true, inputTokens: true, outputTokens: true, createdAt: true },
    });
    result.push(...rows.map<UserTokenUsageEntry>((row) => ({
      id: row.id, source: "personalQuestion", occurredAt: row.createdAt.toISOString(), status: normalizedStatus(row.status),
      modelId: row.modelId, operation: "personalKnowledgeQa", scope: null, project: null,
      usage: usageFromRecord(row),
    })));
  }

  if (isSourceEnabled(filter, "extraction")) {
    const base: Prisma.PersonalKnowledgeExtractionAttemptWhereInput = {
      ownerUserId: actor.id,
      issuedAt: { gte: filter.from, lt: filter.until },
      requestCount: { gt: 0 },
      ...sourceFilter(filter.status),
    };
    const where: Prisma.PersonalKnowledgeExtractionAttemptWhereInput = cursor === null
      ? base
      : { AND: [base, userTokenUsageCursorWhere("extraction", cursor) as Prisma.PersonalKnowledgeExtractionAttemptWhereInput] };
    const rows = await db.personalKnowledgeExtractionAttempt.findMany({
      where,
      orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
      take,
      select: { id: true, status: true, modelId: true, operation: true, requestCount: true, usageKnown: true, inputTokens: true, outputTokens: true, issuedAt: true },
    });
    result.push(...rows.map<UserTokenUsageEntry>((row) => ({
      id: row.id, source: "extraction", occurredAt: row.issuedAt.toISOString(), status: normalizedStatus(row.status),
      modelId: row.modelId, operation: row.operation, scope: null, project: null,
      usage: summaryFromRequestBuckets([{
        usageKnown: row.usageKnown,
        _sum: { requestCount: row.requestCount, inputTokens: row.inputTokens, outputTokens: row.outputTokens },
      }]),
    })));
  }

  if (isSourceEnabled(filter, "semantic")) {
    const base: Prisma.PersonalKnowledgeSemanticAuditWhereInput = {
      ownerUserId: actor.id,
      createdAt: { gte: filter.from, lt: filter.until },
      requestCount: { gt: 0 },
      ...enumSourceFilter(filter.status),
    };
    const where: Prisma.PersonalKnowledgeSemanticAuditWhereInput = cursor === null
      ? base
      : { AND: [base, userTokenUsageCursorWhere("semantic", cursor) as Prisma.PersonalKnowledgeSemanticAuditWhereInput] };
    const rows = await db.personalKnowledgeSemanticAudit.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: { id: true, status: true, modelId: true, kind: true, requestCount: true, usageKnown: true, inputTokens: true, createdAt: true },
    });
    result.push(...rows.map<UserTokenUsageEntry>((row) => ({
      id: row.id, source: "semantic", occurredAt: row.createdAt.toISOString(), status: normalizedStatus(row.status),
      modelId: row.modelId, operation: row.kind, scope: null, project: null,
      usage: usageFromInputOnlyRecord({ requestCount: row.requestCount, usageKnown: row.usageKnown, inputTokens: row.inputTokens }),
    })));
  }

  if (isSourceEnabled(filter, "project")) {
    const base = projectAuditWhere(actor, filter);
    const where: Prisma.ProviderCallAuditWhereInput = cursor === null
      ? base
      : { AND: [base, userTokenUsageCursorWhere("project", cursor) as Prisma.ProviderCallAuditWhereInput] };
    const rows = await db.providerCallAudit.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true, status: true, modelId: true, operation: true, usageKnown: true, inputTokens: true, outputTokens: true, createdAt: true,
        job: { select: { kind: true, project: { select: { id: true, name: true } } } },
      },
    });
    result.push(...rows.flatMap((row) => {
      if (row.job?.project === null || row.job?.project === undefined) return [];
      return [{
        id: row.id, source: "project" as const, occurredAt: row.createdAt.toISOString(), status: normalizedStatus(row.status),
        modelId: row.modelId, operation: `${row.job.kind}:${row.operation}`, scope: null,
        project: Object.freeze({ id: row.job.project.id, name: row.job.project.name }),
        usage: usageFromRecord(row),
      }];
    }));
  }

  return Object.freeze(result);
}

async function querySummaries(actor: WebAiActor, filter: UserTokenUsageFilter, projects: readonly AccessibleProject[], db: UsageDb): Promise<readonly TokenUsageSummary[]> {
  const summaries: TokenUsageSummary[] = [];
  if (isSourceEnabled(filter, "unifiedQuestion")) {
    summaries.push(await queryUnifiedQuestionSummary(actor, filter, projects, db));
  }
  if (isSourceEnabled(filter, "personalQuestion")) {
    const where: Prisma.PersonalKnowledgeQaAuditWhereInput = { ownerUserId: actor.id, createdAt: { gte: filter.from, lt: filter.until }, ...enumSourceFilter(filter.status) };
    const groups = await db.personalKnowledgeQaAudit.groupBy({ by: ["usageKnown"], where, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true } });
    summaries.push(summaryFromBuckets(groups));
  }
  if (isSourceEnabled(filter, "extraction")) {
    const where: Prisma.PersonalKnowledgeExtractionAttemptWhereInput = { ownerUserId: actor.id, issuedAt: { gte: filter.from, lt: filter.until }, requestCount: { gt: 0 }, ...sourceFilter(filter.status) };
    const groups = await db.personalKnowledgeExtractionAttempt.groupBy({ by: ["usageKnown"], where, _sum: { requestCount: true, inputTokens: true, outputTokens: true } });
    summaries.push(summaryFromRequestBuckets(groups));
  }
  if (isSourceEnabled(filter, "semantic")) {
    const where: Prisma.PersonalKnowledgeSemanticAuditWhereInput = { ownerUserId: actor.id, createdAt: { gte: filter.from, lt: filter.until }, requestCount: { gt: 0 }, ...enumSourceFilter(filter.status) };
    const groups = await db.personalKnowledgeSemanticAudit.groupBy({ by: ["usageKnown"], where, _sum: { requestCount: true, inputTokens: true } });
    summaries.push(summaryFromRequestBuckets(groups, true));
  }
  if (isSourceEnabled(filter, "project")) {
    const groups = await db.providerCallAudit.groupBy({ by: ["usageKnown"], where: projectAuditWhere(actor, filter), _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true } });
    summaries.push(summaryFromBuckets(groups));
  }
  return Object.freeze(summaries);
}

/** Read the signed-in user's own personal and currently accessible project usage. */
export async function getUserTokenUsagePage(
  actor: WebAiActor,
  filter: UserTokenUsageFilter,
  db: UsageDb = getDb(),
): Promise<UserTokenUsagePage> {
  if (filter.projectId !== null) await assertWebAiProjectAccess(actor, filter.projectId, "view", db as PrismaClient);
  const cursor = decodeUserTokenUsageCursor(filter.cursor);
  const projects = await readAccessibleUnifiedProjects(actor, filter, db);
  const [rows, summaries] = await Promise.all([
    queryEntries(actor, filter, cursor, projects, db),
    querySummaries(actor, filter, projects, db),
  ]);
  const sorted = [...rows].sort((left, right) => {
    const timeDelta = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    if (timeDelta !== 0) return timeDelta;
    const sourceDelta = SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source);
    if (sourceDelta !== 0) return sourceDelta;
    return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
  });
  const entries = sorted.slice(0, filter.pageSize);
  const hasNext = sorted.length > filter.pageSize;
  const nextCursor = hasNext && entries.length > 0 ? encodeUserTokenUsageCursor(entries[entries.length - 1]!) : null;
  return Object.freeze({
    filters: Object.freeze({ kind: filter.kind, status: filter.status, from: filter.fromDate, to: filter.toDate, projectId: filter.projectId, pageSize: filter.pageSize }),
    summary: mergeUsage(summaries),
    entries: Object.freeze(entries),
    nextCursor,
  });
}
