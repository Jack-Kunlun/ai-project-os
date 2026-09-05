"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import {
  connectionButtonClass,
  connectionErrorText,
  connectionFieldClass,
  type ConnectionMessage,
  formatConnectionDate,
  isConnectionConflict,
  readConnectionError,
} from "../connection-ui";
import {
  createDefaultGitDraft,
  createGitEditDraft,
  gitCredentialLabel,
  gitProviderLabels,
  gitStatusLabels,
  type GitAuthKind,
  type GitCatalogEntry,
  type GitConnection,
  type GitConnectionDraft,
  type GitEditDraft,
  type GitProviderKind,
  type GitTransport,
} from "./git-connections-state";

type PagePayload = Readonly<{ connections: GitConnection[]; catalog: GitCatalogEntry[] }>;

const statusStyles: Record<GitConnection["status"], string> = {
  configured: "bg-amber-50 text-amber-700 ring-amber-200",
  verified: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-rose-50 text-rose-700 ring-rose-200",
  disabled: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function GitConnectionsClient() {
  const [connections, setConnections] = useState<GitConnection[]>([]);
  const [catalog, setCatalog] = useState<GitCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/me/git-connections", { cache: "no-store" });
      if (!response.ok) throw await readConnectionError(response, "个人 Git 连接加载失败");
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

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl px-5 pb-16 pt-7 sm:px-8 lg:px-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/profile" className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"><span aria-hidden="true">←</span> 返回个人中心</Link>
        <span className="text-xs text-slate-400">个人设置 / 我的连接 / Git</span>
      </div>

      <section className="mt-6 rounded-3xl border border-slate-200/80 bg-white p-6 shadow-sm sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">My Git connections</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">我的 Git 连接</h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">连接只属于当前账户，凭据会在服务端加密保存。你可以在这里测试自己有权限访问的仓库，但不会把连接自动共享给任何项目。</p>
          </div>
          <div className="rounded-2xl bg-indigo-50 px-4 py-3 text-sm text-indigo-900 lg:max-w-xs">
            <p className="font-semibold">当前使用边界</p>
            <p className="mt-1 text-xs leading-5">项目委托开发中，当前连接不能用于项目/自动化。请不要在项目页寻找或复制这条连接。</p>
          </div>
        </div>
      </section>

      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-5 rounded-2xl px-4 py-3 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-700" : message.tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>{message.text}</p> : null}
      {loadError ? <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><span>{loadError}</span><button type="button" onClick={() => void load()} className="min-h-10 font-semibold underline">重试</button></div> : null}

      <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(280px,.78fr)_minmax(0,1.22fr)]">
        <GitCreateForm catalog={catalog} onCreated={(connection) => { setConnections((current) => [...current, connection]); setMessage({ tone: "success", text: "Git 连接已保存。请在连接卡片中填写仓库路径并测试。" }); }} />
        <section className="min-w-0 rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-xl font-semibold">已有连接</h2><p className="mt-1 text-xs leading-5 text-slate-500">只显示地址、状态与密钥掩码，不显示完整秘密。</p></div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{loading ? "读取中…" : `${connections.length} 个连接`}</span>
          </div>
          {loading ? <div className="mt-5 space-y-3" aria-label="正在加载 Git 连接"><div className="h-48 animate-pulse rounded-2xl bg-slate-100" /><div className="h-48 animate-pulse rounded-2xl bg-slate-100" /></div> : connections.length === 0 ? <div className="mt-5 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-5 py-9 text-center"><p className="text-sm font-semibold text-slate-700">还没有个人 Git 连接</p><p className="mt-2 text-xs leading-5 text-slate-500">从左侧添加一个连接，保存后先用只读探针确认仓库与分支。</p></div> : <div className="mt-5 space-y-4">{connections.map((connection) => <GitConnectionCard key={connection.id} connection={connection} onChanged={(next) => setConnections((current) => current.map((item) => item.id === next.id ? next : item))} onRemoved={(id) => { setConnections((current) => current.filter((item) => item.id !== id)); setMessage({ tone: "success", text: "Git 连接已删除。" }); }} onReload={load} />)}</div>}
        </section>
      </div>
    </div>
  );
}

