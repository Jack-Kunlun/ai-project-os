"use client";
import { UiFeedbackText, UiErrorText } from "@/components/ui-error-text";


import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { HelpTooltip } from "@/components/help-tooltip";
import { ParentPageLink } from "@/components/parent-page-link";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import {
  connectionButtonClass,
  connectionErrorText,
  connectionFieldClass,
  ConnectionRequestError,
  type ConnectionMessage,
  formatConnectionDate,
} from "../connection-ui";
import { ConnectionGovernancePanel, connectionBlockerText } from "../governance-panel";
import { ConnectionCreateDialog, ConnectionDialogActions } from "../connection-create-dialog";
import { ConnectionEditDialog } from "../connection-edit-dialog";
import listStyles from "../connection-list.module.css";
import styles from "../../../support-pages.module.css";
import {
  createDefaultGitDraft,
  gitAuthKindLabels,
  gitProviderLabels,
  gitStatusLabels,
  type GitAuthKind,
  type GitCatalogEntry,
  type GitConnection,
  type GitConnectionDraft,
  type GitProviderKind,
  type GitTransport,
} from "./git-connections-state";

type PagePayload = Readonly<{ connections: GitConnection[]; catalog: GitCatalogEntry[] }>;
type OwnerDelegation = Readonly<{
  id: string;
  project: Readonly<{ id: string; name: string; archivedAt: string | null }>;
  connection: Readonly<{ id: string; name: string; providerKind: string; transport: string; status: string; ownershipState: string }>;
  scope: Readonly<{ repositoryPath: string; trackedRef: string; manualSyncAllowed: boolean; automationAllowed: boolean }>;
  status: "draft" | "ownerConfirmed" | "active";
  version: number;
  expiresAt: string;
  capabilities: Readonly<{ canReject: boolean; canRevoke: boolean }>;
}>;
type OwnerDelegationPayload = Readonly<{ delegations: readonly OwnerDelegation[] }>;

const statusStyles: Record<GitConnection["status"], string> = {
  configured: "bg-amber-50 text-amber-700 ring-amber-200",
  verified: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-rose-50 text-rose-700 ring-rose-200",
  disabled: "bg-slate-100 text-slate-600 ring-slate-200",
};

async function readSafeConnectionError(response: Response, fallback: string): Promise<ConnectionRequestError> {
  const safe = await safeResponseError(response, fallback);
  return new ConnectionRequestError(safe.message, safe.code ?? "CONNECTION_REQUEST_FAILED", response.status);
}

