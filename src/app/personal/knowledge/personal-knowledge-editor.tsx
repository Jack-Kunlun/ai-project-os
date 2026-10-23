import { UiErrorText, UiFeedbackText } from "@/components/ui-error-text";
import { UiText, useTranslate } from "@/components/appearance-provider";
import { ShellIcon } from "@/components/shell-icon";
import type { FormEvent } from "react";

export type KnowledgeDraft = Readonly<{ title: string; content: string; isDefaultMemory: boolean }>;

/** Keep client validation aligned with the service limits before submitting. */
export function validateKnowledgeDraft(draft: KnowledgeDraft): string | null {
  if (draft.title.trim().length === 0 || draft.content.trim().length === 0) return "请填写标题和正文。";
  if (draft.isDefaultMemory && draft.content.length > 2_000) return "个人通用记忆每条最多 2,000 字符，请缩短正文或取消标记。";
  return null;
}

/** Shared create/edit form with a visible memory-length limit and retained draft on failure. */
export function PersonalKnowledgeEditor({
  mode,
  draft,
  saving,
  error,
  notice,
  onDraftChange,
  onCancel,
  onSubmit,
}: {
  mode: "edit" | "create";
  draft: KnowledgeDraft;
  saving: boolean;
  error: string | null;
  notice?: string | null;
  onDraftChange: (draft: KnowledgeDraft) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): React.JSX.Element {
  const translateUi = useTranslate();
  const defaultMemoryTooLong = draft.isDefaultMemory && draft.content.length > 2_000;
  const visibleError = error ? error : defaultMemoryTooLong ? "个人通用记忆已超出 2,000 字符，请缩短正文或取消标记。" : null;
  return <form onSubmit={onSubmit} className="knowledge-editor-form">
    <header data-dialog-header className="knowledge-editor-header">
      <div>
        <h2 id="knowledge-modal-title">{mode === "create" ? <UiText text={"新建知识"} /> : <UiText text={"编辑知识"} />}</h2>
        <span className="mt-2 inline-block rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600"><UiText text={"纯文本 / Markdown"} /></span>
      </div>
      <button data-dialog-close type="button" onClick={onCancel} disabled={saving} aria-label={translateUi("关闭窗口")} className="app-icon-button"><ShellIcon name="close" className="app-icon--control" /></button>
    </header>
    <p className="knowledge-editor-intro"><UiText text={"内容保存在你的个人知识库中；保存后会保留版本历史。"} /></p>
    <div data-dialog-body className="knowledge-editor-body">
      {notice ? <p role="status" className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800"><UiFeedbackText text={notice} /></p> : null}
      <label className="knowledge-editor-field"><UiText text={"标题"} /><input value={draft.title} onChange={(event) => onDraftChange({ ...draft, title: event.target.value })} disabled={saving} required maxLength={240} placeholder={translateUi("例如：产品想法与待验证假设")} />
      </label>
      <label className="knowledge-editor-field"><UiText text={"正文"} /><textarea value={draft.content} onChange={(event) => onDraftChange({ ...draft, content: event.target.value })} disabled={saving} required maxLength={100000} rows={mode === "create" ? 9 : 16} aria-describedby="knowledge-content-count knowledge-default-memory-limit" aria-invalid={defaultMemoryTooLong} placeholder={translateUi("记录你的知识、摘要、规则或下一步想法……")} />
        <span id="knowledge-content-count" className="mt-1 block text-right text-xs font-normal text-slate-400">{draft.content.length.toLocaleString("zh-CN")} {" "}<UiText text={"/ 100,000 字符"} /></span>
      </label>
      <label className="knowledge-editor-memory">
        <input type="checkbox" checked={draft.isDefaultMemory} disabled={saving} aria-describedby="knowledge-default-memory-limit" aria-invalid={defaultMemoryTooLong} onChange={(event) => onDraftChange({ ...draft, isDefaultMemory: event.target.checked })} />
        <span><strong className="block font-semibold"><UiText text={"作为个人通用记忆"} /></strong><span className="mt-1 block"><UiText text={"明确标记的约定会自动带入你发起的项目 AI 请求；当前项目约定优先。项目成员可能在生成结果中看到其中内容。最多 8 条。"} /></span><span id="knowledge-default-memory-limit" aria-live="polite" className={"mt-2 block text-xs font-semibold " + (defaultMemoryTooLong ? "text-rose-700" : "text-slate-600")}>{draft.isDefaultMemory ? `${translateUi("个人通用记忆：")}${draft.content.length.toLocaleString("zh-CN")} ${translateUi("/ 2,000 字符")}${translateUi(defaultMemoryTooLong ? "，请缩短正文或取消标记。" : "。")}` : <UiText text={"标记为个人通用记忆后，每条最多 2,000 字符。"} />}</span></span>
      </label>
    </div>
    <div data-dialog-footer className="knowledge-editor-actions">
      {visibleError ? <div id="knowledge-editor-error" role="alert" className="knowledge-editor-error"><UiErrorText text={visibleError} /></div> : null}
      <div className="flex gap-4">
      <button type="button" onClick={onCancel} disabled={saving} className="knowledge-editor-button app-action-button"><UiText text={"取消"} /></button>
      <button type="submit" disabled={saving} aria-describedby={visibleError ? "knowledge-editor-error" : undefined} className="knowledge-editor-submit app-action-button">{saving ? <UiText text={"保存中…"} /> : mode === "create" ? <UiText text={"创建知识"} /> : <UiText text={"保存新版本"} />}</button>
      </div>
    </div>
  </form>;
}
