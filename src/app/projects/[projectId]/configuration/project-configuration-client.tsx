"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { buildProjectHref } from "@/lib/project-navigation";

/** Trusted identity and project context supplied by the protected server page. */
type ProjectConfigurationClientProps = Readonly<{
  username: string;
  projectId: string;
  isSystemAdmin: boolean;
}>;

/** One endpoint's independent read state; a failed section must not hide siblings. */
type SnapshotState<T> = Readonly<{
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}>;

/** Selection source is closed over known server values; malformed values stay unknown. */
type AiSource = "platformDefault" | "personalDelegation" | "unknown";

/** Allowlisted model selection projection; provider credentials and names stay server-side. */
type AiSelection = Readonly<{
  operation: string;
  /** The server's current route source; never inferred from delegation presence. */
  source: AiSource;
  /** Optimistic concurrency version exposed as a read-only snapshot field. */
  version: number | null;
  /** Capability flags are displayed as labels and do not grant execution rights. */
  operationExecutionAvailable: boolean | null;
  controlPlaneOnly: boolean | null;
}>;

type AiDelegation = Readonly<{
  operation: string;
  /** Lifecycle status is mapped to a safe label; unknown values remain unknown. */
  status: string;
  /** Delegation version and expiry are informational only on this page. */
  version: number | null;
  expiresAt: string | null;
  /** Selection state comes from the route projection and is not recomputed here. */
  selected: boolean | null;
  selectedSource: AiSource;
  operationExecutionAvailable: boolean | null;
  controlPlaneOnly: boolean | null;
}>;

type AiSnapshot = Readonly<{
  /** Route selections and delegation rows are parsed independently from one API payload. */
  selections: readonly AiSelection[];
  delegations: readonly AiDelegation[];
}>;

/** Safe Git scope projection used by this read-only summary. */
type GitDelegation = Readonly<{
  /** Status, version and expiry describe the current delegation snapshot. */
  status: string;
  version: number | null;
  expiresAt: string | null;
  repositoryPath: string | null;
  trackedRef: string | null;
  includeRoots: readonly string[];
  softExcludePatterns: readonly string[];
  /** Scope switches are shown without exposing connection credentials or evidence. */
  role: string | null;
  requiredForProjectSnapshot: boolean | null;
  codeEnabled: boolean | null;
  metadataEnabled: boolean | null;
  manualSyncAllowed: boolean | null;
  automationAllowed: boolean | null;
}>;

type GitSnapshot = Readonly<{ delegations: readonly GitDelegation[] }>;

/** MCP delegation projection limited to lifecycle and effective safety fields. */
type McpDelegation = Readonly<{
  /** Record status and effective status are separate server projections. */
  recordStatus: string;
  effectiveStatus: string;
  /** Effective reason is an allowlisted safety explanation, never a raw error. */
  effectiveReason: string | null;
  evidenceState: string | null;
  version: number | null;
  expiresAt: string | null;
}>;

/** MCP grant projection excludes remote connection evidence and tool schemas. */
type McpGrant = Readonly<{
  /** Tool name is bounded display text; schemas and remote evidence stay hidden. */
  toolName: string | null;
  status: string;
  effective: boolean | null;
  effectiveReason: string | null;
  reviewRequired: boolean | null;
  delegationStatus: string | null;
  expiresAt: string | null;
}>;

type McpSnapshot = Readonly<{
  /** One parser supports both connection and grant endpoints; missing arrays stay empty. */
  delegations: readonly McpDelegation[];
  grants: readonly McpGrant[];
  candidateCount: number;
}>;

const aiOperationLabels: Readonly<Record<string, string>> = {
  embedding: "向量模型",
  visionExtract: "视觉抽取",
  autoExtract: "自动抽取",
  sourceSummary: "资料摘要",
  projectAnalysis: "项目分析",
  generateWithContext: "上下文生成",
};

const aiStatusLabels: Readonly<Record<string, string>> = {
  draft: "待连接所有者确认",
  ownerConfirmed: "待项目 Owner 确认",
  active: "已启用委托",
  rejected: "已拒绝",
  revoked: "已撤销",
  expired: "已到期",
};

