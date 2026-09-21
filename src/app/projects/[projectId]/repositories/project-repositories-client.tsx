"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";

type ConnectionOption = Readonly<{ id: string; name: string; providerKind: string; transport: string; status: string; ownershipState: string }>;
type DelegationCapabilities = Readonly<{ canOwnerConfirm: boolean; canProjectConfirm: boolean; canReject: boolean; canRevoke: boolean; canManualSync: boolean }>;
type Delegation = Readonly<{
  id: string;
  projectId: string;
  /** Personal connection identity is returned only to its owner. */
  connection: Readonly<{ id: string; name: string; providerKind: string; transport: string }> | null;
  connectionOwner: Readonly<{ displayName: string } | null>;
  scope: Readonly<{ repositoryPath: string; trackedRef: string; includeRoots: unknown; softExcludePatterns: unknown; role: string; requiredForProjectSnapshot: boolean; codeEnabled: boolean; metadataEnabled: boolean; manualSyncAllowed: boolean; automationAllowed: boolean }>;
  status: string;
  version: number;
  expiresAt: string;
  proposedAt: string;
  ownerConfirmedAt: string | null;
  projectConfirmedAt: string | null;
  activatedAt: string | null;
  rejectedAt: string | null;
  revokedAt: string | null;
  expiredAt: string | null;
  ownerConfirmedBy: Readonly<{ displayName: string } | null>;
  projectConfirmedBy: Readonly<{ displayName: string } | null>;
  terminalReason: string | null;
  capabilities: DelegationCapabilities;
}>;
type RunSummary = Readonly<{ id: string; projectId: string; delegationId: string; status: string; stage: string; dispatchState: string; failureCode: string | null; delegationVersion: number; frozenCommitSha: string | null; fileCount: number | null; decodedTextBytes: number | null; createdAt: string; startedAt: string | null; completedAt: string | null; acknowledged: boolean }>;
type RunDetail = Readonly<{ run: RunSummary; acknowledgement: Readonly<{ acknowledgedAt: string }> | null; entries: readonly Readonly<{ ordinal: number; normalizedPath: string; contentBytes: number; lineCount: number; projectSourceId: string }>[]; capabilities: Readonly<{ canAcknowledge: boolean }> }>;
type ListPayload = Readonly<{ capabilities: Readonly<{ canPropose: boolean }>; connections: readonly ConnectionOption[]; delegations: readonly Delegation[] }>;
type RunListPayload = Readonly<{ runs: readonly RunSummary[]; nextCursor: string | null; capabilities: Readonly<{ canView: boolean; canAcknowledge: boolean }> }>;

const statusLabels: Record<string, string> = { draft: "待连接所有者确认", ownerConfirmed: "待项目 Owner 确认", active: "已启用手动读取", rejected: "已拒绝", revoked: "已撤销", expired: "已过期" };
const runStatusLabels: Record<string, string> = { queued: "排队中", running: "读取中", succeeded: "已发布", failed: "失败", unknown: "结果未知" };
const roleLabels: Record<string, string> = { primary: "主仓库", application: "应用代码", infrastructure: "基础设施", library: "公共库", documentation: "文档", other: "其他" };

function formatTime(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function formatScope(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | T | null;
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && body.error?.message ? body.error.message : "请求失败，请刷新后重试";
    throw new Error(message);
  }
  return body as T;
}

function createClientRequestKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") throw new Error("当前浏览器不支持安全请求标识");
  return globalThis.crypto.randomUUID();
}

function currentTimeMillis(): number { return Date.now(); }

function localDateTimeValue(value: Date): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

