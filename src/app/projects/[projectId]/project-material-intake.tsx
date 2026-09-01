"use client";

import Link from "next/link";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

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
}: {
  projectId: string;
  onChanged: () => Promise<void>;
}) {
  const [contentText, setContentText] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [capturedAt, setCapturedAt] = useState("");
  const [savingText, setSavingText] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [maxFiles, setMaxFiles] = useState(10);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setContentText("");
      setExternalRef("");
      setCapturedAt("");
      await onChanged();
      setMessage("文本已加入项目资料。它仍是待审核来源，不会直接成为已确认事实。");
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
    setUploading(true);
    setError(null);
    setMessage(null);
    let uploaded = 0;
    const failures: string[] = [];
    for (const file of files) {
      try {
        const form = new FormData();
        form.set("file", file);
        const response = await fetch(`/api/projects/${projectId}/assets`, { method: "POST", body: form });
        if (!response.ok) throw new Error(await responseError(response, "上传失败"));
        uploaded += 1;
        setMessage(`正在上传并解析 ${uploaded + failures.length} / ${files.length}…`);
      } catch (cause) {
        failures.push(`${selectedFileName(file)}：${cause instanceof Error ? cause.message : "上传失败"}`);
      }
    }
    setFiles([]);
    try {
      await onChanged();
      if (failures.length > 0) {
        setError(`已保存 ${uploaded} 个，失败 ${failures.length} 个：${failures.slice(0, 3).join("；")}${failures.length > 3 ? "；其余失败项请分批重试" : ""}`);
        setMessage(uploaded > 0 ? "已保存文件的本地解析状态可在“管理全部文件”查看；需要模型识别的任务结束后会进入通知中心。" : null);
      } else {
        setMessage(`已保存 ${uploaded} 个文件。本地解析状态可在“管理全部文件”查看；需要模型识别的任务结束后会进入通知中心。需要人工确认的内容不会自动写入记忆。`);
      }
    } catch {
      setError("文件上传已经结束，但资料列表刷新失败；请打开“管理全部文件”确认结果。");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section id="project-materials" className="scroll-mt-44 rounded-3xl border border-indigo-100 bg-white p-7 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-5 border-b border-slate-100 pb-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">One intake</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">项目资料统一入口</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">输入文本、上传图片或文档、选择整个文件夹，都从这里开始。资料会进入同一套解析、审核、记忆与引用链路。</p>
        </div>
        <Link href={`/projects/${projectId}/assets`} className="inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:border-indigo-300 hover:text-indigo-700">管理全部文件</Link>
      </div>

      {error ? <p role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm leading-6 text-rose-700">{error}</p> : null}
      {message ? <p role="status" aria-live="polite" className="mt-5 rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 text-sm leading-6 text-indigo-800">{message}</p> : null}

      <div className="mt-7 grid min-w-0 gap-6 lg:grid-cols-2">
        <form id="manual-text" onSubmit={saveText} className="min-w-0 rounded-2xl bg-slate-950 p-6 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">输入文本</p>
          <h3 className="mt-2 text-xl font-semibold">粘贴一段项目资料</h3>
          <p className="mt-2 text-xs leading-5 text-slate-400">适合会议记录、项目进展、需求说明和临时笔记。系统保留原文，不会把未审核内容当成事实。</p>
          <textarea value={contentText} onChange={(event) => setContentText(event.target.value)} rows={8} maxLength={100_000} required placeholder="直接输入或粘贴项目资料…" className="mt-5 w-full resize-y rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm leading-6 text-white outline-none placeholder:text-slate-500 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-300/20" />
          <details className="mt-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
            <summary className="cursor-pointer text-xs font-semibold text-slate-300">补充来源链接和资料时间（可选）</summary>
            <label className="mt-4 block text-xs text-slate-300">来源链接<input type="url" value={externalRef} onChange={(event) => setExternalRef(event.target.value)} maxLength={2_048} placeholder="https://example.com/document" className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500" /></label>
            <label className="mt-4 block text-xs text-slate-300">资料时间<input type="datetime-local" value={capturedAt} onChange={(event) => setCapturedAt(event.target.value)} className="mt-2 w-full rounded-xl border border-white/10 bg-white/10 px-4 py-3 text-sm text-white outline-none [color-scheme:dark]" /></label>
          </details>
          <button disabled={savingText || !contentText.trim()} className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-indigo-400 px-5 py-3 text-sm font-semibold text-slate-950 hover:bg-indigo-300 disabled:cursor-not-allowed disabled:opacity-50">{savingText ? "保存中…" : "加入项目资料"}</button>
        </form>

        <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">上传文件</p>
          <h3 className="mt-2 text-xl font-semibold text-slate-950">图片、文档或整个文件夹</h3>
          <p className="mt-2 text-xs leading-5 text-slate-500">支持常用文本、Office、PDF 与图片格式。图片和扫描件只有在你确认后才会发送给项目配置的视觉模型。</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-indigo-300 bg-white px-5 text-center hover:border-indigo-400 hover:bg-indigo-50">
              <input type="file" multiple accept={FILE_ACCEPT} onChange={chooseFiles} className="sr-only" />
              <span className="text-sm font-semibold text-indigo-700">选择图片或文档</span>
              <span className="mt-1 text-[11px] text-slate-400">可一次多选</span>
            </label>
            <label className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-violet-300 bg-white px-5 text-center hover:border-violet-400 hover:bg-violet-50">
              <input ref={(node) => { node?.setAttribute("webkitdirectory", ""); }} type="file" multiple accept={FILE_ACCEPT} onChange={chooseFiles} className="sr-only" />
              <span className="text-sm font-semibold text-violet-700">选择整个文件夹</span>
              <span className="mt-1 text-[11px] text-slate-400">读取子目录中的受支持文件</span>
            </label>
          </div>
          <p className="mt-3 text-[11px] leading-5 text-slate-400">单次最多 {maxFiles} 个文件；文件夹中的不支持格式会自动跳过。</p>
          {files.length > 0 ? <div className="mt-4 min-w-0 rounded-xl bg-white p-4 text-xs text-slate-600"><p className="font-semibold text-slate-800">已选择 {files.length} 个文件</p><p className="mt-2 line-clamp-3 [overflow-wrap:anywhere]">{files.map(selectedFileName).join("、")}</p></div> : null}
          <button type="button" onClick={() => void uploadFiles()} disabled={uploading || files.length === 0} className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">{uploading ? "上传并解析中…" : files.length > 0 ? `上传并解析 ${files.length} 个文件` : "请先选择文件或文件夹"}</button>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Link href={`/projects/${projectId}/external-sources`} className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 transition hover:border-cyan-300 hover:bg-cyan-50"><span className="text-sm font-semibold text-slate-800">添加网页资料</span><span className="mt-1 block text-xs leading-5 text-slate-500">抓取公开网页或经授权的内网页面，并保留原始地址。</span></Link>
        <Link href={`/projects/${projectId}/repositories`} className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 transition hover:border-emerald-300 hover:bg-emerald-50"><span className="text-sm font-semibold text-slate-800">连接代码仓库</span><span className="mt-1 block text-xs leading-5 text-slate-500">关联 GitHub、Gitee、GitLab 或自建 Git，按固定提交只读扫描。</span></Link>
      </div>
    </section>
  );
}
