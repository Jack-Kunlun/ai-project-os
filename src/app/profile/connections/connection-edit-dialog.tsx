"use client";

import { useState, type FormEvent } from "react";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { ConnectionCreateDialog, ConnectionDialogActions } from "./connection-create-dialog";

type Kind = "git" | "mcp";

/** Edit the safe display field; network and credential changes use governed actions. */
export function ConnectionEditDialog({ kind, connection, onClose, onSaved }: {
  kind: Kind;
  connection: Readonly<{ id: string; name: string; updatedAt: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(connection.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = `${kind}-connection-edit-form`;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/me/${kind}-connections/${encodeURIComponent(connection.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), expectedUpdatedAt: connection.updatedAt }),
      });
      if (!response.ok) throw new Error((await safeResponseError(response, "连接名称保存失败")).message);
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接名称保存失败");
    } finally {
      setPending(false);
    }
  }

  return <ConnectionCreateDialog title="编辑连接名称" onClose={onClose}>
    <form id={formId} onSubmit={(event) => void save(event)} className="space-y-4">
      <label className="block text-sm font-semibold text-slate-700">连接名称
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} className="mt-2 min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal outline-none focus:border-indigo-300" />
      </label>
      <p className="text-xs leading-5 text-slate-500">凭据轮换、重新测试、停用等会影响安全证据的变更，请在连接详情中的安全治理区完成。</p>
      {error ? <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p> : null}
      <ConnectionDialogActions><button type="submit" form={formId} disabled={pending || !name.trim()} className="ml-auto min-h-10 rounded-xl bg-indigo-600 px-5 text-sm font-semibold text-white disabled:opacity-50">{pending ? "保存中…" : "保存修改"}</button></ConnectionDialogActions>
    </form>
  </ConnectionCreateDialog>;
}