export function ProjectRepositoriesClient({ username, projectId, isSystemAdmin }: { username: string; projectId: string; isSystemAdmin: boolean }) {
  const [payload, setPayload] = useState<ListPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();
  const manualRequestKeys = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await requestJson<ListPayload>(`/api/projects/${projectId}/git-repository-delegations`);
      setPayload(next); setLoadError(null);
    } catch (error) { setLoadError(error instanceof Error ? error.message : "项目 Git 委托加载失败"); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function mutate(path: string, body: Record<string, unknown>, success: string) {
    try { await requestJson(`/api/projects/${projectId}/git-repository-delegations/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); setMessage(success); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "操作失败，请刷新后重试"); await load(); }
  }

  async function confirmOwner(delegation: Delegation) {
    const result = await confirm({ eyebrow: "连接所有者确认", title: "确认只读凭据使用？", description: "这会允许项目在第二次确认后使用你的个人 Git 凭据执行一次性、只读的仓库读取。不会启用自动同步，也不会写入仓库。", confirmLabel: "确认只读使用", cancelLabel: "返回" });
    if (result.confirmed) await mutate(`${delegation.id}/owner-confirmation`, { expectedVersion: delegation.version, acknowledgeReadOnlyCredentialUse: true }, "连接所有者确认已提交，等待项目 Owner。");
  }

  async function confirmProject(delegation: Delegation) {
    const result = await confirm({ eyebrow: "项目 Owner 确认", title: "确认仓库范围与资料进入？", description: "这会确认仓库、分支和目录范围，并允许一次性只读结果进入本项目资料。自动化、写入和提交仍不会开启。", confirmLabel: "确认项目范围", cancelLabel: "返回" });
    if (result.confirmed) await mutate(`${delegation.id}/project-confirmation`, { expectedVersion: delegation.version, acknowledgeRepositoryScope: true, acknowledgeDataEgress: true }, "项目 Owner 确认已提交，手动读取已开放。");
  }

  async function terminal(delegation: Delegation, action: "rejection" | "revocation") {
    const result = await confirm({ eyebrow: action === "rejection" ? "拒绝委托" : "撤销委托", title: action === "rejection" ? "拒绝这次项目委托？" : "撤销这次项目委托？", description: action === "rejection" ? "拒绝后需要重新创建委托才能继续。请填写原因，便于项目成员理解。" : "撤销会立即停止后续手动读取；已经发出的外部读取不能撤回。请填写原因。", confirmLabel: action === "rejection" ? "确认拒绝" : "确认撤销", cancelLabel: "返回", tone: "danger", inputLabel: "原因", inputPlaceholder: "例如：仓库范围需要调整", inputOptional: false, maxLength: 500 });
    if (result.confirmed) await mutate(`${delegation.id}/${action}`, { expectedVersion: delegation.version, reason: result.value.trim() }, action === "rejection" ? "委托已拒绝。" : "委托已撤销。");
  }

  async function manualSync(delegation: Delegation): Promise<void> {
    const result = await confirm({ eyebrow: "一次性手动读取", title: "读取这次已确认的仓库范围？", description: "本次只读取已确认的分支和目录，不启用自动化，不写入仓库。外部读取发出后可能无法撤回。", confirmLabel: "开始只读读取", cancelLabel: "返回" });
    if (!result.confirmed) return;
    let key: string;
    try { key = manualRequestKeys.current[delegation.id] ?? createClientRequestKey(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "当前浏览器不支持安全请求标识"); return; }
    manualRequestKeys.current[delegation.id] = key;
    try {
      const result = await requestJson<{ status: string; failureCode: string | null }>(`/api/projects/${projectId}/git-repository-delegations/${delegation.id}/manual-sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientRequestKey: key }) });
      delete manualRequestKeys.current[delegation.id];
      setMessage(result.status === "succeeded"
        ? "手动读取成功，资料已发布到项目。"
        : result.status === "unknown"
          ? "手动读取结果未知；外部读取可能已发出，系统不会自动重试。"
          : result.status === "failed"
            ? `手动读取失败${result.failureCode ? `：${result.failureCode}` : ""}。`
            : "手动读取已记录，请在运行历史查看最新状态。");
      await load();
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "手动读取未完成；可以安全重试，当前请求会复用本次意图。请勿重复开启新的读取。"); }
  }

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="projects" projectId={projectId} projectSection="repositories" isSystemAdmin={isSystemAdmin} />{dialog}<div className="mx-auto max-w-7xl px-5 py-7 sm:px-8 lg:px-10"><div className="mb-5"><ProjectMaterialsParentLink projectId={projectId} /></div><section className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 px-6 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-8 sm:py-9"><div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div className="max-w-3xl"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Repository access</p><h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">项目 Git 委托</h1><p className="mt-4 text-sm leading-7 text-slate-300">个人 Git 连接仍只属于你自己。完成连接所有者与项目 Owner 两次确认后，项目成员可以按已冻结范围发起一次性手动只读读取。</p></div><div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300 lg:max-w-xs"><p className="font-semibold text-white">边界说明</p><p className="mt-2 text-xs leading-5">自动化、写入/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准。</p></div></div></section><p className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-xs leading-5 text-indigo-950">费用承担者为连接所有者；第三方费用由其与服务商约定，平台不代扣，也不计入项目平台额度。</p>{message ? <p role="status" className="mt-5 rounded-2xl bg-indigo-50 px-4 py-3 text-sm text-indigo-800">{message}</p> : null}{loadError ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span>{loadError}</span><button type="button" onClick={() => void load()} className="min-h-10 font-semibold underline">重试</button></div> : null}{loading ? <LoadingState /> : payload === null ? null : <div className="mt-7 grid min-w-0 gap-6 lg:grid-cols-[minmax(280px,.78fr)_minmax(0,1.22fr)]"><ProposalPanel projectId={projectId} enabled={payload.capabilities.canPropose} connections={payload.connections} onCreated={() => { setMessage("委托草稿已创建，请完成连接所有者确认。"); void load(); }} /><section className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">Delegations</p><h2 className="mt-2 text-2xl font-semibold">项目委托</h2><p className="mt-1 text-sm leading-6 text-slate-500">只展示安全摘要；连接地址、用户名、凭据与网络证据不会出现在项目页。</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{payload.delegations.length} 条</span></div>{payload.delegations.length === 0 ? <div className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-10 text-center"><p className="text-sm font-semibold text-slate-700">还没有项目 Git 委托</p><p className="mt-2 text-xs leading-5 text-slate-500">从左侧选择一条已验证的个人 Git 连接，提交仓库范围后再进行双确认。</p></div> : <div className="mt-6 space-y-4">{payload.delegations.map((delegation) => <DelegationCard key={delegation.id} projectId={projectId} delegation={delegation} onOwnerConfirm={() => void confirmOwner(delegation)} onProjectConfirm={() => void confirmProject(delegation)} onTerminal={(action) => void terminal(delegation, action)} onManualSync={() => manualSync(delegation)} />)}</div>}</section></div>}</div></main>;
}

