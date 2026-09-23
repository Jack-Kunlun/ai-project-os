"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import {
  connectionButtonClass,
  connectionErrorText,
  connectionFieldClass,
  type ConnectionMessage,
  formatConnectionDate,
  isConnectionConflict,
  readConnectionError,
} from "./connection-ui";

export type PersonalGovernanceKind = "git" | "mcp";
export type PersonalGovernanceAction =
  | "rotateCredential"
  | "retrust"
  | "retest"
  | "rediscover"
  | "disable"
  | "enable"
  | "delete";

type GovernancePreview = Readonly<{
  id: string;
  connectionId: string;
  action: PersonalGovernanceAction;
  connection: Readonly<{
    name: string;
    status: string;
    configurationVersion: number;
    updatedAt: string;
  }>;
  scope: "personal";
  owner: Readonly<{ userId: string; feePayer: "connection_owner" }>;
  reason: string;
  requestKey: string;
  requestFingerprint: string;
  impactFingerprint: string;
  impact: Readonly<Record<string, unknown>>;
  blockers: readonly string[];
  canExecute: boolean;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  executionStatus: string;
}>;

type GovernedConnection = Readonly<{
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  authKind: string;
  recoveryState: "ready" | "credentialRebindRequired" | "rebuildRequired";
}>;

type ConnectionGovernancePanelProps = Readonly<{
  kind: PersonalGovernanceKind;
  connection: GovernedConnection;
  onReload: () => Promise<void>;
  onRemoved: () => void;
}>;

type PendingAction = "preview" | "confirm" | "execute" | null;
type TestedProbeIntent = Readonly<{ draftProbeId: string; probeRequestKey: string; repositoryPath?: string; trackedRef?: string }>;

const actionLabels: Record<PersonalGovernanceKind, Partial<Record<PersonalGovernanceAction, string>>> = {
  git: {
    rotateCredential: "轮换凭据",
    retrust: "重新信任网络",
    retest: "重新测试仓库",
    disable: "停用连接",
    enable: "重新启用",
    delete: "永久删除",
  },
  mcp: {
    rotateCredential: "轮换凭据",
    retrust: "重新信任网络",
    rediscover: "重新发现工具",
    disable: "停用连接",
    enable: "重新启用",
    delete: "永久删除",
  },
};

const actionDescriptions: Record<PersonalGovernanceKind, Partial<Record<PersonalGovernanceAction, string>>> = {
  git: {
    rotateCredential: "替换服务端加密凭据，并清除需要重新验证的连接状态。",
    retrust: "准备重新确认网络指纹；当前不会发起网络请求，外部连通性仍未验证。",
    retest: "先执行一次只读 ls-remote 测试，再进入影响预览和独立确认。",
    disable: "停用连接，后续项目使用会失败关闭。",
    enable: "重新启用连接，但不会自动重新测试、重新发现或重放外部操作。",
    delete: "删除连接及其加密凭据；服务端会先检查所有安全影响和历史引用。",
  },
  mcp: {
    rotateCredential: "替换服务端加密凭据，并清除需要重新验证的连接状态。",
    retrust: "准备重新确认网络指纹；治理动作不会发起 MCP 协议请求或向远端发送凭据，MCP 连通性仍未验证。",
    rediscover: "先执行 initialize 和 tools/list 只读测试，再进入影响预览和独立确认。",
    disable: "停用连接，后续项目使用会失败关闭。",
    enable: "重新启用连接，但不会自动重新测试、重新发现或重放外部操作。",
    delete: "删除连接及其加密凭据；服务端会先检查所有安全影响和历史引用。",
  },
};

function actionDescription(kind: PersonalGovernanceKind, action: PersonalGovernanceAction): string {
  return actionDescriptions[kind][action] ?? "此治理动作需要先生成安全预览。";
}

function governanceBoundary(kind: PersonalGovernanceKind): string {
  return kind === "mcp"
    ? "MCP 连接保存和重新发现都会先执行受限 DNS/地址安全解析及 initialize/tools-list 只读测试；其他治理动作不会发起协议请求。"
    : "重新测试会先固定安全地址并执行只读 ls-remote；其他治理动作不会自动发起网络请求。";
}

