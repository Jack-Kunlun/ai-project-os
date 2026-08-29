"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";

type WorkspaceRole = "owner" | "admin" | "member" | "viewer";
type ProjectRole = "owner" | "editor" | "viewer";
type Overview = { workspace: { id: string; name: string; slug: string }; role: WorkspaceRole; counts: { memberships: number; projects: number; oidcProviders: number } };
type Project = { id: string; name: string };
type Member = { userId: string; role: WorkspaceRole; user: { id: string; username: string; displayName: string | null; email: string | null; disabledAt: string | null; createdAt: string; oidcIdentities: Array<{ provider: { id: string; name: string }; lastLoginAt: string }> }; workspace: { projects: Project[] }; projectGrants: Array<{ projectId: string; role: ProjectRole }> };
type Invitation = { id: string; email: string | null; workspaceRole: WorkspaceRole; projectId: string | null; projectRole: ProjectRole | null; expiresAt: string; acceptedAt: string | null; revokedAt: string | null; project: { name: string } | null; invitedBy: { username: string } };
type OidcProvider = { id: string; name: string; issuerUrl: string; clientId: string; tokenAuthMethod: "clientSecretPost" | "clientSecretBasic"; allowPrivateNetwork: boolean; autoProvision: boolean; defaultWorkspaceRole: "member" | "viewer"; allowedEmailDomains: string[]; status: "configured" | "verified" | "error" | "disabled"; lastTestedAt: string | null; lastErrorCode: string | null };
type View = "members" | "invitations" | "oidc";

async function responseError(response: Response, fallback: string) { try { const payload = await response.json() as { error?: { message?: string } }; return payload.error?.message ?? fallback; } catch { return fallback; } }

export function TeamClient({ username }: { username: string }) {
  const [view, setView] = useState<View>("members");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [providers, setProviders] = useState<OidcProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const overviewResponse = await fetch("/api/workspaces/current", { cache: "no-store" });
      if (!overviewResponse.ok) throw new Error(await responseError(overviewResponse, "工作区加载失败"));
      const nextOverview = (await overviewResponse.json() as { overview: Overview }).overview;
      setOverview(nextOverview);
      if (["owner", "admin"].includes(nextOverview.role)) {
        const [memberResponse, invitationResponse, providerResponse] = await Promise.all([
          fetch(`/api/workspaces/${nextOverview.workspace.id}/members`, { cache: "no-store" }),
          fetch(`/api/workspaces/${nextOverview.workspace.id}/invitations`, { cache: "no-store" }),
          fetch(`/api/workspaces/${nextOverview.workspace.id}/oidc-providers`, { cache: "no-store" }),
        ]);
        const failed = [memberResponse, invitationResponse, providerResponse].find((response) => !response.ok);
        if (failed) throw new Error(await responseError(failed, "团队配置加载失败"));
        setMembers((await memberResponse.json() as { members: Member[] }).members);
        setInvitations((await invitationResponse.json() as { invitations: Invitation[] }).invitations);
        setProviders((await providerResponse.json() as { providers: OidcProvider[] }).providers);
      }
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "工作区加载失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);
  const canAdmin = overview !== null && ["owner", "admin"].includes(overview.role);

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="team" /><div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12"><section className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-violet-950 px-8 py-10 text-white shadow-xl shadow-slate-950/10"><div className="flex flex-wrap items-end justify-between gap-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Workspace & identity</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">团队与访问控制</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">集中管理本地成员、项目授权和企业 OIDC。所有项目访问由服务端角色校验，页面状态只用于解释权限，不作为安全边界。</p></div>{overview ? <div className="rounded-2xl border border-white/10 bg-white/10 px-5 py-4 text-right"><p className="text-xs text-violet-200">{overview.workspace.name}</p><strong className="mt-1 block text-lg">{overview.role}</strong></div> : null}</div></section>{error ? <div role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}{overview ? <section className="mt-7 grid gap-4 sm:grid-cols-3"><Metric label="成员" value={overview.counts.memberships} /><Metric label="项目" value={overview.counts.projects} /><Metric label="企业身份源" value={overview.counts.oidcProviders} /></section> : null}{!loading && !canAdmin ? <div className="mt-8 rounded-3xl border border-slate-200 bg-white px-6 py-14 text-center"><h2 className="text-xl font-semibold">当前角色无需管理团队配置</h2><p className="mt-3 text-sm text-slate-500">工作区 Owner 或 Admin 可以管理成员、邀请与 OIDC 身份源。</p></div> : null}{canAdmin && overview ? <><nav className="mt-8 flex gap-2 overflow-x-auto rounded-2xl bg-slate-100 p-1" aria-label="团队设置">{([['members','成员与权限'],['invitations','邀请链接'],['oidc','企业 OIDC']] as const).map(([key,label]) => <button key={key} onClick={() => setView(key)} className={`shrink-0 rounded-xl px-5 py-2.5 text-sm font-semibold ${view === key ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}>{label}</button>)}</nav><div className="mt-6">{view === "members" ? <MembersView workspaceId={overview.workspace.id} members={members} projects={members[0]?.workspace.projects ?? []} onReload={reload} /> : view === "invitations" ? <InvitationsView workspaceId={overview.workspace.id} invitations={invitations} projects={members[0]?.workspace.projects ?? []} /> : <OidcView workspaceId={overview.workspace.id} providers={providers} onReload={reload} />}</div></> : null}</div></main>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-semibold text-slate-400">{label}</p><strong className="mt-2 block text-3xl">{value}</strong></div>; }