export function GitConnectionsClient() {
  const t = useTranslate();

  const [connections, setConnections] = useState<GitConnection[]>([]);
  const [catalog, setCatalog] = useState<GitCatalogEntry[]>([]);
  const [ownerDelegations, setOwnerDelegations] = useState<readonly OwnerDelegation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ownerDelegationsLoading, setOwnerDelegationsLoading] = useState(true);
  const [ownerDelegationsError, setOwnerDelegationsError] = useState<string | null>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<GitConnection["status"] | "all">("all");

  const filteredConnections = connections.filter((connection) => {
    const query = search.trim().toLocaleLowerCase();
    const searchable = `${connection.name} ${connection.baseUrl} ${gitProviderLabels[connection.providerKind]}`.toLocaleLowerCase();
    return (query === "" || searchable.includes(query)) && (statusFilter === "all" || connection.status === statusFilter);
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/me/git-connections", { cache: "no-store" });
      if (!response.ok) throw await readSafeConnectionError(response, "个人 Git 连接加载失败");
      const payload = await response.json() as PagePayload;
      setConnections(payload.connections);
      setCatalog(payload.catalog);
      setLoadError(null);
    } catch (error) {
      setLoadError(connectionErrorText(error, "个人 Git 连接加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOwnerDelegations = useCallback(async () => {
    setOwnerDelegationsLoading(true);
    try {
      const response = await fetch("/api/me/git-delegations", { cache: "no-store" });
      if (!response.ok) throw await readSafeConnectionError(response, "项目委托安全记录加载失败");
      const payload = await response.json() as OwnerDelegationPayload;
      setOwnerDelegations(payload.delegations);
      setOwnerDelegationsError(null);
    } catch (error) {
      setOwnerDelegationsError(connectionErrorText(error, "项目委托安全记录加载失败"));
    } finally { setOwnerDelegationsLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); void loadOwnerDelegations(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, loadOwnerDelegations]);

  return (
    <div data-page-content className={styles.content}>
      <div className="mb-4">
        <ParentPageLink href="/personal/configuration" label="返回我的空间配置" />
      </div>

      <section className={listStyles.pageHeader}>
        <div className="min-w-0">
          <h1 className={listStyles.pageTitle}><UiText text={"Git 授权管理"} /></h1>
          <p className={listStyles.description}><UiText text={"Git 凭据由你个人持有并加密保存。项目代码仓库从项目配置发起连接和范围提案；此处用于维护个人连接、查看受影响项目，并撤销或拒绝项目授权。"} /></p>
        </div>
        <button type="button" disabled={loading || catalog.length === 0} onClick={() => setCreateOpen(true)} className={listStyles.primaryAction}><UiText text={"添加 Git 服务"} /></button>
      </section>

      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-5 rounded-2xl px-4 py-3 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-700" : message.tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}><UiFeedbackText text={message.text} /></p> : null}
      {loadError ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span><UiErrorText text={loadError} /></span><button type="button" onClick={() => void load()} className="min-h-10 font-semibold underline"><UiText text={"重试"} /></button></div> : null}

      {createOpen ? <ConnectionCreateDialog title={t("添加 Git 服务")} onClose={() => setCreateOpen(false)}><GitCreateForm catalog={catalog} onCreated={(connection) => { setConnections((current) => [...current, connection]); setCreateOpen(false); setMessage({ tone: "success", text: "Git 连接已保存。" }); }} /></ConnectionCreateDialog> : null}
      <section className={`${listStyles.section} mt-6`}>
        <header className={listStyles.sectionHeader}>
          <div><h2 className={listStyles.sectionTitle}><UiText text={"已有连接"} /></h2><p className={listStyles.sectionDescription}><UiText text={"只显示地址、状态与密钥掩码，不显示完整秘密。"} /></p></div>
          <span className={listStyles.count}>{loading ? t("读取中…") : `${filteredConnections.length}${t(" 条")}`}</span>
        </header>
        <div className={listStyles.filters}>
          <label><span className="sr-only">{t("搜索")}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("搜索")} className={listStyles.filterInput} /></label>
          <label><span className="sr-only"><UiText text={"状态"} /></span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as GitConnection["status"] | "all")} className={listStyles.filterSelect}><option value="all"><UiText text={"全部状态"} /></option>{Object.entries(gitStatusLabels).map(([value, label]) => <option key={value} value={value}><UiText text={label} /></option>)}</select></label>
        </div>
        {loading ? <div className="px-5 pb-5" role="status" aria-label={t("正在加载 Git 连接")}><div className="h-20 animate-pulse rounded-md bg-slate-100" /></div> : connections.length === 0 ? <div className={listStyles.emptyState}><p className="font-semibold"><UiText text={"还没有个人 Git 连接"} /></p><p className="mt-2"><UiText text={"点击“添加服务”，先测试指定仓库和 ref，确认结果后再保存。"} /></p></div> : filteredConnections.length === 0 ? <div className={listStyles.emptyState}><UiText text={"没有找到匹配的内容。"} /></div> : filteredConnections.map((connection) => <GitConnectionCard key={connection.id} connection={connection} catalog={catalog} onRemoved={() => { setConnections((current) => current.filter((item) => item.id !== connection.id)); setMessage({ tone: "success", text: "Git 连接已删除。" }); }} onReload={load} />)}
      </section>

      <section className={`${listStyles.delegationSection} mt-6`}>
        <header className={listStyles.sectionHeader}>
          <div><h2 className={listStyles.sectionTitle}><UiText text={"项目委托安全管理"} /></h2><p className={listStyles.sectionDescription}><UiText text={"这里列出你作为连接所有者的未终态委托。即使你已失去项目访问，或项目已归档，仍可撤销后续使用或拒绝尚未生效的委托。"} /></p></div>
          <span className={listStyles.count}>{ownerDelegationsLoading ? t("读取中…") : `${ownerDelegations.length}${t(" 条")}`}</span>
        </header>
        {ownerDelegationsError ? <div role="alert" className="mx-5 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-rose-50 px-4 py-3 text-xs text-rose-700"><span><UiErrorText text={ownerDelegationsError} /></span><button type="button" onClick={() => void loadOwnerDelegations()} className="min-h-10 font-semibold underline"><UiText text={"重试"} /></button></div> : null}
        {ownerDelegationsLoading ? <div className="mx-5 mb-5 h-20 animate-pulse rounded-md bg-slate-100" role="status" aria-label={t("正在加载项目委托安全记录")} /> : ownerDelegations.length === 0 && ownerDelegationsError === null ? <div className={listStyles.emptyState}><UiText text={"当前没有需要你处理的项目委托安全记录。"} /></div> : <div className="grid gap-3 p-4 sm:p-5 lg:grid-cols-2">{ownerDelegations.map((delegation) => <OwnerDelegationCard key={delegation.id} delegation={delegation} onReload={loadOwnerDelegations} onMessage={setMessage} />)}</div>}
      </section>

      <aside className={listStyles.boundaryNote}>
        <p className={listStyles.boundaryTitle}><UiText text={"当前使用边界"} /></p>
        <p><UiText text={"个人连接不会自动开放给任何项目。项目页支持一次性手动只读委托和单独的自动读取双确认授权；写入/提交和旧 PAT 路径保持关闭。新建连接会先测试指定仓库和 ref；后续变更仍必须通过安全影响预览。"} /></p>
      </aside>
    </div>
  );
}