function heldActionMessage(kind: PersonalGovernanceKind): string {
  return kind === "mcp"
    ? "治理动作已安全挂起，未发起 MCP 协议请求，也未向远端发送凭据。"
    : "治理动作已安全挂起，未发起网络请求。";
}

function unavailableActionNote(kind: PersonalGovernanceKind): string {
  return kind === "mcp"
    ? "尚未开放，不能绕过治理：此治理动作当前不会触发 MCP 协议请求或向远端发送凭据，MCP 连通性仍未验证；服务端也不会自动重试。"
    : "尚未开放，不能绕过治理：此治理动作当前不会触发网络请求，外部连通性仍未验证；服务端也不会自动重试。";
}

const blockerLabels: Record<string, string> = {
  connection_disabled: "连接当前已停用",
  secret_required_at_preview: "预览阶段必须填写新的凭据",
  credential_unavailable: "当前连接没有可轮换的凭据",
  connection_must_be_disabled: "永久删除前必须先停用连接",
  active_manual_run: "存在排队中或运行中的手动读取",
  legacy_project_link: "存在仍启用的遗留项目关联",
  live_delegation: "存在活动项目委托",
  historical_reference: "存在不可删除的历史引用",
  active_tool_grant: "存在活动工具授权",
  non_terminal_action: "存在未终态 MCP 动作",
  reserved_dispatch: "存在已预留但未完成的派发记录",
  permanent_v2_attestation: "存在永久保留的 V2 管理员审核证据",
  confirmation_name_mismatch: "连接名称确认不匹配",
  external_io_planned_not_dispatched: "尚未开放外部发包，不能绕过治理",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readItems(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function itemProjectName(item: Record<string, unknown>): string {
  return readText(item.projectName) ?? "项目名称不可见";
}

function itemStatus(item: Record<string, unknown>): string {
  return readText(item.status) ?? "状态不可用";
}

function itemExpiry(item: Record<string, unknown>): string {
  const expiry = readText(item.expiresAt);
  return expiry === null ? "无到期时间" : `有效至 ${formatConnectionDate(expiry)}`;
}

function impactTotals(kind: PersonalGovernanceKind, impact: Readonly<Record<string, unknown>>): Readonly<{ count: number; summary: string }> {
  if (kind === "git") {
    const legacy = readItems(impact.legacyLinks);
    const delegations = readItems(impact.liveDelegations);
    const runs = readItems(impact.manualRuns);
    const history = readCount(impact.historicalReferences);
    const count = legacy.length + delegations.length + runs.length + history;
    return { count, summary: `遗留关联 ${legacy.length}、活动委托 ${delegations.length}、手动读取 ${runs.length}、历史引用 ${history}` };
  }
  const delegations = readItems(impact.liveDelegations);
  const grants = readItems(impact.activeToolGrants);
  const attestations = readCount(impact.v2Attestations);
  const actions = readCount(impact.nonTerminalActions);
  const dispatches = readCount(impact.reservedDispatches);
  const count = delegations.length + grants.length + attestations + actions + dispatches;
  return { count, summary: `活动委托 ${delegations.length}、工具授权 ${grants.length}、V2 审核 ${attestations}、未终态动作 ${actions}、派发预留 ${dispatches}` };
}

function blockerText(code: string): string {
  return blockerLabels[code] ?? `安全策略阻断（${code}）`;
}

function previewApiPath(kind: PersonalGovernanceKind, connectionId: string, operation: "preview" | "execute"): string {
  const prefix = kind === "git" ? "git-connections" : "mcp-connections";
  return `/api/me/${prefix}/${connectionId}/governance/${operation}`;
}

function probeApiPath(kind: PersonalGovernanceKind, connectionId: string): string {
  const prefix = kind === "git" ? "git-connections" : "mcp-connections";
  return `/api/me/${prefix}/${connectionId}/probe`;
}

function defaultAction(kind: PersonalGovernanceKind, status: string): PersonalGovernanceAction {
  if (status === "disabled") return "enable";
  return kind === "git" ? "disable" : "disable";
}

function actionIsAvailable(
  kind: PersonalGovernanceKind,
  action: PersonalGovernanceAction,
  authKind: string,
  recoveryState: GovernedConnection["recoveryState"],
): boolean {
  if (recoveryState === "rebuildRequired") return false;
  if (recoveryState === "credentialRebindRequired") return action === "rotateCredential" && authKind !== "none";
  if (action === "retest" || action === "rediscover") return kind === "git" ? action === "retest" : action === "rediscover";
  if (action === "retrust") return true;
  if (action === "rotateCredential") return authKind !== "none";
  return true;
}

function stableGovernanceError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name === "ConnectionRequestError") {
    const code = "code" in error && typeof error.code === "string" ? error.code : "";
    const messages: Record<string, string> = {
      GIT_CONNECTION_PREVIEW_EXPIRED: "安全预览已过期，请重新生成。",
      MCP_CONNECTION_PREVIEW_EXPIRED: "安全预览已过期，请重新生成。",
      GIT_CONNECTION_IMPACT_CHANGED: "连接影响范围已变化，请重新预览。",
      MCP_CONNECTION_IMPACT_CHANGED: "连接影响范围已变化，请重新预览。",
      GIT_CONNECTION_CONFLICT: "连接状态已变化，请刷新后重新预览。",
      MCP_CONNECTION_CONFLICT: "连接状态已变化，请刷新后重新预览。",
      GIT_CONNECTION_PREVIEW_MISMATCH: "安全预览与当前请求不一致，未执行操作。",
      MCP_CONNECTION_PREVIEW_MISMATCH: "安全预览与当前请求不一致，未执行操作。",
      GIT_CONNECTION_IN_USE: "连接仍有安全影响，当前操作未执行。",
      MCP_CONNECTION_IN_USE: "连接仍有安全影响，当前操作未执行。",
      GIT_EXTERNAL_IO_PLANNED_NOT_DISPATCHED: "重新测试或重信任尚未开放外部发包，未执行远程操作。",
      MCP_EXTERNAL_IO_PLANNED_NOT_DISPATCHED: "重新发现或重信任尚未开放外部发包，未执行远程操作。",
    };
    if (messages[code] !== undefined) return messages[code];
  }
  return connectionErrorText(error, fallback);
}