function GitCreateForm({ catalog, onCreated }: { catalog: readonly GitCatalogEntry[]; onCreated: (connection: GitConnection) => void }) {
  const [draft, setDraft] = useState<GitConnectionDraft>(() => createDefaultGitDraft(catalog));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);
  const selected = catalog.find((entry) => entry.kind === draft.providerKind);

  function setValue<K extends keyof GitConnectionDraft>(key: K, value: GitConnectionDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function chooseProvider(value: GitProviderKind) {
    const entry = catalog.find((item) => item.kind === value);
    setDraft((current) => ({ ...current, providerKind: value, baseUrl: entry ? (current.transport === "ssh" ? entry.defaultSshUrl : entry.defaultHttpsUrl) : current.baseUrl }));
  }

  function chooseTransport(value: GitTransport) {
    const entry = catalog.find((item) => item.kind === draft.providerKind);
    setDraft((current) => ({ ...current, transport: value, authKind: value === "ssh" ? "sshKey" : current.authKind === "sshKey" ? "token" : current.authKind, baseUrl: entry ? (value === "ssh" ? entry.defaultSshUrl : entry.defaultHttpsUrl) : current.baseUrl, tlsCaCertificate: value === "ssh" ? "" : current.tlsCaCertificate, sshKnownHost: value === "ssh" ? current.sshKnownHost : "" }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    const secret = draft.secret.trim();
    if ((draft.authKind === "none") !== (secret.length === 0)) {
      setMessage({ tone: "error", text: draft.authKind === "none" ? "无凭据连接不能填写秘密。" : "当前认证方式需要填写凭据。" }); setPending(false); return;
    }
    try {
      const response = await fetch("/api/me/git-connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft.name, providerKind: draft.providerKind, transport: draft.transport, baseUrl: draft.baseUrl, authKind: draft.authKind, username: draft.username.trim() || null, secret: draft.authKind === "none" ? null : secret, allowPrivateNetwork: draft.allowPrivateNetwork, tlsCaCertificate: draft.transport === "https" ? draft.tlsCaCertificate || null : null, sshKnownHost: draft.transport === "ssh" ? draft.sshKnownHost || null : null }) });
      if (!response.ok) throw await readConnectionError(response, "Git 连接保存失败");
      const connection = (await response.json() as { connection: GitConnection }).connection;
      onCreated(connection);
      setDraft(createDefaultGitDraft(catalog));
      setMessage({ tone: "success", text: "已加密保存。密钥输入框已清空，请在卡片中测试连接。" });
    } catch (error) {
      setMessage({ tone: "error", text: connectionErrorText(error, "Git 连接保存失败") });
    } finally { setPending(false); setDraft((current) => ({ ...current, secret: "" })); }
  }

  return <section className="h-fit min-w-0 rounded-3xl border border-indigo-100 bg-indigo-50/40 p-5 shadow-sm sm:p-6"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">New personal connection</p><h2 className="mt-2 text-xl font-semibold">添加 Git 服务</h2><p className="mt-2 text-xs leading-5 text-slate-600">所有登录用户都可以配置自己的连接，不受会员等级限制。</p><form onSubmit={submit} className="mt-5 space-y-3"><Field label="连接名称"><input className={connectionFieldClass} value={draft.name} onChange={(event) => setValue("name", event.target.value)} maxLength={80} placeholder="我的代码仓库" required /></Field><Field label="服务类型"><select className={connectionFieldClass} value={draft.providerKind} onChange={(event) => chooseProvider(event.target.value as GitProviderKind)}>{catalog.map((entry) => <option key={entry.kind} value={entry.kind}>{entry.label}</option>)}{catalog.length === 0 ? <option value="github">GitHub</option> : null}</select></Field><div className="grid gap-3 sm:grid-cols-2"><Field label="传输"><select className={connectionFieldClass} value={draft.transport} onChange={(event) => chooseTransport(event.target.value as GitTransport)}><option value="https">HTTPS</option><option value="ssh">SSH</option></select></Field><Field label="认证方式"><select className={connectionFieldClass} value={draft.authKind} onChange={(event) => setValue("authKind", event.target.value as GitAuthKind)}><option value="none">无认证</option>{draft.transport === "https" ? <><option value="token">Token</option><option value="basic">Basic</option></> : <option value="sshKey">SSH Key</option>}</select></Field></div><Field label="服务地址"><input className={connectionFieldClass} value={draft.baseUrl} onChange={(event) => setValue("baseUrl", event.target.value)} placeholder={selected?.defaultHttpsUrl ?? "https://git.example.com"} required /></Field>{draft.authKind !== "none" ? <div className="grid gap-3 sm:grid-cols-2"><Field label="用户名（可选）"><input className={connectionFieldClass} value={draft.username} onChange={(event) => setValue("username", event.target.value)} maxLength={128} placeholder={draft.transport === "ssh" ? "git" : "x-access-token"} /></Field><Field label={draft.transport === "ssh" ? "私钥 / 凭据" : "Token 或密码"}><input type="password" autoComplete="new-password" className={connectionFieldClass} value={draft.secret} onChange={(event) => setValue("secret", event.target.value)} minLength={1} maxLength={24000} required /></Field></div> : null}<details className="rounded-2xl border border-slate-200/80 bg-white/70 p-3"><summary className="cursor-pointer text-xs font-semibold text-slate-700">高级网络安全设置</summary><div className="mt-3 space-y-3"><label className="flex items-start gap-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900"><input type="checkbox" checked={draft.allowPrivateNetwork} onChange={(event) => setValue("allowPrivateNetwork", event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span><strong className="block">允许受信内网地址</strong><span>只对你明确管理的服务开启；云元数据地址仍会被禁止。</span></span></label>{draft.transport === "https" ? <Field label="自定义 CA（可选）"><textarea className={`${connectionFieldClass} min-h-24 font-mono text-xs`} value={draft.tlsCaCertificate} onChange={(event) => setValue("tlsCaCertificate", event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" /></Field> : <Field label="SSH known_hosts 记录"><input className={`${connectionFieldClass} font-mono text-xs`} value={draft.sshKnownHost} onChange={(event) => setValue("sshKnownHost", event.target.value)} placeholder="git.example.com ssh-ed25519 AAAA…" required /></Field>}</div></details>{message ? <p role={message.tone === "error" ? "alert" : "status"} className={`text-xs leading-5 ${message.tone === "error" ? "text-rose-700" : "text-slate-600"}`}>{message.text}</p> : null}<button type="submit" disabled={pending} className={`${connectionButtonClass} min-h-11 w-full bg-slate-950 px-4 text-sm text-white hover:bg-indigo-700`}>{pending ? "加密保存中…" : "加密保存连接"}</button></form><p className="mt-4 text-[11px] leading-5 text-slate-500">公网默认 HTTPS；开启内网、上传 CA 或配置 known_hosts 前，请确认目标服务与网络边界。</p></section>;
}

function GitConnectionCard({ connection, onChanged, onRemoved, onReload }: { connection: GitConnection; onChanged: (connection: GitConnection) => void; onRemoved: (id: string) => void; onReload: () => Promise<void> }) {
  const { confirm, dialog } = useAppConfirmDialog();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<GitEditDraft>(() => createGitEditDraft(connection));
  const [repositoryPath, setRepositoryPath] = useState("");
  const [trackedRef, setTrackedRef] = useState("main");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<ConnectionMessage | null>(null);

  function resetEdit() { setEditing(false); setDraft(createGitEditDraft(connection)); }
  function setEditValue<K extends keyof GitEditDraft>(key: K, value: GitEditDraft[K]) { setDraft((current) => ({ ...current, [key]: value })); }

  async function failAndRefresh(error: unknown, fallback: string) {
    if (isConnectionConflict(error)) {
      await onReload();
      setMessage({ tone: "error", text: "连接状态已刷新，请重新打开编辑或重试。" });
      resetEdit();
    } else setMessage({ tone: "error", text: connectionErrorText(error, fallback) });
  }

  async function update(body: Record<string, unknown>, key: string, success: string): Promise<GitConnection | null> {
    setPending(key); setMessage(null);
    try {
      const response = await fetch(`/api/me/git-connections/${connection.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, expectedUpdatedAt: connection.updatedAt }) });
      if (!response.ok) throw await readConnectionError(response, "Git 连接更新失败");
      const next = (await response.json() as { connection: GitConnection }).connection;
      onChanged(next); setMessage({ tone: "success", text: success }); return next;
    } catch (error) { await failAndRefresh(error, "Git 连接更新失败"); return null; }
    finally { setPending(null); }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = await update({ name: draft.name, username: draft.username.trim() || null, ...(draft.secret ? { secret: draft.secret } : {}), allowPrivateNetwork: draft.allowPrivateNetwork, tlsCaCertificate: connection.transport === "https" ? draft.tlsCaCertificate || null : null, sshKnownHost: connection.transport === "ssh" ? draft.sshKnownHost || null : null }, "edit", draft.secret ? "配置与凭据已更新，请重新测试连接。" : "连接配置已更新，请重新测试连接。");
    setDraft((current) => ({ ...current, secret: "" }));
    if (next) resetEdit();
  }

  async function testConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending("test"); setMessage({ tone: "info", text: "正在执行只读仓库探针，不会扫描或写入仓库…" });
    try {
      const response = await fetch(`/api/me/git-connections/${connection.id}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryPath, trackedRef, expectedUpdatedAt: connection.updatedAt }) });
      if (!response.ok) throw await readConnectionError(response, "Git 连接测试失败");
      const payload = await response.json() as { connection: GitConnection; probe: { repositoryPath: string; trackedRef: string; commitSha: string } };
      onChanged(payload.connection); setMessage({ tone: "success", text: `测试通过：${payload.probe.repositoryPath} @ ${payload.probe.trackedRef}，已确认提交 ${payload.probe.commitSha.slice(0, 12)}…` });
    } catch (error) { await failAndRefresh(error, "Git 连接测试失败"); }
    finally { setPending(null); }
  }

  async function toggle() { await update({ enabled: connection.status === "disabled" }, "toggle", connection.status === "disabled" ? "连接已重新启用，请重新测试。" : "连接已停用；当前版本不会用于项目或自动化。",); }

  async function remove() {
    let current = connection;
    if (current.status !== "disabled" || current.disabledAt === null) {
      const disabled = await update({ enabled: false }, "disable-before-delete", "连接已停用，请继续确认删除。");
      if (!disabled) return;
      current = disabled;
    }
    const result = await confirm({ eyebrow: "Delete personal Git connection", title: `删除“${current.name}”？`, description: "删除会移除连接和加密凭据，且不可恢复；如果未来存在项目引用，服务端会拒绝删除。", inputLabel: `输入连接名称“${current.name}”以确认`, inputPlaceholder: current.name, requiredValue: current.name, confirmLabel: "确认删除", tone: "danger", maxLength: 80 });
    if (!result.confirmed) return;
    setPending("delete"); setMessage(null);
    try {
      const response = await fetch(`/api/me/git-connections/${current.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationName: result.value, expectedUpdatedAt: current.updatedAt }) });
      if (!response.ok) throw await readConnectionError(response, "Git 连接删除失败");
      onRemoved(current.id);
    } catch (error) { await failAndRefresh(error, "Git 连接删除失败"); }
    finally { setPending(null); }
  }

  return <article className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 sm:p-5">{dialog}<div className="flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex min-w-0 flex-wrap items-center gap-2"><h3 className="max-w-full break-words text-base font-semibold text-slate-900">{connection.name}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${statusStyles[connection.status]}`}>{gitStatusLabels[connection.status]}</span></div><p className="mt-2 break-all text-xs text-slate-500">{gitProviderLabels[connection.providerKind]} · {connection.transport.toUpperCase()} · {connection.baseUrl}</p></div><div className="shrink-0 text-right text-xs text-slate-400"><p>{connection.authKind === "none" ? "无凭据" : `${connection.authKind} ${gitCredentialLabel(connection)}`}</p><p className="mt-1">更新于 {formatConnectionDate(connection.updatedAt)}</p></div></div>{connection.lastErrorCode ? <p role="status" className="mt-3 break-words rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">最近错误：{connection.lastErrorCode}。修改安全配置或凭据后请重新测试。</p> : null}<dl className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3"><div><dt className="text-slate-400">最近测试</dt><dd className="mt-1 font-medium">{formatConnectionDate(connection.lastTestedAt)}</dd></div><div><dt className="text-slate-400">已关联仓库</dt><dd className="mt-1 font-medium">{connection._count.repositories} 个（当前不开放项目委托）</dd></div><div><dt className="text-slate-400">内网访问</dt><dd className="mt-1 font-medium">{connection.allowPrivateNetwork ? "已显式允许" : "禁止"}</dd></div></dl>{editing ? <form onSubmit={saveEdit} className="mt-4 grid gap-3 rounded-xl border border-indigo-100 bg-white p-4 sm:grid-cols-2"><Field label="连接名称"><input className={connectionFieldClass} value={draft.name} onChange={(event) => setEditValue("name", event.target.value)} required maxLength={80} /></Field><Field label="用户名（可选）"><input className={connectionFieldClass} value={draft.username} onChange={(event) => setEditValue("username", event.target.value)} maxLength={128} /></Field><Field label="轮换凭据（可选）"><input type="password" autoComplete="new-password" className={connectionFieldClass} value={draft.secret} onChange={(event) => setEditValue("secret", event.target.value)} minLength={1} maxLength={24000} placeholder="留空表示不修改" /></Field><label className="mt-1 flex items-start gap-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900"><input type="checkbox" checked={draft.allowPrivateNetwork} onChange={(event) => setEditValue("allowPrivateNetwork", event.target.checked)} className="mt-1 h-4 w-4 shrink-0" /><span><strong className="block">允许受信内网地址</strong><span>变更后需要重新测试。</span></span></label>{connection.transport === "https" ? <Field label="替换自定义 CA（可选）"><textarea className={`${connectionFieldClass} min-h-24 font-mono text-xs`} value={draft.tlsCaCertificate} onChange={(event) => setEditValue("tlsCaCertificate", event.target.value)} placeholder="留空表示清除自定义 CA" /></Field> : <Field label="替换 SSH known_hosts"><input className={`${connectionFieldClass} font-mono text-xs`} value={draft.sshKnownHost} onChange={(event) => setEditValue("sshKnownHost", event.target.value)} placeholder="留空表示清除记录" /></Field>}<div className="flex flex-wrap gap-2 sm:col-span-2"><button type="submit" disabled={pending !== null} className={`${connectionButtonClass} bg-indigo-600 text-white hover:bg-indigo-500`}>{pending === "edit" ? "保存中…" : "保存修改"}</button><button type="button" onClick={resetEdit} className={`${connectionButtonClass} border border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}>取消</button></div></form> : null}<form onSubmit={testConnection} className="mt-4 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"><Field label="只读测试仓库路径"><input className={connectionFieldClass} value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} placeholder="owner/repository" required disabled={connection.status === "disabled" || pending !== null} /></Field><Field label="分支 / ref"><input className={connectionFieldClass} value={trackedRef} onChange={(event) => setTrackedRef(event.target.value)} placeholder="main" required disabled={connection.status === "disabled" || pending !== null} /></Field><button type="submit" disabled={pending !== null || connection.status === "disabled"} className={`${connectionButtonClass} min-h-11 bg-indigo-600 px-4 text-white hover:bg-indigo-500`}>{pending === "test" ? "测试中…" : "测试只读连接"}</button></form>{message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-3 text-xs leading-5 ${message.tone === "error" ? "text-rose-700" : message.tone === "success" ? "text-emerald-700" : "text-slate-600"}`}>{message.text}</p> : null}<div className="mt-4 flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap gap-2"><button type="button" onClick={() => { setDraft(createGitEditDraft(connection)); setEditing((current) => !current); }} disabled={pending !== null} className={`${connectionButtonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}>{editing ? "关闭编辑" : "编辑配置"}</button></div><div className="flex flex-wrap gap-2">{connection.status === "disabled" ? <button type="button" onClick={() => void toggle()} disabled={pending !== null} className={`${connectionButtonClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}>{pending === "toggle" ? "处理中…" : "重新启用"}</button> : <button type="button" onClick={() => void toggle()} disabled={pending !== null} className={`${connectionButtonClass} text-rose-700 hover:bg-rose-50`}>{pending === "toggle" ? "处理中…" : "停用"}</button>}<button type="button" onClick={() => void remove()} disabled={pending !== null} className={`${connectionButtonClass} text-rose-700 hover:bg-rose-50`}>{pending === "delete" ? "删除中…" : "删除"}</button></div></div>{connection.status === "disabled" ? <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs leading-5 text-slate-600">连接已停用；重新启用后必须重新测试。删除需要保持停用并输入准确名称。</p> : null}</article>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block min-w-0 text-xs font-semibold text-slate-700">{label}{children}</label>;
}
