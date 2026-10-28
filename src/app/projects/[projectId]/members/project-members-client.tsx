"use client";

import { DialogActions } from "@/components/dialog-actions";
import { UiErrorText } from "@/components/ui-error-text";


import { UiText, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { BackButton } from "@/components/back-button";
import { useAppConfirmDialog } from "@/components/app-confirm-dialog";
import { OperationPanel } from "@/components/operation-panel";
import { safeResponseError } from "@/lib/safe-error-presentation";
import styles from "./project-members.module.css";

type Member = Readonly<{
  userId: string; username: string; displayName: string | null;
  workspaceRole: string | null; membershipId: string | null;
  projectRole: "owner" | "editor" | "viewer" | null;
  inheritedOwner: boolean;
  canGrant: boolean;
}>;
type Payload = Readonly<{
  project: { id: string; name: string; workspaceId: string; membershipInheritanceMode: string };
  canManage: boolean; canManageWorkspace: boolean; members: Member[]; truncated: boolean;
}>;

export function ProjectMembersClient({ projectId, username, isSystemAdmin, embedded = false }: { projectId: string; username: string; isSystemAdmin: boolean; embedded?: boolean }) {
  const t = useTranslate();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<{ userId: string; message: string } | null>(null);
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

  async function save(member: Member, role: "editor" | "viewer" | null): Promise<boolean> {
    if (pendingUserId !== null || role === member.projectRole) return false;
    const decision = await confirm({
      eyebrow: "项目成员权限", title: role === null ? `移除 @${member.username} 的项目授权？` : `授予 @${member.username} ${role} 权限？`,
      description: "这只修改当前项目的显式授权。团队邀请、账号和团队角色仍在团队空间管理。请输入原因，变更会留下审计记录。",
      confirmLabel: role === null ? "确认移除" : "确认保存", tone: role === null ? "warning" : "primary",
      inputLabel: "变更原因", inputOptional: false, maxLength: 500,
    });
    if (!decision.confirmed) return false;
    setPendingUserId(member.userId); setError(null); setOperationError(null);
    try {
      const body = role === null
        ? { action: "revoke", expectedMembershipId: member.membershipId, reason: decision.value.trim() }
        : { action: "grant", role, expectedMembershipId: member.membershipId, reason: decision.value.trim() };
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(member.userId)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error((await safeResponseError(response, "项目权限保存失败")).message);
      await reload();
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "项目权限保存失败";
      setError(message); setOperationError({ userId: member.userId, message }); return false;
    }
    finally { setPendingUserId(null); }
  }

  const RootElement = embedded ? "section" : "main";
  return <RootElement className={embedded ? "text-slate-950" : "min-h-screen bg-[#f5f7fb] text-slate-950"}>
    {!embedded ? <AppHeader username={username} active="projects" projectId={projectId} projectSection="members" isSystemAdmin={isSystemAdmin} /> : null}
    {dialog}
    <div data-page-content={!embedded ? "" : undefined} className={embedded ? "" : "pb-16 pt-8"}>
      {!embedded ? <div className="mb-5"><BackButton fallbackHref={`/projects/${projectId}`} label="返回项目概览" /></div> : null}
      {!embedded ? <h1 className="text-3xl font-semibold"><UiText text={"成员权限"} /></h1> : null}
      <p className="mt-2 text-sm text-slate-600"><UiText text={"查看当前项目的有效权限并管理显式授权；团队级账号与邀请在团队空间处理。"} /></p>
      {error ? <p role="alert" className="mt-5 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700"><UiErrorText text={error} /></p> : null}
      {loading ? <p role="status" className="mt-7 text-sm text-slate-500"><UiText text={"正在加载成员…"} /></p> : payload ? <>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 bg-white p-5">
          <div><h2 className="text-lg font-semibold">{payload.project.name}</h2><p className="mt-1 text-xs text-slate-500">{payload.canManage ? <UiText text={"你拥有当前项目的 Owner 权限，可为已有团队成员设置 Editor 或 Viewer 权限。"} /> : <UiText text={"你可以查看当前项目已明确授权的成员。"} />}</p></div>
          {payload.canManage ? <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700"><UiText text={"我的权限：Owner"} /></span> : null}
          {payload.canManage && payload.canManageWorkspace ? <Link href={`/team/${encodeURIComponent(payload.project.workspaceId)}?view=invitations`} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-xs font-semibold text-indigo-700"><UiText text={"邀请成员与创建账号 →"} /></Link> : null}
        </div>
        {payload.truncated ? <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800"><UiText text={"团队成员选择列表只展示前 200 人；当前项目已有授权仍全部列出并可撤销。"} /></p> : null}
        {payload.members.length === 0 ? <p className="mt-6 rounded-md border border-dashed border-slate-200 bg-white p-8 text-sm text-slate-500"><UiText text={"当前没有可显示的项目成员。"} /></p> : <div className={`${styles.tableFrame} mt-5`}>
          <table role="table" aria-colcount={5} className={`${styles.membersTable} w-full border-collapse text-left text-sm`}>
            <thead role="rowgroup" className={styles.tableHead}><tr role="row" className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <th role="columnheader" scope="col" className="px-4 py-3 font-semibold"><UiText text={"成员"} /></th>
              <th role="columnheader" scope="col" className="px-4 py-3 font-semibold"><UiText text={"团队角色"} /></th>
              <th role="columnheader" scope="col" className="px-4 py-3 font-semibold"><UiText text={"有效权限"} /></th>
              <th role="columnheader" scope="col" className="px-4 py-3 font-semibold"><UiText text={"显式授权"} /></th>
              <th role="columnheader" scope="col" className="px-4 py-3 font-semibold"><UiText text={"操作"} /></th>
            </tr></thead>
            <tbody role="rowgroup">
              {payload.members.map((member) => <tr role="row" key={member.userId} className="border-b border-slate-100 last:border-0">
                <td role="cell" data-label={t("成员")} className="px-4 py-4"><p className="font-semibold">{member.displayName || member.username}</p><p className="mt-1 break-all text-xs text-slate-500">@{member.username}</p></td>
                <td role="cell" data-label={t("团队角色")} className="px-4 py-4 text-slate-600">{member.workspaceRole ?? "—"}</td>
                <td role="cell" data-label={t("有效权限")} className="px-4 py-4"><span className="font-medium">{member.inheritedOwner ? <UiText text={"Owner · 团队继承"} /> : member.projectRole ?? <UiText text={"无项目权限"} />}</span></td>
                <td role="cell" data-label={t("显式授权")} className="px-4 py-4 text-slate-600">{member.projectRole ? <>{member.projectRole}{member.inheritedOwner ? <p className="mt-1 text-xs text-slate-500"><UiText text={"团队继承权限优先。"} /></p> : null}</> : "—"}</td>
                <td role="cell" data-label={t("操作")} className="px-4 py-4">{payload.canManage && member.projectRole !== "owner" && !member.inheritedOwner ? <MemberRoleEditor key={member.membershipId ?? member.userId} member={member} disabled={pendingUserId !== null} error={operationError?.userId === member.userId ? operationError.message : null} onSave={(role) => save(member, role)} /> : <span className="text-slate-400">—</span>}</td>
              </tr>)}
            </tbody>
          </table>
        </div>}
      </> : null}
    </div>
  </RootElement>;
}

function MemberRoleEditor({ member, disabled, error, onSave }: { member: Member; disabled: boolean; error: string | null; onSave: (role: "editor" | "viewer" | null) => Promise<boolean> }) {
  const [role, setRole] = useState<"editor" | "viewer" | "">(member.projectRole === "editor" || member.projectRole === "viewer" ? member.projectRole : "");
  const [open, setOpen] = useState(false);
  return <OperationPanel title={`编辑 @${member.username} 的项目权限`} triggerLabel="编辑权限" open={open} onOpenChange={setOpen} disabled={disabled} description="只修改当前项目的显式授权，变更原因和操作人会写入审计记录。">
    <div>
      <label className="block text-sm font-semibold text-slate-700"><UiText text={"项目权限"} /><select value={role} onChange={(event) => setRole(event.target.value as typeof role)} disabled={disabled} className="mt-2 block min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 font-normal"><option value=""><UiText text={"不单独授权"} /></option>{member.canGrant || member.projectRole === "viewer" ? <option value="viewer" disabled={!member.canGrant}><UiText text={"Viewer · 查看"} /></option> : null}{member.canGrant || member.projectRole === "editor" ? <option value="editor" disabled={!member.canGrant}><UiText text={"Editor · 编辑"} /></option> : null}</select></label>
      {!member.canGrant ? <p className="mt-3 text-xs text-amber-700"><UiText text={"该成员已离开团队或账号停用，只能撤销现有项目授权。"} /></p> : null}
      {error ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700"><UiErrorText text={error} /></p> : null}
      <DialogActions><button type="button" disabled={disabled || (role || null) === member.projectRole} onClick={async () => { if (await onSave(role || null)) setOpen(false); }} className="app-action-button app-action-button--compact rounded-xl bg-indigo-600 font-semibold text-white disabled:opacity-50"><UiText text={"保存权限"} /></button></DialogActions>
    </div>
  </OperationPanel>;
}