function ProposalPanel({ projectId, enabled, connections, onCreated }: { projectId: string; enabled: boolean; connections: readonly ConnectionOption[]; onCreated: () => void }) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [trackedRef, setTrackedRef] = useState("main");
  const [includeRoots, setIncludeRoots] = useState(".");
  const [softExcludePatterns, setSoftExcludePatterns] = useState(".git");
  const [role, setRole] = useState("primary");
  const [expiresAt, setExpiresAt] = useState(() => localDateTimeValue(new Date(Date.now() + 24 * 60 * 60 * 1000)));
  const [flags, setFlags] = useState({ requiredForProjectSnapshot: true, codeEnabled: true, metadataEnabled: true });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!enabled || connectionId === "") return;
    const expiry = new Date(expiresAt); const now = currentTimeMillis();
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() < now + 10 * 60 * 1000 || expiry.getTime() > now + 30 * 24 * 60 * 60 * 1000) { setError("有效期必须在 10 分钟到 30 天之间。"); return; }
    setPending(true); setError(null);
    try { await requestJson(`/api/projects/${projectId}/git-repository-delegations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gitConnectionId: selectedConnectionId, repositoryPath, trackedRef, includeRoots: includeRoots.split("\n").map((item) => item.trim()).filter(Boolean), softExcludePatterns: softExcludePatterns.split("\n").map((item) => item.trim()).filter(Boolean), role, requiredForProjectSnapshot: flags.requiredForProjectSnapshot, codeEnabled: flags.codeEnabled, metadataEnabled: flags.metadataEnabled, manualSyncAllowed: true, automationAllowed: false, expiresAt: expiry.toISOString() }) }); setRepositoryPath(""); onCreated(); }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : "委托创建失败，请检查范围后重试"); }
    finally { setPending(false); }
  }

  const selectedConnectionId = connections.some((connection) => connection.id === connectionId) ? connectionId : (connections[0]?.id ?? "");
  return <section className="h-fit min-w-0 rounded-3xl border border-indigo-100 bg-indigo-50/50 p-5 shadow-sm sm:p-6"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">New delegation</p><h2 className="mt-2 text-xl font-semibold">提案一次性只读范围</h2><p className="mt-2 text-xs leading-5 text-slate-600">只能选择当前账户已验证的个人连接。提交后仍需连接所有者和项目 Owner 独立确认。</p>{!enabled ? <p className="mt-4 rounded-xl bg-slate-100 px-3 py-3 text-xs leading-5 text-slate-600">当前账户没有明确的项目 Editor/Owner 权限，不能创建委托。</p> : connections.length === 0 ? <p className="mt-4 rounded-xl bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-900">还没有可用的个人 Git 连接。请先在<Link href="/personal/connections/git" className="font-semibold underline">个人 Git 设置</Link>中完成验证。</p> : <form onSubmit={submit} className="mt-5 space-y-3"><Field label="个人 Git 连接"><select className={fieldClass} value={selectedConnectionId} onChange={(event) => setConnectionId(event.target.value)}>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name} · {connection.providerKind} · {connection.transport.toUpperCase()}</option>)}</select></Field><Field label="仓库路径"><input required className={fieldClass} value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} placeholder="owner/repository" /></Field><Field label="分支"><input required className={fieldClass} value={trackedRef} onChange={(event) => setTrackedRef(event.target.value)} placeholder="main" /></Field><Field label="包含目录（每行一个）"><textarea required className={`${fieldClass} min-h-20`} value={includeRoots} onChange={(event) => setIncludeRoots(event.target.value)} /></Field><Field label="软排除目录（每行一个）"><textarea className={`${fieldClass} min-h-20`} value={softExcludePatterns} onChange={(event) => setSoftExcludePatterns(event.target.value)} /></Field><div className="grid gap-3 sm:grid-cols-2"><Field label="用途"><select className={fieldClass} value={role} onChange={(event) => setRole(event.target.value)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="有效期截止"><input required type="datetime-local" className={fieldClass} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></Field></div><div className="space-y-2 rounded-2xl border border-indigo-100 bg-white/70 p-3 text-xs text-slate-600"><p className="font-semibold text-slate-800">资料范围</p>{([ ["requiredForProjectSnapshot", "作为项目资料快照必需来源"], ["codeEnabled", "允许代码资料进入项目"], ["metadataEnabled", "允许元数据进入项目"] ] as const).map(([key, label]) => <label key={key} className="flex items-start gap-2"><input type="checkbox" checked={flags[key]} onChange={(event) => setFlags((current) => ({ ...current, [key]: event.target.checked }))} className="mt-0.5 h-4 w-4" /><span>{label}</span></label>)}</div><div className="rounded-2xl bg-slate-100 px-3 py-3 text-xs leading-5 text-slate-600"><p className="font-semibold text-slate-800">本期固定规则</p><p className="mt-1">手动只读：开启；自动化：关闭；不会写入、提交或创建 Pull Request。</p></div>{error ? <p role="alert" className="text-xs leading-5 text-rose-700">{error}</p> : null}<button type="submit" disabled={pending} className="min-h-11 w-full rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{pending ? "提交中…" : "提交委托提案"}</button></form>}</section>;
}

function DelegationCard({ projectId, delegation, onOwnerConfirm, onProjectConfirm, onTerminal, onManualSync }: { projectId: string; delegation: Delegation; onOwnerConfirm: () => void; onProjectConfirm: () => void; onTerminal: (action: "rejection" | "revocation") => void; onManualSync: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false); const [runs, setRuns] = useState<RunSummary[]>([]); const [nextCursor, setNextCursor] = useState<string | null>(null); const [runsLoading, setRunsLoading] = useState(false); const [runsError, setRunsError] = useState<string | null>(null); const [detail, setDetail] = useState<RunDetail | null>(null); const [canAcknowledge, setCanAcknowledge] = useState(false);
  const { confirm: confirmRun, dialog: runDialog } = useAppConfirmDialog();
  const loadRuns = useCallback(async (cursor?: string) => { setRunsLoading(true); setRunsError(null); try { const query = new URLSearchParams(); if (cursor) query.set("cursor", cursor); query.set("limit", "20"); const result = await requestJson<RunListPayload>(`/api/projects/${projectId}/git-repository-delegations/${delegation.id}/manual-runs?${query.toString()}`); setRuns((current) => cursor ? [...current, ...result.runs] : [...result.runs]); setNextCursor(result.nextCursor); setCanAcknowledge(result.capabilities.canAcknowledge); } catch (error) { setRunsError(error instanceof Error ? error.message : "运行历史加载失败"); } finally { setRunsLoading(false); } }, [delegation.id, projectId]);
  useEffect(() => { if (!expanded) return; const timer = window.setTimeout(() => void loadRuns(), 0); return () => window.clearTimeout(timer); }, [expanded, loadRuns]);
  async function showDetail(runId: string) { try { const nextDetail = await requestJson<RunDetail>(`/api/projects/${projectId}/git-repository-delegations/${delegation.id}/manual-runs/${runId}`); setDetail(nextDetail); setCanAcknowledge(nextDetail.capabilities.canAcknowledge); } catch (error) { setRunsError(error instanceof Error ? error.message : "运行详情加载失败"); } }
  async function startManualSync() { await onManualSync(); if (expanded) await loadRuns(); }
  async function acknowledge(run: RunSummary) {
    const result = await confirmRun({ eyebrow: "人工核对未知运行", title: "确认已人工核对？", description: "这只会追加人工核对记录，不会改写运行状态、不会重新发起读取，也不会把未知结果变成成功。", confirmLabel: "确认人工核对", cancelLabel: "返回", tone: "warning" });
    if (!result.confirmed) return;
    try { await requestJson(`/api/projects/${projectId}/git-repository-delegations/${delegation.id}/manual-runs/${run.id}/reconciliation`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); await loadRuns(); if (detail?.run.id === run.id) await showDetail(run.id); } catch (error) { setRunsError(error instanceof Error ? error.message : "人工核对未保存，请刷新后重试"); }
  }
  const includeRoots = formatScope(delegation.scope.includeRoots); const excludes = formatScope(delegation.scope.softExcludePatterns); const terminal = delegation.status === "rejected" || delegation.status === "revoked" || delegation.status === "expired";
  const connectionLabel = delegation.connection?.name ?? "个人连接（仅所有者可见）";
  const connectionKind = delegation.connection
    ? `${delegation.connection.providerKind} · ${delegation.connection.transport.toUpperCase()}`
    : "连接身份已隐藏";
  return <article className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5">{runDialog}<div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-base font-semibold text-slate-900">{connectionLabel}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ring-1 ${delegation.status === "active" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : terminal ? "bg-slate-100 text-slate-600 ring-slate-200" : "bg-amber-50 text-amber-700 ring-amber-200"}`}>{statusLabels[delegation.status] ?? delegation.status}</span></div><p className="mt-2 text-xs text-slate-500">{connectionKind} · {delegation.scope.repositoryPath} · {delegation.scope.trackedRef}</p><p className="mt-1 text-xs text-slate-400">连接所有者：{delegation.connectionOwner?.displayName ?? "不可用"}</p></div><div className="text-right text-xs text-slate-400"><p>有效至 {formatTime(delegation.expiresAt)}</p><p className="mt-1">版本 {delegation.version}</p></div></div><dl className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3"><div><dt className="text-slate-400">范围</dt><dd className="mt-1 font-medium">{roleLabels[delegation.scope.role] ?? delegation.scope.role} · {includeRoots.length} 个目录</dd></div><div><dt className="text-slate-400">双确认</dt><dd className="mt-1 font-medium">{delegation.ownerConfirmedAt ? "连接所有者已确认" : "等待连接所有者"}{delegation.projectConfirmedAt ? " · 项目已确认" : " · 等待项目 Owner"}</dd></div><div><dt className="text-slate-400">运行权限</dt><dd className="mt-1 font-medium">{delegation.scope.manualSyncAllowed && !delegation.scope.automationAllowed ? "手动只读" : "受限"}</dd></div></dl><div className="mt-4 flex flex-wrap gap-2">{delegation.capabilities.canOwnerConfirm ? <button type="button" onClick={onOwnerConfirm} className={buttonClass}>确认只读凭据</button> : null}{delegation.capabilities.canProjectConfirm ? <button type="button" onClick={onProjectConfirm} className={buttonClass}>确认项目范围</button> : null}{delegation.capabilities.canManualSync ? <button type="button" onClick={() => void startManualSync()} className="min-h-10 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500">手动只读读取</button> : null}{delegation.capabilities.canReject ? <button type="button" onClick={() => onTerminal("rejection")} className={quietDangerClass}>拒绝</button> : null}{delegation.capabilities.canRevoke ? <button type="button" onClick={() => onTerminal("revocation")} className={quietDangerClass}>撤销</button> : null}<button type="button" onClick={() => setExpanded((value) => !value)} className={buttonClass}>{expanded ? "收起运行历史" : "查看运行历史"}</button></div>{delegation.terminalReason ? <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">终止原因：{delegation.terminalReason}</p> : null}<div className="mt-4 flex flex-wrap gap-2 text-[12px] text-slate-500">{excludes.length > 0 ? <span>软排除：{excludes.join("、")}</span> : <span>未设置软排除</span>}<span aria-hidden="true">·</span><span>{delegation.scope.codeEnabled ? "代码" : "不含代码"} · {delegation.scope.metadataEnabled ? "元数据" : "不含元数据"}</span></div>{expanded ? <RunHistory projectId={projectId} runs={runs} nextCursor={nextCursor} loading={runsLoading} error={runsError} detail={detail} canAcknowledge={canAcknowledge} onLoadMore={() => nextCursor ? void loadRuns(nextCursor) : undefined} onRetry={() => void loadRuns()} onDetail={(run) => void showDetail(run.id)} onAcknowledge={(run) => void acknowledge(run)} /> : null}</article>;
}

