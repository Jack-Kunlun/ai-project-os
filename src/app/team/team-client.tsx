"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { AppHeader } from "@/components/app-header";
import { ScopeEvidenceCard } from "@/components/scope-evidence-card";
import { safeResponseError } from "@/lib/safe-error-presentation";

type WorkspaceRole = "owner" | "admin" | "member" | "viewer";
type ProjectRole = "owner" | "editor" | "viewer";
type MembershipAccessState = "pending" | "confirmed" | "revoked";
type Overview = { workspace: { id: string; name: string; slug: string }; role: WorkspaceRole; counts: { memberships: number; projects: number } };
type Project = { id: string; name: string };
type Member = { userId: string; role: WorkspaceRole; accessState: MembershipAccessState; user: { id: string; username: string; displayName: string | null; email: string | null; disabledAt: string | null; createdAt: string; oidcIdentities: Array<{ provider: { id: string; name: string }; lastLoginAt: string }> }; workspace: { projects: Project[] }; projectGrants: Array<{ projectId: string; role: ProjectRole; accessState: MembershipAccessState }> };
type Invitation = { id: string; email: string | null; workspaceRole: WorkspaceRole; projectId: string | null; projectRole: ProjectRole | null; expiresAt: string; acceptedAt: string | null; revokedAt: string | null; version: number; createdAt?: string; project: { name: string } | null; invitedBy: { username: string } };
type OidcProvider = { id: string; name: string; issuerUrl: string; clientId: string; tokenAuthMethod: "clientSecretPost" | "clientSecretBasic"; allowPrivateNetwork: boolean; autoProvision: boolean; defaultWorkspaceRole: "member" | "viewer"; allowedEmailDomains: string[]; status: "configured" | "verified" | "error" | "disabled"; lastTestedAt: string | null; lastErrorCode: string | null; updatedAt: string };
type AdminView = "members" | "invitations" | "oidc";
type WorkspaceTeamView = "overview" | "members" | "permissions" | "activity" | "settings" | AdminView;

async function responseError(response: Response, fallback: string) { return (await safeResponseError(response, fallback)).message; }

