import type { FormEvent } from "react";

export type KnowledgeDraft = Readonly<{ title: string; content: string; isDefaultMemory: boolean }>;

/** Keep client validation aligned with the service limits before submitting. */
export function validateKnowledgeDraft(draft: KnowledgeDraft): string | null {
  if (draft.title.trim().length === 0 || draft.content.trim().length === 0) return "请填写标题和正文。";
  if (draft.isDefaultMemory && draft.content.length > 2_000) return "个人通用记忆每条最多 2,000 字符，请缩短正文或取消标记。";
  return null;
}

/** Shared create/edit form with an accessible, visible memory-length limit. */
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
  const defaultMemoryTooLong = draft.isDefaultMemory && draft.content.length > 2_000;
  const visibleError = error ?? (defaultMemoryTooLong ? "个人通用记忆已超出 2,000 字符，请缩短正文或取消标记。" : null);
  return <form onSubmit={onSubmit} className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-7">
      <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">{mode === "create" ? "New note" : "Edit note"}</p><h2 id="knowledge-modal-title" className="mt-1 text-xl font-semibold">{mode === "create" ? "新建个人知识" : "编辑个人知识"}</h2><span className="mt-2 inline-block rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-500">纯文本 / Markdown</span></div>
      <button type="button" onClick={onCancel} disabled={saving} className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-50">关闭</button>
    </header>
    <p className="mx-5 mt-4 shrink-0 rounded-2xl bg-indigo-50 px-4 py-3 text-xs leading-5 text-indigo-800 sm:mx-7">内容只保存在你的个人知识库中，不需要先创建项目。保存后会保留版本历史。</p>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-7">
      {notice ? <p role="status" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm leading-5 text-emerald-800">{notice}</p> : null}
      <label className="block text-sm font-semibold text-slate-700">标题<input value={draft.title} onChange={(event) => onDraftChange({ ...draft, title: event.target.value })} disabled={saving} required maxLength={240} placeholder="例如：产品想法与待验证假设" className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50" /></label>
      <label className="block text-sm font-semibold text-slate-700">正文<textarea value={draft.content} onChange={(event) => onDraftChange({ ...draft, content: event.target.value })} disabled={saving} required maxLength={100000} rows={18} aria-describedby="knowledge-content-count knowledge-default-memory-limit" aria-invalid={defaultMemoryTooLong} placeholder="记录你的知识、摘要、规则或下一步想法……" className="mt-2 w-full resize-y rounded-xl border border-slate-200 px-4 py-3 text-sm leading-6 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50" /><span id="knowledge-content-count" className="mt-1 block text-right text-xs font-normal text-slate-400">{draft.content.length.toLocaleString("zh-CN")} / 100,000 字符</span></label>
      <label className={"flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm " + (defaultMemoryTooLong ? "border-rose-300 bg-rose-50" : "border-indigo-100 bg-indigo-50/60")}><input type="checkbox" checked={draft.isDefaultMemory} disabled={saving} aria-describedby="knowledge-default-memory-limit" aria-invalid={defaultMemoryTooLong} onChange={(event) => onDraftChange({ ...draft, isDefaultMemory: event.target.checked })} className="mt-1 h-4 w-4 shrink-0" /><span><strong className="block">作为个人通用记忆</strong><span className="mt-1 block text-xs leading-5">仅将明确标记的约定自动带入你发起的项目 AI 问答与分析；当前项目约定优先。原始文档仍属于个人知识库，但项目成员可查看生成结果，结果可能复述其中内容。取消标记只影响后续请求，不会撤回已生成的项目结果。最多 8 条。</span><span id="knowledge-default-memory-limit" aria-live="polite" className={"mt-2 block text-xs font-semibold leading-5 " + (defaultMemoryTooLong ? "text-rose-700" : "text-slate-600")}>{draft.isDefaultMemory ? "个人通用记忆：" + draft.content.length.toLocaleString("zh-CN") + " / 2,000 字符" + (defaultMemoryTooLong ? "，请缩短正文或取消标记。" : "。") : "标记为个人通用记忆后，每条最多 2,000 字符。"}</span></span></label>
    </div>
    <div className="sticky bottom-0 z-10 flex shrink-0 flex-wrap justify-end gap-3 border-t border-slate-100 bg-white/95 px-5 py-3 backdrop-blur sm:px-7">{visibleError ? <div id="knowledge-editor-error" role="alert" className="w-full rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{visibleError}</div> : null}<button type="button" onClick={onCancel} disabled={saving} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 disabled:opacity-50">取消</button><button type="submit" disabled={saving} aria-describedby={visibleError ? "knowledge-editor-error" : undefined} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50">{saving ? "保存中…" : mode === "create" ? "创建内容" : "保存新版本"}</button></div>
  </form>;
}
