"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { UiText, useTranslate } from "@/components/appearance-provider";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { OperationPanel } from "@/components/operation-panel";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { ProjectOverviewParentLink } from "@/components/project-parent-link";
import { connectionErrorText, readConnectionError } from "@/app/profile/connections/connection-ui";
import supportStyles from "../project-support.module.css";

type ActionStatus = "waitingApproval" | "approved" | "rejected" | "cancelled" | "dispatchReserved" | "succeeded" | "failed" | "unknown" | "expired" | "invalidated";
type Action = Readonly<{
  id: string;
  projectId: string;
  clientRequestId: string;
  grantId: string;
  toolName: string;
  actionRevision: string;
  status: ActionStatus;
  stateVersion: number;
  createdAt: string;
  transitionAt: string | null;
  approvedAt: string | null;
  approvalExpiresAt: string | null;
  rejectedAt: string | null;
  cancelledAt: string | null;
  arguments?: unknown;
  result?: Readonly<{
    payload: unknown;
    resultFingerprint: string;
    resultBytes: number;
    resultNodes: number;
    resultDepth: number;
    omittedContentCount: number;
  }>;
  importedSourceId?: string;
}>;
type ActionListPayload = Readonly<{ projectId: string; archived: boolean; actions: readonly Action[] }>;
type ActionMutationPayload = Readonly<{ created: boolean; action: Action }>;
type ActionImportPayload = Readonly<{ created: boolean; import: Readonly<{ projectSourceId: string; contentFingerprint: string }> }>;
type Grant = Readonly<{
  id: string;
  grantVersion: number | null;
  status: "active" | "revoked";
  effective: boolean;
  toolName: string | null;
  tool: Readonly<{ name: string | null; title: string | null; description: string | null; inputSchema: unknown }>;
}>;
type GrantPayload = Readonly<{ projectId: string; archived: boolean; grants: readonly Grant[] }>;
type Feedback = Readonly<{ tone: "success" | "error" | "warning"; text: string }>;

const statusLabels: Record<ActionStatus, string> = {
  waitingApproval: "等待审批",
  approved: "已批准，等待单次派发",
  rejected: "已拒绝",
  cancelled: "已取消",
  dispatchReserved: "派发结果处理中",
  succeeded: "派发成功",
  failed: "派发失败",
  unknown: "派发结果未知",
  expired: "审批已过期",
  invalidated: "授权快照已失效",
};

const reasonLabels = {
  unsafe_arguments: "参数不安全",
  stale_snapshot: "授权或工具定义已变化",
  not_needed: "不再需要",
  policy_denied: "项目策略不允许",
} as const;

const buttonClass = "inline-flex min-h-10 items-center justify-center rounded-xl px-3 py-2 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButtonClass = `${buttonClass} bg-indigo-600 text-white hover:bg-indigo-500`;
const quietButtonClass = `${buttonClass} border border-slate-200 text-slate-700 hover:bg-slate-50`;
const dangerButtonClass = `${buttonClass} border border-rose-200 text-rose-700 hover:bg-rose-50`;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  if (!response.ok) throw await readConnectionError(response, "项目 MCP 动作请求失败");
  return await response.json() as T;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "暂无记录";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "暂无记录";
}

function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "参数无法显示";
  }
}

function actionStatusClass(status: ActionStatus): string {
  if (status === "succeeded") return "bg-emerald-50 text-emerald-700";
  if (status === "waitingApproval" || status === "approved" || status === "dispatchReserved") return "bg-amber-50 text-amber-800";
  if (status === "unknown" || status === "failed" || status === "invalidated" || status === "expired") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-600";
}

