"use client";

import { UiText, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { modalBackdropClassName, modalSurfaceClassName } from "@/components/modal-styles";
import { useInquiryOperation } from "@/components/inquiry-operation";
import { awaitImportedAsset } from "./imported-asset-readiness";
import { ProjectFactImport } from "./project-fact-import";
import styles from "./project-materials.module.css";
import type { MaterialKind } from "./materials/materials-navigation";

type UploadPolicy = { maxFiles: number };
const SUPPORTED_FILE_EXTENSIONS = [".txt", ".md", ".markdown", ".csv", ".json", ".pdf", ".docx", ".pptx", ".xlsx", ".png", ".jpg", ".jpeg", ".webp"] as const;
const FILE_ACCEPT = SUPPORTED_FILE_EXTENSIONS.join(",");

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function selectedFileName(file: File): string {
  return file.webkitRelativePath || file.name;
}

function isSupportedFile(file: File): boolean {
  const normalized = file.name.toLowerCase();
  return SUPPORTED_FILE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
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
  const [savedAssetCount, setSavedAssetCount] = useState(0);
  const [maxFiles, setMaxFiles] = useState(10);
  const [factSourceIds, setFactSourceIds] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    const selected = Array.from(event.target.files ?? []);
    const supported = selected.filter(isSupportedFile);
    const accepted = supported.slice(0, maxFiles);
    const unsupportedCount = selected.length - supported.length;
    setFiles(accepted);
    setError(null);
    setMessage(supported.length > maxFiles
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
    setSavedAssetCount(0);
    setError(null);
    setMessage(null);
    let uploaded = 0;
    const readySourceIds: string[] = [];
    const pendingParsing: string[] = [];
    const failures: string[] = [];
    const failedFiles: File[] = [];
    for (const file of files) {
      try {
        const form = new FormData();
        form.set("file", file);
        const response = await fetch(`/api/projects/${projectId}/assets`, { method: "POST", body: form });
        if (!response.ok) throw new Error(await responseError(response, "上传失败"));
        const payload = await response.json() as { asset?: { id: string; status: string; segments?: Array<{ projectSourceId: string | null }> } };
        const readiness = payload.asset ? await awaitImportedAsset(projectId, payload.asset, () => setMessage(`正在等待 ${selectedFileName(file)} 的本地解析…`)) : null;
        if (readiness?.pending) pendingParsing.push(selectedFileName(file));
        readySourceIds.push(...(readiness?.asset.segments ?? []).flatMap((segment) => segment.projectSourceId ? [segment.projectSourceId] : []));
        uploaded += 1;
        setMessage(`正在上传并解析 ${uploaded + failures.length} / ${files.length}…`);
      } catch (cause) {
        failures.push(`${selectedFileName(file)}：${cause instanceof Error ? cause.message : "上传失败"}`);
        failedFiles.push(file);
      }
    }
    setFiles(failedFiles);
    setSavedAssetCount(uploaded);
    setFactSourceIds([...new Set(readySourceIds)]);
    try {
      await onChanged();
      if (failures.length > 0) {
        setError(`已保存 ${uploaded} 个，失败 ${failures.length} 个：${failures.slice(0, 3).join("；")}${failures.length > 3 ? "；其余失败项请分批重试" : ""}`);
        setMessage(uploaded > 0 ? "已保存文件的本地解析状态可在“管理全部文件”查看；需要模型识别的任务结束后会进入通知中心。" : null);
      } else {
        setMessage(`已保存 ${uploaded} 个文件。${pendingParsing.length > 0 ? `其中 ${pendingParsing.length} 个仍在后台解析或状态暂时不可读，请稍后在文件库查看。` : ""}本地解析状态可在“管理全部文件”查看；需要模型识别的任务结束后会进入通知中心。已解析的文本可在下方直接交给 AI 整理成事实；图片和扫描件仍需先完成识别核对。`);
      }
    } catch {
      setError("文件上传已经结束，但资料列表刷新失败；请打开“管理全部文件”确认结果。");
    } finally {
      setUploading(false);
    }
  }

  if (!hasOpened) return null;

  return (
    <div hidden={!open} inert={!open} aria-hidden={!open || undefined} style={open ? undefined : { display: "none" }} className={`${styles.drawerBackdrop} ${modalBackdropClassName}`} onMouseDown={(event) => { if (event.target === event.currentTarget) closeDrawer(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="add-source-dialog-title" aria-describedby="add-source-dialog-description" onKeyDown={handleDialogKeyDown} className={`${styles.drawer} overflow-hidden ${modalSurfaceClassName}`}>
        <div data-dialog-header className={`${styles.drawerHeader} flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 bg-white px-5 py-4 sm:px-7`}>
        <div>
          <h2 id="add-source-dialog-title" className="text-lg font-semibold tracking-tight text-slate-950"><UiText text={"添加资料"} /></h2>
          <p id="add-source-dialog-description" className="mt-1 max-w-3xl text-xs leading-5 text-slate-600"><UiText text={"资料会保留原文和来源。需要模型处理时，会先显示本次范围并等待确认。"} /></p>
        </div>
        <button ref={closeButtonRef} data-dialog-close type="button" onClick={closeDrawer} className="inline-flex min-h-9 items-center justify-center rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-indigo-300 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"><UiText text={"关闭"} /></button>
      </div>

      <div data-dialog-body className={`${styles.drawerBody} px-5 py-5 sm:px-7`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 text-xs text-slate-500">
        <p><UiText text={"当前入口："} /><strong className="font-semibold">{translateUi(kindLabels[kind])}</strong></p>
        <Link href={`/projects/${projectId}/assets`} onClick={() => closeDrawer()} className="font-semibold text-indigo-700 underline underline-offset-4"><UiText text={"管理已上传文件"} /></Link>
      </div>

      {error ? <p role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm leading-6 text-rose-700">{error}</p> : null}
      {message ? <p role="status" aria-live="polite" className="mt-5 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm leading-6 text-indigo-800">{message}</p> : null}

      <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
        <form id="manual-text" onSubmit={saveText} className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-slate-900">
          <h3 className="text-sm font-semibold text-slate-950"><UiText text={"手工文本"} /></h3>
          <p className="mt-1 text-xs leading-5 text-slate-600"><UiText text={"粘贴会议记录、进展或其他项目原文。"} /></p>
          <textarea value={contentText} onChange={(event) => setContentText(event.target.value)} rows={5} maxLength={100_000} required placeholder={translateUi("直接输入或粘贴项目资料…")} className="mt-4 w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100" />
          <details className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
            <summary className="cursor-pointer text-xs font-semibold text-slate-700"><UiText text={"补充来源链接和资料时间（可选）"} /></summary>
            <label className="mt-4 block text-xs text-slate-600"><UiText text={"来源链接"} /><input type="url" value={externalRef} onChange={(event) => setExternalRef(event.target.value)} maxLength={2_048} placeholder="https://example.com/document" className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none placeholder:text-slate-400" /></label>
            <label className="mt-4 block text-xs text-slate-600"><UiText text={"资料时间"} /><input type="datetime-local" value={capturedAt} onChange={(event) => setCapturedAt(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none [color-scheme:light]" /></label>
          </details>
          <button disabled={savingText || !contentText.trim()} className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{savingText ? <UiText text={"保存中…"} /> : <UiText text={"加入原始资料"} />}</button>
        </form>

        <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <h3 className="text-sm font-semibold text-slate-950"><UiText text={"图片、文档或文件夹"} /></h3>
          <p className="mt-1 text-xs leading-5 text-slate-500"><UiText text={"支持常用文本、Office、PDF 与图片格式；图片识别需经本次确认。"} /></p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-indigo-300 bg-white px-5 text-center hover:border-indigo-400 hover:bg-indigo-50">
              <input type="file" multiple accept={FILE_ACCEPT} onChange={chooseFiles} className="sr-only" />
              <span className="text-sm font-semibold text-indigo-700"><UiText text={"选择图片或文档"} /></span>
              <span className="mt-1 text-[12px] text-slate-400"><UiText text={"可一次多选"} /></span>
            </label>
            <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-violet-300 bg-white px-5 text-center hover:border-violet-400 hover:bg-violet-50">
              <input ref={(node) => { node?.setAttribute("webkitdirectory", ""); }} type="file" multiple accept={FILE_ACCEPT} onChange={chooseFiles} className="sr-only" />
              <span className="text-sm font-semibold text-violet-700"><UiText text={"选择整个文件夹"} /></span>
              <span className="mt-1 text-[12px] text-slate-400"><UiText text={"读取子目录中的受支持文件"} /></span>
            </label>
          </div>
          <p className="mt-3 text-[12px] leading-5 text-slate-400"><UiText text={"单次最多"} />{" "}{maxFiles} {" "}<UiText text={"个文件；文件夹中的不支持格式会自动跳过。"} /></p>
          {files.length > 0 ? <div className="mt-4 min-w-0 rounded-xl bg-white p-4 text-xs text-slate-600"><p className="font-semibold text-slate-800"><UiText text={"已选择"} />{" "}{files.length} {" "}<UiText text={"个文件"} /></p><p className="mt-2 line-clamp-3 [overflow-wrap:anywhere]">{files.map(selectedFileName).join("、")}</p></div> : null}
          <button type="button" onClick={() => void uploadFiles()} disabled={uploading || files.length === 0} className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">{uploading ? <UiText text={"上传并解析中…"} /> : files.length > 0 ? `上传并解析 ${files.length} 个文件` : <UiText text={"请先选择文件或文件夹"} />}</button>
        </div>
      </div>

      {savedAssetCount > 0 && factSourceIds.length === 0 ? <div role="status" className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900"><p><UiText text={"文件已保存，暂未有可整理的文字。下一步查看解析进度；图片和扫描件需先确认识别并核对文字。"} /></p><Link href={`/projects/${projectId}/assets`} className="mt-2 inline-flex min-h-11 items-center font-semibold underline"><UiText text={"继续解析或核对识别文字 →"} /></Link></div> : null}
      <ProjectFactImport key={factSourceIds.join(",")} projectId={projectId} sourceIds={factSourceIds} onChanged={onChanged} />

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/projects/${projectId}/external-sources`} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-cyan-300 hover:text-cyan-800"><UiText text={"添加网页资料"} /></Link>
        <Link href={`/projects/${projectId}/repositories`} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-emerald-300 hover:text-emerald-800"><UiText text={"连接代码仓库"} /></Link>
      </div>
      </div>
      </div>
    </div>
  );
}
