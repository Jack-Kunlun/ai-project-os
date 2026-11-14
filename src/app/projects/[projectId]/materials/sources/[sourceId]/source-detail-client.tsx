"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { UiText, useTranslate, useAppearance } from "@/components/appearance-provider";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { OperationPanel } from "@/components/operation-panel";
import { ProjectFactImport } from "../../../project-fact-import";
import { AppHeader } from "@/components/app-header";
import { ParentPageLink } from "@/components/parent-page-link";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";
import { safeMaterialsReturnTo } from "../../materials-navigation";
import supportStyles from "../../../project-support.module.css";

type ProjectSource = {
  id: string;
  kind: "document" | "screenshot" | "github" | "git" | "web" | "manual";
  externalRef: string | null;
  contentText: string;
  contentHash: string;
  capturedAt: string | null;
  ingestedAt: string;
};

function formatDate(value: string | null, language: string): string {
  if (!value) return language === "en" ? "Not specified" : "未填写";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (language === "en" ? "Invalid time" : "时间无效") : new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function getSource(projectId: string, sourceId: string, contentHash: string | null, signal?: AbortSignal): Promise<ProjectSource> {
  const query = contentHash === null ? "" : `?contentHash=${encodeURIComponent(contentHash)}`;
  const response = await fetch(`/api/projects/${projectId}/sources/${sourceId}${query}`, { cache: "no-store", signal });
  const payload = await response.json().catch(() => null) as { source?: ProjectSource; error?: { code?: string; message?: string } } | null;
  if (payload?.error?.code === "SOURCE_CITATION_STALE") {
    throw new Error("搜索引用对应的资料已更新、退役或删除，请返回重新搜索。");
  }
  if (!response.ok || payload?.source === undefined) throw new Error(payload?.error?.message ?? "资料原文加载失败");
  return payload.source;
}

export function ProjectSourceDetailClient({ username, isSystemAdmin }: { username: string; isSystemAdmin: boolean }) {
  const translateUi = useTranslate();
  const {language} = useAppearance();
  const { projectId, sourceId } = useParams<{ projectId: string; sourceId: string }>();
  const searchParams = useSearchParams();
  const citationContentHash = searchParams.get("contentHash");
  const fromNotifications = searchParams.get("from") === "notifications";
  const safeReturnTo = safeMaterialsReturnTo(projectId, searchParams.get("returnTo"));
  const [source, setSource] = useState<ProjectSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setSource(null);
    setError(null);
    try {
      const loaded = await getSource(projectId, sourceId, citationContentHash, signal);
      if (!signal?.aborted) setSource(loaded);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "资料原文加载失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [citationContentHash, projectId, sourceId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  return (
    <main className={supportStyles.supportPage}>
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="materials" isSystemAdmin={isSystemAdmin} />
      <div data-page-content>
        <div className="mb-5">{fromNotifications ? <ParentPageLink href="/notifications" label={translateUi("返回通知中心")} /> : safeReturnTo ? <ParentPageLink href={safeReturnTo} label={translateUi("返回原始资料")} scroll={false} /> : <ProjectMaterialsParentLink projectId={projectId} />}</div>
        <section className="pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-app-link"><UiText text={"Source detail"} /></p>
          <h1 className="app-page-title mt-3 font-semibold"><UiText text={"项目资料详情"} /></h1>
          <p className="mt-2 font-mono text-xs text-app-muted [overflow-wrap:anywhere]">{sourceId}</p>
        </section>
        {error ? <div role="alert" className="rounded-field border border-app-danger-border bg-app-danger-soft px-5 py-4 text-sm text-app-danger-ink app-feedback-error"><p><UiErrorText text={error} /></p><button type="button" onClick={() => void load()} className="mt-3 font-semibold underline underline-offset-4"><UiText text={"重试"} /></button></div> : null}
        {loading && !source ? <div className="h-72 animate-pulse rounded-control bg-app-surface-soft" aria-label={translateUi("正在加载资料详情")} /> : source ? <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(260px,0.75fr)]">
          <section className="min-w-0 overflow-hidden rounded-panel border border-app-border bg-app-surface app-panel">
            <div className="border-b border-app-border p-5 sm:p-6"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-app-accent-soft px-2.5 py-1 text-[12px] font-semibold uppercase tracking-wide text-app-link">{source.kind}</span><span className="rounded-full border border-app-border bg-app-surface-soft px-2.5 py-1 text-[12px] font-semibold text-app-muted"><UiText text={"原始资料"} /></span></div><h2 className="mt-3 text-lg font-semibold"><UiText text={"原始资料内容"} /></h2></div>
            <pre data-source-document className="whitespace-pre-wrap break-words p-5 text-sm leading-7 sm:p-6">{source.contentText}</pre>
          </section>
          <aside className="min-w-0 space-y-4">
            <section className="rounded-panel border border-app-border bg-app-surface p-5 app-panel">
              <h2 className="text-sm font-semibold"><UiText text={"资料信息"} /></h2>
              <dl className="mt-4 space-y-4 text-sm">
                <div><dt className="text-xs font-medium text-app-muted"><UiText text={"资料类型"} /></dt><dd className="mt-1 break-words">{source.kind}</dd></div>
                <div><dt className="text-xs font-medium text-app-muted"><UiText text={"外部来源"} /></dt><dd className="mt-1 break-all">{source.externalRef ?? <UiText text={"未提供外部来源"} />}</dd></div>
                <div><dt className="text-xs font-medium text-app-muted"><UiText text={"资料时间"} /></dt><dd className="mt-1">{formatDate(source.capturedAt, language)}</dd></div>
                <div><dt className="text-xs font-medium text-app-muted"><UiText text={"接入于"} /></dt><dd className="mt-1">{formatDate(source.ingestedAt, language)}</dd></div>
              </dl>
              <div className="mt-4 border-t border-app-border pt-4"><p className="text-xs font-semibold text-app-muted"><UiText text={"SHA-256"} /></p><code className="mt-2 block break-all text-xs leading-5 text-app-muted">{source.contentHash}</code></div>
            </section>
            <section aria-label={translateUi("资料下一步")} className="border-t border-app-border pt-5">
              <h2 className="text-sm font-semibold"><UiText text={"资料已保存，接下来做什么？"} /></h2>
              <p className="mt-2 text-sm leading-6 text-app-muted"><UiText text={"可直接整理这份资料；有原文依据且符合条件的内容形成事实，其余结果待核对。想查资料时，再单独确认更新问答索引。"} /></p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <OperationPanel title={translateUi("整理这份资料")} triggerLabel="继续 AI 整理"><ProjectFactImport projectId={projectId} sourceIds={[source.id]} onChanged={async () => undefined} /></OperationPanel>
              </div>
            </section>
          </aside>
        </div> : null}
      </div>
    </main>
  );
}