export function ProjectMcpActionsClient({ username, projectId, isSystemAdmin }: { username: string; projectId: string; isSystemAdmin: boolean }) {
  const translateUi = useTranslate();
  const [actions, setActions] = useState<readonly Action[]>([]);
  const [grants, setGrants] = useState<readonly Grant[]>([]);
  const [archived, setArchived] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState("");
  const [detail, setDetail] = useState<Action | null>(null);
  const [grantId, setGrantId] = useState("");
  const [argumentsText, setArgumentsText] = useState("{}");
  const [rejectReason, setRejectReason] = useState<keyof typeof reasonLabels>("unsafe_arguments");
  const [proposeOpen, setProposeOpen] = useState(false);
  const [operationOpen, setOperationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [uncertainDispatchIds, setUncertainDispatchIds] = useState<ReadonlySet<string>>(() => new Set());
  const [importedSource, setImportedSource] = useState<Readonly<{ actionId: string; sourceId: string }> | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);
  const pendingKeyRef = useRef<string | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();

  const effectiveGrants = useMemo(
    () => grants.filter((grant) => grant.status === "active" && grant.effective && grant.grantVersion === 1),
    [grants],
  );
  const selectedGrant = effectiveGrants.find((grant) => grant.id === grantId) ?? effectiveGrants[0] ?? null;

  const load = useCallback(async ({ showLoading = true }: { showLoading?: boolean } = {}) => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    if (showLoading) setLoading(true);
    try {
      const [actionPayload, grantPayload] = await Promise.all([
        requestJson<ActionListPayload>(`/api/projects/${projectId}/mcp-actions`, { signal: controller.signal }),
        requestJson<GrantPayload>(`/api/projects/${projectId}/mcp-tool-grants`, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      setActions(actionPayload.actions);
      setArchived(actionPayload.archived || grantPayload.archived);
      setGrants(grantPayload.grants);
      setSelectedActionId((current) => actionPayload.actions.some((action) => action.id === current)
        ? current
        : actionPayload.actions[0]?.id ?? "");
      setGrantId((current) => grantPayload.grants.some((grant) => grant.id === current && grant.status === "active" && grant.effective && grant.grantVersion === 1)
        ? current
        : grantPayload.grants.find((grant) => grant.status === "active" && grant.effective && grant.grantVersion === 1)?.id ?? "");
      setLoadError(null);
    } catch (error) {
      if (controller.signal.aborted) return;
      setLoadError(connectionErrorText(error, "加载项目 MCP 动作失败；请确认当前账号是项目 Owner。"));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      loadControllerRef.current?.abort();
      detailControllerRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    const timer = window.setTimeout(() => {
      if (!selectedActionId) {
        setDetail(null);
        setDetailError(null);
        setDetailLoading(false);
        return;
      }
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      void requestJson<Action>(`/api/projects/${projectId}/mcp-actions/${selectedActionId}`, { signal: controller.signal })
        .then((next) => {
          if (!controller.signal.aborted) setDetail(next);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setDetailError(connectionErrorText(error, "读取动作详情失败"));
        })
        .finally(() => {
          if (!controller.signal.aborted) setDetailLoading(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, selectedActionId]);

  async function postAction(url: string, body: Record<string, unknown>, key: string, successText: string): Promise<Action | null> {
    if (pendingKeyRef.current !== null) return null;
    pendingKeyRef.current = key;
    setPendingKey(key);
    setFeedback(null);
    try {
      const result = await requestJson<ActionMutationPayload>(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setDetail(result.action);
      setSelectedActionId(result.action.id);
      setFeedback({ tone: "success", text: successText });
      await load({ showLoading: false });
      return result.action;
    } catch (error) {
      setFeedback({ tone: "error", text: connectionErrorText(error, "动作请求失败；请刷新并重新核对当前状态。") });
      return null;
    } finally {
      pendingKeyRef.current = null;
      setPendingKey(null);
    }
  }

  async function refreshStatus(): Promise<void> {
    await load({ showLoading: false });
    if (!selectedActionId || pendingKeyRef.current !== null) return;
    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const latest = await requestJson<Action>(`/api/projects/${projectId}/mcp-actions/${selectedActionId}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setDetail(latest);
      setUncertainDispatchIds((current) => {
        const next = new Set(current);
        next.delete(selectedActionId);
        return next;
      });
    } catch (error) {
      if (!controller.signal.aborted) setDetailError(connectionErrorText(error, "重新读取动作详情失败"));
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }

  async function propose(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedGrant === null || archived) return;
    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(argumentsText) as unknown;
    } catch {
      setFeedback({ tone: "error", text: "参数必须是有效 JSON。" });
      return;
    }
    const action = await postAction(`/api/projects/${projectId}/mcp-actions`, {
      clientRequestId: crypto.randomUUID(),
      grantId: selectedGrant.id,
      expectedGrantVersion: 1,
      arguments: parsedArguments,
    }, "propose", "动作提案已创建。请在下方检查服务端规范化后的完整参数再审批。");
    if (action !== null) { setArgumentsText("{}"); setProposeOpen(false); }
  }

  async function approve(): Promise<boolean> {
    if (detail === null || detail.status !== "waitingApproval" || archived || !Object.prototype.hasOwnProperty.call(detail, "arguments")) return false;
    const result = await confirm({
      eyebrow: "项目 Owner 审批",
      title: `批准 ${detail.toolName} 的单次调用？`,
      description: `${translateUi("请先核对页面中的完整规范化参数。当前状态为")}${translateUi(statusLabels[detail.status])}，${translateUi("状态版本")} ${detail.stateVersion}，${translateUi("动作修订")} ${detail.actionRevision}。${translateUi("此批准仅允许一次派发。")}`,
      confirmLabel: "批准一次",
      cancelLabel: "返回检查",
      inputLabel: "输入“批准”继续",
      requiredValue: "批准",
      inputPlaceholder: "批准",
    });
    if (!result.confirmed) return false;
    return await postAction(`/api/projects/${projectId}/mcp-actions/${detail.id}/decision`, {
      decision: "approved",
      expectedStateVersion: detail.stateVersion,
      expectedActionRevision: detail.actionRevision,
      acknowledgeSingleUse: true,
    }, `approve:${detail.id}`, "已记录单次审批。还需单独确认后才能派发。") !== null;
  }

  async function reject(): Promise<boolean> {
    if (detail === null || detail.status !== "waitingApproval" || archived || !Object.prototype.hasOwnProperty.call(detail, "arguments")) return false;
    const result = await confirm({
      eyebrow: "项目 Owner 拒绝",
      title: `拒绝 ${detail.toolName}？`,
      description: `本次提案的规范化参数与版本将在上方显示。当前状态版本 ${detail.stateVersion}，动作修订 ${detail.actionRevision}。`,
      confirmLabel: "确认拒绝",
      cancelLabel: "返回检查",
      tone: "danger",
      inputLabel: "输入“拒绝”继续",
      requiredValue: "拒绝",
      inputPlaceholder: "拒绝",
    });
    if (!result.confirmed) return false;
    return await postAction(`/api/projects/${projectId}/mcp-actions/${detail.id}/decision`, {
      decision: "rejected",
      expectedStateVersion: detail.stateVersion,
      expectedActionRevision: detail.actionRevision,
      reasonCode: rejectReason,
    }, `reject:${detail.id}`, "动作提案已拒绝。") !== null;
  }

  async function cancel(): Promise<boolean> {
    if (detail === null || !["waitingApproval", "approved"].includes(detail.status)) return false;
    const result = await confirm({
      eyebrow: "取消项目动作",
      title: `取消 ${detail.toolName}？`,
      description: `取消会阻止后续审批或派发。当前状态版本 ${detail.stateVersion}，动作修订 ${detail.actionRevision}。`,
      confirmLabel: "确认取消",
      cancelLabel: "返回",
      tone: "danger",
      inputLabel: "输入“取消”继续",
      requiredValue: "取消",
      inputPlaceholder: "取消",
    });
    if (!result.confirmed) return false;
    return await postAction(`/api/projects/${projectId}/mcp-actions/${detail.id}/cancel`, {
      expectedStateVersion: detail.stateVersion,
      expectedActionRevision: detail.actionRevision,
    }, `cancel:${detail.id}`, "动作已取消。") !== null;
  }

  async function dispatch(): Promise<boolean> {
    if (detail === null || detail.status !== "approved" || archived || uncertainDispatchIds.has(detail.id)) return false;
    const result = await confirm({
      eyebrow: "单次外部派发",
      title: `现在派发 ${detail.toolName}？`,
      description: `外部服务可能已经收到请求，派发后无法撤回。当前状态版本 ${detail.stateVersion}，动作修订 ${detail.actionRevision}。如果结果未知，平台不会自动重试，请刷新并读取服务端状态。`,
      confirmLabel: "确认并派发一次",
      cancelLabel: "返回",
      tone: "warning",
      inputLabel: "输入“派发”继续",
      requiredValue: "派发",
      inputPlaceholder: "派发",
    });
    if (!result.confirmed) return false;
    if (pendingKeyRef.current !== null) return false;
    pendingKeyRef.current = `dispatch:${detail.id}`;
    setPendingKey(`dispatch:${detail.id}`);
    setFeedback(null);
    try {
      const dispatched = await requestJson<Action>(`/api/projects/${projectId}/mcp-actions/${detail.id}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedStateVersion: detail.stateVersion,
          expectedActionRevision: detail.actionRevision,
          acknowledgeSingleUse: true,
        }),
      });
      setDetail(dispatched);
      setFeedback(dispatched.status === "unknown"
        ? { tone: "warning", text: "派发结果未知。请勿重试；刷新只会读取服务端状态，不会再次派发。" }
        : { tone: "success", text: `${translateUi("派发已结束：")}${translateUi(statusLabels[dispatched.status] ?? dispatched.status)}。` });
      await load({ showLoading: false });
      return true;
    } catch (error) {
      setUncertainDispatchIds((current) => new Set(current).add(detail.id));
      setFeedback({ tone: "warning", text: `派发请求未能确认结果：${connectionErrorText(error, "连接中断或服务暂不可用")}。请勿重试；刷新只会重新读取服务端状态。` });
      detailControllerRef.current?.abort();
      const controller = new AbortController();
      detailControllerRef.current = controller;
      try {
        const latest = await requestJson<Action>(`/api/projects/${projectId}/mcp-actions/${detail.id}`, { signal: controller.signal });
        if (!controller.signal.aborted) setDetail(latest);
      } catch {
        // The dispatch outcome remains uncertain; do not send another POST.
      }
      return false;
    } finally {
      pendingKeyRef.current = null;
      setPendingKey(null);
    }
  }

  async function importResult(): Promise<void> {
    if (detail?.status !== "succeeded" || detail.result === undefined || archived || pendingKeyRef.current !== null) return;
    const approval = await confirm({
      eyebrow: "人工纳入项目资料",
      title: `纳入 ${detail.toolName} 的成功结果？`,
      description: "请先核对上方安全处理后的结果。纳入后会创建带动作与结果指纹的未审核项目资料；它不会自动成为已确认事实，也不会再次调用外部工具。",
      confirmLabel: "纳入未审核资料",
      cancelLabel: "返回检查",
      inputLabel: "输入“纳入”继续",
      requiredValue: "纳入",
      inputPlaceholder: "纳入",
    });
    if (!approval.confirmed) return;
    const key = `import:${detail.id}`;
    pendingKeyRef.current = key;
    setPendingKey(key);
    setFeedback(null);
    try {
      const result = await requestJson<ActionImportPayload>(`/api/projects/${projectId}/mcp-actions/${detail.id}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedActionRevision: detail.actionRevision,
          expectedResultFingerprint: detail.result.resultFingerprint,
        }),
      });
      setImportedSource({ actionId: detail.id, sourceId: result.import.projectSourceId });
      setDetail((current) => current?.id === detail.id
        ? { ...current, importedSourceId: result.import.projectSourceId }
        : current);
      setFeedback({ tone: "success", text: result.created
        ? "结果已纳入未审核项目资料。请打开资料并按项目审核流程处理。"
        : "此结果此前已纳入；未创建重复资料。" });
    } catch (error) {
      setFeedback({ tone: "error", text: connectionErrorText(error, "纳入失败；请刷新并重新核对动作结果。") });
    } finally {
      pendingKeyRef.current = null;
      setPendingKey(null);
    }
  }

  const detailHasArguments = detail !== null && Object.prototype.hasOwnProperty.call(detail, "arguments");
  const canApprove = detail?.status === "waitingApproval" && detailHasArguments && !archived && pendingKey === null;
  const canCancel = detail !== null && (detail.status === "waitingApproval" || detail.status === "approved") && pendingKey === null;
  const canDispatch = detail?.status === "approved" && !archived && pendingKey === null && !uncertainDispatchIds.has(detail.id);

  return (
    <main className={supportStyles.supportPage}>
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="tools" isSystemAdmin={isSystemAdmin} />
      {dialog}
      <div className="mx-auto max-w-7xl px-5 py-7 sm:px-8 lg:px-10">
        <div className="mb-5"><ProjectOverviewParentLink projectId={projectId} /></div>
        <section className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-6 py-8 text-white shadow-xl sm:px-8 sm:py-9 lg:px-10">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300"><UiText text={"Project MCP actions"} /></p>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl"><UiText text={"只读 MCP 动作审批"} /></h1>
          <p className="mt-4 max-w-4xl text-sm leading-7 text-slate-300"><UiText text={"仅项目 Owner 可使用。先检查完整规范化参数，再单独批准；派发必须再次明确确认。第三方请求不可撤回，结果未知时不会自动重试。"} /></p>
        </section>

        {feedback ? <p role={feedback.tone === "error" ? "alert" : "status"} className={`mt-5 rounded-2xl px-4 py-3 text-sm leading-6 ${feedback.tone === "error" ? "bg-rose-50 text-rose-700" : feedback.tone === "warning" ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-700"}`}>{feedback.text}</p> : null}
        {loadError ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span><UiErrorText text={loadError} /></span><button type="button" onClick={() => void load()} className={quietButtonClass}><UiText text={"重新读取"} /></button></div> : null}
        {archived ? <p className="mt-5 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900"><UiText text={"项目已归档。可以检查和取消待处理动作，不能创建、审批或派发动作。"} /></p> : null}

        {loading ? <div className="mt-6 h-48 animate-pulse rounded-3xl bg-slate-200" aria-label={translateUi("正在加载项目动作")} /> : !loadError ? (
          <div className="mt-6 space-y-6">
            {effectiveGrants.length === 0 ? <p className="rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm leading-6 text-slate-600"><UiText text={"当前没有有效的 V2 只读授权，请先在项目工具权限页完成授权。"} /></p> : <OperationPanel title={translateUi("创建一次性提案")} triggerLabel="创建一次性提案" open={proposeOpen} onOpenChange={(open) => { setProposeOpen(open); if (open) setFeedback(null); }} disabled={pendingKey !== null || archived} description="创建提案只保存一次性审批请求，不会调用远端服务。之后仍需核对参数、审批并单独确认派发。">
              {feedback?.tone === "error" ? <p role="alert" className="mb-4 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{feedback.text}</p> : null}
              <div className="max-w-3xl rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <p className="text-xs leading-5 text-slate-500"><UiText text={"仅能选择当前有效的 V2 只读授权。参数会由服务器校验并规范化；创建提案不会调用远端服务。"} /></p>
                <form onSubmit={(event) => void propose(event)} className="mt-5 space-y-4">
                  <label className="block text-xs font-semibold text-slate-700"><UiText text={"有效工具授权"} /><select value={selectedGrant?.id ?? ""} onChange={(event) => setGrantId(event.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100">
                      {effectiveGrants.map((grant) => <option key={grant.id} value={grant.id}>{grant.tool.title || grant.tool.name || grant.toolName || <UiText text={"未命名工具"} />} · {grant.tool.name ?? grant.toolName ?? grant.id.slice(0, 8)}</option>)}
                    </select>
                  </label>
                  {selectedGrant?.tool.description ? <p className="rounded-xl bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600">{selectedGrant.tool.description}</p> : null}
                  {selectedGrant ? <details className="rounded-xl border border-slate-200 px-3 py-3"><summary className="cursor-pointer text-xs font-semibold text-slate-700"><UiText text={"查看不可信的输入 schema"} /></summary><pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-100">{jsonPreview(selectedGrant.tool.inputSchema)}</pre></details> : null}
                  <label className="block text-xs font-semibold text-slate-700"><UiText text={"调用参数 JSON"} /><textarea value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} rows={10} maxLength={32_000} spellCheck={false} className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-950 px-3 py-3 font-mono text-xs leading-5 text-slate-100 outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" aria-label={translateUi("调用参数 JSON")} />
                  </label>
                  <button type="submit" disabled={pendingKey !== null || archived || selectedGrant === null} className={`${primaryButtonClass} min-h-11 w-full`}>{pendingKey === "propose" ? <UiText text={"提交中…"} /> : <UiText text={"创建审批提案"} />}</button>
                </form>
              </div>
            </OperationPanel>}
            <section className="min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600"><UiText text={"Action records"} /></p><h2 className="mt-2 text-xl font-semibold"><UiText text={"动作记录与详情"} /></h2><p className="mt-1 text-xs leading-5 text-slate-500"><UiText text={"每次进入或刷新都会从受权限保护的 API 重新读取状态和完整参数。"} /></p></div><div className="flex items-center gap-3"><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{actions.length} {" "}<UiText text={"条"} /></span><button type="button" onClick={() => void refreshStatus()} disabled={pendingKey !== null} className={quietButtonClass}><UiText text={"刷新状态"} /></button></div></div>
              {actions.length === 0 ? <p className="mt-5 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-xs text-slate-500"><UiText text={"还没有项目 MCP 动作。"} /></p> : (
                <div className="mt-5 grid min-w-0 gap-5 xl:grid-cols-[minmax(180px,.6fr)_minmax(0,1fr)]">
                  <div className="min-w-0 space-y-2" aria-label={translateUi("项目 MCP 动作列表")}>
                    {actions.map((action) => <button key={action.id} type="button" onClick={() => { setImportedSource(null); setOperationOpen(false); setSelectedActionId(action.id); }} disabled={pendingKey !== null} aria-pressed={selectedActionId === action.id} className={`w-full min-w-0 rounded-xl border p-3 text-left transition ${selectedActionId === action.id ? "border-indigo-300 bg-indigo-50" : "border-slate-200 hover:bg-slate-50"}`}><span className="block break-all text-xs font-semibold text-slate-800">{action.toolName}</span><span className="mt-2 flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-1 text-[12px] font-semibold ${actionStatusClass(action.status)}`}>{translateUi(statusLabels[action.status])}</span><span className="font-mono text-[10px] text-slate-400"><UiText text={"v"} />{action.stateVersion}</span></span><span className="mt-2 block text-[12px] text-slate-400">{formatDate(action.createdAt)}</span></button>)}
                  </div>
                  <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5">
                    {detailLoading ? <p className="py-8 text-center text-xs text-slate-500"><UiText text={"正在读取规范化参数与状态…"} /></p> : detailError ? <p role="alert" className="rounded-xl bg-rose-50 px-3 py-3 text-xs text-rose-700"><UiErrorText text={detailError} /></p> : detail ? <>
                      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words text-base font-semibold text-slate-900">{detail.toolName}</h3><p className="mt-1 break-all font-mono text-[12px] text-slate-500">{detail.id}</p></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${actionStatusClass(detail.status)}`}>{translateUi(statusLabels[detail.status])}</span></div>
                      <dl className="mt-4 grid min-w-0 gap-3 rounded-xl bg-white p-3 text-xs sm:grid-cols-2"><div><dt className="text-slate-400"><UiText text={"状态版本"} /></dt><dd className="mt-1 font-mono font-semibold text-slate-800">{detail.stateVersion}</dd></div><div><dt className="text-slate-400"><UiText text={"授权版本"} /></dt><dd className="mt-1 font-mono font-semibold text-slate-800"><UiText text={"1"} /></dd></div><div className="min-w-0 sm:col-span-2"><dt className="text-slate-400"><UiText text={"动作修订"} /></dt><dd className="mt-1 break-all font-mono text-[12px] text-slate-700">{detail.actionRevision}</dd></div><div><dt className="text-slate-400"><UiText text={"提案时间"} /></dt><dd className="mt-1 text-slate-700">{formatDate(detail.createdAt)}</dd></div><div><dt className="text-slate-400"><UiText text={"审批到期"} /></dt><dd className="mt-1 text-slate-700">{formatDate(detail.approvalExpiresAt)}</dd></div></dl>
                      {detailHasArguments ? <section className="mt-4 min-w-0"><h4 className="text-xs font-semibold text-slate-700"><UiText text={"服务端规范化后的完整参数"} /></h4><pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">{jsonPreview(detail.arguments)}</pre></section> : <p className="mt-4 rounded-xl bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-900"><UiText text={"详情接口尚未返回参数；在参数可见前不能审批。"} /></p>}
                      {detail.result ? <section className="mt-4 min-w-0"><h4 className="text-xs font-semibold text-slate-700"><UiText text={"安全处理后的派发结果"} /></h4>{detail.result.payload === null ? <p className="mt-2 rounded-xl bg-white px-3 py-3 text-xs text-slate-600"><UiText text={"没有可显示的结果正文。结果指纹："} /><code className="break-all">{detail.result.resultFingerprint}</code></p> : <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">{jsonPreview(detail.result.payload)}</pre>}<p className="mt-2 break-all text-[12px] text-slate-500"><UiText text={"指纹"} />{" "}{detail.result.resultFingerprint} · {detail.result.resultBytes} {" "}<UiText text={"字节 ·"} />{" "}{detail.result.omittedContentCount} {" "}<UiText text={"项内容已省略"} /></p></section> : null}
                      {detail.status === "succeeded" && detail.result ? <div className="mt-4 flex flex-wrap items-center gap-3"><button type="button" onClick={() => void importResult()} disabled={archived || pendingKey !== null || detail.importedSourceId !== undefined} className={quietButtonClass}>{pendingKey === `import:${detail.id}` ? <UiText text={"纳入中…"} /> : detail.importedSourceId ? <UiText text={"已纳入未审核资料"} /> : <UiText text={"人工纳入未审核资料"} />}</button>{detail.importedSourceId || importedSource?.actionId === detail.id ? <a href={`/projects/${encodeURIComponent(projectId)}/materials/sources/${encodeURIComponent(detail.importedSourceId ?? importedSource!.sourceId)}`} className="text-xs font-semibold text-indigo-700 underline underline-offset-2"><UiText text={"打开纳入的资料"} /></a> : null}</div> : null}
                      {detail.status === "unknown" ? <p role="status" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-xs leading-5 text-rose-800"><UiText text={"外部派发结果未知。请勿重试；此动作已终态化，刷新仅重新读取记录，不会再次派发。"} /></p> : detail.status === "dispatchReserved" ? <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-900"><UiText text={"派发已进入处理中。请勿重复提交，刷新仅重新读取状态。"} /></p> : null}
                      {canApprove || canCancel || detail.status === "approved" ? <div className="mt-4"><OperationPanel title={translateUi("处理 MCP 动作")} triggerLabel="处理动作" open={operationOpen} onOpenChange={(open) => { setOperationOpen(open); if (open) setFeedback(null); }} disabled={pendingKey !== null} description="审批和派发都要求再次明确确认，并核对动作版本。第三方请求不可撤回，结果未知时不会自动重试。">
                        {feedback?.tone === "error" ? <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{feedback.text}</p> : null}
                        <div className="max-w-3xl space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
                          {detail.status === "waitingApproval" ? <label className="block text-sm font-semibold text-slate-700"><UiText text={"拒绝原因"} /><select value={rejectReason} onChange={(event) => setRejectReason(event.target.value as keyof typeof reasonLabels)} className="mt-2 min-h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal">{Object.entries(reasonLabels).map(([value, label]) => <option key={value} value={value}>{translateUi(label)}</option>)}</select></label> : null}
                          <div className="flex flex-wrap gap-2">{detail.status === "waitingApproval" ? <><button type="button" onClick={async () => { if (await approve()) setOperationOpen(false); }} disabled={!canApprove} className={primaryButtonClass}>{pendingKey === `approve:${detail.id}` ? <UiText text={"审批中…"} /> : <UiText text={"批准一次"} />}</button><button type="button" onClick={async () => { if (await reject()) setOperationOpen(false); }} disabled={!canApprove} className={dangerButtonClass}>{pendingKey === `reject:${detail.id}` ? <UiText text={"拒绝中…"} /> : <UiText text={"拒绝提案"} />}</button></> : null}{canCancel ? <button type="button" onClick={async () => { if (await cancel()) setOperationOpen(false); }} disabled={pendingKey !== null} className={quietButtonClass}>{pendingKey === `cancel:${detail.id}` ? <UiText text={"取消中…"} /> : <UiText text={"取消动作"} />}</button> : null}{detail.status === "approved" ? <button type="button" onClick={async () => { if (await dispatch()) setOperationOpen(false); }} disabled={!canDispatch} className={`${primaryButtonClass} ${canDispatch ? "bg-amber-600 hover:bg-amber-500 focus-visible:outline-amber-600" : ""}`}>{pendingKey === `dispatch:${detail.id}` ? <UiText text={"派发中…"} /> : uncertainDispatchIds.has(detail.id) ? <UiText text={"结果待核实，请勿重试"} /> : <UiText text={"单独确认并派发"} />}</button> : null}</div>
                        </div>
                      </OperationPanel></div> : null}
                      {uncertainDispatchIds.has(detail.id) && detail.status === "approved" ? <p role="status" className="mt-3 rounded-xl bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-900"><UiText text={"本次派发请求未能确认结果，本页面已暂停再次派发。请先刷新并核对服务端动作状态；没有自动重试。"} /></p> : null}
                    </> : <p className="py-8 text-center text-xs text-slate-500"><UiText text={"选择一条动作以查看完整参数、版本和处理结果。"} /></p>}
                  </div>
                </div>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </main>
  );
}