function RunHistory({ projectId, runs, nextCursor, loading, error, detail, canAcknowledge, onLoadMore, onRetry, onDetail, onAcknowledge }: { projectId: string; runs: readonly RunSummary[]; nextCursor: string | null; loading: boolean; error: string | null; detail: RunDetail | null; canAcknowledge: boolean; onLoadMore: () => void; onRetry: () => void; onDetail: (run: RunSummary) => void; onAcknowledge: (run: RunSummary) => void }) {
  return <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-4" aria-label="手动读取运行历史"><div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="text-sm font-semibold text-slate-900">运行历史</h4><p className="mt-1 text-xs text-slate-500">按时间分页；未知结果不会自动重试。</p></div>{loading ? <span className="text-xs text-slate-400">加载中…</span> : null}</div>{error ? <div role="alert" className="mt-3 flex flex-wrap justify-between gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700"><span>{error}</span><button type="button" onClick={onRetry} className="font-semibold underline">重试</button></div> : null}{runs.length === 0 && !loading && !error ? <p className="mt-4 rounded-xl bg-slate-50 px-3 py-5 text-center text-xs text-slate-500">还没有手动读取记录。</p> : <div className="mt-4 space-y-2">{runs.map((run) => <div key={run.id} className="rounded-xl border border-slate-200 px-3 py-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-semibold text-slate-800">{runStatusLabels[run.status] ?? run.status}</p><p className="mt-1 text-[12px] text-slate-500">{formatTime(run.createdAt)} · {run.fileCount ?? 0} 个文件 · {run.decodedTextBytes ?? 0} 字节</p></div><span className="text-[12px] text-slate-400">{run.completedAt ? formatTime(run.completedAt) : run.stage}</span></div>{run.status === "unknown" ? <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[12px] leading-5 text-amber-900">外部读取可能已发出、无可信发布结果、禁止自动重试。{run.acknowledged ? "已人工核对（运行仍保持未知）。" : ""}</p> : null}{run.failureCode ? <p className="mt-2 text-[12px] text-rose-700">{run.failureCode}</p> : null}<div className="mt-2 flex flex-wrap gap-3 text-[12px] font-semibold"><button type="button" onClick={() => onDetail(run)} className="text-indigo-700 underline">查看详情</button>{canAcknowledge && run.status === "unknown" && !run.acknowledged ? <button type="button" onClick={() => onAcknowledge(run)} className="text-amber-700 underline">已人工核对</button> : null}</div></div>)}</div>}{nextCursor ? <button type="button" onClick={onLoadMore} disabled={loading} className="mt-4 min-h-10 w-full rounded-xl border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">加载更多</button> : null}{detail ? <RunDetailPanel projectId={projectId} detail={detail} /> : null}</section>;
}