function OwnerDelegationCard({ delegation, onReload, onMessage }: { delegation: OwnerDelegation; onReload: () => Promise<void>; onMessage: (message: ConnectionMessage) => void }) {
  const t = useTranslate();
  const { language } = useAppearance();
  const { confirm, dialog } = useAppConfirmDialog();
  const [pending, setPending] = useState<"rejection" | "revocation" | null>(null);
  const statusLabel = t(delegation.status === "draft" ? "待确认" : delegation.status === "ownerConfirmed" ? "待项目 Owner 确认" : "已启用手动读取");

  async function terminal(action: "rejection" | "revocation") {
    const result = await confirm({
      eyebrow: t(action === "rejection" ? "拒绝项目委托" : "撤销项目委托"),
      title: t(action === "rejection" ? "拒绝这项委托？" : "撤销这项委托？"),
      description: t(action === "rejection" ? "拒绝会阻止这项尚未完成的委托继续确认。请填写原因。" : "撤销会停止后续手动读取；已经发出的外部读取不能撤回。请填写原因。"),
      confirmLabel: t(action === "rejection" ? "确认拒绝" : "确认撤销"),
      cancelLabel: t("返回"),
      tone: "danger",
      inputLabel: t("原因"),
      inputPlaceholder: t("例如：仓库范围需要调整"),
      inputOptional: false,
      maxLength: 500,
    });
    if (!result.confirmed) return;
    setPending(action);
    try {
      const response = await fetch(`/api/projects/${delegation.project.id}/git-repository-delegations/${delegation.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: delegation.version, reason: result.value.trim() }),
      });
      if (!response.ok) throw await readSafeConnectionError(response, action === "rejection" ? "拒绝委托失败" : "撤销委托失败");
      onMessage({ tone: "success", text: action === "rejection" ? "项目委托已拒绝。" : "项目委托已撤销。" });
      await onReload();
    } catch (error) {
      onMessage({ tone: "error", text: connectionErrorText(error, action === "rejection" ? "拒绝委托失败" : "撤销委托失败") });
    } finally { setPending(null); }
  }

  return <article className={listStyles.delegationCard}>{dialog}<div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-sm font-semibold text-slate-900">{delegation.project.name}</h3><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[12px] font-semibold text-slate-600">{statusLabel}</span>{delegation.project.archivedAt ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[12px] font-semibold text-amber-800"><UiText text={"项目已归档"} /></span> : null}</div><p className="mt-2 break-all text-xs text-slate-500">{delegation.connection.name} · {delegation.connection.providerKind} · {delegation.connection.transport.toUpperCase()}</p><p className="mt-1 break-all text-xs text-slate-500">{delegation.scope.repositoryPath} · {delegation.scope.trackedRef}</p></div><div className="shrink-0 text-right text-xs text-slate-400"><p><UiText text={"版本 "} />{delegation.version}</p><p className="mt-1"><UiText text={"有效至 "} />{formatConnectionDate(delegation.expiresAt, language)}</p></div></div><div className="mt-3 flex flex-wrap gap-2 text-[12px] text-slate-700"><span>{t(delegation.scope.manualSyncAllowed && !delegation.scope.automationAllowed ? "一次性手动只读" : "受限范围")}</span><span aria-hidden="true">·</span><span>{t(delegation.scope.automationAllowed ? "自动化范围需单独开放" : "自动化关闭")}</span></div><div className="mt-4 flex flex-wrap gap-2">{delegation.capabilities.canReject ? <button type="button" onClick={() => void terminal("rejection")} disabled={pending !== null} className={`${connectionButtonClass} min-h-11 text-rose-700 hover:bg-rose-50`}>{pending === "rejection" ? t("处理中…") : t("拒绝委托")}</button> : null}{delegation.capabilities.canRevoke ? <button type="button" onClick={() => void terminal("revocation")} disabled={pending !== null} className={`${connectionButtonClass} min-h-11 text-rose-700 hover:bg-rose-50`}>{pending === "revocation" ? t("处理中…") : t("撤销委托")}</button> : null}</div></article>;
}

export function GitCreateForm({ catalog, onCreated, onProjectSaved, initialRepositoryPath, initialTrackedRef, requireCredential = false, editing, onEdited }: {
  catalog: readonly GitCatalogEntry[];
  onCreated?: (connection: GitConnection) => void;
  onProjectSaved?: (result: Readonly<{ connectionId: string; repositoryPath: string; trackedRef: string }>) => Promise<void>;
  initialRepositoryPath?: string;
  initialTrackedRef?: string;
  requireCredential?: boolean;
  editing?: GitConnection;
  onEdited?: () => void;
}) {
  const t = useTranslate();
  const { language } = useAppearance();

  const { confirm, dialog } = useAppConfirmDialog();
  const [draft, setDraft] = useState<GitConnectionDraft>(() => editing ? {
    name: editing.name, providerKind: editing.providerKind, transport: editing.transport, baseUrl: editing.baseUrl,
    authKind: editing.authKind, username: editing.username ?? "", secret: "", repositoryPath: "",
    trackedRef: "main", allowPrivateNetwork: editing.allowPrivateNetwork,
    tlsCaCertificate: editing.tlsCaCertificate ?? "", sshKnownHost: editing.sshKnownHost ?? "",
  } : { ...createDefaultGitDraft(catalog), repositoryPath: initialRepositoryPath ?? "", trackedRef: initialTrackedRef ?? "main" });
  const [pending, setPending] = useState<"testing" | "saving" | null>(null);
  const [testedProbe, setTestedProbe] = useState<Readonly<{ draftProbeId: string; createRequestKey: string; repositoryPath: string; trackedRef: string; testedAt: string; commitSha: string | null } | null>>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);
  const selected = catalog.find((entry) => entry.kind === draft.providerKind);

  function setValue<K extends keyof GitConnectionDraft>(key: K, value: GitConnectionDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setTestedProbe(null);
  }

  function chooseProvider(value: GitProviderKind) {
    const entry = catalog.find((item) => item.kind === value);
    setDraft((current) => ({ ...current, providerKind: value, baseUrl: entry ? (current.transport === "ssh" ? entry.defaultSshUrl : entry.defaultHttpsUrl) : current.baseUrl }));
    setTestedProbe(null);
  }

  function chooseTransport(value: GitTransport) {
    const entry = catalog.find((item) => item.kind === draft.providerKind);
    setDraft((current) => ({ ...current, transport: value, authKind: value === "ssh" ? "sshKey" : current.authKind === "sshKey" ? "token" : current.authKind, baseUrl: entry ? (value === "ssh" ? entry.defaultSshUrl : entry.defaultHttpsUrl) : current.baseUrl, tlsCaCertificate: value === "ssh" ? "" : current.tlsCaCertificate, sshKnownHost: value === "ssh" ? current.sshKnownHost : "" }));
    setTestedProbe(null);
  }

  function buildDraftInput(createRequestKey: string) {
    const secret = draft.secret.trim();
    return { name: draft.name, providerKind: draft.providerKind, transport: draft.transport, baseUrl: draft.baseUrl, authKind: draft.authKind, username: draft.username.trim() || null, secret: draft.authKind === "none" ? null : secret, allowPrivateNetwork: draft.allowPrivateNetwork, tlsCaCertificate: draft.transport === "https" ? draft.tlsCaCertificate || null : null, sshKnownHost: draft.transport === "ssh" ? draft.sshKnownHost || null : null, repositoryPath: draft.repositoryPath.trim(), trackedRef: draft.trackedRef.trim(), clientRequestKey: createRequestKey };
  }

  function editCandidate(draftInput: ReturnType<typeof buildDraftInput>) {
    const { name: _name, clientRequestKey: _key, ...candidate } = draftInput;
    void _name; void _key;
    return candidate;
  }

  async function testConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending !== null) return;
    setMessage(null);
    const secret = draft.secret.trim();
    if (requireCredential && draft.authKind === "none") {
      setMessage({ tone: "error", text: "项目仓库读取需要只读凭据，请选择 Token、Basic 或 SSH Key。" });
      return;
    }
    if ((draft.authKind === "none") !== (secret.length === 0)) {
      setMessage({ tone: "error", text: draft.authKind === "none" ? "无凭据连接不能填写秘密。" : "当前认证方式需要填写凭据。" });
      return;
    }
    setPending("testing");
    try {
      const createRequestKey = globalThis.crypto.randomUUID();
      const draftInput = buildDraftInput(createRequestKey);
      const probeResponse = await fetch(editing ? `/api/me/git-connections/${encodeURIComponent(editing.id)}/probe` : "/api/me/git-connections/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(editing ? { clientRequestKey: createRequestKey, expectedUpdatedAt: editing.updatedAt, repositoryPath: draftInput.repositoryPath, trackedRef: draftInput.trackedRef, candidate: editCandidate(draftInput) } : draftInput) });
      if (!probeResponse.ok) throw await readSafeConnectionError(probeResponse, "Git 连接测试失败");
      const probe = (await probeResponse.json() as { probe: { draftProbeId: string | null; createRequestKey: string; status: string; safeErrorCode: string | null; result: { commitSha: string | null } } }).probe;
      if (probe.status !== "settled" || probe.draftProbeId === null || probe.createRequestKey !== createRequestKey) {
        throw new ConnectionRequestError(probe.safeErrorCode ? `Git 连接测试失败：${probe.safeErrorCode}` : "Git 连接测试未通过，请检查仓库路径、ref 和凭据。", probe.safeErrorCode ?? "GIT_CONNECTION_PROBE_FAILED", 409);
      }
      setTestedProbe({ draftProbeId: probe.draftProbeId, createRequestKey, repositoryPath: draftInput.repositoryPath, trackedRef: draftInput.trackedRef, testedAt: new Date().toISOString(), commitSha: probe.result.commitSha });
      setMessage({ tone: "success", text: "连接测试成功。请核对下方目标与提交，再点击“保存连接”。" });
    } catch (error) {
      setTestedProbe(null);
      setMessage({ tone: "error", text: connectionErrorText(error, "Git 连接测试失败") });
    } finally { setPending(null); }
  }

  async function saveConnection() {
    if (pending !== null || testedProbe === null) return;
    setPending("saving"); setMessage(null);
    try {
      if (editing) {
        const candidate = editCandidate(buildDraftInput(testedProbe.createRequestKey));
        const base = `/api/me/git-connections/${encodeURIComponent(editing.id)}/governance`;
        const intent = { action: "retest", reason: "编辑 Git 连接地址或认证并重新测试", requestKey: crypto.randomUUID(), expectedUpdatedAt: editing.updatedAt, draftProbeId: testedProbe.draftProbeId, probeRequestKey: testedProbe.createRequestKey, repositoryPath: testedProbe.repositoryPath, trackedRef: testedProbe.trackedRef, candidate };
        const previewResponse = await fetch(`${base}/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intent) });
        if (!previewResponse.ok) throw await readSafeConnectionError(previewResponse, "连接影响预览失败");
        const preview = (await previewResponse.json() as { preview: { id: string; requestKey: string; requestFingerprint: string; impactFingerprint: string; blockers: string[]; canExecute: boolean } }).preview;
        if (!preview.canExecute) throw new ConnectionRequestError(`${t("请先处理连接影响：")}${connectionBlockerText(preview.blockers, t)}`, "GIT_CONNECTION_IN_USE", 409);
        const approval = await confirm({ eyebrow: t("连接配置变更"), title: t("保存已测试的新配置？"), description: t("旧项目委托必须先撤销。保存会更新连接配置版本，之后需要在项目中重新授权。"), confirmLabel: t("保存新配置"), cancelLabel: t("返回检查") });
        if (!approval.confirmed) return;
        const executeResponse = await fetch(`${base}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ previewId: preview.id, requestKey: preview.requestKey, requestFingerprint: preview.requestFingerprint, impactFingerprint: preview.impactFingerprint, expectedUpdatedAt: editing.updatedAt, draftProbeId: testedProbe.draftProbeId, probeRequestKey: testedProbe.createRequestKey, repositoryPath: testedProbe.repositoryPath, trackedRef: testedProbe.trackedRef, candidate }) });
        if (!executeResponse.ok) throw await readSafeConnectionError(executeResponse, "连接配置保存失败");
        onEdited?.();
        return;
      }
      const createInput = buildDraftInput(testedProbe.createRequestKey);
      const response = await fetch("/api/me/git-connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...createInput, clientRequestKey: undefined, draftProbeId: testedProbe.draftProbeId, createRequestKey: testedProbe.createRequestKey }) });
      if (!response.ok) throw await readSafeConnectionError(response, "Git 连接保存失败");
      const connection = (await response.json() as { connection: GitConnection }).connection;
      setDraft(createDefaultGitDraft(catalog));
      setTestedProbe(null);
      if (onProjectSaved) {
        const result = { connectionId: connection.id, repositoryPath: testedProbe.repositoryPath, trackedRef: testedProbe.trackedRef };
        setMessage({ tone: "success", text: "Git 连接已保存，正在核验项目可用连接…" });
        try {
          await onProjectSaved(result);
        } catch {
          setMessage({ tone: "error", text: "Git 连接已保存，但项目连接列表刷新失败。请在项目页面重试核验。" });
        }
      } else {
        onCreated?.(connection);
        setMessage({ tone: "success", text: "已完成 Git 仓库只读测试并加密保存。密钥输入框已清空；后续变更请在连接卡片中通过安全治理预览管理。" });
      }
    } catch (error) {
      setMessage({ tone: "error", text: connectionErrorText(error, "Git 连接保存失败") });
    } finally { setPending(null); setDraft((current) => ({ ...current, secret: "" })); setTestedProbe(null); }
  }

  return <><section className="h-fit min-w-0 rounded-3xl border border-slate-200 bg-white p-5 sm:p-6"><div className="flex items-center gap-2"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">{editing ? t("Edit personal connection") : t("New personal connection")}</p><HelpTooltip label={t("Git 连接流程")}><UiText text={"填写连接信息 → 测试指定仓库和 ref → 核对测试结果后保存 → 在项目中单独完成授权。"} /></HelpTooltip></div><h2 className="mt-2 text-xl font-semibold">{t(editing ? "编辑 Git 地址与认证" : "添加 Git 服务")}</h2><p className="mt-2 text-xs leading-5 text-slate-600">{t(editing ? "地址或认证变化必须重新输入完整凭据、测试指定仓库和 ref，并通过授权影响预览。活动委托需先撤销；保存后在项目中重新授权。" : "所有登录用户都可以配置自己的连接，不受会员等级限制。先测试指定仓库和 ref，确认结果后再保存。")}</p>{requireCredential ? <p className="mt-2 text-xs leading-5 text-slate-600"><UiText text={"项目读取需要具有只读权限的凭据；无认证连接不能用于项目授权。"} /></p> : null}<form id="git-create-form" onSubmit={testConnection} className="mt-5 space-y-3"><Field label={t("连接名称")}><input className={connectionFieldClass} value={draft.name} onChange={(event) => setValue("name", event.target.value)} maxLength={80} placeholder={t("我的代码仓库")} disabled={editing !== undefined} required /></Field><Field label={t("服务类型")}><select className={connectionFieldClass} value={draft.providerKind} onChange={(event) => chooseProvider(event.target.value as GitProviderKind)}>{catalog.map((entry) => <option key={entry.kind} value={entry.kind}>{t(entry.label)}</option>)}{catalog.length === 0 ? <option value="github">GitHub</option> : null}</select></Field><div className="grid gap-3 sm:grid-cols-2"><Field label={t("传输")}><select className={connectionFieldClass} value={draft.transport} onChange={(event) => chooseTransport(event.target.value as GitTransport)}><option value="https">HTTPS</option><option value="ssh">SSH</option></select></Field><Field label={t("认证方式")}><select className={connectionFieldClass} value={draft.authKind} onChange={(event) => setValue("authKind", event.target.value as GitAuthKind)}>{!requireCredential ? <option value="none"><UiText text={"无认证"} /></option> : null}{draft.transport === "https" ? <><option value="token">Token</option><option value="basic">Basic</option></> : <option value="sshKey">SSH Key</option>}</select></Field></div><Field label={t("服务地址")}><input className={connectionFieldClass} value={draft.baseUrl} onChange={(event) => setValue("baseUrl", event.target.value)} placeholder={selected?.defaultHttpsUrl ?? "https://git.example.com"} required /></Field><div className="grid gap-3 sm:grid-cols-2"><Field label={t("仓库路径")}><input className={connectionFieldClass} value={draft.repositoryPath} onChange={(event) => setValue("repositoryPath", event.target.value)} placeholder="owner/repository" required /></Field><Field label={t("测试分支或 ref")}><input className={connectionFieldClass} value={draft.trackedRef} onChange={(event) => setValue("trackedRef", event.target.value)} placeholder="main" required /></Field></div>{draft.authKind !== "none" ? <div className="grid gap-3 sm:grid-cols-2"><Field label={t("用户名（可选）")}><input className={connectionFieldClass} value={draft.username} onChange={(event) => setValue("username", event.target.value)} maxLength={128} placeholder={draft.transport === "ssh" ? "git" : "x-access-token"} /></Field><Field label={t(draft.transport === "ssh" ? "私钥 / 凭据" : "Token 或密码")}><input type="password" autoComplete="new-password" className={connectionFieldClass} value={draft.secret} onChange={(event) => setValue("secret", event.target.value)} minLength={1} maxLength={24000} required /></Field></div> : null}<details open className="rounded-2xl border border-slate-200/80 bg-white/70 p-3"><summary className="cursor-pointer text-xs font-semibold text-slate-700"><UiText text={"高级网络安全设置"} /></summary><div className="mt-3 space-y-3"><label className="flex items-start gap-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900"><input type="checkbox" checked={draft.allowPrivateNetwork} onChange={(event) => setValue("allowPrivateNetwork", event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span><strong className="block"><UiText text={"允许受信内网地址"} /></strong><span><UiText text={"只对你明确管理的服务开启；云元数据地址仍会被禁止。"} /></span></span></label>{draft.transport === "https" ? <Field label={t("自定义 CA（可选）")}><textarea className={`${connectionFieldClass} min-h-24 font-mono text-xs`} value={draft.tlsCaCertificate} onChange={(event) => setValue("tlsCaCertificate", event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" /></Field> : <Field label={t("SSH known_hosts 记录")}><input className={`${connectionFieldClass} font-mono text-xs`} value={draft.sshKnownHost} onChange={(event) => setValue("sshKnownHost", event.target.value)} placeholder="git.example.com ssh-ed25519 AAAA…" required /></Field>}</div></details>{testedProbe ? <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs leading-5 text-emerald-800"><p className="font-semibold"><UiText text={"测试成功 · "} />{formatConnectionDate(testedProbe.testedAt, language)}</p><p className="mt-1 break-all"><UiText text={"目标："} />{testedProbe.repositoryPath} @ {testedProbe.trackedRef}</p><p className="mt-1"><UiText text={"ref 提交："} /><span className="font-mono">{testedProbe.commitSha ?? "已响应"}</span></p></div> : null}{message ? <p role={message.tone === "error" ? "alert" : "status"} className={`text-xs leading-5 ${message.tone === "error" ? "text-rose-700" : message.tone === "success" ? "text-emerald-700" : "text-slate-600"}`}><UiFeedbackText text={message.text} /></p> : null}<ConnectionDialogActions><div className="flex w-full flex-wrap gap-2"><button type="submit" form="git-create-form" disabled={pending !== null} className={`${connectionButtonClass} ${styles.primaryAction} min-h-11 flex-1 px-4 text-sm text-white`}>{pending === "testing" ? t("测试中…") : testedProbe ? t("重新测试连接") : t("测试连接")}</button>{testedProbe ? <button type="button" onClick={() => void saveConnection()} disabled={pending !== null} className={`${connectionButtonClass} ${styles.secondaryAction} min-h-11 flex-1 border border-slate-300 bg-white px-4 text-sm text-slate-800`}>{pending === "saving" ? t("保存中…") : editing ? t("保存新配置") : t("保存连接")}</button> : null}</div></ConnectionDialogActions></form><p className="mt-4 text-[12px] leading-5 text-slate-700"><UiText text={"公网默认 HTTPS；开启内网、上传 CA 或配置 known_hosts 前，请确认目标服务与网络边界。"} /></p></section>{dialog}</>;
}

function GitConnectionCard({ connection, catalog, onRemoved, onReload }: { connection: GitConnection; catalog: readonly GitCatalogEntry[]; onRemoved: () => void; onReload: () => Promise<void> }) {
  const t = useTranslate();
  const { language } = useAppearance();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);

  function closeDetails() {
    setDetailsOpen(false);
    setEditing(false);
    setEditingConfig(false);
  }

  return <>
    <article className={listStyles.connectionRow}>
      <div className={listStyles.connectionIdentity}>
        <div className={listStyles.connectionNameLine}>
          <h3 className={listStyles.connectionName}>{connection.name}</h3>
          <span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ring-1 ${statusStyles[connection.status]}`}>{t(gitStatusLabels[connection.status])}</span>
        </div>
        <p className={listStyles.connectionAddress}>{t(gitProviderLabels[connection.providerKind])} · {connection.transport.toUpperCase()} · {connection.baseUrl}</p>
      </div>
      <div className={listStyles.connectionMeta}>
        <p>{connection.authKind === "none" ? t("无凭据") : `${t(gitAuthKindLabels[connection.authKind])} (${t("已加密")})`}</p>
        <p><UiText text={"更新于 "} />{formatConnectionDate(connection.updatedAt, language)}</p>
      </div>
      <button type="button" onClick={() => setDetailsOpen(true)} className={listStyles.manageAction}><UiText text={"安全管理"} /></button>
    </article>

    <WorkspaceDialog title={`${t("管理 ")}${connection.name}${t(" 的连接安全")}`} open={detailsOpen} drawer onClose={closeDetails}>
      <div className={listStyles.details}>
        <p className="text-sm leading-6 text-slate-600"><UiText text={"连接状态与影响范围在详情中查看；凭据轮换、启停、删除和重新测试须在这里先预览再确认。"} /></p>
        {connection.lastErrorCode ? <p role="status" className="break-words rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700"><UiText text={"最近错误："} />{connection.lastErrorCode}<UiText text={"。请通过安全治理预览管理后续变更；重新测试会先执行一次只读 ls-remote，再继续影响预览。"} /></p> : null}
        <dl className="grid gap-3 text-xs text-slate-600 sm:grid-cols-2">
          <div><dt className="text-slate-400"><UiText text={"最近测试"} /></dt><dd className="mt-1 font-medium">{formatConnectionDate(connection.lastTestedAt, language)}</dd></div>
          <div><dt className="text-slate-400"><UiText text={"内网访问"} /></dt><dd className="mt-1 font-medium">{t(connection.allowPrivateNetwork ? "已显式允许" : "禁止")}</dd></div>
          <div><dt className="text-slate-400"><UiText text={"认证方式"} /></dt><dd className="mt-1 font-medium">{connection.authKind === "none" ? t("无凭据") : `${t(gitAuthKindLabels[connection.authKind])} (${t("已加密")})`}</dd></div>
        </dl>
        <ScopeEvidenceCard title={t("个人 Git 连接边界")} evidence={{ scope: t("个人连接"), owner: t("当前账户"), payer: t("不适用（Git 连接不产生平台模型费用）"), affectedProjects: t("尚未取得项目委托证据；仅按当前账户的项目权限与明确委托判断，不以仓库数量代替项目影响"), latestSuccess: connection.lastTestedAt ? `${t("最近测试：")}${formatConnectionDate(connection.lastTestedAt, language)}` : t("尚未完成连接测试") }} />
        <p className="text-xs leading-5 text-slate-500"><UiText text={"费用承担者为连接所有者；第三方费用由其与服务商约定，平台不代扣，也不计入项目平台额度。"} /></p>
        {connection.status === "disabled" ? <p className="rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600"><UiText text={"连接已停用；重新启用后必须重新测试。重新测试会先执行一次只读 ls-remote，再继续影响预览。"} /></p> : null}
        <div className={listStyles.detailsActions}>
          <button type="button" onClick={() => setEditing(true)} className={listStyles.editAction}><UiText text={"编辑名称"} /></button>
          <button type="button" onClick={() => setEditingConfig(true)} className={listStyles.editAction}><UiText text={"编辑地址与认证"} /></button>
        </div>
        <ConnectionGovernancePanel kind="git" connection={{ id: connection.id, name: connection.name, status: connection.status, updatedAt: connection.updatedAt, authKind: connection.authKind, recoveryState: connection.recoveryState }} onReload={onReload} onRemoved={onRemoved} />
      </div>
      {editing ? <ConnectionEditDialog kind="git" connection={connection} onClose={() => setEditing(false)} onSaved={() => void onReload()} /> : null}
      {editingConfig ? <ConnectionCreateDialog title={t("编辑 Git 地址与认证")} onClose={() => setEditingConfig(false)}><GitCreateForm catalog={catalog} editing={connection} onEdited={() => { setEditingConfig(false); void onReload(); }} /></ConnectionCreateDialog> : null}
    </WorkspaceDialog>
  </>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const t = useTranslate();
  const help = label === t("服务地址")
    ? "HTTPS 示例：https://git.example.com；SSH 示例：ssh://git@git.example.com。这里是占位格式，请换成你管理的服务地址。连接测试还需要指定有读取权限的仓库和 ref。"
    : label.includes(t("Token")) || label.includes(t("私钥"))
      ? "从自己的 Git 服务创建只读凭据，粘贴在这里。示例不会提供可用密钥；请勿把凭据放入 URL。"
      : label.includes(t("仓库路径"))
        ? "示例：owner/repository。请填写当前凭据确实可以读取的仓库路径，测试只读取指定分支 ref。"
        : label.includes(t("测试分支"))
          ? "示例：main 或 refs/heads/main。系统会规范化为分支名并执行 git ls-remote，只读取该 ref。"
      : label.includes("known_hosts")
        ? "示例格式：git.example.com ssh-ed25519 AAAA…。必须通过可信渠道核实服务器主机密钥，不能直接复制占位值。"
        : label.includes("CA")
          ? "仅在自建服务使用可信私有 CA 时填写 PEM 证书；公网官方服务通常留空。"
          : label === t("认证方式") || label === t("传输")
            ? "按服务提供的 HTTPS 或 SSH 接入方式选择，并使用对应的只读认证方式。"
            : null;
  return <div className="min-w-0"><div className="mb-1.5 flex items-center gap-1"><span className="text-xs font-semibold text-slate-700">{label}</span>{help ? <HelpTooltip label={label}>{t(help)}</HelpTooltip> : null}</div><label className="block"><span className="sr-only">{label}</span>{children}</label></div>;
}
