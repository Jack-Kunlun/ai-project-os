"use client";
import { UiFeedbackText, UiErrorText } from "@/components/ui-error-text";
import { DialogActions, DialogForm, DialogSubmit } from "@/components/dialog-actions";

import {  UiText, useTranslate } from "@/components/appearance-provider";
import { ShellIcon } from "@/components/shell-icon";
import { OperationPanelFooterTargetContext } from "@/components/operation-panel";
import Link from "next/link";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { modalBackdropClassName, modalFooterClassName, modalSurfaceClassName } from "@/components/modal-styles";
import { useInquiryOperation } from "@/components/inquiry-operation";
import { awaitImportedAsset } from "./imported-asset-readiness";
import { ProjectFactImport } from "./project-fact-import";
import { buildProjectHref } from "@/lib/project-navigation";
import { safeResponseError } from "@/lib/safe-error-presentation";
import { projectAssetUploadRequest } from "@/lib/project-assets/upload-request";
import { selectSupportedProjectAssetFiles } from "@/lib/project-assets/file-selection";
import styles from "./project-materials.module.css";
import type { MaterialKind } from "./materials/materials-navigation";

type UploadPolicy = { maxFiles: number };
type ImportedAssetResult = { id: string; name: string; status: string; hasSource: boolean };

function importedAssetGuidance(asset: ImportedAssetResult): { message: string; action: string } {
  if (asset.status === "uploaded" || asset.status === "parsing") {
    return { message: "文件已保存，正在本地解析。", action: "查看解析进度" };
  }
  if (asset.status === "waitingVision") {
    return { message: "文件已保存，图片识别需另行确认；本次上传不会自动发送图片内容。", action: "打开文件后手动开始识别" };
  }
  if (asset.status === "awaitingReview") {
    return { message: "识别已完成，文字等待你核对后才会纳入资料。", action: "核对识别文字" };
  }
  if (asset.status === "failed") {
    return { message: "文件本地解析失败，可在文件详情中重新解析。", action: "打开文件并重试解析" };
  }
  if (asset.status === "ready" && !asset.hasSource) {
    return { message: "解析已完成，但没有提取到可用文字。", action: "查看文件详情" };
  }
  if (asset.status === "ready") {
    return { message: "解析完成，已提取可用文字，可在下方交给 AI 整理。", action: "查看文件详情" };
  }
  return { message: "文件已保存，当前状态可在文件详情中查看。", action: "查看文件状态" };
}

async function responseError(response: Response, fallback: string): Promise<string> {
  return (await safeResponseError(response, fallback)).message;
}

function selectedFileName(file: File): string {
  return file.webkitRelativePath || file.name;
}