function ImpactDetails({ kind, impact }: Readonly<{ kind: PersonalGovernanceKind; impact: Readonly<Record<string, unknown>> }>) {
  const gitLegacy = readItems(impact.legacyLinks);
  const gitDelegations = readItems(impact.liveDelegations);
  const gitRuns = readItems(impact.manualRuns);
  const mcpDelegations = readItems(impact.liveDelegations);
  const mcpGrants = readItems(impact.activeToolGrants);
  const totals = impactTotals(kind, impact);

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Safety impact</p>
          <h4 className="mt-1 text-sm font-semibold text-slate-900">影响预览</h4>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">共 {totals.count} 项</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">{totals.summary}</p>
      <p className="mt-2 text-[12px] leading-5 text-slate-500">仅展示你有权查看的安全项目名、状态、到期时间和计数；不展示 endpoint、凭据或原始指纹。</p>
      {kind === "git" ? (
        <div className="mt-3 space-y-2 text-xs">
          {gitLegacy.map((item, index) => <ImpactRow key={`legacy-${index}`} label="遗留项目关联" item={item} />)}
          {gitDelegations.map((item, index) => <ImpactRow key={`delegation-${index}`} label="活动项目委托" item={item} />)}
          {gitRuns.map((item, index) => <ImpactRow key={`run-${index}`} label="手动读取" item={item} />)}
          {readCount(impact.historicalReferences) > 0 ? <p className="rounded-xl bg-amber-50 px-3 py-2 leading-5 text-amber-800">历史引用：{readCount(impact.historicalReferences)} 条（不可删除引用）</p> : null}
          {gitLegacy.length + gitDelegations.length + gitRuns.length + readCount(impact.historicalReferences) === 0 ? <p className="rounded-xl bg-emerald-50 px-3 py-2 leading-5 text-emerald-800">当前没有发现下游项目影响。</p> : null}
        </div>
      ) : (
        <div className="mt-3 space-y-2 text-xs">
          {mcpDelegations.map((item, index) => <ImpactRow key={`delegation-${index}`} label="活动项目委托" item={item} />)}
          {mcpGrants.map((item, index) => <ImpactRow key={`grant-${index}`} label={`工具授权${readText(item.toolName) === null ? "" : ` · ${readText(item.toolName)}`}`} item={item} />)}
          {readCount(impact.v2Attestations) > 0 ? <p className="rounded-xl bg-amber-50 px-3 py-2 leading-5 text-amber-800">V2 管理员审核证据：{readCount(impact.v2Attestations)} 条（删除永久阻断）</p> : null}
          {readCount(impact.nonTerminalActions) > 0 ? <p className="rounded-xl bg-amber-50 px-3 py-2 leading-5 text-amber-800">未终态动作：{readCount(impact.nonTerminalActions)} 条</p> : null}
          {readCount(impact.reservedDispatches) > 0 ? <p className="rounded-xl bg-amber-50 px-3 py-2 leading-5 text-amber-800">派发预留：{readCount(impact.reservedDispatches)} 条</p> : null}
          {mcpDelegations.length + mcpGrants.length + readCount(impact.v2Attestations) + readCount(impact.nonTerminalActions) + readCount(impact.reservedDispatches) === 0 ? <p className="rounded-xl bg-emerald-50 px-3 py-2 leading-5 text-emerald-800">当前没有发现下游项目影响。</p> : null}
        </div>
      )}
    </div>
  );
}