export function TeamClient({ username, currentUserId, isSystemAdmin }: { username: string; currentUserId: string; isSystemAdmin: boolean }) {
  void currentUserId;
  const searchParams = useSearchParams();
  const router = useRouter();
  const [teams, setTeams] = useState<Overview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestedView] = useState(() => searchParams.get("view"));
  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const response = await fetch("/api/teams", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "团队列表加载失败"));
      setTeams((await response.json() as { teams: Overview[] }).teams);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "团队列表加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void reload({ showLoading: true }), 0); return () => window.clearTimeout(timer); }, [reload]);
  useEffect(() => {
    if (loading || error || teams.length !== 1) return;
    const view = requestedView === "members" || requestedView === "invitations" || requestedView === "oidc" ? `?view=${requestedView}` : "";
    router.replace(`/team/${teams[0].workspace.id}${view}`);
  }, [error, loading, requestedView, router, teams]);

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="team" isSystemAdmin={isSystemAdmin} /><div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12"><section className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-violet-950 px-8 py-10 text-white shadow-xl shadow-slate-950/10"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Teams</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">我的团队</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">查看你已确认加入的团队、团队项目和实际访问权限。</p></section>{error ? <div role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}{loading ? <div className="mt-7 grid gap-5 md:grid-cols-2"><div className="h-52 animate-pulse rounded-3xl bg-slate-200" /><div className="h-52 animate-pulse rounded-3xl bg-slate-200" /></div> : teams.length === 0 ? <section className="mt-7 rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center"><h2 className="text-xl font-semibold">暂未加入团队</h2><p className="mt-3 text-sm text-slate-500">加入团队后，团队空间会显示在这里。你的个人工作区仍在“个人工作台”中。</p></section> : teams.length > 1 ? <section className="mt-7 grid gap-5 lg:grid-cols-2" aria-label="团队列表">{teams.map((team) => <article key={team.workspace.id} className="flex min-h-52 flex-col rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">{team.workspace.name}</h2><p className="mt-2 text-xs text-slate-500">{team.role} · {team.counts.memberships} 位成员 · {team.counts.projects} 个可访问项目</p></div><span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700">已加入</span></div><div className="mt-auto pt-7"><a href={`/team/${team.workspace.id}`} className="inline-flex min-h-10 items-center justify-center rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white">进入团队</a></div></article>)}</section> : null}</div></main>;
}

type TeamProjectView = { id: string; name: string; slug: string; description: string | null; archivedAt: string | null; updatedAt: string; _count: { sources: number; items: number } };
type TeamOverviewPayload = { workspace: { id: string; name: string; slug: string }; role: WorkspaceRole; counts: { memberships: number; projects: number }; members: Array<{ userId: string; role: WorkspaceRole; username: string; displayName: string | null }>; projects: TeamProjectView[] };
type TeamPermissionsPayload = { workspace: { id: string; name: string; slug: string }; role: WorkspaceRole; projects: Array<{ project: { id: string; name: string; slug: string }; permission: ProjectRole; source: "workspace-role" | "project-grant" }> };
type TeamActivityPayload = { workspace: { id: string; name: string; slug: string }; role: WorkspaceRole; activity: Array<{ id: string; kind: "membership" | "invitation" | "role"; label: string; createdAt: string; project: { id: string; name: string } | null }> };

export function WorkspaceTeamClient({ username, currentUserId, isSystemAdmin, workspaceId }: { username: string; currentUserId: string; isSystemAdmin: boolean; workspaceId: string }) {
  void currentUserId;
  const searchParams = useSearchParams();
  const requestedView = searchParams.get("view");
  const initialView: WorkspaceTeamView = requestedView === "members" || requestedView === "permissions" || requestedView === "activity" || requestedView === "settings" || requestedView === "invitations" || requestedView === "oidc" ? requestedView : "overview";
  const [view, setView] = useState<WorkspaceTeamView>(initialView);
  const [overview, setOverview] = useState<TeamOverviewPayload | null>(null);
  const [permissions, setPermissions] = useState<TeamPermissionsPayload | null>(null);
  const [activity, setActivity] = useState<TeamActivityPayload | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [providers, setProviders] = useState<OidcProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (showLoading) setLoading(true);
    try {
      const overviewResponse = await fetch(`/api/teams/${workspaceId}/overview`, { cache: "no-store" });
      if (!overviewResponse.ok) throw new Error(await responseError(overviewResponse, "团队加载失败"));
      const nextOverview = (await overviewResponse.json() as { overview: TeamOverviewPayload }).overview;
      const [permissionsResponse, activityResponse] = await Promise.all([
        fetch(`/api/teams/${workspaceId}/permissions`, { cache: "no-store" }),
        fetch(`/api/teams/${workspaceId}/activity`, { cache: "no-store" }),
      ]);
      const failedProjection = [permissionsResponse, activityResponse].find((response) => !response.ok);
      if (failedProjection) throw new Error(await responseError(failedProjection, "团队信息加载失败"));
      setOverview(nextOverview);
      setPermissions((await permissionsResponse.json() as { permissions: TeamPermissionsPayload }).permissions);
      setActivity((await activityResponse.json() as { activity: TeamActivityPayload }).activity);
      if (nextOverview.role === "owner" || nextOverview.role === "admin") {
        const [memberResponse, invitationResponse, oidcResponse] = await Promise.all([
          fetch(`/api/workspaces/${workspaceId}/members`, { cache: "no-store" }),
          fetch(`/api/workspaces/${workspaceId}/invitations`, { cache: "no-store" }),
          fetch(`/api/workspaces/${workspaceId}/oidc-providers`, { cache: "no-store" }),
        ]);
        const failedAdmin = [memberResponse, invitationResponse, oidcResponse].find((response) => !response.ok);
        if (failedAdmin) throw new Error(await responseError(failedAdmin, "团队配置加载失败"));
        setMembers((await memberResponse.json() as { members: Member[] }).members);
        setInvitations((await invitationResponse.json() as { invitations: Invitation[] }).invitations);
        setProviders((await oidcResponse.json() as { providers: OidcProvider[] }).providers);
      } else {
        setMembers([]); setInvitations([]); setProviders([]);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "团队加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { const timer = window.setTimeout(() => void reload({ showLoading: true }), 0); return () => window.clearTimeout(timer); }, [reload]);

  const canAdmin = overview !== null && (overview.role === "owner" || overview.role === "admin");
  const projectOptions: Project[] = overview?.projects.map((project) => ({ id: project.id, name: project.name })) ?? [];

  function selectView(next: WorkspaceTeamView) {
    setView(next);
    const query = next === "overview" ? "" : `?view=${next}`;
    router.replace(`/team/${workspaceId}${query}`);
  }

  const navigation: Array<[WorkspaceTeamView, string]> = [["overview", "团队总览"], ["members", "成员与创建账号"], ["permissions", "我的权限"], ["activity", "活动记录"]];
  if (canAdmin) navigation.push(["invitations", "邀请成员"], ["settings", "团队设置"]);

  // The workspace back-link is rendered in the same compact client shell as
  // the existing admin controls; retain its native navigation behavior.
  // eslint-disable-next-line @next/next/no-html-link-for-pages
  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AppHeader username={username} active="team" isSystemAdmin={isSystemAdmin} /><div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12"><div className="mb-5"><a href="/team" className="text-sm font-semibold text-violet-700 hover:text-violet-900">← 我的团队</a></div><section className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-violet-950 px-8 py-10 text-white shadow-xl shadow-slate-950/10"><div className="flex flex-wrap items-end justify-between gap-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Team workspace</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{overview?.workspace.name ?? "团队空间"}</h1><p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">查看团队成员、项目访问权限和已记录的团队活动。</p></div>{overview ? <div className="rounded-2xl border border-white/10 bg-white/10 px-5 py-4 text-right"><p className="text-xs text-violet-200">当前角色</p><strong className="mt-1 block text-lg">{overview.role}</strong></div> : null}</div></section>{error ? <div role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}{overview ? <section className="mt-7 grid gap-4 sm:grid-cols-2"><Metric label="已确认成员" value={overview.counts.memberships} /><Metric label="可访问项目" value={overview.counts.projects} /></section> : null}<nav className="mt-8 flex gap-2 overflow-x-auto rounded-2xl bg-slate-100 p-1" aria-label="团队功能">{navigation.map(([key, label]) => <button type="button" key={key} onClick={() => selectView(key)} className={`shrink-0 rounded-xl px-5 py-2.5 text-sm font-semibold ${view === key || view === "oidc" && key === "settings" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}>{label}</button>)}</nav>{loading ? <div className="mt-7 h-72 animate-pulse rounded-3xl bg-slate-200" /> : overview ? <div className="mt-7">{view === "overview" ? <TeamOverviewView overview={overview} /> : view === "members" ? canAdmin ? <MembersView workspaceId={workspaceId} members={members} projects={projectOptions} onReload={reload} /> : <TeamMemberDirectory members={overview.members} /> : view === "permissions" ? <TeamPermissionsView permissions={permissions} /> : view === "activity" ? <TeamActivityView activity={activity} /> : canAdmin && view === "invitations" ? <InvitationsGovernanceView workspaceId={workspaceId} invitations={invitations} projects={projectOptions} onReload={reload} /> : canAdmin && view === "oidc" ? <OidcView workspaceId={workspaceId} providers={providers} onReload={reload} /> : canAdmin ? <TeamSettingsView onSelect={selectView} /> : <TeamOverviewView overview={overview} />}</div> : null}</div></main>;
}

function TeamOverviewView({ overview }: { overview: TeamOverviewPayload }) {
  return <div className="grid gap-7 lg:grid-cols-[1.15fr_.85fr]"><section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><div className="flex items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Projects</p><h2 className="mt-2 text-2xl font-semibold">团队项目</h2></div><span className="text-xs text-slate-400">{overview.counts.projects} 个可访问项目</span></div>{overview.projects.length === 0 ? <p className="mt-8 rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">当前没有分配给你的项目。</p> : <div className="mt-5 space-y-3">{overview.projects.map((project) => <a key={project.id} href={`/projects/${project.id}`} className="block rounded-2xl border border-slate-100 p-4 transition hover:border-violet-200 hover:bg-violet-50/40"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><h3 className="truncate font-semibold text-slate-900">{project.name}</h3><p className="mt-1 line-clamp-1 text-xs text-slate-500">{project.description || "暂无项目描述"}</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${project.archivedAt ? "bg-slate-100 text-slate-500" : "bg-emerald-50 text-emerald-700"}`}>{project.archivedAt ? "已归档" : "进行中"}</span></div><p className="mt-3 text-xs text-slate-400">{project._count.sources} 个资料源 · {project._count.items} 条已确认条目</p></a>)}</div>}</section><section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><div className="flex items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Members</p><h2 className="mt-2 text-2xl font-semibold">团队成员</h2></div><span className="text-xs text-slate-400">{overview.counts.memberships} 人</span></div><div className="mt-5 space-y-3">{overview.members.slice(0, 8).map((member) => <div key={member.userId} className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3"><div><p className="text-sm font-semibold text-slate-800">{member.displayName || member.username}</p><p className="mt-1 text-xs text-slate-400">@{member.username}</p></div><span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600">{member.role}</span></div>)}</div></section></div>;
}

function TeamMemberDirectory({ members }: { members: TeamOverviewPayload["members"] }) {
  return <section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Members</p><h2 className="mt-2 text-2xl font-semibold">团队成员</h2><div className="mt-6 grid gap-3 md:grid-cols-2">{members.map((member) => <div key={member.userId} className="flex items-center justify-between rounded-2xl border border-slate-100 px-4 py-4"><div><p className="text-sm font-semibold text-slate-800">{member.displayName || member.username}</p><p className="mt-1 text-xs text-slate-400">@{member.username}</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{member.role}</span></div>)}</div></section>;
}

function TeamPermissionsView({ permissions }: { permissions: TeamPermissionsPayload | null }) {
  if (permissions === null) return <section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-sm text-slate-500">权限信息暂不可用。</p></section>;
  return <section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Access</p><h2 className="mt-2 text-2xl font-semibold">我的项目权限</h2><p className="mt-3 text-sm text-slate-500">权限来自团队角色或项目单独授权，项目列表已经按服务端实际访问结果过滤。</p>{permissions.projects.length === 0 ? <p className="mt-7 rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">当前没有可访问的项目。</p> : <div className="mt-6 overflow-hidden rounded-2xl border border-slate-100"><div className="grid grid-cols-[1fr_auto_auto] gap-4 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-500"><span>项目</span><span>权限</span><span>来源</span></div>{permissions.projects.map((entry) => <a key={entry.project.id} href={`/projects/${entry.project.id}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-t border-slate-100 px-4 py-4 text-sm hover:bg-violet-50/40"><span className="font-semibold text-slate-800">{entry.project.name}</span><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">{entry.permission}</span><span className="text-xs text-slate-400">{entry.source === "workspace-role" ? "团队角色" : "项目授权"}</span></a>)}</div>}</section>;
}

function TeamActivityView({ activity }: { activity: TeamActivityPayload | null }) {
  if (activity === null) return <section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-sm text-slate-500">活动记录暂不可用。</p></section>;
  return <section className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Activity</p><h2 className="mt-2 text-2xl font-semibold">团队活动记录</h2><p className="mt-3 text-sm text-slate-500">记录来自成员访问、邀请和角色治理审计；敏感原因和凭据不会展示。</p>{activity.activity.length === 0 ? <p className="mt-7 rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">暂时没有已记录的团队活动。</p> : <div className="mt-6 space-y-3">{activity.activity.map((entry) => <div key={`${entry.kind}-${entry.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-100 px-4 py-4"><div><p className="text-sm font-semibold text-slate-800">{entry.label}</p>{entry.project ? <p className="mt-1 text-xs text-slate-500">项目：{entry.project.name}</p> : null}</div><time className="text-xs text-slate-400" dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString("zh-CN")}</time></div>)}</div>}</section>;
}

function TeamSettingsView({ onSelect }: { onSelect: (view: WorkspaceTeamView) => void }) {
  return <section className="grid gap-5 md:grid-cols-2"><button type="button" onClick={() => onSelect("members")} className="rounded-3xl border border-slate-200 bg-white p-7 text-left shadow-sm transition hover:border-violet-200"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Members</p><h2 className="mt-2 text-xl font-semibold">成员与角色</h2><p className="mt-3 text-sm leading-6 text-slate-500">管理成员、项目授权和角色治理。</p></button><button type="button" onClick={() => onSelect("invitations")} className="rounded-3xl border border-slate-200 bg-white p-7 text-left shadow-sm transition hover:border-violet-200"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Invitations</p><h2 className="mt-2 text-xl font-semibold">邀请成员</h2><p className="mt-3 text-sm leading-6 text-slate-500">查看和创建团队邀请。</p></button><button type="button" onClick={() => onSelect("oidc")} className="rounded-3xl border border-slate-200 bg-white p-7 text-left shadow-sm transition hover:border-violet-200"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Enterprise identity</p><h2 className="mt-2 text-xl font-semibold">企业 OIDC</h2><p className="mt-3 text-sm leading-6 text-slate-500">管理团队的企业身份源。</p></button></section>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-xs font-semibold text-slate-400">{label}</p><strong className="mt-2 block text-3xl">{value}</strong></div>; }

function MembersView({ workspaceId, members, projects, onReload }: { workspaceId: string; members: Member[]; projects: Project[]; onReload: () => Promise<void> }) {
  return <div className="grid gap-7 xl:grid-cols-[.72fr_1.28fr]"><MemberForm workspaceId={workspaceId} projects={projects} onReload={onReload} /><section><div className="mb-4 flex items-end justify-between px-1"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Members</p><h2 className="mt-2 text-2xl font-semibold">工作区成员</h2></div><span className="text-xs text-slate-400">{members.length} 人</span></div><div className="space-y-4">{members.map((member) => <MemberCard key={member.userId} workspaceId={workspaceId} member={member} onReload={onReload} />)}</div></section></div>;
}

function MemberForm({ workspaceId, projects, onReload }: { workspaceId: string; projects: Project[]; onReload: () => Promise<void> }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [displayName, setDisplayName] = useState(""); const [email, setEmail] = useState(""); const [role, setRole] = useState<"member" | "viewer">("member"); const [projectId, setProjectId] = useState(""); const [projectRole, setProjectRole] = useState<"editor" | "viewer">("editor"); const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setMessage(null); try { const response = await fetch(`/api/workspaces/${workspaceId}/members`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, displayName: displayName || null, email: email || null, workspaceRole: role, projectGrants: projectId ? [{ projectId, role: projectRole }] : [] }) }); if (!response.ok) throw new Error(await responseError(response, "成员创建失败")); setUsername(""); setPassword(""); setDisplayName(""); setEmail(""); setProjectId(""); setMessage("本地成员已创建，密码请通过安全渠道单独告知。"); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "成员创建失败"); } finally { setPending(false); } }
  return <form onSubmit={submit} autoComplete="off" className="h-fit rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Local account</p><h2 className="mt-2 text-2xl font-semibold">添加本地成员</h2><Input label="登录名" name="new-member-username" autoComplete="off" value={username} onChange={setUsername} required /><Input label="显示名称" name="new-member-display-name" autoComplete="off" value={displayName} onChange={setDisplayName} /><Input label="邮箱（用于邀请校验；OIDC 身份需单独绑定）" name="new-member-email" autoComplete="off" value={email} onChange={setEmail} type="email" /><Input label="初始密码（至少 12 位，含字母和数字）" name="new-member-password" autoComplete="new-password" value={password} onChange={setPassword} type="password" required /><Select label="工作区角色" value={role} onChange={(value) => setRole(value as typeof role)} options={[['member','Member：仅访问授权项目'],['viewer','Viewer：仅访问授权项目']]} /><Select label="初始项目（可选）" value={projectId} onChange={setProjectId} options={[["","暂不授权项目"], ...projects.map((project) => [project.id, project.name])]} />{projectId ? <Select label="项目角色" value={projectRole} onChange={(value) => setProjectRole(value as "editor" | "viewer")} options={[['editor','Editor'],['viewer','Viewer']]} /> : null}{message ? <p role="status" className="mt-4 text-xs text-slate-600">{message}</p> : null}<button disabled={pending} className="mt-6 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? "创建中…" : "创建成员"}</button></form>;
}

function MemberCard({ workspaceId, member, onReload }: { workspaceId: string; member: Member; onReload: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [targetRole, setTargetRole] = useState<WorkspaceRole>(member.role);
  const [reason, setReason] = useState("");
  const [confirmationUsername, setConfirmationUsername] = useState("");
  const [preview, setPreview] = useState<Readonly<{
    previewId: string;
    current: { role: WorkspaceRole; membershipId: string };
    target: { role: WorkspaceRole; ownerCount: number; projectGrantCount: number; permissionReduction: boolean };
    ownerCount: number;
    ownerCountAfter: number;
    projectGrantCount: number;
    projectGrantFingerprint: string;
    membershipFingerprint: string;
    requestFingerprint: string;
    impactFingerprint: string;
    requestKey: string;
    issuedAt: string;
    expiresAt: string;
  }> | null>(null);
  const requestRef = useRef<{ fingerprint: string; key: string } | null>(null);

  function changeRole(role: WorkspaceRole) {
    setTargetRole(role);
    setPreview(null);
    setConfirmationUsername("");
    setMessage(null);
  }

  function changeReason(value: string) {
    setReason(value);
    setPreview(null);
    setConfirmationUsername("");
  }

  async function createPreview() {
    if (targetRole === member.role) {
      setMessage("请选择与当前角色不同的目标角色。");
      return;
    }
    if (reason.trim().length === 0) {
      setMessage("角色变更必须填写独立原因。");
      return;
    }
    const fingerprint = JSON.stringify([member.userId, targetRole, reason.trim()]);
    if (requestRef.current === null || requestRef.current.fingerprint !== fingerprint) {
      requestRef.current = { fingerprint, key: globalThis.crypto.randomUUID() };
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/members/${member.userId}/role/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetRole, reason: reason.trim(), requestKey: requestRef.current.key }),
      });
      if (!response.ok) throw new Error(await responseError(response, "角色变更预览失败"));
      const payload = await response.json() as { preview: typeof preview };
      setPreview(payload.preview);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "角色变更预览失败");
    } finally {
      setPending(false);
    }
  }

  async function executePreview() {
    if (preview === null || confirmationUsername !== member.user.username) {
      setMessage("请输入目标用户名以确认执行。");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/members/${member.userId}/role/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          previewId: preview.previewId,
          currentRole: preview.current.role,
          targetRole: preview.target.role,
          reason: reason.trim(),
          requestKey: preview.requestKey,
          requestFingerprint: preview.requestFingerprint,
          expectedImpactFingerprint: preview.impactFingerprint,
          expectedOwnerCount: preview.ownerCount,
          expectedProjectGrantCount: preview.projectGrantCount,
          expectedProjectGrantFingerprint: preview.projectGrantFingerprint,
          expectedMembershipFingerprint: preview.membershipFingerprint,
          previewIssuedAt: preview.issuedAt,
          previewExpiresAt: preview.expiresAt,
          confirmation: true,
          confirmationUsername,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "角色变更执行失败"));
      setPreview(null);
      setReason("");
      setConfirmationUsername("");
      setTargetRole(member.role);
      requestRef.current = null;
      await onReload();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "角色变更执行失败");
    } finally {
      setPending(false);
    }
  }

  return <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">{member.user.displayName || member.user.username}</h3><span className="rounded-full bg-violet-50 px-2.5 py-1 text-[12px] font-semibold text-violet-700">{member.role}</span><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${member.accessState === "confirmed" ? "bg-emerald-50 text-emerald-700" : member.accessState === "pending" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"}`}>{member.accessState === "confirmed" ? "已确认" : member.accessState === "pending" ? "待审核" : "已撤销"}</span>{member.user.disabledAt ? <span className="rounded-full bg-rose-50 px-2.5 py-1 text-[12px] font-semibold text-rose-700">全局已停用</span> : null}</div><p className="mt-2 text-xs text-slate-500">@{member.user.username}{member.user.email ? ` · ${member.user.email}` : ""}</p><p className="mt-2 text-xs text-slate-400">{member.projectGrants.length > 0 ? `${member.projectGrants.length} 个项目授权` : "无单独项目授权"}{member.user.oidcIdentities.length > 0 ? ` · 已关联 ${member.user.oidcIdentities.map((identity) => identity.provider.name).join("、")}` : " · 本地账号"}</p></div><div className="flex gap-2"><select value={targetRole} onChange={(event) => changeRole(event.target.value as WorkspaceRole)} disabled={pending || member.accessState !== "confirmed"} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold"><option value="owner">Owner</option><option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option></select></div></div>{targetRole !== member.role ? <div className="mt-4 rounded-2xl bg-slate-50 p-4"><label className="block text-xs font-semibold text-slate-600">变更原因（必填）<textarea value={reason} onChange={(event) => changeReason(event.target.value)} maxLength={500} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" rows={3} /></label><button type="button" onClick={() => void createPreview()} disabled={pending} className="mt-3 rounded-xl bg-slate-950 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{pending ? "生成中…" : "生成角色变更预览"}</button></div> : null}{preview ? <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50 p-4"><p className="text-xs font-semibold text-violet-900">{preview.current.role} → {preview.target.role} · Owner 数量 {preview.ownerCount} → {preview.ownerCountAfter}</p><p className="mt-1 text-xs text-violet-800">当前项目授权 {preview.projectGrantCount} 项{preview.target.permissionReduction ? "；权限将下降" : ""}</p><p className="mt-1 text-xs text-violet-700">预览有效至 {new Date(preview.expiresAt).toLocaleTimeString("zh-CN")}</p><label className="mt-3 block text-xs font-semibold text-violet-900">输入 @{member.user.username} 确认<input value={confirmationUsername} onChange={(event) => setConfirmationUsername(event.target.value)} className="mt-2 w-full rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm" /></label><button type="button" onClick={() => void executePreview()} disabled={pending || confirmationUsername !== member.user.username} className="mt-3 rounded-xl bg-violet-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{pending ? "执行中…" : "确认并执行"}</button></div> : null}{message ? <p className="mt-3 text-xs text-rose-600">{message}</p> : null}</article>;
}

function InvitationsGovernanceView({ workspaceId, invitations, projects, onReload }: { workspaceId: string; invitations: Invitation[]; projects: Project[]; onReload: () => Promise<void> }) {
  const { confirm, dialog } = useAppConfirmDialog();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [projectId, setProjectId] = useState("");
  const [link, setLink] = useState<string | null>(null);
 const [message, setMessage] = useState<string | null>(null);
 const [pending, setPending] = useState(false);
 const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const createRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const revokeRequestRef = useRef(new Map<string, { fingerprint: string; key: string }>());

  const status = useCallback((invitation: Invitation): "pending" | "accepted" | "revoked" | "expired" => {
    if (invitation.revokedAt !== null) return "revoked";
    if (invitation.acceptedAt !== null) return "accepted";
    return new Date(invitation.expiresAt) <= new Date() ? "expired" : "pending";
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
   const normalizedEmail = email.trim().toLowerCase();
   if (normalizedEmail.length === 0) { setMessage("邮箱为必填项，邀请必须绑定到具体账户。"); return; }
    const formFingerprint = normalizedEmail + "|" + role + "|" + (projectId || "");
    if (createRequestRef.current === null || createRequestRef.current.fingerprint !== formFingerprint) {
      createRequestRef.current = { fingerprint: formFingerprint, key: globalThis.crypto.randomUUID() };
    }
   setPending(true); setMessage(null); setLink(null);
   try {
      const requestKey = createRequestRef.current.key;
      const response = await fetch(`/api/workspaces/${workspaceId}/invitations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: normalizedEmail, workspaceRole: role, projectId: projectId || null, projectRole: projectId ? "viewer" : null, expiresInDays: 7, requestKey }) });
     if (!response.ok) throw new Error(await responseError(response, "邀请创建失败"));
     const result = await response.json() as { acceptPath: string | null; alreadyCreated: boolean };
     if (result.acceptPath === null) setMessage("该请求已经创建过邀请。出于安全原因，明文邀请链接不会再次显示，请使用首次返回的链接。");
     else { setLink(`${window.location.origin}${result.acceptPath}`); setMessage("邀请链接只在本次创建后显示，请立即复制并安全发送。"); }
      createRequestRef.current = null;
     await onReload();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "邀请创建失败"); }
    finally { setPending(false); }
  }

  async function revoke(invitation: Invitation) {
    if (status(invitation) !== "pending" || pendingRevokeId !== null) return;
    setPendingRevokeId(invitation.id); setMessage(null);
    try {
      const impactResponse = await fetch(`/api/workspaces/${workspaceId}/invitations/${invitation.id}/impact`, { cache: "no-store" });
      if (!impactResponse.ok) throw new Error(await responseError(impactResponse, "邀请影响预览失败"));
     const impact = await impactResponse.json() as { expectedVersion: number; impactFingerprint: string; blockingCategories: string[] };
     if (impact.blockingCategories.length > 0) throw new Error(`当前邀请状态不能撤销：${impact.blockingCategories.join("、")}`);
     const confirmation = await confirm({ eyebrow: "Invitation lifecycle", title: `撤销发给 ${invitation.email ?? "该邮箱"} 的邀请`, description: invitation.project ? `将撤销工作区 ${invitation.workspaceRole} 与项目「${invitation.project.name}」邀请。此操作不可恢复。` : `将撤销工作区 ${invitation.workspaceRole} 邀请，且不会改变现有成员或项目权限。此操作不可恢复。`, inputLabel: "撤销原因（必填）", inputPlaceholder: "例如：收件人变更或邀请范围有误", inputOptional: false, confirmLabel: "确认撤销邀请", tone: "danger", maxLength: 500 });
     if (!confirmation.confirmed) return;
      // Keep a key stable for a network retry, but rotate it when the user
      // materially changes the revoke form (the reason) or when a fresh
      // impact preview changes the operation snapshot.
      const requestFingerprint = JSON.stringify([invitation.id, impact.impactFingerprint, confirmation.value.trim()]);
      const existingRequest = revokeRequestRef.current.get(requestFingerprint) ?? { fingerprint: requestFingerprint, key: globalThis.crypto.randomUUID() };
      revokeRequestRef.current.set(requestFingerprint, existingRequest);
      const response = await fetch(`/api/workspaces/${workspaceId}/invitations/${invitation.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: confirmation.value, requestKey: existingRequest.key, expectedVersion: impact.expectedVersion, expectedImpactFingerprint: impact.impactFingerprint, confirmation: true }) });
     if (!response.ok) throw new Error(await responseError(response, "邀请撤销失败"));
      revokeRequestRef.current.delete(requestFingerprint);
      setMessage("邀请已撤销，原链接立即失效。");
      await onReload();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "邀请撤销失败"); }
    finally { setPendingRevokeId(null); }
  }

  return <>{dialog}<div className="grid gap-7 xl:grid-cols-[.72fr_1.28fr]"><form onSubmit={(event) => void create(event)} className="h-fit rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Invitation</p><h2 className="mt-2 text-2xl font-semibold">创建邀请链接</h2><p className="mt-3 text-sm leading-6 text-slate-500">邀请必须绑定到邮箱。新邀请仅支持工作区 Member/Viewer，以及项目 Editor/Viewer；Owner/Admin 变更需走治理流程。</p><Input label="邮箱（必填）" value={email} onChange={setEmail} type="email" required /><Select label="工作区角色" value={role} onChange={(value) => setRole(value as typeof role)} options={[['member','Member'],['viewer','Viewer']]} /><Select label="同时授权项目（可选）" value={projectId} onChange={setProjectId} options={[["","无"], ...projects.map((project) => [project.id, project.name])]} /><button disabled={pending} className="mt-6 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{pending ? "创建中…" : "生成 7 天邀请"}</button>{link ? <div className="mt-4 rounded-xl bg-slate-50 p-3"><code className="break-all text-xs text-slate-600">{link}</code><button type="button" onClick={() => void navigator.clipboard.writeText(link)} className="mt-3 block text-xs font-semibold text-indigo-600">复制链接</button></div> : null}{message ? <p role="status" className="mt-3 text-xs text-slate-600">{message}</p> : null}</form><section><div className="flex items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Invitation lifecycle</p><h2 className="mt-2 text-2xl font-semibold">邀请记录</h2></div><span className="text-xs text-slate-400">{invitations.length} 条</span></div><div className="mt-4 space-y-3">{invitations.length === 0 ? <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">还没有邀请记录。</div> : invitations.map((invitation) => { const invitationStatus = status(invitation); return <div key={invitation.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex flex-wrap justify-between gap-4"><div><p className="font-semibold">{invitation.email ?? "历史未绑定邮箱邀请"}</p><p className="mt-1 text-xs text-slate-500">工作区 {invitation.workspaceRole}{invitation.project ? ` · 项目 ${invitation.project.name} / ${invitation.projectRole}` : ""}</p><p className="mt-1 text-xs text-slate-400">创建者 @{invitation.invitedBy.username} · 版本 {invitation.version}</p></div><div className="flex items-start gap-3"><span className={`rounded-full px-3 py-1 text-xs font-semibold ${invitationStatus === "pending" ? "bg-amber-50 text-amber-700" : invitationStatus === "accepted" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{invitationStatus === "pending" ? "待使用" : invitationStatus === "accepted" ? "已接受" : invitationStatus === "revoked" ? "已撤销" : "已过期"}</span>{invitationStatus === "pending" ? <button type="button" onClick={() => void revoke(invitation)} disabled={pendingRevokeId !== null} className="rounded-xl border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50">{pendingRevokeId === invitation.id ? "处理中…" : "撤销"}</button> : null}</div></div><p className="mt-3 text-xs text-slate-400">{new Date(invitation.expiresAt).toLocaleDateString("zh-CN")} 到期</p></div>; })}</div></section></div></>;
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

type OidcCardProps = { workspaceId: string; provider: OidcProvider; onReload: () => Promise<void> };

function OidcCard(props: OidcCardProps) {
  const { confirm, dialog } = useAppConfirmDialog();
  return <>{dialog}<OidcCardContent {...props} confirm={confirm} /></>;
}

function OidcCardContent({ workspaceId, provider, onReload, confirm }: OidcCardProps & { confirm: ReturnType<typeof useAppConfirmDialog>["confirm"] }) {
  const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function patch(body: unknown) { setPending(true); setMessage(null); try { const response = await fetch(`/api/workspaces/${workspaceId}/oidc-providers/${provider.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await responseError(response, "OIDC 更新失败")); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "OIDC 更新失败"); } finally { setPending(false); } }
  async function remove() {
    const confirmation = await confirm({
      eyebrow: "Identity provider lifecycle",
      title: `永久删除「${provider.name}」`,
      description: "永久删除会移除 OIDC 配置与 Client Secret，且不可恢复。已有成员身份绑定时系统会拒绝删除。",
      inputLabel: `输入身份源名称「${provider.name}」以确认`,
      requiredValue: provider.name,
      confirmLabel: "确认永久删除",
      tone: "danger",
    });
    if (!confirmation.confirmed) return;
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/oidc-providers/${provider.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationName: confirmation.value, expectedUpdatedAt: provider.updatedAt }) });
      if (!response.ok) throw new Error(await responseError(response, "OIDC 永久删除失败"));
      await onReload();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "OIDC 永久删除失败"); }
    finally { setPending(false); }
  }
  const loginScope = provider.status === "verified" ? "当前工作区登录已验证" : provider.status === "disabled" ? "当前工作区登录已停用" : "当前工作区登录待验证";
  const autoJoinScope = provider.status === "disabled" ? "自动加入已停用" : provider.status === "verified" && provider.autoProvision ? "自动加入已开启" : provider.autoProvision ? "自动加入待验证" : "自动加入已关闭";
  const memberScope = provider.status === "verified" && provider.autoProvision ? "项目不适用 · 工作区成员 · 自动加入账户（已验证邮箱）" : provider.autoProvision ? "项目不适用 · 工作区成员 · 自动加入账户（待验证）" : "项目不适用 · 工作区成员 · 自动加入账户（当前关闭）";
  return <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap justify-between gap-4"><div><div className="flex items-center gap-2"><h3 className="text-lg font-semibold">{provider.name}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${provider.status === "verified" ? "bg-emerald-50 text-emerald-700" : provider.status === "disabled" ? "bg-slate-100 text-slate-500" : "bg-rose-50 text-rose-700"}`}>{provider.status}</span></div><p className="mt-2 max-w-lg truncate text-xs text-slate-500">{provider.issuerUrl}</p><p className="mt-2 text-xs text-slate-400">{provider.tokenAuthMethod === "clientSecretBasic" ? "client_secret_basic" : "client_secret_post"} · {provider.allowPrivateNetwork ? "内网已授权" : "仅公网 HTTPS"}</p><p className="mt-1 text-xs text-slate-400">自动加入：{provider.autoProvision ? (provider.allowedEmailDomains.length ? provider.allowedEmailDomains.join("、") : "任意已验证邮箱") : "关闭"}</p></div><div className="flex flex-wrap gap-2">{provider.status !== "disabled" ? <><button onClick={() => void patch({ rediscover: true })} disabled={pending} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold">重新验证</button><button onClick={() => void patch({ enabled: false })} disabled={pending} className="rounded-xl px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100">停用</button></> : <><button onClick={() => void patch({ enabled: true })} disabled={pending} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">启用</button><button onClick={() => void remove()} disabled={pending} className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white">永久删除</button></>}</div></div><div className="mt-5"><ScopeEvidenceCard title="工作区 OIDC 边界" evidence={{ scope: `${loginScope} · ${autoJoinScope}`, owner: "工作区管理员", payer: "不适用", affectedProjects: memberScope, latestSuccess: provider.lastTestedAt ? `最近验证：${new Date(provider.lastTestedAt).toLocaleString("zh-CN")}` : "尚未取得验证证据" }} /></div>{provider.status === "disabled" ? <p className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">已有成员身份绑定时系统会拒绝永久删除，避免用户失去唯一登录方式。</p> : null}{provider.lastErrorCode ? <p className="mt-3 text-xs text-rose-600">{provider.lastErrorCode}</p> : null}{message ? <p className="mt-3 text-xs text-rose-600">{message}</p> : null}</article>;
}

function Input({ label, name, autoComplete, value, onChange, type = "text", required = false }: { label: string; name?: string; autoComplete?: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean }) { return <label className="mt-5 block text-sm font-medium text-slate-700">{label}<input name={name} autoComplete={autoComplete} type={type} value={value} onChange={(event) => onChange(event.target.value)} required={required} className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-violet-400" /></label>; }
function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<readonly string[]> }) { return <label className="mt-5 block text-sm font-medium text-slate-700">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">{options.map(([key,name]) => <option key={key || "empty"} value={key ?? ""}>{name ?? key}</option>)}</select></label>; }
