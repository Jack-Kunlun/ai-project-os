import { Prisma, type AiOperation, type PlatformTokenLedgerEntryKind } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { accessibleProjectWhere, type AccessUser } from "@/lib/access-control";
import { getPlatformTokenSummaryInTransaction, type EntitlementDb, type PlatformCreditSummary } from "@/lib/ai-entitlements";
import { getCurrentMembershipApplication } from "@/lib/membership-application-service";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RANGE_VALUES = ["7d", "30d", "90d", "365d", "custom"] as const;
const LEDGER_KINDS = ["grant", "reserve", "settle", "release", "hold", "adjustment"] as const;
const OPERATIONS = ["embedding", "visionExtract", "autoExtract", "sourceSummary", "projectAnalysis", "generateWithContext"] as const;
const QUERY_KEYS = new Set(["range", "from", "to", "timezone", "page", "pageSize", "kind", "operation", "modelId", "projectId", "scope"]);

export type CreditReportRange = (typeof RANGE_VALUES)[number];
export type CreditReportLedgerKind = (typeof LEDGER_KINDS)[number];
export type CreditReportOperation = (typeof OPERATIONS)[number];
export type CreditReportScope = "all" | "personal" | "project";

type DateParts = Readonly<{ year: number; month: number; day: number }>;

export type CreditReportQueryInput = Readonly<{
  range: CreditReportRange;
  from: string | null;
  to: string | null;
  timezone: string;
  page: number;
  pageSize: number;
  kind: CreditReportLedgerKind | "all";
  operation: CreditReportOperation | "all";
  modelId: string | null;
  projectId: string | null;
  scope: CreditReportScope;
}>;

export type CreditReportWindow = Readonly<{
  from: Date;
  to: Date;
  fromDate: string;
  toDate: string;
  days: readonly string[];
}>;

export type CreditReportQuery = CreditReportQueryInput & Readonly<{ window: CreditReportWindow }>;

export type CreditReportDailyPoint = Readonly<{
  date: string;
  settledCredits: number;
  settledRawTokens: number;
  rawTokenCoverageComplete: boolean;
  pendingCredits: number;
}>;

export type CreditReportLedgerEntry = Readonly<{
  id: string;
  occurredAt: Date;
  kind: CreditReportLedgerKind;
  kindLabel: string;
  operation: CreditReportOperation | null;
  operationLabel: string | null;
  modelId: string | null;
  projectName: string;
  settledCredits: number;
  balanceDelta: number;
  status: "active" | "expired" | "revoked" | "reserved" | "settled" | "released" | "pending" | "adjusted";
}>;

export type CreditReportMembershipApplication = Readonly<{
  id: string;
  status: "pending" | "fulfilled" | "rejected" | "withdrawn";
  statusVersion: number;
  submittedAt: Date;
  fulfilledAt: Date | null;
  rejectedAt: Date | null;
  withdrawnAt: Date | null;
}>;

export type CreditReport = Readonly<{
  asOf: Date;
  query: CreditReportQuery;
  summary: PlatformCreditSummary;
  usage: Readonly<{
    daily: readonly CreditReportDailyPoint[];
    settledCredits: number;
    pendingCredits: number;
  }>;
  ledger: Readonly<{
    entries: readonly CreditReportLedgerEntry[];
    page: number;
    pageSize: number;
    total: number;
    hasNextPage: boolean;
  }>;
  membershipApplication: CreditReportMembershipApplication | null;
}>;

function invalidQuery(message = "额度报表查询参数无效"): never {
  throw new ApiError(400, "CREDITS_INVALID_QUERY", message);
}

function assertSingle(searchParams: URLSearchParams, key: string): string | null {
  const values = searchParams.getAll(key);
  if (values.length > 1) invalidQuery(`Query parameter ${key} must be unique`);
  return values[0] ?? null;
}