function ImpactRow({ label, item }: Readonly<{ label: string; item: Record<string, unknown> }>) {
  return <p className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 leading-5 text-slate-700"><span><strong className="font-semibold">{label}</strong> · {itemProjectName(item)}</span><span className="text-slate-500">{itemStatus(item)} · {itemExpiry(item)}</span></p>;
}

export function ConnectionGovernancePanel({ kind, connection, onReload, onRemoved }: ConnectionGovernancePanelProps) {
  const { confirm, dialog } = useAppConfirmDialog();
  const [selectedAction, setSelectedAction] = useState<PersonalGovernanceAction>(() => defaultAction(kind, connection.status));
  const [reason, setReason] = useState("");
  const [secret, setSecret] = useState("");
  const [confirmationName, setConfirmationName] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [trackedRef, setTrackedRef] = useState("main");
  const [testedProbe, setTestedProbe] = useState<TestedProbeIntent | null>(null);
  const [preview, setPreview] = useState<GovernancePreview | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);
  const actions = useMemo(() => Object.entries(actionLabels[kind]).filter(([value]) => actionIsAvailable(kind, value as PersonalGovernanceAction, connection.authKind, connection.recoveryState)) as Array<[PersonalGovernanceAction, string]>, [connection.authKind, connection.recoveryState, kind]);
  const action = actions.some(([value]) => value === selectedAction) ? selectedAction : actions[0]?.[0] ?? selectedAction;

  function chooseAction(next: PersonalGovernanceAction) {
    setSelectedAction(next);
    setPreview(null);
    setTestedProbe(null);
    setMessage(null);
    if (next !== "rotateCredential") setSecret("");
    if (next !== "delete") setConfirmationName("");
  }

  function requestReason(): string {
    const base = reason.trim();
    if (kind === "git" && action === "retest") {
      const path = repositoryPath.trim();
      const ref = trackedRef.trim();
      return `${base}${base.length > 0 ? "；" : ""}仓库 ${path || "未指定"} @ ${ref || "未指定"}`;
    }
    return base;
  }

  async function createPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending !== null) return;
    const normalizedReason = requestReason();
    if (normalizedReason.length === 0) {
      setMessage({ tone: "error", text: "请先填写本次变更原因。" });
      return;
    }
    if (normalizedReason.length > 500) {
      setMessage({ tone: "error", text: "变更原因（含测试范围）不能超过 500 个字符。" });
      return;
    }
    if (action === "rotateCredential" && secret.trim().length < 8) {
      setMessage({ tone: "error", text: "新凭据至少需要 8 个字符；只会在当前浏览器表单中暂存。" });
      return;
    }
    if (action === "delete" && confirmationName.trim().length === 0) {
      setMessage({ tone: "error", text: "请先输入连接名称，才能生成删除预览。" });
      return;
    }
    const requestKey = `${kind}-${connection.id}-${Date.now()}-${globalThis.crypto.randomUUID()}`;
    setPending("preview");
    setMessage(null);
    try {
      let probeIntent: TestedProbeIntent | null = null;
      if (action === "retest" || action === "rediscover") {
        const probeRequestKey = globalThis.crypto.randomUUID();
        const probeResponse = await fetch(probeApiPath(kind, connection.id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientRequestKey: probeRequestKey,
            expectedUpdatedAt: connection.updatedAt,
            ...(kind === "git" ? { repositoryPath: repositoryPath.trim(), trackedRef: trackedRef.trim() } : {}),
          }),
        });
        if (!probeResponse.ok) throw await readConnectionError(probeResponse, "连通性测试失败");
        const payload = await probeResponse.json() as { probe?: { draftProbeId?: string | null; createRequestKey?: string; status?: string; safeErrorCode?: string | null } };
        const probe = payload.probe;
        if (probe?.status !== "settled" || probe.draftProbeId === undefined || probe.draftProbeId === null || probe.createRequestKey !== probeRequestKey) {
          throw new Error(probe?.safeErrorCode === null || probe?.safeErrorCode === undefined ? "连通性测试未通过，请检查连接配置。" : `连通性测试未通过：${probe.safeErrorCode}`);
        }
        probeIntent = kind === "git"
          ? { draftProbeId: probe.draftProbeId, probeRequestKey, repositoryPath: repositoryPath.trim(), trackedRef: trackedRef.trim() }
          : { draftProbeId: probe.draftProbeId, probeRequestKey };
        setTestedProbe(probeIntent);
      }
      const response = await fetch(previewApiPath(kind, connection.id, "preview"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          requestKey,
          reason: normalizedReason,
          expectedUpdatedAt: connection.updatedAt,
          ...(action === "rotateCredential" ? { secret } : {}),
          ...(action === "delete" ? { confirmationName: confirmationName.trim() } : {}),
          ...(probeIntent === null ? {} : { draftProbeId: probeIntent.draftProbeId, probeRequestKey: probeIntent.probeRequestKey, ...(kind === "git" ? { repositoryPath: probeIntent.repositoryPath, trackedRef: probeIntent.trackedRef } : {}) }),
        }),
      });
      if (!response.ok) throw await readConnectionError(response, "安全影响预览失败");
      const payload = await response.json() as { preview?: GovernancePreview };
      if (payload.preview === undefined) throw new Error("安全影响预览响应无效");
      setPreview(payload.preview);
      setMessage({ tone: payload.preview.canExecute ? "info" : "error", text: payload.preview.canExecute ? "预览已生成，请核对影响并完成独立确认。" : "预览已生成，但当前存在安全阻断，不能执行。" });
    } catch (error) {
      if (isConnectionConflict(error)) await onReload();
      setMessage({ tone: "error", text: stableGovernanceError(error, "安全影响预览失败") });
    } finally {
      setPending(null);
    }
  }

  async function executePreview() {
    if (preview === null || pending !== null) return;
    setPending("confirm");
    const result = await confirm({
      eyebrow: "Independent confirmation",
      title: `确认${actionLabels[kind][action] ?? "这项变更"}？`,
      description: `本次预览将在 ${formatConnectionDate(preview.expiresAt)} 失效。${impactTotals(kind, preview.impact).summary}。请输入确认短语后才会执行。`,
      inputLabel: action === "delete" ? `输入连接名称“${connection.name}”以确认` : "输入“确认”以确认预览仍有效",
      inputPlaceholder: action === "delete" ? connection.name : "确认",
      requiredValue: action === "delete" ? connection.name : "确认",
      confirmLabel: action === "delete" ? "确认删除" : "确认执行",
      cancelLabel: "返回预览",
      tone: action === "delete" ? "danger" : action === "disable" ? "warning" : "primary",
      maxLength: 80,
    });
    if (!result.confirmed) {
      setPending(null);
      return;
    }
    setPending("execute");
    setMessage(null);
    try {
      const response = await fetch(previewApiPath(kind, connection.id, "execute"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          previewId: preview.id,
          requestKey: preview.requestKey,
          requestFingerprint: preview.requestFingerprint,
          impactFingerprint: preview.impactFingerprint,
          expectedUpdatedAt: preview.connection.updatedAt,
          ...(action === "rotateCredential" ? { secret } : {}),
          ...(action === "delete" ? { confirmationName: result.value } : {}),
          ...(testedProbe === null ? {} : { draftProbeId: testedProbe.draftProbeId, probeRequestKey: testedProbe.probeRequestKey, ...(kind === "git" ? { repositoryPath: testedProbe.repositoryPath, trackedRef: testedProbe.trackedRef } : {}) }),
        }),
      });
      if (!response.ok) throw await readConnectionError(response, "安全变更未执行");
      const payload = await response.json() as { result?: { status?: string; result?: { safeErrorCode?: string | null } } };
      const status = payload.result?.status;
      const held = status === "held" || payload.result?.result?.safeErrorCode !== null && payload.result?.result?.safeErrorCode !== undefined;
      setPreview(null);
      setSecret("");
      setConfirmationName("");
      if (action === "delete" && status === "completed") {
        onRemoved();
        setMessage({ tone: "success", text: "连接已删除；页面列表已局部更新。" });
      } else {
        setMessage({ tone: held ? "info" : "success", text: held ? heldActionMessage(kind) : "连接治理变更已完成；页面列表将局部刷新。" });
        await onReload();
      }
    } catch (error) {
      if (isConnectionConflict(error)) {
        setPreview(null);
        await onReload();
      }
      setMessage({ tone: "error", text: stableGovernanceError(error, "安全变更未执行") });
    } finally {
      setPending(null);
    }
  }

  const totals = preview === null ? null : impactTotals(kind, preview.impact);
  const actionLabel = actionLabels[kind][action] ?? "连接变更";

  return (
    <section className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4" aria-labelledby={`governance-title-${connection.id}`}>
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Connection governance</p>
          <h4 id={`governance-title-${connection.id}`} className="mt-1 text-sm font-semibold text-slate-900">高风险变更安全预览</h4>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-600">所有轮换、停用、启用、删除和重新信任/测试都必须先生成预览，再完成独立确认。不会自动撤销项目授权。{governanceBoundary(kind)}</p>
        </div>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">scope personal · owner pays</span>
      </div>
      {connection.recoveryState === "rebuildRequired" ? <p role="status" className="mt-4 rounded-2xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">账号恢复后，该无凭据连接仅保留历史配置，不能补凭据或复活。请使用新名称新建连接并重新验证/发现、重新配置项目委托及必要审核；旧项目授权不会自动恢复。</p> : null}
      {connection.recoveryState === "credentialRebindRequired" ? <p role="status" className="mt-4 rounded-2xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">账号恢复后，该连接仅可填写新凭据并执行轮换重绑；其他治理动作、测试、发现和重信任都不能作为恢复通道。</p> : null}
      {actions.length > 0 ? <form onSubmit={createPreview} className="mt-4 grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs font-semibold text-slate-700">变更类型<select className={connectionFieldClass} value={action} onChange={(event) => chooseAction(event.target.value as PersonalGovernanceAction)} disabled={pending !== null || preview !== null}>{actions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><span className="mt-1 block text-xs font-normal leading-5 text-slate-500">{actionDescription(kind, action)}</span></label>
          <label className="block text-xs font-semibold text-slate-700">变更原因<input className={connectionFieldClass} value={reason} onChange={(event) => { setReason(event.target.value); setPreview(null); }} maxLength={500} placeholder="例如：凭据轮换或项目范围调整" required disabled={pending !== null || preview !== null} /></label>
        </div>
        {action === "rotateCredential" ? <label className="block text-xs font-semibold text-slate-700">新凭据（仅当前浏览器暂存）<input type="password" autoComplete="new-password" className={connectionFieldClass} value={secret} onChange={(event) => { setSecret(event.target.value); setPreview(null); }} minLength={8} maxLength={32768} placeholder="不会在预览或响应中回显" required disabled={pending !== null || preview !== null} /></label> : null}
        {action === "delete" ? <label className="block text-xs font-semibold text-slate-700">删除预览确认名称<input className={connectionFieldClass} value={confirmationName} onChange={(event) => { setConfirmationName(event.target.value); setPreview(null); }} maxLength={80} placeholder={connection.name} required disabled={pending !== null || preview !== null} /></label> : null}
        {kind === "git" && action === "retest" ? <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-semibold text-slate-700">只读仓库路径<input className={connectionFieldClass} value={repositoryPath} onChange={(event) => { setRepositoryPath(event.target.value); setPreview(null); setTestedProbe(null); }} maxLength={768} placeholder="owner/repository" disabled={pending !== null || preview !== null} /></label><label className="block text-xs font-semibold text-slate-700">分支 / ref<input className={connectionFieldClass} value={trackedRef} onChange={(event) => { setTrackedRef(event.target.value); setPreview(null); setTestedProbe(null); }} maxLength={255} placeholder="main" disabled={pending !== null || preview !== null} /></label></div> : null}
        {preview === null ? <button type="submit" disabled={pending !== null} className={`${connectionButtonClass} min-h-11 w-fit bg-indigo-600 px-4 text-white hover:bg-indigo-500`}>{pending === "preview" ? "生成预览中…" : `生成${actionLabel}预览`}</button> : <div className="flex flex-wrap gap-2"><button type="button" onClick={() => { setPreview(null); setMessage(null); }} disabled={pending !== null} className={`${connectionButtonClass} border border-slate-200 bg-white text-slate-700 hover:bg-white`}>重新生成预览</button>{preview.canExecute ? <button type="button" onClick={() => void executePreview()} disabled={pending !== null} className={`${connectionButtonClass} bg-slate-950 px-4 text-white hover:bg-indigo-700`}>{pending === "confirm" ? "等待确认…" : pending === "execute" ? "执行中…" : `继续${actionLabel}`}</button> : null}</div>}
      </form> : null}
      {preview !== null ? <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4" aria-live="polite"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Preview issued</p><p className="mt-1 text-sm font-semibold text-slate-900">{actionLabel} · 配置版本 {preview.connection.configurationVersion}</p><p className="mt-1 text-xs text-slate-500">作用域：{preview.scope} · 费用承担者：{preview.owner.feePayer === "connection_owner" ? "连接所有者" : "未定义"}</p><p className="mt-1 text-xs text-slate-500">签发于 {formatConnectionDate(preview.issuedAt)}，有效至 {formatConnectionDate(preview.expiresAt)}</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${preview.canExecute ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{preview.canExecute ? "可在确认后执行" : "阻断，不能执行"}</span></div><p className="mt-3 text-xs leading-5 text-slate-600">费用承担者为连接所有者。第三方费用由其与服务商约定，平台不代扣，也不计入项目平台额度。</p>{totals !== null ? <ImpactDetails kind={kind} impact={preview.impact} /> : null}{preview.blockers.length > 0 ? <div className="mt-4 rounded-2xl bg-rose-50 p-4"><p className="text-xs font-semibold text-rose-800">安全阻断</p><ul className="mt-2 space-y-1 text-xs leading-5 text-rose-700">{preview.blockers.map((blocker) => <li key={blocker}>· {blockerText(blocker)}</li>)}</ul></div> : null}{(action === "retest" || action === "rediscover" || action === "retrust") && testedProbe === null ? <p className="mt-4 rounded-2xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">{unavailableActionNote(kind)}</p> : null}</div> : null}
      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-3 text-xs leading-5 ${message.tone === "error" ? "text-rose-700" : message.tone === "success" ? "text-emerald-700" : "text-slate-600"}`}>{message.text}</p> : null}
    </section>
  );
}