const gitStatusLabels: Readonly<Record<string, string>> = {
  draft: "待连接所有者确认",
  ownerConfirmed: "待项目 Owner 确认",
  active: "已启用委托",
  rejected: "已拒绝",
  revoked: "已撤销",
  expired: "已到期",
};

const mcpStatusLabels: Readonly<Record<string, string>> = {
  draft: "待连接所有者确认",
  ownerConfirmed: "待项目 Owner 确认",
  active: "已启用委托",
  rejected: "已拒绝",
  revoked: "已撤销",
  expired: "已到期",
};

const mcpReasonLabels: Readonly<Record<string, string>> = {
  not_active: "委托尚未生效",
  expired: "委托已到期",
  project_archived: "项目已归档",
  connection_evidence_drift: "连接安全证据已变化",
  owner_membership_drift: "连接所有者成员资格已变化",
  project_owner_membership_drift: "项目 Owner 成员资格已变化",
  delegation_missing: "委托记录不存在",
  delegation_not_active: "连接委托已终止",
  delegation_expired: "连接委托已到期",
  definition_drift: "工具定义已变化",
  attestation_missing: "审核证据不存在",
  attestation_invalid: "审核证据已失效",
  attestation_drift: "审核绑定已变化",
  review_required: "需要管理员审核",
  grant_revoked: "工具授权已撤销",
};

