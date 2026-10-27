"use client";

import { useRef, useState } from "react";
import { UiErrorText } from "@/components/ui-error-text";
import { UiText, useTranslate } from "@/components/appearance-provider";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { notifyUserProjectsChanged } from "@/lib/user-navigation";

export type ProjectLifecycleAction = "archive" | "restore" | "delete";
export type ProjectLifecycleProject = Readonly<{ id: string; name: string; updatedAt: string }>;

export function ProjectLifecycleDialog({ project, action, onClose, onChanged, onRefresh = () => window.location.reload() }: { project: ProjectLifecycleProject; action: ProjectLifecycleAction; onClose: () => void; onChanged: (action: ProjectLifecycleAction) => void; onRefresh?: () => void }): React.JSX.Element {
  const t = useTranslate();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const pendingRef = useRef(false);
  const archive = action === "archive";
  const remove = action === "delete";
  const confirmed = action === "restore" || confirmation === project.name;

  async function submit() {
    if (!confirmed || pendingRef.current || needsRefresh) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(remove ? `/api/projects/${project.id}` : `/api/projects/${project.id}/lifecycle`, {
        method: remove ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(remove ? { confirmationName: confirmation, expectedUpdatedAt: project.updatedAt } : { action, expectedUpdatedAt: project.updatedAt }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
        if (response.status === 409 && payload?.error?.code === "PROJECT_LIFECYCLE_STALE") setNeedsRefresh(true);
        throw new Error(payload?.error?.message ?? (archive ? "项目归档失败" : remove ? "项目永久删除失败" : "项目恢复失败"));
      }
      notifyUserProjectsChanged();
      onChanged(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : archive ? "项目归档失败" : remove ? "项目永久删除失败" : "项目恢复失败");
      pendingRef.current = false;
      setPending(false);
    }
  }

  const title = t(archive ? "归档「{name}」" : remove ? "永久删除「{name}」" : "恢复「{name}」").replace("{name}", project.name);
  const description = t(archive
    ? "归档后项目将移出进行中列表，并拒绝修改和新任务。数据、历史审计和模型用量不会删除。"
    : remove
      ? "此操作不可恢复：项目资料、文件、仓库快照、候选、记忆索引、智能体记录和项目审计都会删除。建议先导出 JSON；系统仅保留不含项目名称或内容的最小删除回执。"
      : "恢复后项目会重新出现在进行中列表，并可继续修改资料、同步仓库和运行 AI 任务。");
  const actionLabel = pending ? "处理中…" : archive ? "确认归档" : remove ? "确认永久删除" : "恢复项目";

  return <WorkspaceDialog title={title} open onClose={() => { if (!pendingRef.current) onClose(); }} busy={pending} compact footer={<div className="ml-auto flex flex-wrap justify-end gap-3">
        <button data-dialog-close type="button" onClick={onClose} disabled={pending} className="rounded-lg border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-600"><UiText text={"取消"} /></button>
        {needsRefresh ? <button type="button" onClick={() => { onClose(); onRefresh(); }} className="rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white"><UiText text="重新读取项目" /></button> : null}
        <button type="button" onClick={() => void submit()} disabled={!confirmed || pending || needsRefresh} className={`rounded-lg px-5 py-3 text-sm font-semibold text-white disabled:opacity-40 ${remove ? "bg-rose-600" : archive ? "bg-amber-600" : "bg-indigo-600"}`}><UiText text={actionLabel} /></button>
      </div>}>
        <p className={`text-sm leading-6 ${remove ? "text-rose-700" : "text-slate-600"}`}>{description}</p>
        {archive || remove ? <label className="mt-5 block text-sm font-semibold text-slate-700"><UiText text={"输入项目名称以确认"} /><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={`mt-2 w-full rounded-lg border bg-white px-4 py-3 text-sm outline-none focus:ring-4 ${remove ? "border-rose-200 focus:border-rose-400 focus:ring-rose-100" : "border-slate-200 focus:border-amber-300 focus:ring-amber-100"}`} /></label> : null}
        {error ? <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{needsRefresh ? <UiText text="项目状态已变化，请重新读取后确认。" /> : <UiErrorText text={error} />}</p> : null}
    </WorkspaceDialog>;
}
