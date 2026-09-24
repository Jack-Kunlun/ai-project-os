"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { safeResponseError } from "@/lib/safe-error-presentation";

type Member = Readonly<{
  userId: string; username: string; displayName: string | null;
  workspaceRole: string | null; membershipId: string | null;
  projectRole: "owner" | "editor" | "viewer" | null;
  inheritedOwner: boolean;
  canGrant: boolean;
}>;
type Payload = Readonly<{
  project: { id: string; name: string; workspaceId: string; membershipInheritanceMode: string };
  canManage: boolean; members: Member[]; truncated: boolean;
}>;

export function ProjectMembersClient({ projectId, username, isSystemAdmin }: { projectId: string; username: string; isSystemAdmin: boolean }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const { confirm, dialog } = useAppConfirmDialog();

  const reload = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, { cache: "no-store" });
      if (!response.ok) throw new Error((await safeResponseError(response, "项目成员加载失败")).message);
      setPayload(await response.json() as Payload);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "项目成员加载失败"); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { const timer = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(timer); }, [reload]);

  async function save(member: Member, role: "editor" | "viewer" | null) {
    if (pendingUserId !== null || role === member.projectRole) return;
    const decision = await confirm({
      eyebrow: "项目成员权限", title: role === null ? `移除 @${member.username} 的项目授权？` : `授予 @${member.username} ${role} 权限？`,
      description: "这只修改当前项目的显式授权。团队邀请、账号和团队角色仍在团队空间管理。请输入原因，变更会留下审计记录。",
      confirmLabel: role === null ? "确认移除" : "确认保存", tone: role === null ? "warning" : "primary",
      inputLabel: "变更原因", inputOptional: false, maxLength: 500,
    });
    if (!decision.confirmed) return;
    setPendingUserId(member.userId); setError(null);
    try {
      const body = role === null
        ? { action: "revoke", expectedMembershipId: member.membershipId, reason: decision.value.trim() }
        : { action: "grant", role, expectedMembershipId: member.membershipId, reason: decision.value.trim() };
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(member.userId)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error((await safeResponseError(response, "项目权限保存失败")).message);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "项目权限保存失败"); }
    finally { setPendingUserId(null); }
  }

  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
    <AppHeader username={username} active="projects" projectId={projectId} projectSection="members" isSystemAdmin={isSystemAdmin} />
    {dialog}
    <div className="mx-auto max-w-7xl px-5 pb-16 pt-8 sm:px-8 lg:px-10">
      <h1 className="text-3xl font-semibold">项目成员与权限</h1>
      <p className="mt-2 text-sm text-slate-600">查看当前项目的有效权限并管理显式授权；团队级账号与邀请在团队空间处理。</p>
      {error ? <p role="alert" className="mt-5 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
      {loading ? <p role="status" className="mt-7 text-sm text-slate-500">正在加载成员…</p> : payload ? <>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5">
          <div><h2 className="text-lg font-semibold">{payload.project.name}</h2><p className="mt-1 text-xs text-slate-500">{payload.canManage ? "选择团队成员并设置当前项目的 Editor 或 Viewer 权限。团队 Owner/Admin 继承项目 Owner 权限，需在团队空间修改团队角色。" : "你可以查看当前项目已明确授权的成员。"}</p></div>
          <Link href={`/team/${encodeURIComponent(payload.project.workspaceId)}`} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-xs font-semibold text-indigo-700">团队空间 · 邀请与账号 →</Link>
        </div>
        {payload.truncated ? <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">团队成员选择列表只展示前 200 人；当前项目已有授权仍全部列出并可撤销。</p> : null}
        {payload.members.length === 0 ? <p className="mt-6 rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-sm text-slate-500">当前没有可显示的项目成员。</p> : <ul className="mt-5 grid gap-3 md:grid-cols-2">{payload.members.map((member) => <li key={member.userId} className="rounded-2xl border border-slate-200 bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{member.displayName || member.username}</h3><p className="mt-1 text-xs text-slate-500">@{member.username}{member.workspaceRole ? ` · 团队 ${member.workspaceRole}` : ""}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">有效权限：{member.inheritedOwner ? "Owner · 团队继承" : member.projectRole ?? "无项目权限"}</span></div>{member.inheritedOwner && member.projectRole ? <p className="mt-2 text-xs text-slate-500">另有显式项目授权：{member.projectRole}；团队继承权限优先。</p> : null}{payload.canManage && member.projectRole !== "owner" && !member.inheritedOwner ? <MemberRoleEditor key={member.membershipId ?? member.userId} member={member} disabled={pendingUserId !== null} onSave={(role) => void save(member, role)} /> : null}</li>)}</ul>}
      </> : null}
    </div>
  </main>;
}

function MemberRoleEditor({ member, disabled, onSave }: { member: Member; disabled: boolean; onSave: (role: "editor" | "viewer" | null) => void }) {
  const [role, setRole] = useState<"editor" | "viewer" | "">(member.projectRole === "editor" || member.projectRole === "viewer" ? member.projectRole : "");
  return <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4"><label className="min-w-40 flex-1 text-xs font-semibold text-slate-700">项目权限<select value={role} onChange={(event) => setRole(event.target.value as typeof role)} disabled={disabled} className="mt-1 block min-h-10 w-full rounded-xl border border-slate-200 bg-white px-3 font-normal"><option value="">不单独授权</option>{member.canGrant || member.projectRole === "viewer" ? <option value="viewer" disabled={!member.canGrant}>Viewer · 查看</option> : null}{member.canGrant || member.projectRole === "editor" ? <option value="editor" disabled={!member.canGrant}>Editor · 编辑</option> : null}</select></label><button type="button" disabled={disabled || (role || null) === member.projectRole} onClick={() => onSave(role || null)} className="min-h-10 rounded-xl bg-indigo-600 px-4 text-xs font-semibold text-white disabled:opacity-50">保存权限</button>{!member.canGrant ? <p className="w-full text-xs text-amber-700">该成员已离开团队或账号停用，只能撤销现有项目授权。</p> : null}</div>;
}