function parseEnum<T extends string>(value: string | null, allowed: readonly T[], fallback: T, label: string): T {
  if (value === null || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  invalidQuery(`${label} 无效`);
}

function parsePositiveInt(value: string | null, fallback: number, max: number, label: string): number {
  if (value === null || value === "") return fallback;
  if (!/^[1-9]\d*$/u.test(value)) invalidQuery(`${label} 无效`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) invalidQuery(`${label} 超出范围`);
  return parsed;
}

function parseDateParts(value: string, label: string): DateParts {
  const match = DATE_ONLY.exec(value);
  if (match === null) invalidQuery(`${label} 必须是 YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970 || year > 9999 || candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) invalidQuery(`${label} 不是有效日期`);
  return { year, month, day };
}

function dateToString(date: DateParts): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function shiftDate(date: DateParts, days: number): DateParts {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function localDateParts(date: Date, timezone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.get("year")), month: Number(values.get("month")), day: Number(values.get("day")) };
}

function localDateTimeParts(date: Date, timezone: string): Readonly<{ year: number; month: number; day: number; hour: number; minute: number; second: number }> {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")), month: Number(values.get("month")), day: Number(values.get("day")),
    hour: Number(values.get("hour")), minute: Number(values.get("minute")), second: Number(values.get("second")),
  };
}

/** Convert a local midnight to UTC while honoring the requested IANA zone. */
function localMidnight(date: DateParts, timezone: string): Date {
  const desired = Date.UTC(date.year, date.month - 1, date.day);
  let candidate = desired;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const local = localDateTimeParts(new Date(candidate), timezone);
    const observed = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    candidate += desired - observed;
  }
  const result = new Date(candidate);
  const resolved = localDateTimeParts(result, timezone);
  if (resolved.year !== date.year || resolved.month !== date.month || resolved.day !== date.day || resolved.hour !== 0 || resolved.minute !== 0 || resolved.second !== 0) invalidQuery("日期范围在指定时区中不可用");
  return result;
}

function validateTimezone(value: string | null): string {
  const timezone = value === null || value === "" ? "UTC" : value.trim();
  if (timezone.length === 0 || timezone.length > 100) invalidQuery("统计时区无效");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    invalidQuery("统计时区无效");
  }
  return timezone;
}

export function parseCreditReportQuery(searchParams: URLSearchParams): CreditReportQueryInput {
  for (const key of searchParams.keys()) if (!QUERY_KEYS.has(key)) invalidQuery(`不支持的查询参数：${key}`);
  const range = parseEnum(assertSingle(searchParams, "range"), RANGE_VALUES, "30d", "统计范围");
  const from = assertSingle(searchParams, "from");
  const to = assertSingle(searchParams, "to");
  if (range === "custom") {
    if (from === null || to === null) invalidQuery("自定义范围需要 from 和 to");
    parseDateParts(from, "from");
    parseDateParts(to, "to");
  } else if (from !== null || to !== null) {
    invalidQuery("预设范围不能同时传入 from 或 to");
  }
  const timezone = validateTimezone(assertSingle(searchParams, "timezone"));
  const kind = parseEnum(assertSingle(searchParams, "kind"), ["all", ...LEDGER_KINDS] as const, "all", "流水类型");
  const operation = parseEnum(assertSingle(searchParams, "operation"), ["all", ...OPERATIONS] as const, "all", "操作类型");
  const modelId = assertSingle(searchParams, "modelId");
  if (modelId !== null && (modelId.trim().length === 0 || modelId.length > 128)) invalidQuery("模型标识无效");
  const projectId = assertSingle(searchParams, "projectId");
  if (projectId !== null && !UUID.test(projectId)) invalidQuery("项目标识无效");
  const scope = parseEnum(assertSingle(searchParams, "scope"), ["all", "personal", "project"] as const, "all", "统计范围类型");
  if (scope === "project" && projectId === null) invalidQuery("项目范围需要 projectId");
  if (scope !== "project" && projectId !== null) invalidQuery("projectId 只能用于项目范围");
  return Object.freeze({
    range, from, to, timezone,
    page: parsePositiveInt(assertSingle(searchParams, "page"), 1, 10_000, "页码"),
    pageSize: parsePositiveInt(assertSingle(searchParams, "pageSize"), 20, 50, "每页条数"),
    kind, operation, modelId: modelId?.trim() ?? null, projectId: projectId?.toLowerCase() ?? null, scope,
  });
}

export function resolveCreditReportQuery(input: CreditReportQueryInput, now: Date): CreditReportQuery {
  if (Number.isNaN(now.getTime())) invalidQuery("当前时间无效");
  const current = localDateParts(now, input.timezone);
  const toParts = input.range === "custom" ? parseDateParts(input.to!, "to") : current;
  const dayCount = input.range === "7d" ? 7 : input.range === "90d" ? 90 : input.range === "365d" ? 365 : 30;
  const fromParts = input.range === "custom" ? parseDateParts(input.from!, "from") : shiftDate(toParts, -(dayCount - 1));
  const fromDate = dateToString(fromParts);
  const toDate = dateToString(toParts);
  if (fromDate > toDate) invalidQuery("日期范围必须至少包含一天");
  const from = localMidnight(fromParts, input.timezone);
  const to = localMidnight(shiftDate(toParts, 1), input.timezone);
  if (to <= from) invalidQuery("日期范围无效");
  const days: string[] = [];
  for (let cursor = fromParts; dateToString(cursor) <= toDate; cursor = shiftDate(cursor, 1)) days.push(dateToString(cursor));
  if (days.length === 0 || days.length > 366) invalidQuery("自定义范围最多支持 366 天");
  return Object.freeze({ ...input, window: Object.freeze({ from, to, fromDate, toDate, days: Object.freeze(days) }) });
}

function sumSafe(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new ApiError(500, "CREDITS_PROJECTION_INCONSISTENT", "额度报表数据暂时无法读取");
  return total;
}

const kindLabels: Readonly<Record<CreditReportLedgerKind, string>> = {
  grant: "额度发放", reserve: "预留", settle: "使用结算", release: "释放", hold: "待核对", adjustment: "额度调整",
};

const operationLabels: Readonly<Record<CreditReportOperation, string>> = {
  embedding: "向量索引", visionExtract: "图片识别", autoExtract: "自动抽取", sourceSummary: "资料摘要", projectAnalysis: "项目分析", generateWithContext: "引用式生成",
};

function statusForEntry(kind: CreditReportLedgerKind, reservationStatus: string | null, expiresAt: Date | null, revokedAt: Date | null, now: Date): CreditReportLedgerEntry["status"] {
  if (kind === "grant" || kind === "adjustment") return revokedAt !== null ? "revoked" : expiresAt !== null && expiresAt <= now ? "expired" : "active";
  if (kind === "reserve") return reservationStatus === "reserved" ? "reserved" : reservationStatus === "held" ? "pending" : "released";
  if (kind === "settle") return "settled";
  if (kind === "release") return "released";
  return "pending";
}

function operationLabel(operation: AiOperation | null): string | null {
  return operation === null ? null : operationLabels[operation as CreditReportOperation] ?? "未知操作";
}

type ReportDb = EntitlementDb;

export async function getCreditReportInTransaction(userId: string, db: ReportDb, query: CreditReportQuery, now: Date): Promise<CreditReport> {
  const summary = await getPlatformTokenSummaryInTransaction(userId, db, now);
  const reservationWhere: Prisma.PlatformTokenReservationWhereInput = {
    userId,
    ...(query.operation === "all" ? {} : { operation: query.operation as AiOperation }),
    ...(query.modelId === null ? {} : { modelId: query.modelId }),
    ...(query.scope === "personal" ? { webAiGrantProjectId: null } : query.scope === "project" ? { webAiGrantProjectId: query.projectId! } : {}),
  };

  const [settledReservations, pendingReservations, ledgerTotal, ledgerRows, membershipApplication] = await Promise.all([
    db.platformTokenReservation.findMany({ where: { ...reservationWhere, status: "settled", settledAt: { gte: query.window.from, lt: query.window.to } }, select: { settledAt: true, rawSettledTokens: true, allocations: { select: { settledTokens: true } } } }),
    db.platformTokenReservation.findMany({ where: { ...reservationWhere, status: "held", createdAt: { gte: query.window.from, lt: query.window.to } }, select: { createdAt: true, reservedTokens: true } }),
    db.platformTokenLedgerEntry.count({ where: {
      userId, createdAt: { gte: query.window.from, lt: query.window.to },
      ...(query.kind === "all" ? {} : { entryKind: query.kind as PlatformTokenLedgerEntryKind }),
      ...(Object.keys(reservationWhere).length <= 1 ? {} : { reservation: { is: reservationWhere } }),
    } }),
    db.platformTokenLedgerEntry.findMany({
      where: {
        userId, createdAt: { gte: query.window.from, lt: query.window.to },
        ...(query.kind === "all" ? {} : { entryKind: query.kind as PlatformTokenLedgerEntryKind }),
        ...(Object.keys(reservationWhere).length <= 1 ? {} : { reservation: { is: reservationWhere } }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true, grantId: true, entryKind: true, amount: true, createdAt: true,
        reservation: { select: { status: true, operation: true, modelId: true, webAiGrantProjectId: true, allocations: { select: { grantId: true, settledTokens: true } } } },
        grant: { select: { expiresAt: true, revokedAt: true } },
      },
    }),
    getCurrentMembershipApplication(userId, db),
  ]);

  const dailySettled = new Map(query.window.days.map((date) => [date, 0]));
  const dailyRawTokens = new Map(query.window.days.map((date) => [date, 0]));
  const dailyRawCoverage = new Map(query.window.days.map((date) => [date, true]));
  const dailyPending = new Map(query.window.days.map((date) => [date, 0]));
  for (const reservation of settledReservations) {
    if (reservation.settledAt === null) continue;
    const date = dateToString(localDateParts(reservation.settledAt, query.timezone));
    if (!dailySettled.has(date)) continue;
    const amount = sumSafe(reservation.allocations.map((allocation) => allocation.settledTokens));
    dailySettled.set(date, dailySettled.get(date)! + amount);
    dailyRawTokens.set(date, sumSafe([dailyRawTokens.get(date)!, reservation.rawSettledTokens ?? 0]));
    if (reservation.rawSettledTokens === null) dailyRawCoverage.set(date, false);
  }
  for (const reservation of pendingReservations) {
    const date = dateToString(localDateParts(reservation.createdAt, query.timezone));
    if (!dailyPending.has(date)) continue;
    if (!Number.isSafeInteger(reservation.reservedTokens) || reservation.reservedTokens < 0) throw new ApiError(500, "CREDITS_PROJECTION_INCONSISTENT", "额度报表数据暂时无法读取");
    dailyPending.set(date, dailyPending.get(date)! + reservation.reservedTokens);
  }
  const daily = Object.freeze(query.window.days.map((date) => Object.freeze({ date, settledCredits: dailySettled.get(date)!, settledRawTokens: dailyRawTokens.get(date)!, rawTokenCoverageComplete: dailyRawCoverage.get(date)!, pendingCredits: dailyPending.get(date)! })));

  const projectIds = [...new Set(ledgerRows.map((row) => row.reservation?.webAiGrantProjectId).filter((id): id is string => typeof id === "string"))];
  const visibleProjects = projectIds.length === 0 ? [] : await db.project.findMany({ where: { AND: [accessibleProjectWhere({ id: userId, role: "user" } satisfies AccessUser), { id: { in: projectIds } }] }, select: { id: true, name: true } });
  const projectNames = new Map(visibleProjects.map((project) => [project.id, project.name]));
  const entries = Object.freeze(ledgerRows.map((row) => {
    const kind = row.entryKind as CreditReportLedgerKind;
    const reservation = row.reservation;
    const allocation = reservation?.allocations.find((candidate) => candidate.grantId === row.grantId);
    const projectName = reservation === null ? "未关联项目" : reservation.webAiGrantProjectId === null ? "未关联项目" : projectNames.get(reservation.webAiGrantProjectId) ?? "项目已不可见";
    return Object.freeze({
      id: row.id,
      occurredAt: row.createdAt,
      kind,
      kindLabel: kindLabels[kind],
      operation: reservation?.operation as CreditReportOperation | null ?? null,
      operationLabel: operationLabel(reservation?.operation ?? null),
      modelId: reservation?.modelId ?? null,
      projectName,
      settledCredits: kind === "settle" ? allocation?.settledTokens ?? 0 : 0,
      balanceDelta: row.amount,
      status: statusForEntry(kind, reservation?.status ?? null, row.grant?.expiresAt ?? null, row.grant?.revokedAt ?? null, now),
    });
  }));

  return Object.freeze({
    asOf: now,
    query,
    summary,
    usage: Object.freeze({ daily, settledCredits: sumSafe(daily.map((point) => point.settledCredits)), pendingCredits: sumSafe(daily.map((point) => point.pendingCredits)) }),
    ledger: Object.freeze({ entries, page: query.page, pageSize: query.pageSize, total: ledgerTotal, hasNextPage: query.page * query.pageSize < ledgerTotal }),
    membershipApplication: membershipApplication === null ? null : Object.freeze({
      id: membershipApplication.id, status: membershipApplication.status, statusVersion: membershipApplication.statusVersion,
      submittedAt: membershipApplication.submittedAt, fulfilledAt: membershipApplication.fulfilledAt, rejectedAt: membershipApplication.rejectedAt, withdrawnAt: membershipApplication.withdrawnAt,
    }),
  });
}