function MembersView({ workspaceId, members, projects, onReload }: { workspaceId: string; members: Member[]; projects: Project[]; onReload: () => Promise<void> }) {
  return <div className="grid gap-7 xl:grid-cols-[.72fr_1.28fr]"><MemberForm workspaceId={workspaceId} projects={projects} onReload={onReload} /><section><div className="mb-4 flex items-end justify-between px-1"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Members</p><h2 className="mt-2 text-2xl font-semibold">工作区成员</h2></div><span className="text-xs text-slate-400">{members.length} 人</span></div><div className="space-y-4">{members.map((member) => <MemberCard key={member.userId} workspaceId={workspaceId} member={member} onReload={onReload} />)}</div></section></div>;
}

function MemberForm({ workspaceId, projects, onReload }: { workspaceId: string; projects: Project[]; onReload: () => Promise<void> }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [displayName, setDisplayName] = useState(""); const [email, setEmail] = useState(""); const [role, setRole] = useState<"admin" | "member" | "viewer">("member"); const [projectId, setProjectId] = useState(""); const [projectRole, setProjectRole] = useState<ProjectRole>("editor"); const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setMessage(null); try { const response = await fetch(`/api/workspaces/${workspaceId}/members`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, displayName: displayName || null, email: email || null, workspaceRole: role, projectGrants: projectId ? [{ projectId, role: projectRole }] : [] }) }); if (!response.ok) throw new Error(await responseError(response, "成员创建失败")); setUsername(""); setPassword(""); setDisplayName(""); setEmail(""); setProjectId(""); setMessage("本地成员已创建，密码请通过安全渠道单独告知。"); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "成员创建失败"); } finally { setPending(false); } }
  return <form onSubmit={submit} autoComplete="off" className="h-fit rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Local account</p><h2 className="mt-2 text-2xl font-semibold">添加本地成员</h2><Input label="登录名" name="new-member-username" autoComplete="off" value={username} onChange={setUsername} required /><Input label="显示名称" name="new-member-display-name" autoComplete="off" value={displayName} onChange={setDisplayName} /><Input label="邮箱（用于邀请校验；OIDC 身份需单独绑定）" name="new-member-email" autoComplete="off" value={email} onChange={setEmail} type="email" /><Input label="初始密码（至少 12 位，含字母和数字）" name="new-member-password" autoComplete="new-password" value={password} onChange={setPassword} type="password" required /><Select label="工作区角色" value={role} onChange={(value) => setRole(value as typeof role)} options={[['admin','Admin：管理成员和所有项目'],['member','Member：仅访问授权项目'],['viewer','Viewer：仅访问授权项目']]} /><Select label="初始项目（可选）" value={projectId} onChange={setProjectId} options={[["","暂不授权项目"], ...projects.map((project) => [project.id, project.name])]} />{projectId ? <Select label="项目角色" value={projectRole} onChange={(value) => setProjectRole(value as ProjectRole)} options={[['owner','Owner'],['editor','Editor'],['viewer','Viewer']]} /> : null}{message ? <p role="status" className="mt-4 text-xs text-slate-600">{message}</p> : null}<button disabled={pending} className="mt-6 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? "创建中…" : "创建成员"}</button></form>;
}

