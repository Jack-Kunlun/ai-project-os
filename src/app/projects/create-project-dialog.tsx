"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { UiErrorText } from "@/components/ui-error-text";
import { UiText, useTranslate } from "@/components/appearance-provider";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { notifyUserProjectsChanged } from "@/lib/user-navigation";

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function CreateProjectDialog({ workspaceId, onClose, onCreated }: { workspaceId: string; onClose: () => void; onCreated: () => Promise<void> }) {
  const t = useTranslate();
  const pendingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspace, setWorkspace] = useState<{ id: string; name: string } | null>(null);
  const workspaceName = workspace?.id === workspaceId ? workspace.name : "";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/workspaces/current", { cache: "no-store", signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json() as { overview?: { workspace?: { id: string; name: string } }; availableWorkspaces?: Array<{ id: string; name: string }> };
        const spaces = [payload.overview?.workspace, ...(Array.isArray(payload.availableWorkspaces) ? payload.availableWorkspaces : [])];
        const target = spaces.find(space => space?.id === workspaceId && typeof space.name === "string");
        if (!controller.signal.aborted && target) setWorkspace(target);
      } catch { /* The current-workspace hint remains usable if the name cannot be read. */ }
    })();
    return () => controller.abort();
  }, [workspaceId]);


  const close = () => {
    if (!pendingRef.current) onCloseRef.current();
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    pendingRef.current = true;
    setPending(true); setError(null);
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description, workspaceId }) });
      if (!response.ok) throw new Error(t(await readError(response, "项目创建失败")));
      await onCreated();
      notifyUserProjectsChanged();
      onCloseRef.current();
    } catch (submitError) {
      setError(t(submitError instanceof Error ? submitError.message : "项目创建失败"));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return <WorkspaceDialog title="新建项目" open onClose={close} busy={pending} inquiryEnabled={false} compact closeLabel="关闭" footer={<div className="flex w-full flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-xs leading-5 text-app-muted [overflow-wrap:anywhere]">{workspaceName ? <><UiText text="创建在" /> <span>{workspaceName}</span></> : <UiText text="创建在当前工作区" />}</p>
        <div className="flex shrink-0 justify-end gap-4">
          <button data-dialog-close type="button" onClick={close} disabled={pending} className="app-button-secondary rounded-control border font-semibold"><UiText text="取消" /></button>
          <button type="submit" form="projects-create-form" disabled={pending || !name.trim()} className="app-button-primary rounded-control font-semibold disabled:opacity-50">{pending ? t("创建中…") : t("创建项目")}</button>
        </div>
      </div>}>
        <form id="projects-create-form" onSubmit={submit}>
          <label htmlFor="projects-project-name" className="text-sm font-semibold text-app-text"><UiText text="项目名称" /></label>
          <input id="projects-project-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required placeholder={t("给项目一个清晰的名字")} className="mt-2 w-full rounded-field border border-app-border bg-app-surface px-4 py-3 text-sm outline-none focus:border-app-accent-border focus:ring-4 focus:ring-app-accent-border app-field" />
          <label htmlFor="projects-project-description" className="mt-4 block text-sm font-semibold text-app-text"><UiText text="项目描述" /> <span className="font-normal text-app-muted"><UiText text="（可选）" /></span></label>
          <textarea id="projects-project-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={4} placeholder={t("这个项目要达成什么？")} className="mt-2 w-full resize-none rounded-field border border-app-border px-4 py-3 text-sm outline-none focus:border-app-accent-border focus:ring-4 focus:ring-app-accent-border app-field" />
          {error ? <p role="alert" className="mt-4 rounded-field bg-app-danger-soft px-4 py-3 text-sm text-app-danger-ink app-feedback-error"><UiErrorText text={error} /></p> : null}
        </form>
    </WorkspaceDialog>;
}