/** Accept only plain object-like payloads before reading allowlisted fields. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Treat malformed or absent list fields as empty without trusting their shape. */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Trim user-facing text and truncate it before rendering untrusted endpoint data. */
function readText(record: Record<string, unknown> | null, key: string, maxLength = 240): string | null {
  const value = record?.[key];
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Preserve only actual booleans so missing values are shown as unknown. */
function readBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

/** Keep positive safe integer versions; invalid values cannot become concurrency claims. */
function readVersion(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Validate date text before formatting it; invalid or missing timestamps stay null. */
function readDate(record: Record<string, unknown> | null, key: string): string | null {
  const value = readText(record, key, 80);
  if (value === null || Number.isNaN(new Date(value).getTime())) return null;
  return value;
}

/** Bound each displayed scope list to 24 trimmed entries of 240 characters. */
function readTextArray(value: unknown, maxItems = 24): string[] {
  return asArray(value)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, maxItems)
    .map((item) => item.trim().slice(0, 240));
}

/** Normalize route source values and avoid guessing when the API shape changes. */
function readSource(value: unknown): AiSource {
  return value === "platformDefault" || value === "personalDelegation" ? value : "unknown";
}

/**
 * Normalize only documented MCP reason codes. Unknown server text is reduced
 * to a local sentinel so the page never reflects arbitrary error details.
 */
function readMcpReason(record: Record<string, unknown> | null, key: string): string | null {
  const value = readText(record, key, 120);
  if (value === null) return null;
  const normalized = value.toLowerCase();
  return Object.prototype.hasOwnProperty.call(mcpReasonLabels, normalized) ? normalized : "unknown";
}

/** Project the AI selection allowlist without provider names, URLs or credentials. */
function parseAiSelection(value: unknown): AiSelection | null {
  const record = asRecord(value);
  const operation = readText(record, "operation", 80);
  if (operation === null) return null;
  return Object.freeze({
    operation,
    source: readSource(record?.source),
    version: readVersion(record, "version"),
    operationExecutionAvailable: readBoolean(record, "operationExecutionAvailable"),
    controlPlaneOnly: readBoolean(record, "controlPlaneOnly"),
  });
}

/** Project delegation lifecycle fields while retaining unknown status/source safely. */
function parseAiDelegation(value: unknown): AiDelegation | null {
  const record = asRecord(value);
  const operation = readText(record, "operation", 80);
  if (operation === null) return null;
  return Object.freeze({
    operation,
    status: readText(record, "status", 80) ?? "unknown",
    version: readVersion(record, "version"),
    expiresAt: readDate(record, "expiresAt"),
    selected: readBoolean(record, "selected"),
    selectedSource: readSource(record?.selectedSource),
    operationExecutionAvailable: readBoolean(record, "operationExecutionAvailable"),
    controlPlaneOnly: readBoolean(record, "controlPlaneOnly"),
  });
}

/** Parse the AI endpoint's two independent arrays into a stable UI snapshot. */
function parseAiSnapshot(payload: unknown): AiSnapshot {
  const record = asRecord(payload);
  return Object.freeze({
    selections: asArray(record?.selections).map(parseAiSelection).filter((value): value is AiSelection => value !== null),
    delegations: asArray(record?.delegations).map(parseAiDelegation).filter((value): value is AiDelegation => value !== null),
  });
}

/** Project only Git repository scope and lifecycle fields needed by the summary. */
function parseGitDelegation(value: unknown): GitDelegation | null {
  const record = asRecord(value);
  const scope = asRecord(record?.scope);
  if (record === null && scope === null) return null;
  return Object.freeze({
    status: readText(record, "status", 80) ?? "unknown",
    version: readVersion(record, "version"),
    expiresAt: readDate(record, "expiresAt"),
    repositoryPath: readText(scope, "repositoryPath", 768),
    trackedRef: readText(scope, "trackedRef", 255),
    includeRoots: readTextArray(scope?.includeRoots),
    softExcludePatterns: readTextArray(scope?.softExcludePatterns),
    role: readText(scope, "role", 80),
    requiredForProjectSnapshot: readBoolean(scope, "requiredForProjectSnapshot"),
    codeEnabled: readBoolean(scope, "codeEnabled"),
    metadataEnabled: readBoolean(scope, "metadataEnabled"),
    manualSyncAllowed: readBoolean(scope, "manualSyncAllowed"),
    automationAllowed: readBoolean(scope, "automationAllowed"),
  });
}

/** Parse Git delegations without carrying connection identity or security evidence. */
function parseGitSnapshot(payload: unknown): GitSnapshot {
  const record = asRecord(payload);
  return Object.freeze({
    delegations: asArray(record?.delegations).map(parseGitDelegation).filter((value): value is GitDelegation => value !== null),
  });
}

/** Project MCP effective eligibility and lifecycle fields from the connection API. */
function parseMcpDelegation(value: unknown): McpDelegation | null {
  const record = asRecord(value);
  if (record === null) return null;
  const eligibility = asRecord(record.effectiveEligibility);
  return Object.freeze({
    recordStatus: readText(record, "recordStatus", 80) ?? "unknown",
    effectiveStatus: readText(record, "effectiveStatus", 80) ?? "unknown",
    effectiveReason: readMcpReason(eligibility, "reason"),
    evidenceState: readText(record, "evidenceState", 120),
    version: readVersion(record, "version"),
    expiresAt: readDate(record, "expiresAt"),
  });
}

/** Project grant effectiveness and review flags without remote tool schemas. */
function parseMcpGrant(value: unknown): McpGrant | null {
  const record = asRecord(value);
  if (record === null) return null;
  const delegation = asRecord(record.delegation);
  return Object.freeze({
    toolName: readText(record, "toolName", 120),
    status: readText(record, "status", 80) ?? "unknown",
    effective: readBoolean(record, "effective"),
    effectiveReason: readMcpReason(record, "effectiveReason"),
    reviewRequired: readBoolean(record, "reviewRequired"),
    delegationStatus: readText(delegation, "status", 80),
    expiresAt: readDate(delegation, "expiresAt"),
  });
}

/** Parse either MCP endpoint; absent delegation, grant or candidate arrays remain empty. */
function parseMcpSnapshot(payload: unknown): McpSnapshot {
  const record = asRecord(payload);
  return Object.freeze({
    delegations: asArray(record?.delegations).map(parseMcpDelegation).filter((value): value is McpDelegation => value !== null),
    grants: asArray(record?.grants).map(parseMcpGrant).filter((value): value is McpGrant => value !== null),
    candidateCount: asArray(record?.candidates).length,
  });
}

/** Identify fetch cancellation so normal navigation does not become a user error. */
function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

/**
 * Read one independent control-plane endpoint. The request identity contains
 * both projectId and a monotonic token so a late response cannot repaint a
 * new project after navigation, even if fetch finishes after abort().
 */
function useProjectSnapshot<T>(
  projectId: string,
  endpoint: string,
  parse: (payload: unknown) => T,
  fallback: string,
  forbiddenMessage = "当前账号没有查看此项目配置的权限。",
): SnapshotState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState<Readonly<{ projectId: string; message: string }> | null>(null);
  const requestRef = useRef<{ projectId: string; token: number; controller: AbortController } | null>(null);
  const tokenRef = useRef(0);

  const load = useCallback(async () => {
    requestRef.current?.controller.abort();
    const request = { projectId, token: ++tokenRef.current, controller: new AbortController() };
    requestRef.current = request;
    setLoading(true);
    setErrorState(null);
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal: request.controller.signal });
      if (!response.ok) {
        if (response.status === 403) throw new Error(forbiddenMessage);
        if (response.status === 404) throw new Error("项目配置不存在或当前项目已不可访问。");
        throw new Error(fallback);
      }
      const next = parse(await response.json());
      if (requestRef.current?.token !== request.token || requestRef.current?.projectId !== request.projectId || request.controller.signal.aborted) return;
      setData(next);
      setLoadedProjectId(request.projectId);
    } catch (cause) {
      if (request.controller.signal.aborted || isAbortError(cause) || requestRef.current?.token !== request.token || requestRef.current?.projectId !== request.projectId) return;
      setErrorState({ projectId: request.projectId, message: cause instanceof Error ? cause.message : fallback });
    } finally {
      if (requestRef.current?.token === request.token) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [endpoint, fallback, forbiddenMessage, parse, projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.controller.abort();
      tokenRef.current += 1;
      requestRef.current = null;
    };
  }, [load]);

  return {
    data: loadedProjectId === projectId ? data : null,
    loading,
    error: errorState?.projectId === projectId ? errorState.message : null,
    refresh: () => void load(),
  };
}

