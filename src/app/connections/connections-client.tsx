"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";

type ProviderKind = "github" | "gitee" | "gitlab" | "gitea" | "forgejo" | "generic";
type Transport = "https" | "ssh";
type AuthKind = "none" | "token" | "basic" | "sshKey";
type CatalogEntry = { kind: ProviderKind; label: string; defaultHttpsUrl: string; defaultSshUrl: string };
type Connection = {
  id: string;
  name: string;
  providerKind: ProviderKind;
  transport: Transport;
  baseUrl: string;
  authKind: AuthKind;
  username: string | null;
  allowPrivateNetwork: boolean;
  tlsCaCertificate: string | null;
  sshKnownHost: string | null;
  status: "configured" | "verified" | "error" | "disabled";
  lastTestedAt: string | null;
  lastErrorCode: string | null;
  credential: { maskedSuffix: string; rotatedAt: string | null; updatedAt: string } | null;
  _count: { repositories: number };
};

async function responseError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

const statusLabels = { configured: "待验证", verified: "已验证", error: "验证失败", disabled: "已停用" } as const;
const statusStyles = {
  configured: "bg-amber-50 text-amber-700 ring-amber-200",
  verified: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-rose-50 text-rose-700 ring-rose-200",
  disabled: "bg-slate-100 text-slate-500 ring-slate-200",
} as const;