function RunDetailPanel({ projectId, detail }: { projectId: string; detail: RunDetail }) {
  return <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-xs font-semibold text-slate-900">运行详情</h5><span className="text-[12px] text-slate-500">{detail.entries.length} 条资料</span></div>{detail.run.status === "succeeded" && detail.entries.length > 0 ? <ul className="mt-3 space-y-2">{detail.entries.map((entry) => <li key={entry.ordinal} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-[12px]"><span className="min-w-0 break-all text-slate-700">{entry.normalizedPath}</span><Link href={`/projects/${projectId}/materials/sources/${entry.projectSourceId}`} className="shrink-0 font-semibold text-indigo-700 underline">打开资料</Link></li>)}</ul> : <p className="mt-3 text-[12px] leading-5 text-slate-600">当前运行没有可展示的成功资料条目。</p>}{detail.acknowledgement ? <p className="mt-3 text-[12px] text-slate-500">人工核对于 {formatTime(detail.acknowledgement.acknowledgedAt)} 完成；运行状态仍保持未知。</p> : null}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block min-w-0 text-xs font-semibold text-slate-700">{label}{children}</label>; }
const fieldClass = "mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100";
const buttonClass = "min-h-10 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700";
const quietDangerClass = "min-h-10 rounded-xl px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-50";
function LoadingState() { return <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(280px,.78fr)_minmax(0,1.22fr)]" aria-label="正在加载项目 Git 委托"><div className="h-[34rem] animate-pulse rounded-3xl bg-slate-200" /><div className="h-[28rem] animate-pulse rounded-3xl bg-slate-200" /></div>; }
