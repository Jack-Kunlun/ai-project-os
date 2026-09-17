import {
  SYSTEM_AUDIT_ACTION_LABELS,
  SYSTEM_AUDIT_ACTION_OPTIONS,
  SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE,
  SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE,
  SYSTEM_AUDIT_RESULT_LABELS,
  SYSTEM_AUDIT_RESULT_OPTIONS,
  SYSTEM_AUDIT_SOURCE_LABELS,
  type SystemAuditSource,
} from "@/lib/system-audit-catalog";

export type AuditPrincipal = Readonly<{
  kind: string;
  id: string | null;
  username: string | null;
  displayName: string | null;
}>;

export type AuditEvidence = Readonly<{
  before: Record<string, string | number | boolean | null>;
  after: Record<string, string | number | boolean | null>;
  versions: Record<string, number | null>;
  safeErrorCode: string | null;
  reasonRecorded: boolean;
}>;

export type AuditEvent = Readonly<{
  id: string;
  source: string;
  action: string;
  result: string;
  occurredAt: string;
  actor: AuditPrincipal;
  subject: AuditPrincipal | null;
  references: Record<string, string>;
  evidence: AuditEvidence;
}>;

export type AuditList = Readonly<{
  events: readonly AuditEvent[];
  nextCursor: string | null;
  snapshotAt: string;
  pageSize: number;
}>;

export type FilterValues = Readonly<Record<string, string>>;

export type AuditFilterInput = Readonly<{
  source: string;
  action: string;
  result: string;
  actor: string;
  subject: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  from: string;
  to: string;
}>;

/**
 * The audit list is served by a cursor protocol with a fixed page size.  The
 * page-size value is part of the request contract and must not drift when the
 * filters are re-organised in the UI.
 */
export const AUDIT_PAGE_SIZE = 20;

/**
 * Filters that only appear when the operator explicitly expands the advanced
 * section.  These carry raw identifier values that are rarely typed.
 */
export const ADVANCED_FILTER_KEYS = ["action", "projectId", "workspaceId", "userId"] as const;

const FILTER_LABELS: Readonly<Record<string, string>> = {
  source: "来源",
  action: "动作",
  result: "结果",
  actor: "操作者",
  subject: "主体",
  projectId: "项目 ID",
  workspaceId: "工作区 ID",
  userId: "用户 ID",
  from: "开始时间",
  to: "结束时间",
};

const REFERENCE_LABELS: Readonly<Record<string, string>> = {
  categories: "证据类别",
  projectId: "项目引用",
  workspaceId: "工作区引用",
  userId: "用户引用",
  actorId: "操作者引用",
  subjectId: "主体引用",
};

const SOURCE_LABELS: ReadonlyMap<string, string> = new Map(Object.entries(SYSTEM_AUDIT_SOURCE_LABELS));
const ACTION_LABELS: ReadonlyMap<string, string> = new Map(Object.entries(SYSTEM_AUDIT_ACTION_LABELS));
const RESULT_LABELS: ReadonlyMap<string, string> = new Map(Object.entries(SYSTEM_AUDIT_RESULT_LABELS));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function auditSourceLabel(value: string): string {
  return SOURCE_LABELS.get(value) ?? value;
}

export function auditActionLabel(value: string): string {
  return ACTION_LABELS.get(value) ?? value;
}

export function auditResultLabel(value: string): string {
  return RESULT_LABELS.get(value) ?? value;
}

/**
 * Long identifiers are the reason the filter chips used to blow the row apart.
 * Catalogue-backed values render as their operator-facing label, identifiers
 * show a stable prefix, and the full value stays available through the element
 * title.
 */
export function auditFilterChipValue(key: string, value: string): string {
  if (key === "source") return auditSourceLabel(value);
  if (key === "result") return auditResultLabel(value);
  if (key === "action") return auditActionLabel(value);
  if (key === "from" || key === "to") return shortTimestamp(value);
  if (UUID_PATTERN.test(value) && value.length > 12) return `${value.slice(0, 8)}…`;
  return value.length > 24 ? `${value.slice(0, 24)}…` : value;
}

function shortTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(parsed);
}

export function sourceActions(value: string): readonly string[] {
  return value === "" ? [] : SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE[value as SystemAuditSource] ?? [];
}

export function sourceResults(value: string): readonly string[] {
  return value === "" ? [] : SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE[value as SystemAuditSource] ?? [];
}