function MemberCard({ workspaceId, member, onReload }: { workspaceId: string; member: Member; onReload: () => Promise<void> }) {
  const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function patch(body: unknown) { setPending(true); setMessage(null); try { const response = await fetch(`/api/workspaces/${workspaceId}/members/${member.userId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await responseError(response, "成员更新失败")); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "成员更新失败"); } finally { setPending(false); } }
  return <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">{member.user.displayName || member.user.username}</h3><span className="rounded-full bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700">{member.role}</span>{member.user.disabledAt ? <span className="rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700">已停用</span> : null}</div><p className="mt-2 text-xs text-slate-500">@{member.user.username}{member.user.email ? ` · ${member.user.email}` : ""}</p><p className="mt-2 text-xs text-slate-400">{member.projectGrants.length > 0 ? `${member.projectGrants.length} 个项目授权` : "无单独项目授权"}{member.user.oidcIdentities.length > 0 ? ` · 已关联 ${member.user.oidcIdentities.map((identity) => identity.provider.name).join("、")}` : " · 本地账号"}</p></div><div className="flex gap-2"><select value={member.role} onChange={(event) => void patch({ workspaceRole: event.target.value })} disabled={pending} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold"><option value="owner">Owner</option><option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option></select><button onClick={() => void patch({ disabled: !member.user.disabledAt })} disabled={pending} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">{member.user.disabledAt ? "启用" : "停用"}</button></div></div>{message ? <p className="mt-3 text-xs text-rose-600">{message}</p> : null}</article>;
}

function InvitationsView({ workspaceId, invitations, projects }: { workspaceId: string; invitations: Invitation[]; projects: Project[] }) {
  const [email, setEmail] = useState(""); const [role, setRole] = useState<"member" | "viewer" | "admin">("member"); const [projectId, setProjectId] = useState(""); const [link, setLink] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null); const active = useMemo(() => invitations.filter((item) => !item.acceptedAt && !item.revokedAt && new Date(item.expiresAt) > new Date()), [invitations]);
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setMessage(null); const response = await fetch(`/api/workspaces/${workspaceId}/invitations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email || null, workspaceRole: role, projectId: projectId || null, projectRole: projectId ? "viewer" : null, expiresInDays: 7 }) }); if (!response.ok) { setMessage(await responseError(response, "邀请创建失败")); return; } const result = await response.json() as { acceptPath: string }; setLink(`${window.location.origin}${result.acceptPath}`); setMessage("邀请链接只在本次创建后显示，请立即复制并安全发送。"); }
  return <div className="grid gap-7 xl:grid-cols-[.72fr_1.28fr]"><form onSubmit={(event) => void create(event)} className="h-fit rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Invitation</p><h2 className="mt-2 text-2xl font-semibold">创建邀请链接</h2><Input label="限定邮箱（推荐）" value={email} onChange={setEmail} type="email" /><Select label="工作区角色" value={role} onChange={(value) => setRole(value as typeof role)} options={[['member','Member'],['viewer','Viewer'],['admin','Admin']]} /><Select label="同时授权项目（可选）" value={projectId} onChange={setProjectId} options={[["","无"], ...projects.map((project) => [project.id, project.name])]} /><button className="mt-6 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white">生成 7 天邀请</button>{link ? <div className="mt-4 rounded-xl bg-slate-50 p-3"><code className="break-all text-xs text-slate-600">{link}</code><button type="button" onClick={() => void navigator.clipboard.writeText(link)} className="mt-3 block text-xs font-semibold text-indigo-600">复制链接</button></div> : null}{message ? <p className="mt-3 text-xs text-slate-500">{message}</p> : null}</form><section><h2 className="text-2xl font-semibold">有效邀请</h2><div className="mt-4 space-y-3">{active.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">没有尚未使用的邀请。</div> : active.map((invitation) => <div key={invitation.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex justify-between gap-4"><div><p className="font-semibold">{invitation.email ?? "不限定邮箱"}</p><p className="mt-1 text-xs text-slate-500">{invitation.workspaceRole}{invitation.project ? ` · ${invitation.project.name} / ${invitation.projectRole}` : ""}</p></div><span className="text-xs text-slate-400">{new Date(invitation.expiresAt).toLocaleDateString("zh-CN")} 到期</span></div></div>)}</div></section></div>;
}

function OidcView({ workspaceId, providers, onReload }: { workspaceId: string; providers: OidcProvider[]; onReload: () => Promise<void> }) {
  return <div className="grid gap-7 xl:grid-cols-[.8fr_1.2fr]"><OidcForm workspaceId={workspaceId} onReload={onReload} /><section><div className="mb-4"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Identity providers</p><h2 className="mt-2 text-2xl font-semibold">企业身份源</h2></div><div className="space-y-4">{providers.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">还没有 OIDC 身份源。</div> : providers.map((provider) => <OidcCard key={provider.id} workspaceId={workspaceId} provider={provider} onReload={onReload} />)}</div></section></div>;
}

function OidcForm({ workspaceId, onReload }: { workspaceId: string; onReload: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [issuerUrl, setIssuerUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState("openid profile email");
  const [tokenAuthMethod, setTokenAuthMethod] = useState<"clientSecretPost" | "clientSecretBasic">("clientSecretBasic");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [autoProvision, setAutoProvision] = useState(false);
  const [defaultWorkspaceRole, setDefaultWorkspaceRole] = useState<"member" | "viewer">("viewer");
  const [domains, setDomains] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/oidc-providers`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name, issuerUrl, clientId, clientSecret, tokenAuthMethod,
          scopes: scopes.split(/\s+/u).filter(Boolean), allowPrivateNetwork,
          autoProvision, defaultWorkspaceRole,
          allowedEmailDomains: domains.split(",").map((value) => value.trim()).filter(Boolean),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "OIDC 配置失败"));
      setName(""); setIssuerUrl(""); setClientId(""); setClientSecret(""); setDomains("");
      setMessage("Discovery、端点网络、PKCE 与签名算法能力已验证。请在身份提供商登记当前站点的 /api/auth/oidc/callback 回调地址。");
      await onReload();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "OIDC 配置失败"); }
    finally { setPending(false); }
  }

  return <form onSubmit={submit} autoComplete="off" className="h-fit rounded-3xl border border-slate-200 bg-white p-7 shadow-sm">
    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">OpenID Connect</p><h2 className="mt-2 text-2xl font-semibold">添加企业身份源</h2>
    <p className="mt-3 text-xs leading-5 text-slate-500">使用 Authorization Code + PKCE，校验 issuer、audience、nonce、过期时间与 JWKS 签名。公网端点必须使用 HTTPS，服务端访问会固定已验证的 DNS 地址。</p>
    <Input label="名称" name="oidc-provider-name" autoComplete="off" value={name} onChange={setName} required /><Input label="Issuer URL" name="oidc-issuer-url" autoComplete="off" value={issuerUrl} onChange={setIssuerUrl} type="url" required /><Input label="Client ID" name="oidc-client-id" autoComplete="off" value={clientId} onChange={setClientId} required /><Input label="Client Secret" name="oidc-client-secret" autoComplete="new-password" value={clientSecret} onChange={setClientSecret} type="password" required />
    <Input label="Scopes（空格分隔，必须包含 openid）" value={scopes} onChange={setScopes} required />
    <Select label="Token 端点认证方式" value={tokenAuthMethod} onChange={(value) => setTokenAuthMethod(value as typeof tokenAuthMethod)} options={[["clientSecretBasic", "client_secret_basic（Discovery 默认）"], ["clientSecretPost", "client_secret_post"]]} />
    <Select label="自动加入后的工作区角色" value={defaultWorkspaceRole} onChange={(value) => setDefaultWorkspaceRole(value as typeof defaultWorkspaceRole)} options={[["viewer", "Viewer"], ["member", "Member"]]} />
    <label className="mt-5 flex items-start gap-3 rounded-xl bg-slate-50 p-4 text-xs text-slate-600"><input type="checkbox" checked={allowPrivateNetwork} onChange={(event) => setAllowPrivateNetwork(event.target.checked)} className="mt-0.5" /><span><strong className="block text-slate-700">允许受信任内网 OIDC</strong>仅用于公司内网部署；开启后允许 HTTP 和私网地址，但云元数据地址仍会拒绝。</span></label>
    <label className="mt-3 flex items-start gap-3 rounded-xl bg-slate-50 p-4 text-xs text-slate-600"><input type="checkbox" checked={autoProvision} onChange={(event) => setAutoProvision(event.target.checked)} className="mt-0.5" /><span>允许已验证邮箱按域名创建新账户；不会把尚未关联的 OIDC 身份按邮箱自动合并到已有账户。</span></label>
    {autoProvision ? <Input label="允许邮箱域名（逗号分隔；留空表示任意已验证域名）" value={domains} onChange={setDomains} /> : null}
    {message ? <p role="status" className="mt-4 text-xs leading-5 text-slate-600">{message}</p> : null}<button disabled={pending} className="mt-6 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? "验证 Discovery…" : "验证并保存"}</button>
  </form>;
}

function OidcCard({ workspaceId, provider, onReload }: { workspaceId: string; provider: OidcProvider; onReload: () => Promise<void> }) {
  const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function patch(body: unknown) { setPending(true); setMessage(null); try { const response = await fetch(`/api/workspaces/${workspaceId}/oidc-providers/${provider.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await responseError(response, "OIDC 更新失败")); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "OIDC 更新失败"); } finally { setPending(false); } }
  return <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap justify-between gap-4"><div><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">{provider.name}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${provider.status === "verified" ? "bg-emerald-50 text-emerald-700" : provider.status === "disabled" ? "bg-slate-100 text-slate-500" : "bg-rose-50 text-rose-700"}`}>{provider.status}</span></div><p className="mt-2 max-w-lg truncate text-xs text-slate-500">{provider.issuerUrl}</p><p className="mt-2 text-xs text-slate-400">{provider.tokenAuthMethod === "clientSecretBasic" ? "client_secret_basic" : "client_secret_post"} · {provider.allowPrivateNetwork ? "内网已授权" : "仅公网 HTTPS"}</p><p className="mt-1 text-xs text-slate-400">自动加入：{provider.autoProvision ? (provider.allowedEmailDomains.length ? provider.allowedEmailDomains.join("、") : "任意已验证邮箱") : "关闭"}</p></div><div className="flex gap-2"><button onClick={() => void patch({ rediscover: true })} disabled={pending} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold">重新验证</button><button onClick={() => void patch({ enabled: provider.status === "disabled" })} disabled={pending} className="rounded-xl px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">{provider.status === "disabled" ? "启用" : "停用"}</button></div></div>{provider.lastErrorCode ? <p className="mt-3 text-xs text-rose-600">{provider.lastErrorCode}</p> : null}{message ? <p className="mt-3 text-xs text-rose-600">{message}</p> : null}</article>;
}

function Input({ label, name, autoComplete, value, onChange, type = "text", required = false }: { label: string; name?: string; autoComplete?: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean }) { return <label className="mt-5 block text-sm font-medium text-slate-700">{label}<input name={name} autoComplete={autoComplete} type={type} value={value} onChange={(event) => onChange(event.target.value)} required={required} className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-violet-400" /></label>; }
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<readonly string[]> }) { return <label className="mt-5 block text-sm font-medium text-slate-700">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">{options.map(([key,name]) => <option key={key || "empty"} value={key ?? ""}>{name ?? key}</option>)}</select></label>; }