export function ProjectMaterialIntake({
  projectId,
  onChanged,
  open,
  kind,
  onClose,
}: {
  projectId: string;
  onChanged: () => Promise<void>;
  open: boolean;
  kind: MaterialKind;
  onClose: () => void;
}) {
  const translateUi = useTranslate();
  const [hasOpened, setHasOpened] = useState(open);
  if (open && !hasOpened) setHasOpened(true);
  const [contentText, setContentText] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [capturedAt, setCapturedAt] = useState("");
  const [savingText, setSavingText] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadedAssets, setUploadedAssets] = useState<ImportedAssetResult[]>([]);
  const [maxFiles, setMaxFiles] = useState(10);
  const [factSourceIds, setFactSourceIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<Array<{ name: string; message: string }>>([]);
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useInquiryOperation(open, dialogRef);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const kindLabels: Record<MaterialKind, string> = {
    all: "资料",
    manual: "文本资料",
    document: "文档资料",
    screenshot: "图片资料",
    web: "网页资料",
    github: "GitHub 资料",
    git: "代码仓库资料",
  };

  useEffect(() => {
    if (!open) return;
    const activeElement = document.activeElement;
    openerRef.current = activeElement instanceof HTMLElement && activeElement.id === "add-source-trigger"
      ? activeElement
      : document.getElementById("add-source-trigger");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  function closeDrawer() {
    onClose();
    window.setTimeout(() => {
      (openerRef.current ?? document.getElementById("add-source-trigger"))?.focus();
    }, 0);
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/projects/${projectId}/assets`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as { policy?: UploadPolicy };
        if (!cancelled && payload.policy?.maxFiles) setMaxFiles(payload.policy.maxFiles);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId]);

  async function saveText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!contentText.trim()) return;
    setFactSourceIds([]);
    setSavingText(true);
    setError(null);
    setMessage(null);
    try {
      let capturedAtIso: string | undefined;
      if (capturedAt) {
        const date = new Date(capturedAt);
        if (Number.isNaN(date.getTime())) throw new Error("资料时间格式无效");
        capturedAtIso = date.toISOString();
      }
      const response = await fetch(`/api/projects/${projectId}/sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentText, externalRef, capturedAt: capturedAtIso }),
      });
      if (!response.ok) throw new Error(await responseError(response, "文本资料保存失败"));
      const payload = await response.json() as { source: { id: string } };
      setFactSourceIds([payload.source.id]);
      setContentText("");
      setExternalRef("");
      setCapturedAt("");
      await onChanged();
      setMessage("文本已保存。下方已接好 AI 整理流程，确认本次模型外发后即可自动形成有证据的事实。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "文本资料保存失败");
    } finally {
      setSavingText(false);
    }
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    setUploadErrors([]);
    const selected = Array.from(event.target.files ?? []);
    const { accepted, unsupported, excess } = selectSupportedProjectAssetFiles(selected, maxFiles);
    const unsupportedCount = unsupported.length;
    setFiles(accepted);
    setError(null);
    setMessage(excess.length > 0
      ? `本次最多选择 ${maxFiles} 个受支持文件，已保留前 ${maxFiles} 个${unsupportedCount > 0 ? `，另跳过 ${unsupportedCount} 个不支持的文件` : ""}。`
      : accepted.length > 0
        ? `已选择 ${accepted.length} 个文件${unsupportedCount > 0 ? `，跳过 ${unsupportedCount} 个不支持的文件` : ""}，确认后统一上传并解析。`
        : selected.length > 0
          ? "所选内容中没有受支持的图片或文档。"
          : null);
    event.currentTarget.value = "";
  }

  async function uploadFiles() {
    if (files.length === 0) return;
    setFactSourceIds([]);
    setUploading(true);
    setUploadedAssets([]);
    setError(null);
    setUploadErrors([]);
    setMessage(null);
    let uploaded = 0;
    const readySourceIds: string[] = [];
    const failures: Array<{ name: string; message: string }> = [];
    const failedFiles: File[] = [];
    const savedAssets: ImportedAssetResult[] = [];
    for (const file of files) {
      try {
        const response = await fetch(`/api/projects/${projectId}/assets`, projectAssetUploadRequest(file));
        if (!response.ok) throw new Error(await responseError(response, "上传失败"));
        const payload = await response.json() as { asset: { id: string; displayName?: string; status: string; segments?: Array<{ projectSourceId: string | null }> } };
        const readiness = await awaitImportedAsset(projectId, payload.asset, () => setMessage("正在等待文件的本地解析…"));
        const importedAsset = readiness.asset;
        savedAssets.push({
          id: importedAsset.id,
          name: importedAsset.displayName ?? selectedFileName(file),
          status: importedAsset.status,
          hasSource: importedAsset.segments?.some((segment) => segment.projectSourceId !== null) ?? false,
        });
        readySourceIds.push(...(importedAsset.segments ?? []).flatMap((segment) => segment.projectSourceId ? [segment.projectSourceId] : []));
        uploaded += 1;
        setMessage("正在上传并解析文件…");
      } catch (cause) {
        failures.push({ name: selectedFileName(file), message: cause instanceof Error ? cause.message : "上传失败" });
        failedFiles.push(file);
      }
    }
    setFiles(failedFiles);
    setUploadErrors(failures);
    setUploadedAssets(savedAssets);
    setFactSourceIds([...new Set(readySourceIds)]);
    try {
      await onChanged();
      if (failures.length > 0) {
        setError("部分文件上传失败，请查看每个文件的具体原因。");
        setMessage(uploaded > 0 ? "部分文件已保存。下方列出已保存文件的当前状态和下一步操作；失败文件仍保留在选择列表中，可再次上传。" : null);
      } else {
        setMessage("上传完成。下方列出每个文件的当前状态和下一步操作。");
      }
    } catch {
      setError("文件上传已经结束，但资料列表刷新失败；请打开“管理全部文件”确认结果。");
    } finally {
      setUploading(false);
    }
  }

  if (!hasOpened) return null;

  return (
    <OperationPanelFooterTargetContext.Provider value={footerTarget}>
    <div hidden={!open} inert={!open} aria-hidden={!open || undefined} style={open ? undefined : { display: "none" }} className={`${styles.drawerBackdrop} ${modalBackdropClassName}`} onMouseDown={(event) => { if (event.target === event.currentTarget) closeDrawer(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-source-dialog-title" aria-describedby="add-source-dialog-description" onKeyDown={handleDialogKeyDown} className={`${styles.drawer} overflow-hidden ${modalSurfaceClassName}`}>
        <div data-dialog-header className={`${styles.drawerHeader} flex items-start justify-between gap-4 border-b border-slate-100 bg-white px-5 py-4 sm:px-6`}>
        <div className="min-w-0 flex-1">
          <h2 id="add-source-dialog-title" className="text-lg font-semibold tracking-tight text-slate-950"><UiText text={"添加资料"} /></h2>
          <p id="add-source-dialog-description" className="mt-1 max-w-3xl text-xs leading-5 text-slate-600"><UiText text={"资料会保留原文和来源。需要模型处理时，会先显示本次范围并等待确认。"} /></p>
        </div>
        <button ref={closeButtonRef} data-dialog-close type="button" onClick={closeDrawer} aria-label={translateUi("关闭窗口")} className="app-icon-button"><ShellIcon name="close" className="app-icon--control" /></button>
      </div>

      <div data-dialog-body className={`${styles.drawerBody} px-5 py-5 sm:px-6`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 text-xs text-slate-500">
        <p><UiText text={"当前入口："} /><strong className="font-semibold">{translateUi(kindLabels[kind])}</strong></p>
        <Link href={buildProjectHref(projectId, "assets", { from: "materials" })} onClick={() => closeDrawer()} className="font-semibold text-indigo-700 underline underline-offset-4"><UiText text={"管理已上传文件"} /></Link>
      </div>

      {error ? <p role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm leading-6 text-rose-700"><UiErrorText text={error} /></p> : null}
      {uploadErrors.length > 0 ? <ul className="mt-3 space-y-3 text-sm text-rose-700">{uploadErrors.map((failure, index) => <li key={`${index}:${failure.name}`} className="break-words border-b border-slate-200 pb-3"><p className="font-semibold">{failure.name}</p><p><UiErrorText text={failure.message} /></p></li>)}</ul> : null}
      {message ? <p role="status" aria-live="polite" className="mt-5 border-t border-slate-200 pt-4 text-sm leading-6 text-slate-700"><UiFeedbackText text={message} /></p> : null}

      <DialogForm id="manual-text" onSubmit={saveText} className="min-w-0">
      <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
        <div className="min-w-0 text-slate-900">
          <h3 className="text-sm font-semibold text-slate-950"><UiText text={"手工文本"} /></h3>
          <p className="mt-1 text-xs leading-5 text-slate-600"><UiText text={"粘贴会议记录、进展或其他项目原文。"} /></p>
          <textarea value={contentText} onChange={(event) => setContentText(event.target.value)} rows={5} maxLength={100_000} required placeholder={translateUi("直接输入或粘贴项目资料…")} className="mt-4 w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100" />
          <details className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
            <summary className="cursor-pointer text-xs font-semibold text-slate-700"><UiText text={"补充来源链接和资料时间（可选）"} /></summary>
            <label className="mt-4 block text-xs text-slate-600"><UiText text={"来源链接"} /><input type="url" value={externalRef} onChange={(event) => setExternalRef(event.target.value)} maxLength={2_048} placeholder="https://example.com/document" className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none placeholder:text-slate-400" /></label>
            <label className="mt-4 block text-xs text-slate-600"><UiText text={"资料时间"} /><input type="datetime-local" value={capturedAt} onChange={(event) => setCapturedAt(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none [color-scheme:light]" /></label>
          </details>
        </div>

        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-950"><UiText text={"图片、文档或文件夹"} /></h3>
          <p className="mt-1 text-xs leading-5 text-slate-500"><UiText text={"支持 DOCX、XLSX、PPTX、PDF、TXT、Markdown、CSV、JSON 和 PNG、JPEG、WebP；旧版 Office 和 WPS 专有格式请先另存。图片识别仍需当次确认。"} /></p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-indigo-300 bg-white px-5 text-center hover:border-indigo-400 hover:bg-indigo-50">
              <input type="file" multiple onChange={chooseFiles} className="sr-only" />
              <span className="text-sm font-semibold text-indigo-700"><UiText text={"选择图片或文档"} /></span>
              <span className="mt-1 text-[12px] text-slate-400"><UiText text={"可一次多选"} /></span>
            </label>
            <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-violet-300 bg-white px-5 text-center hover:border-violet-400 hover:bg-violet-50">
              <input ref={(node) => { node?.setAttribute("webkitdirectory", ""); }} type="file" multiple onChange={chooseFiles} className="sr-only" />
              <span className="text-sm font-semibold text-violet-700"><UiText text={"选择整个文件夹"} /></span>
              <span className="mt-1 text-[12px] text-slate-400"><UiText text={"读取子目录中的受支持文件"} /></span>
            </label>
          </div>
          <p className="mt-3 text-[12px] leading-5 text-slate-400"><UiText text={"单次最多"} />{" "}{maxFiles} {" "}<UiText text={"个文件；文件夹中的不支持格式会自动跳过。"} /></p>
          {files.length > 0 ? <div className="mt-4 min-w-0 rounded-xl bg-white p-4 text-xs text-slate-600"><p className="font-semibold text-slate-800"><UiText text={"已选择"} />{" "}{files.length} {" "}<UiText text={"个文件"} /></p><p className="mt-2 line-clamp-3 [overflow-wrap:anywhere]">{files.map(selectedFileName).join("、")}</p></div> : null}
        </div>
      </div>

      {uploadedAssets.length > 0 ? <div role="status" className="mt-5 space-y-3"><h3 className="text-sm font-semibold text-slate-900"><UiText text={"已上传文件状态"} /></h3>{uploadedAssets.map((asset) => <div key={asset.id} className="border-b border-slate-200 pb-3 last:border-b-0"><p className="break-all text-xs font-semibold text-slate-800">{asset.name}</p><p className="mt-1 text-xs leading-5 text-slate-600"><UiText text={importedAssetGuidance(asset).message} /></p></div>)}</div> : null}
      <DialogActions className="w-full">
        <div className="mr-auto flex min-w-0 flex-wrap gap-2">{uploadedAssets.map((asset) => {
          const guidance = importedAssetGuidance(asset);
          return <Link key={asset.id} href={buildProjectHref(projectId, "assets", { focus: asset.id, from: "materials" })} onClick={() => closeDrawer()} aria-label={`${translateUi(guidance.action)}：${asset.name}`} title={asset.name} className="inline-flex min-h-10 max-w-full items-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 hover:border-indigo-300"><UiText text={guidance.action} /><span className="ml-1 max-w-44 truncate text-slate-500">· {asset.name}</span></Link>;
        })}</div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <DialogSubmit disabled={savingText || !contentText.trim()} className="inline-flex min-h-10 items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{savingText ? <UiText text={"保存中…"} /> : <UiText text={"加入原始资料"} />}</DialogSubmit>
          <button type="button" onClick={() => void uploadFiles()} disabled={uploading || files.length === 0} className="inline-flex min-h-10 items-center justify-center rounded-lg border border-indigo-200 bg-white px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-40">{uploading ? <UiText text={"上传并解析中…"} /> : files.length > 0 ? translateUi("上传并解析 {count} 个文件").replace("{count}", String(files.length)) : <UiText text={"请先选择文件或文件夹"} />}</button>
        </div>
      </DialogActions>
      </DialogForm>
      <div className={factSourceIds.length > 0 ? "mt-5" : undefined}><ProjectFactImport key={factSourceIds.join(",")} projectId={projectId} sourceIds={factSourceIds} onChanged={onChanged} /></div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/projects/${projectId}/external-sources`} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-cyan-300 hover:text-cyan-800"><UiText text={"添加网页资料"} /></Link>
        <Link href={`/projects/${projectId}/repositories`} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-emerald-300 hover:text-emerald-800"><UiText text={"连接代码仓库"} /></Link>
      </div>
      </div>
      <footer data-operation-footer className={modalFooterClassName}>
        <div data-operation-actions ref={setFooterTarget} />
      </footer>
      </div>
    </div>
    </OperationPanelFooterTargetContext.Provider>
  );
}