/** Format validated timestamps for humans while keeping invalid values explicit. */
function formatDate(value: string | null): string {
  if (value === null) return "暂无到期时间";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Render a server version or state clearly that the snapshot omitted it. */
function formatVersion(value: number | null): string {
  return value === null ? "版本未知" : `v${value}`;
}

/** Map known lifecycle statuses and avoid presenting unknown values as active. */
function statusLabel(value: string, labels: Readonly<Record<string, string>>): string {
  return labels[value] ?? "状态未知";
}

/** Translate known AI operations without exposing arbitrary operation text. */
function operationLabel(value: string): string {
  return aiOperationLabels[value] ?? "未知模型操作";
}

/** Describe the route source exactly as returned, including an explicit unknown state. */
function sourceLabel(value: AiSource): string {
  if (value === "platformDefault") return "平台默认";
  if (value === "personalDelegation") return "个人连接委托";
  return "来源未知";
}

/** Show payer semantics only for known route sources; never infer them from status. */
function payerLabel(value: AiSource): string {
  if (value === "platformDefault") return "平台额度/调用方承担";
  if (value === "personalDelegation") return "连接所有者承担供应商费用";
  return "费用承担者未知";
}

/** Convert capability flags to explanatory labels, without claiming an action can run. */
function capabilityLabels(operationExecutionAvailable: boolean | null, controlPlaneOnly: boolean | null): string[] {
  if (controlPlaneOnly === true) return ["仅控制面"];
  if (operationExecutionAvailable === true) return ["运行时能力已登记"];
  return ["能力状态未知"];
}

/** Render three-state flags so absent fields do not become affirmative UI claims. */
function booleanLabel(value: boolean | null, yes: string, no: string): string {
  return value === null ? "状态未知" : value ? yes : no;
}

/** Keep grant effectiveness distinct from record status and explicit when unknown. */
function effectiveLabel(value: boolean | null): string {
  if (value === true) return "当前有效标记";
  if (value === false) return "当前无效标记";
  return "有效性未知";
}

/** Map known MCP blocking reasons without surfacing raw server messages. */
function reasonLabel(value: string | null): string {
  return value === null ? "暂无阻断原因" : mcpReasonLabels[value] ?? "原因未知";
}

/** Automation scope is a separate permission flag and does not mean a worker is running. */
function automationLabel(value: boolean | null): string {
  if (value === true) return "自动化范围需单独开放";
  if (value === false) return "自动化关闭";
  return "自动化状态未知";
}

function SnapshotPanel({
  eyebrow,
  title,
  description,
  state,
  managementHref,
  managementLabel,
  children,
}: Readonly<{
  eyebrow: string;
  title: string;
  description: string;
  state: SnapshotState<unknown>;
  managementHref: string;
  managementLabel: string;
  children: ReactNode;
}>): React.JSX.Element {
  return (
    <section className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">{eyebrow}</p>
          <h2 className="mt-2 text-2xl font-semibold">{title}</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{description}</p>
        </div>
        <button type="button" onClick={state.refresh} disabled={state.loading} className="min-h-10 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-indigo-200 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">
          {state.loading ? "读取中…" : "刷新"}
        </button>
      </div>
      {state.loading && state.data === null ? <div className="mt-5 space-y-3" aria-label={`${title}正在加载`}><div className="h-16 animate-pulse rounded-2xl bg-slate-100" /><div className="h-16 animate-pulse rounded-2xl bg-slate-100" /></div> : null}
      {state.error ? <div role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><p>{state.error}</p><button type="button" onClick={state.refresh} className="mt-2 font-semibold underline">重新读取</button></div> : null}
      {state.loading && state.data !== null ? <p role="status" className="mt-4 text-xs text-slate-400">正在刷新当前读取时快照…</p> : null}
      {state.data !== null ? <div className="mt-5">{children}</div> : null}
      {!state.loading && state.error === null && state.data === null ? <p className="mt-5 rounded-2xl bg-slate-50 px-4 py-4 text-sm text-slate-500">暂时没有可展示的配置快照。</p> : null}
      <div className="mt-5 border-t border-slate-100 pt-4">
        <Link href={managementHref} className="text-xs font-semibold text-indigo-700 underline decoration-indigo-200 underline-offset-4">{managementLabel} →</Link>
      </div>
    </section>
  );
}

function AiSnapshotView({ snapshot }: { snapshot: AiSnapshot }): React.JSX.Element {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold text-slate-700">当前模型路由</p>
        {snapshot.selections.length === 0 ? <p className="mt-3 text-sm text-slate-500">当前接口没有返回模型路由选择。</p> : <div className="mt-3 space-y-3">{snapshot.selections.map((selection) => <article key={`${selection.operation}:${selection.version ?? "unknown"}`} className="rounded-2xl border border-slate-200 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-slate-800">{operationLabel(selection.operation)}</p><span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">{sourceLabel(selection.source)}</span></div><dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3"><div><dt className="text-slate-400">选择版本</dt><dd className="mt-1 font-semibold text-slate-700">{formatVersion(selection.version)}</dd></div><div><dt className="text-slate-400">能力标签</dt><dd className="mt-1 flex flex-wrap gap-1.5">{capabilityLabels(selection.operationExecutionAvailable, selection.controlPlaneOnly).map((label) => <span key={label} className="rounded-full bg-slate-100 px-2 py-1 font-semibold text-slate-600">{label}</span>)}</dd></div><div><dt className="text-slate-400">费用承担</dt><dd className="mt-1 font-semibold text-slate-700">{payerLabel(selection.source)}</dd></div></dl></article>)}</div>}
      </div>
      <div>
        <div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold text-slate-700">个人连接委托</p><span className="text-xs text-slate-400">{snapshot.delegations.length} 条</span></div>
        {snapshot.delegations.length === 0 ? <p className="mt-3 text-sm text-slate-500">当前没有个人模型委托记录。</p> : <div className="mt-3 space-y-3">{snapshot.delegations.map((delegation, index) => <article key={`${delegation.operation}:${delegation.version ?? "unknown"}:${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-slate-800">{operationLabel(delegation.operation)}</p><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${delegation.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{statusLabel(delegation.status, aiStatusLabels)}</span></div><dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3"><div><dt className="text-slate-400">委托版本</dt><dd className="mt-1 font-semibold text-slate-700">{formatVersion(delegation.version)}{delegation.selected === true ? " · 当前选择" : ""}</dd></div><div><dt className="text-slate-400">选择来源</dt><dd className="mt-1 font-semibold text-slate-700">{sourceLabel(delegation.selectedSource)}</dd></div><div><dt className="text-slate-400">到期时间</dt><dd className="mt-1 font-semibold text-slate-700">{formatDate(delegation.expiresAt)}</dd></div></dl><p className="mt-3 text-xs text-slate-500">{payerLabel(delegation.selectedSource)} · {capabilityLabels(delegation.operationExecutionAvailable, delegation.controlPlaneOnly).join("、")}</p></article>)}</div>}
        <Link href="/personal/models" className="mt-4 inline-block text-xs font-semibold text-indigo-700 underline decoration-indigo-200 underline-offset-4">管理个人模型连接 →</Link>
      </div>
    </div>
  );
}

function GitSnapshotView({ snapshot }: { snapshot: GitSnapshot }): React.JSX.Element {
  if (snapshot.delegations.length === 0) return <p className="text-sm text-slate-500">当前没有项目 Git 委托记录。</p>;
  return <div className="space-y-3">{snapshot.delegations.map((delegation, index) => <article key={`${delegation.repositoryPath ?? "unknown"}:${delegation.version ?? "unknown"}:${index}`} className="rounded-2xl border border-slate-200 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-slate-800">{delegation.repositoryPath ?? "仓库范围未知"}</p><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${delegation.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{statusLabel(delegation.status, gitStatusLabels)}</span></div><dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-slate-400">读取分支或引用</dt><dd className="mt-1 break-all font-semibold text-slate-700">{delegation.trackedRef ?? "范围未知"}</dd></div><div><dt className="text-slate-400">委托版本 / 到期</dt><dd className="mt-1 font-semibold text-slate-700">{formatVersion(delegation.version)} · {formatDate(delegation.expiresAt)}</dd></div><div><dt className="text-slate-400">包含目录</dt><dd className="mt-1 break-words font-semibold text-slate-700">{delegation.includeRoots.length > 0 ? delegation.includeRoots.join("、") : "未声明"}</dd></div><div><dt className="text-slate-400">范围开关</dt><dd className="mt-1 font-semibold text-slate-700">代码 {booleanLabel(delegation.codeEnabled, "开启", "关闭")} · 元数据 {booleanLabel(delegation.metadataEnabled, "开启", "关闭")}</dd></div></dl><p className="mt-3 text-xs leading-5 text-slate-500">{booleanLabel(delegation.manualSyncAllowed, "允许手动只读读取", "手动读取未开启")} · {delegation.softExcludePatterns.length} 条排除规则 · {automationLabel(delegation.automationAllowed)}</p><p className="mt-3 rounded-xl bg-indigo-50 px-3 py-2 text-xs leading-5 text-indigo-900">即使状态为“已启用委托”，手动读取前仍会在 Git 页面由原接口重新校验连接、成员资格和仓库范围。</p></article>)}</div>;
}

function McpConnectionsView({ snapshot }: { snapshot: McpSnapshot }): React.JSX.Element {
  if (snapshot.delegations.length === 0) return <p className="text-sm text-slate-500">当前没有 MCP 连接委托记录。</p>;
  return <div className="space-y-3">{snapshot.delegations.map((delegation, index) => <article key={`${delegation.version ?? "unknown"}:${index}`} className="rounded-2xl border border-slate-200 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-slate-800">{statusLabel(delegation.recordStatus, mcpStatusLabels)}</p><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${delegation.effectiveStatus === "eligible" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>{delegation.effectiveStatus === "eligible" ? "当前有效标记" : delegation.effectiveStatus === "ineligible" ? "当前无效标记" : "有效性未知"}</span></div><dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3"><div><dt className="text-slate-400">委托版本</dt><dd className="mt-1 font-semibold text-slate-700">{formatVersion(delegation.version)}</dd></div><div><dt className="text-slate-400">到期时间</dt><dd className="mt-1 font-semibold text-slate-700">{formatDate(delegation.expiresAt)}</dd></div><div><dt className="text-slate-400">安全原因</dt><dd className="mt-1 font-semibold text-slate-700">{reasonLabel(delegation.effectiveReason)}</dd></div></dl><p className="mt-3 text-xs text-slate-500">证据状态：{delegation.evidenceState ?? "状态未知"}</p></article>)}</div>;
}

function McpGrantsView({ snapshot }: { snapshot: McpSnapshot }): React.JSX.Element {
  return <div><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs font-semibold text-slate-700">工具授权摘要</p><span className="text-xs text-slate-400">{snapshot.grants.length} 条 · 候选 {snapshot.candidateCount} 条</span></div>{snapshot.grants.length === 0 ? <p className="mt-3 text-sm text-slate-500">当前没有工具授权记录。</p> : <div className="mt-3 space-y-3">{snapshot.grants.map((grant, index) => <article key={`${grant.toolName ?? "tool"}:${index}`} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-slate-800">{grant.toolName ?? "工具名称未知"}</p><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{statusLabel(grant.status, mcpStatusLabels)}</span></div><p className="mt-3 text-xs text-slate-600">{effectiveLabel(grant.effective)} · 审核 {grant.reviewRequired === true ? "仍需复核" : grant.reviewRequired === false ? "已具备审核标记" : "状态未知"}{grant.effectiveReason ? ` · ${reasonLabel(grant.effectiveReason)}` : ""}</p><p className="mt-2 text-xs text-slate-500">委托状态：{grant.delegationStatus ? statusLabel(grant.delegationStatus, mcpStatusLabels) : "状态未知"} · {formatDate(grant.expiresAt)}</p></article>)}</div>}<p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">本页只展示读取时的控制面快照，不会调用远端 MCP 工具；实际动作仍由既有工具页面和服务端重新校验。</p></div>;
}

export function ProjectConfigurationClient({ username, projectId, isSystemAdmin }: ProjectConfigurationClientProps): React.JSX.Element {
  const ai = useProjectSnapshot(projectId, `/api/projects/${projectId}/ai-provider-delegations`, parseAiSnapshot, "模型路由快照加载失败");
  const git = useProjectSnapshot(projectId, `/api/projects/${projectId}/git-repository-delegations`, parseGitSnapshot, "Git 委托快照加载失败");
  const mcp = useProjectSnapshot(projectId, `/api/projects/${projectId}/mcp-connection-delegations`, parseMcpSnapshot, "MCP 委托快照加载失败");
  const mcpGrants = useProjectSnapshot(projectId, `/api/projects/${projectId}/mcp-tool-grants`, parseMcpSnapshot, "MCP 工具授权快照加载失败", "仅项目 Owner 可查看工具授权。");
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="configuration" isSystemAdmin={isSystemAdmin} />
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10 lg:pt-10">
        <section className="rounded-[2rem] bg-slate-950 px-7 py-9 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-11">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Project configuration</p>
          <div className="mt-3 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">项目配置</h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">这里汇总当前项目读取到的模型路由、Git 委托、MCP 委托和工具授权。页面只展示安全摘要，具体管理仍回到原有页面。</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.07] p-4 text-xs leading-5 text-slate-300 lg:max-w-xs">四个分区独立读取；更新时间可能不同，所有实际操作仍由原接口在提交前重新校验。</div>
          </div>
        </section>

        <div className="mt-7 grid gap-6 xl:grid-cols-2">
          <SnapshotPanel eyebrow="Model routing" title="模型路由" description="显示 operation、当前选择来源、版本、能力标签与费用承担摘要，不展示个人连接名称或凭据。" state={ai} managementHref={buildProjectHref(projectId, "control")} managementLabel="前往项目 AI 工作台">
            <AiSnapshotView snapshot={ai.data as AiSnapshot} />
          </SnapshotPanel>
          <SnapshotPanel eyebrow="Git delegation" title="Git 委托" description="显示委托状态、仓库读取范围、引用与到期时间；连接安全证据和凭据不会出现在这里。" state={git} managementHref={buildProjectHref(projectId, "repositories")} managementLabel="前往 Git 委托管理">
            <GitSnapshotView snapshot={git.data as GitSnapshot} />
          </SnapshotPanel>
          <SnapshotPanel eyebrow="MCP delegation" title="MCP 连接委托" description="显示连接委托的 effective 状态、原因和到期时间；远端工具动作仍保持冻结。" state={mcp} managementHref={buildProjectHref(projectId, "tools")} managementLabel="前往 MCP 工具管理">
            <McpConnectionsView snapshot={mcp.data as McpSnapshot} />
          </SnapshotPanel>
          <SnapshotPanel eyebrow="MCP tool grants" title="MCP 工具授权" description="显示工具授权的 effective、reviewRequired 和委托状态摘要，不提供远端动作入口。" state={mcpGrants} managementHref={buildProjectHref(projectId, "tools")} managementLabel="前往 MCP 工具管理">
            <McpGrantsView snapshot={mcpGrants.data as McpSnapshot} />
          </SnapshotPanel>
        </div>
      </div>
    </main>
  );
}