export function visibleActionOptions(source: string): ReadonlyArray<readonly [string, string]> {
  if (source === "") return SYSTEM_AUDIT_ACTION_OPTIONS;
  const allowed = sourceActions(source);
  return SYSTEM_AUDIT_ACTION_OPTIONS.filter(([value]) => value === "" || allowed.includes(value));
}

export function visibleResultOptions(source: string): ReadonlyArray<readonly [string, string]> {
  if (source === "") return SYSTEM_AUDIT_RESULT_OPTIONS;
  const allowed = sourceResults(source);
  return SYSTEM_AUDIT_RESULT_OPTIONS.filter(([value]) => value === "" || allowed.includes(value));
}

export function dateParts(value: string, locale = "zh-CN"): Readonly<{ date: string; time: string; full: string }> {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { date: value, time: "", full: value };
  return {
    date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed),
    time: new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(parsed),
    full: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(parsed),
  };
}

export function dateLabel(value: string): string {
  return dateParts(value).full;
}

export function principalLabel(value: AuditPrincipal | null): string {
  if (value === null) return "—";
  if (value.kind === "system") return "系统流程";
  if (value.kind === "unrecorded") return "未记录身份";
  return value.displayName ?? value.username ?? value.id ?? "未记录身份";
}

export function valuesLabel(values: Record<string, string | number | boolean | null>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return "无变化";
  return entries.map(([key, value]) => `${key}=${value === null ? "—" : String(value)}`).join(" · ");
}

export function resultClass(value: string): string {
  if (value === "applied" || value === "restored") return "bg-emerald-50 text-emerald-700";
  if (value === "pending") return "bg-amber-50 text-amber-700";
  if (value === "rejected" || value === "revoked" || value === "disabled" || value === "failed") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-600";
}

/**
 * Turns the raw filter inputs into the query object handed to the audit API.
 * Empty values are dropped and the time inputs are normalised so the server
 * sees the same canonical filter set as before.
 */
export function buildAppliedFilters(input: AuditFilterInput): FilterValues {
  const next: Record<string, string> = {};
  for (const key of ["source", "action", "result", "actor", "subject", "projectId", "workspaceId", "userId"] as const) {
    const value = input[key];
    if (value !== "") next[key] = value;
  }
  if (input.from !== "") next.from = new Date(input.from).toISOString();
  if (input.to !== "") next.to = new Date(input.to).toISOString();
  return next;
}

export function buildAuditQueryString(filters: FilterValues, cursor: string | null, pageSize: number = AUDIT_PAGE_SIZE): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) params.set(key, value);
  params.set("pageSize", String(pageSize));
  if (cursor !== null) params.set("cursor", cursor);
  return params.toString();
}

export type AuditFilterChip = Readonly<{
  key: string;
  label: string;
  value: string;
  display: string;
}>;

export function auditFilterChips(filters: FilterValues): readonly AuditFilterChip[] {
  return Object.entries(filters).map(([key, value]) => ({
    key,
    label: FILTER_LABELS[key] ?? key,
    value,
    display: auditFilterChipValue(key, value),
  }));
}

export function hasFilters(filters: FilterValues): boolean {
  return Object.keys(filters).length > 0;
}

export function hasAdvancedFilterValues(input: AuditFilterInput): boolean {
  return ADVANCED_FILTER_KEYS.some((key) => input[key] !== "");
}

export type AuditReferenceEntry = Readonly<{
  key: string;
  label: string;
  value: string;
  technical: boolean;
}>;

export function isTechnicalReferenceValue(value: string): boolean {
  if (UUID_PATTERN.test(value)) return true;
  return /^[A-Za-z0-9_-]{24,}$/u.test(value);
}

/**
 * The list must stay a summary: only a count of safe references is shown, the
 * identifiers themselves live in the detail drawer.
 */
export function auditReferenceEntries(references: Record<string, string>): readonly AuditReferenceEntry[] {
  return Object.entries(references).map(([key, value]) => ({
    key,
    label: REFERENCE_LABELS[key] ?? key,
    value,
    technical: isTechnicalReferenceValue(value),
  }));
}

export function auditReferenceSummary(references: Record<string, string>): string {
  const keys = Object.keys(references);
  if (keys.length === 0) return "无安全引用";
  const identifierKeys = keys.filter((key) => key !== "categories");
  if (identifierKeys.length === 0) return "仅类别标记";
  return `${identifierKeys.length} 项安全引用`;
}