export function ConnectionsClient({ username }: { username: string }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const response = await fetch("/api/settings/git-connections", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "连接器加载失败"));
      const payload = await response.json() as { connections: Connection[]; catalog: CatalogEntry[] };
      setConnections(payload.connections);
      setCatalog(payload.catalog);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接器加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="connections" />
      <div className="mx-auto max-w-7xl px-6 py-10 sm:px-10 lg:px-12">
        <section className="grid gap-8 rounded-[2rem] bg-slate-950 px-7 py-9 text-white shadow-xl shadow-slate-950/10 lg:grid-cols-[1.2fr_.8fr] lg:px-10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Source connections</p>
            <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em]">代码来源连接器</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">统一配置 GitHub、Gitee、GitLab、自建 Gitea / Forgejo 和通用 Git 服务。凭据只在服务端解密；仓库扫描固定提交、禁止交互式提示和本地钩子，并在发布前完成整批校验。</p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            {["HTTPS Token / Basic", "SSH Deploy Key", "自定义 CA", "内网服务显式授权"].map((item) => <div key={item} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-slate-200">{item}</div>)}
          </div>
        </section>

        {error ? <div role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}

        <div className="mt-8 grid gap-7 xl:grid-cols-[.82fr_1.18fr]">
          <ConnectionForm catalog={catalog} onCreated={(connection) => setConnections((current) => [...current, connection])} />
          <section>
            <div className="mb-4 flex items-end justify-between px-1">
              <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Configured</p><h2 className="mt-2 text-2xl font-semibold">已配置服务</h2></div>
              <span className="text-xs text-slate-400">{loading ? "读取中…" : `${connections.length} 个`}</span>
            </div>
            <div className="space-y-4">
              {!loading && connections.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center text-sm text-slate-500">先添加一个 Git 服务，再到项目的“代码仓库”页关联仓库。</div> : null}
              {connections.map((connection) => <ConnectionCard key={connection.id} connection={connection} onChanged={(next) => setConnections((current) => current.map((item) => item.id === next.id ? next : item))} />)}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function ConnectionForm({ catalog, onCreated }: { catalog: CatalogEntry[]; onCreated: (connection: Connection) => void }) {
  const [providerKind, setProviderKind] = useState<ProviderKind>("github");
  const [transport, setTransport] = useState<Transport>("https");
  const [name, setName] = useState("GitHub");
  const [baseUrl, setBaseUrl] = useState("https://github.com");
  const [authKind, setAuthKind] = useState<AuthKind>("token");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [tlsCaCertificate, setTlsCaCertificate] = useState("");
  const [sshKnownHost, setSshKnownHost] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selected = useMemo(() => catalog.find((entry) => entry.kind === providerKind), [catalog, providerKind]);

  function chooseProvider(kind: ProviderKind) {
    setProviderKind(kind);
    const entry = catalog.find((item) => item.kind === kind);
    if (entry) {
      setName(entry.label.split(" /")[0]!);
      setBaseUrl(transport === "https" ? entry.defaultHttpsUrl : entry.defaultSshUrl);
    }
  }

  function chooseTransport(next: Transport) {
    setTransport(next);
    setBaseUrl(next === "https" ? selected?.defaultHttpsUrl ?? "https://git.example.com" : selected?.defaultSshUrl ?? "ssh://git@git.example.com");
    setAuthKind(next === "https" ? "token" : "sshKey");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/settings/git-connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name, providerKind, transport, baseUrl, authKind,
          username: username || null,
          secret: authKind === "none" ? null : secret,
          allowPrivateNetwork,
          tlsCaCertificate: transport === "https" && tlsCaCertificate ? tlsCaCertificate : null,
          sshKnownHost: transport === "ssh" ? sshKnownHost : null,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "连接保存失败"));
      const payload = await response.json() as { connection: Connection };
      onCreated(payload.connection);
      setSecret("");
      setMessage("连接已加密保存。请在右侧使用一个仓库和分支完成只读验证。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "连接保存失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="h-fit rounded-3xl border border-slate-200 bg-white p-6 shadow-sm lg:p-7">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">New connection</p>
      <h2 className="mt-2 text-2xl font-semibold">添加 Git 服务</h2>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="服务类型"><select value={providerKind} onChange={(event) => chooseProvider(event.target.value as ProviderKind)} className="field">{catalog.map((entry) => <option key={entry.kind} value={entry.kind}>{entry.label}</option>)}</select></Field>
        <Field label="传输协议"><select value={transport} onChange={(event) => chooseTransport(event.target.value as Transport)} className="field"><option value="https">HTTPS</option><option value="ssh">SSH</option></select></Field>
      </div>
      <Field label="连接名称"><input className="field" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /></Field>
      <Field label="服务根地址"><input className="field" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={transport === "https" ? "https://git.company.com" : "ssh://git@git.company.com:22"} required /></Field>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="认证方式"><select value={authKind} onChange={(event) => setAuthKind(event.target.value as AuthKind)} className="field" disabled={transport === "ssh"}>{transport === "https" ? <><option value="token">Access Token</option><option value="basic">用户名 / 密码</option><option value="none">公开仓库，无凭据</option></> : <option value="sshKey">SSH Deploy Key</option>}</select></Field>
        {authKind !== "none" ? <Field label="用户名（可选）"><input className="field" value={username} onChange={(event) => setUsername(event.target.value)} placeholder={authKind === "token" ? "留空使用平台默认值" : "git"} /></Field> : <div />}
      </div>
      {authKind !== "none" ? <Field label={authKind === "sshKey" ? "SSH 私钥（只读 Deploy Key，不能带口令）" : authKind === "token" ? "Access Token" : "密码"}>{authKind === "sshKey" ? <textarea className="field min-h-36 font-mono text-xs" value={secret} onChange={(event) => setSecret(event.target.value)} required /> : <input type="password" autoComplete="new-password" className="field" value={secret} onChange={(event) => setSecret(event.target.value)} required />}</Field> : null}
      {transport === "ssh" ? <Field label="SSH known_hosts 公钥记录"><textarea className="field min-h-24 font-mono text-xs" value={sshKnownHost} onChange={(event) => setSshKnownHost(event.target.value)} placeholder="git.company.com ssh-ed25519 AAAA…" required /></Field> : null}
      <button type="button" onClick={() => setAdvanced((value) => !value)} className="mt-5 text-xs font-semibold text-indigo-600">{advanced ? "收起安全选项" : "展开自建服务安全选项"}</button>
      {advanced ? <div className="mt-4 rounded-2xl bg-slate-50 p-4"><label className="flex items-start gap-3 text-sm text-slate-700"><input type="checkbox" checked={allowPrivateNetwork} onChange={(event) => setAllowPrivateNetwork(event.target.checked)} className="mt-1" /><span><strong className="block">允许访问内网地址</strong><span className="mt-1 block text-xs leading-5 text-slate-500">仅用于明确受信的公司内网 Git 服务；云元数据地址始终禁止。</span></span></label>{transport === "https" ? <Field label="自定义 CA 证书（可选）"><textarea className="field min-h-28 font-mono text-xs" value={tlsCaCertificate} onChange={(event) => setTlsCaCertificate(event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" /></Field> : null}</div> : null}
      {message ? <p role="status" className="mt-4 text-xs leading-5 text-slate-600">{message}</p> : null}
      <button disabled={pending || catalog.length === 0} className="mt-6 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50">{pending ? "加密保存中…" : "加密保存连接"}</button>
      <style jsx>{`.field{margin-top:.5rem;width:100%;border-radius:.75rem;border:1px solid #cbd5e1;background:white;padding:.72rem .9rem;font-size:.875rem;color:#0f172a;outline:none}.field:focus{border-color:#818cf8;box-shadow:0 0 0 3px rgba(129,140,248,.14)}.field:disabled{background:#f1f5f9;color:#64748b}`}</style>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="mt-4 block text-sm font-medium text-slate-700">{label}{children}</label>;
}

function ConnectionCard({ connection, onChanged }: { connection: Connection; onChanged: (connection: Connection) => void }) {
  const [repositoryPath, setRepositoryPath] = useState("");
  const [trackedRef, setTrackedRef] = useState("main");
  const [testing, setTesting] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function test(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTesting(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/settings/git-connections/${connection.id}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repositoryPath, trackedRef }) });
      if (!response.ok) throw new Error(await responseError(response, "连接测试失败"));
      const payload = await response.json() as { connection: Connection; probe: { commitSha: string } };
      onChanged(payload.connection);
      setMessage(`只读验证通过，分支当前提交 ${payload.probe.commitSha.slice(0, 12)}。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "连接测试失败");
    } finally {
      setTesting(false);
    }
  }

  async function disable() {
    setDisabling(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/settings/git-connections/${connection.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response, "停用失败"));
      const payload = await response.json() as { connection: Connection };
      onChanged(payload.connection);
      setMessage("连接已停用；加密凭据仍保留，便于审计和后续恢复。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "停用失败");
    } finally {
      setDisabling(false);
    }
  }

  return (
    <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">{connection.name}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${statusStyles[connection.status]}`}>{statusLabels[connection.status]}</span></div><p className="mt-2 text-xs text-slate-500">{connection.providerKind.toUpperCase()} · {connection.transport.toUpperCase()} · {connection.baseUrl}</p></div>
        <div className="text-right text-xs text-slate-400"><p>{connection._count.repositories} 个仓库身份</p><p className="mt-1">凭据 ····{connection.credential?.maskedSuffix ?? "无"}</p></div>
      </div>
      <div className="mt-4 grid gap-2 text-xs text-slate-600 sm:grid-cols-2"><p>内网访问：{connection.allowPrivateNetwork ? "已显式允许" : "禁止"}</p><p>最近验证：{connection.lastTestedAt ? new Date(connection.lastTestedAt).toLocaleString("zh-CN") : "尚未验证"}</p>{connection.lastErrorCode ? <p className="sm:col-span-2 text-rose-600">最近错误：{connection.lastErrorCode}</p> : null}</div>
      {connection.status !== "disabled" ? <form onSubmit={test} className="mt-5 grid gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-[1fr_8rem_auto]"><input value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} placeholder="组织/仓库" required className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-400" /><input value={trackedRef} onChange={(event) => setTrackedRef(event.target.value)} placeholder="main" required className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-400" /><button disabled={testing} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{testing ? "验证中…" : "只读验证"}</button></form> : null}
      <div className="mt-4 flex items-center justify-between gap-3">{message ? <p role="status" className="text-xs leading-5 text-slate-600">{message}</p> : <span />}{connection.status !== "disabled" ? <button onClick={() => void disable()} disabled={disabling} className="shrink-0 rounded-lg px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">{disabling ? "停用中…" : "停用连接"}</button> : null}</div>
    </article>
  );
}
