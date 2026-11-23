"use client";

import { DialogActions, DialogForm, DialogSubmit } from "@/components/dialog-actions";
import { UiErrorText, UiFeedbackText } from "@/components/ui-error-text";


import { UiText, useAppearance, useTranslate } from "@/components/appearance-provider";
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useRef, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { ListPagination } from "@/components/list-pagination";
import { OperationPanel } from "@/components/operation-panel";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";
import { BrowserWebSourceCard, BrowserWebSourceForm, type BrowserWebSourceSummary } from "./browser-web-source-client";
import supportStyles from "../project-support.module.css";
import { formatUiDateTimeOrFallback } from "@/lib/ui-date-format";

type WebSource = {
  id: string;
  name: string;
  url: string;
  allowPrivateNetwork: boolean;
  authenticationMode: "none" | "bearer";
  bearerConfigured: boolean;
  status: "active" | "disabled" | "error";
  lastFetchedAt: string | null;
  lastErrorCode: string | null;
  pendingReview: null | { id: string; title: string; contentHash: string; contentBytes: number; fetchedAt: string; finalUrl: string };
  pointer: null | { publishedAt: string; revision: { id: string; finalUrl: string | null; title: string | null; contentBytes: number; contentHash: string | null; fetchedAt: string } };
};
type ListedSource = WebSource | BrowserWebSourceSummary;

function isBrowserSource(source: ListedSource): source is BrowserWebSourceSummary {
  return source.authenticationMode === "rendered" || source.authenticationMode === "siteForm";
}

type WebSourceReview = { id: string; title: string; finalUrl: string; contentHash: string; contentBytes: number; contentText: string; fetchedAt: string };

async function responseError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch { return fallback; }
}

function formatDate(value: string | null, language: "zh-CN" | "en", t: (text: string) => string) {
  return formatUiDateTimeOrFallback(value === null ? null : new Date(value), language, t("尚未抓取"), { dateStyle: "medium", timeStyle: "short" });
}

export function ProjectExternalSourcesClient({ username, projectId, isSystemAdmin }: { username: string; projectId: string; isSystemAdmin: boolean }) {
  const translateUi = useTranslate();
  const [sources, setSources] = useState<ListedSource[]>([]);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [status, setStatus] = useState<"all" | WebSource["status"]>("all");
  const [pagination, setPagination] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canManageCredentials, setCanManageCredentials] = useState(false);
  const [canReview, setCanReview] = useState(false);
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const requestVersion = useRef(0);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    const version = ++requestVersion.current;
    if (showLoading) setLoading(true);
    try {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: "10",
        status,
        ...(deferredSearch.trim() ? { search: deferredSearch.trim() } : {}),
      });
      const response = await fetch(`/api/projects/${projectId}/web-sources?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "外部资料加载失败"));
      const payload = await response.json() as {
        sources: ListedSource[];
        pagination: { page: number; pageSize: number; total: number; totalPages: number };
        canManageCredentials: boolean;
        canReview: boolean;
        browserEnabled: boolean;
      };
      if (requestVersion.current !== version) return;
      setSources(payload.sources);
      setSourcesLoaded(true);
      setPagination(payload.pagination);
      setCanManageCredentials(payload.canManageCredentials);
      setCanReview(payload.canReview);
      setBrowserEnabled(payload.browserEnabled);
      setError(null);
    } catch (cause) {
      if (requestVersion.current === version) setError(cause instanceof Error ? cause.message : "外部资料加载失败");
    } finally {
      if (showLoading && requestVersion.current === version) setLoading(false);
    }
  }, [deferredSearch, page, projectId, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload({ showLoading: true }), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  function resetFilters(next: { search?: string; status?: "all" | WebSource["status"] }) {
    if (next.search !== undefined) setSearch(next.search);
    if (next.status !== undefined) setStatus(next.status);
    setPage(1);
  }

  return (
    <main className={supportStyles.supportPage}>
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="externalSources" isSystemAdmin={isSystemAdmin} />
      <div data-page-content className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12">
        <div className="mb-5"><ProjectMaterialsParentLink projectId={projectId} /></div>
        <section className="mb-6 max-w-4xl border-b border-app-border pb-5">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-app-link"><UiText text={"External knowledge"} /></p>
          <h1 className="app-page-title mt-2 font-semibold text-app-text"><UiText text={"外部资料入口"} /></h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-app-muted"><UiText text={"添加公开网页或经你明确授权的内网页面。系统固定 DNS 解析、逐跳检查重定向、限制响应体并只提取文本；网页内容作为不可信资料保存，不会被当作系统指令执行。"} /></p>
        </section>
        {error ? <div role="alert" className="mt-6 rounded-field border border-app-danger-border bg-app-danger-soft px-5 py-4 text-sm text-app-danger-ink app-feedback-error"><UiErrorText text={error} /></div> : null}
        {canManageCredentials ? <div className="mt-6 flex flex-wrap gap-3">
          <WebSourceForm projectId={projectId} onCreated={() => { setPage(1); void reload({ showLoading: true }); }} />
          <AuthenticatedWebSourceForm projectId={projectId} onCreated={() => { setPage(1); void reload({ showLoading: true }); }} />
          {browserEnabled ? <BrowserWebSourceForm projectId={projectId} onCreated={() => { setPage(1); void reload({ showLoading: true }); }} /> : null}
        </div> : null}
        <section className="mt-6 rounded-panel border border-app-border bg-app-surface p-6 app-panel">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-app-link"><UiText text={"Local folders"} /></p>
              <h2 className="mt-2 text-xl font-semibold"><UiText text={"本地文件夹批量导入"} /></h2>
              <p className="mt-3 text-sm leading-6 text-app-muted"><UiText text={"从文件资料页选择一个文件夹。浏览器只上传你选中的、受支持且满足大小限制的文件，并逐个保留原文件名和审核状态。"} /></p>
              <Link href={`/projects/${projectId}/assets`} className="mt-5 inline-flex rounded-control px-4 py-2.5 text-xs font-semibold app-button-primary"><UiText text={"前往文件资料"} /></Link>
        </section>
        <section className="mt-8">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3 px-1">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-app-muted"><UiText text={"Web sources"} /></p>
                <h2 className="mt-2 text-2xl font-semibold"><UiText text={"网页资料"} /></h2>
              </div>
              <span className="text-xs text-app-muted">{loading ? <UiText text={"读取中…"} /> : error && !sourcesLoaded ? "—" : translateUi("{count} 个").replace("{count}", String(pagination.total))}</span>
            </div>
            <div className="mb-4 grid gap-3 rounded-panel border border-app-border bg-app-surface p-4 sm:grid-cols-[1fr_auto] app-panel">
              <label>
                <span className="sr-only"><UiText text={"搜索网页资料"} /></span>
                <input value={search} onChange={(event) => resetFilters({ search: event.target.value })} placeholder={translateUi("搜索来源名称、地址或页面标题")} className="w-full rounded-field border border-app-border px-4 py-3 text-sm outline-none focus:border-app-accent-border focus:ring-4 focus:ring-app-accent-border app-field" />
              </label>
              <label>
                <span className="sr-only"><UiText text={"筛选网页资料状态"} /></span>
                <select value={status} onChange={(event) => resetFilters({ status: event.target.value as "all" | WebSource["status"] })} className="h-full min-h-11 rounded-field border border-app-border bg-app-surface px-4 text-sm text-app-muted app-field">
                  <option value="all"><UiText text={"全部状态"} /></option>
                  <option value="active"><UiText text={"已启用"} /></option>
                  <option value="error"><UiText text={"需要处理"} /></option>
                  <option value="disabled"><UiText text={"已停用"} /></option>
                </select>
              </label>
            </div>
            <div className="space-y-4">
              {!loading && sourcesLoaded && sources.length === 0 ? (
                <div className="rounded-panel border border-dashed border-app-border bg-app-surface px-6 py-16 text-center text-sm text-app-muted">
                  {search.trim() || status !== "all" ? <UiText text={"没有匹配的网页资料。"} /> : <UiText text={"还没有网页来源。公开静态网页添加后会抓取；认证及浏览器来源需手动抓取和审核。"} />}
                </div>
              ) : sources.map((source) => isBrowserSource(source)
                ? <BrowserWebSourceCard key={source.id} projectId={projectId} source={source} canManage={canManageCredentials} canReview={canReview} onReload={reload} />
                : <WebSourceCard key={source.id} projectId={projectId} source={source} canManageCredentials={canManageCredentials} canReview={canReview} onReload={reload} />)}
            </div>
            <ListPagination {...pagination} disabled={loading} onPageChange={setPage} />
        </section>
      </div>
    </main>
  );
}
function WebSourceForm({ projectId, onCreated }: { projectId: string; onCreated: (source: WebSource) => void }) {
  const translateUi = useTranslate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(""); const [url, setUrl] = useState(""); const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false); const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/web-sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, url, allowPrivateNetwork }) });
      if (!response.ok) throw new Error(await responseError(response, "网页来源添加失败"));
      onCreated((await response.json() as { source: WebSource }).source); setName(""); setUrl(""); setAllowPrivateNetwork(false); setMessage("网页已抓取并发布到项目资料库。"); setOpen(false);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "网页来源添加失败"); }
    finally { setPending(false); }
  }
  return <OperationPanel title={translateUi("添加网页来源")} triggerLabel="添加公开网页" open={open} onOpenChange={setOpen} disabled={pending} description="添加后会立即抓取，并将公开网页内容发布到项目资料库。">
    <DialogForm onSubmit={submit} className="w-full"><label className="mt-5 block text-sm font-medium text-app-text"><UiText text={"来源名称"} /><input value={name} onChange={(event) => setName(event.target.value)} placeholder={translateUi("例如：产品文档")} required className="mt-2 w-full rounded-field border border-app-border px-4 py-3 text-sm outline-none focus:border-app-accent-border app-field" /></label><label className="mt-5 block text-sm font-medium text-app-text"><UiText text={"网页地址"} /><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://docs.example.com/guide" required className="mt-2 w-full rounded-field border border-app-border px-4 py-3 text-sm outline-none focus:border-app-accent-border app-field" /></label><label className="mt-5 flex items-start gap-3 rounded-panel border border-app-warning-border bg-app-warning-soft p-4 text-xs leading-5 text-app-warning-ink"><input type="checkbox" checked={allowPrivateNetwork} onChange={(event) => setAllowPrivateNetwork(event.target.checked)} className="mt-1" /><span><strong className="block"><UiText text={"允许访问内网地址"} /></strong><UiText text={"仅在该项目确实需要读取公司内网页面时启用。云元数据地址始终被阻止；HTTP 也只有在此开关启用时才允许。"} /></span></label>{message ? <p role="status" className="mt-4 text-xs text-app-muted"><UiFeedbackText text={message} /></p> : null}<DialogActions><button type="button" onClick={() => setOpen(false)} disabled={pending} className="app-button-secondary rounded-control border font-semibold disabled:cursor-not-allowed disabled:opacity-50"><UiText text="取消" /></button><DialogSubmit disabled={pending} className="app-button-primary rounded-control font-semibold disabled:cursor-not-allowed disabled:opacity-50">{pending ? <UiText text={"验证并抓取中…"} /> : <UiText text={"添加并抓取"} />}</DialogSubmit></DialogActions></DialogForm>
  </OperationPanel>;
}

function AuthenticatedWebSourceForm({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const translateUi = useTranslate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/web-sources/authenticated`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, url, bearerToken }) });
      if (!response.ok) throw new Error(await responseError(response, "认证网页来源添加失败"));
      setName(""); setUrl(""); setBearerToken(""); setMessage("凭据已安全保存。请手动抓取并由项目成员审核后发布。"); onCreated(); setOpen(false);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "认证网页来源添加失败"); }
    finally { setPending(false); }
  }
  return <OperationPanel title={translateUi("添加 Bearer 保护网页")} triggerLabel="添加认证网页" open={open} onOpenChange={setOpen} disabled={pending} description="凭据会在服务端加密保存；抓取内容需要手动审核后发布。">
    <DialogForm onSubmit={submit} className="w-full"><p className="mt-3 text-xs leading-5 text-app-muted"><UiText text={"仅支持公网 HTTPS 静态 GET。令牌只在服务端加密保存并绑定此地址；生产环境当前关闭此能力。抓取结果先进入审核，不会自动发布或定时同步。"} /></p><label className="mt-5 block text-sm font-medium text-app-text"><UiText text={"来源名称"} /><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} className="mt-2 w-full rounded-field border border-app-border px-4 py-3 text-sm app-field" /></label><label className="mt-4 block text-sm font-medium text-app-text"><UiText text={"精确 HTTPS 地址"} /><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://docs.example.com/private/guide" required className="mt-2 w-full rounded-field border border-app-border px-4 py-3 text-sm app-field" /></label><label className="mt-4 block text-sm font-medium text-app-text"><UiText text={"Bearer 令牌"} /><input type="password" value={bearerToken} onChange={(event) => setBearerToken(event.target.value)} autoComplete="new-password" required minLength={8} maxLength={4096} className="mt-2 w-full rounded-field border border-app-border px-4 py-3 text-sm app-field" /></label>{message ? <p role="status" className="mt-4 text-xs text-app-muted"><UiFeedbackText text={message} /></p> : null}<DialogActions><button type="button" onClick={() => setOpen(false)} disabled={pending} className="app-button-secondary rounded-control border font-semibold disabled:cursor-not-allowed disabled:opacity-50"><UiText text="取消" /></button><DialogSubmit disabled={pending} className="app-button-primary rounded-control font-semibold disabled:cursor-not-allowed disabled:opacity-50">{pending ? <UiText text={"加密保存中…"} /> : <UiText text={"安全保存凭据"} />}</DialogSubmit></DialogActions></DialogForm>
  </OperationPanel>;
}

function WebSourceCard({ projectId, source, canManageCredentials, canReview, onReload }: { projectId: string; source: WebSource; canManageCredentials: boolean; canReview: boolean; onReload: () => Promise<void> }) {
  const { language } = useAppearance();
  const translateUi = useTranslate();
  const [pending, setPending] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [reviewOperationOpen, setReviewOperationOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [bearerToken, setBearerToken] = useState("");
  const [review, setReview] = useState<WebSourceReview | null>(null);
  const route = `/api/projects/${projectId}/web-sources/${source.id}`;
  async function patch(body: unknown, successMessage?: string) {
    setPending(true); setMessage(null);
    try { const response = await fetch(route, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await responseError(response, "网页来源更新失败")); await onReload(); if (successMessage) setMessage(successMessage); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "网页来源更新失败"); }
    finally { setPending(false); }
  }
  async function sync() {
    setPending(true); setMessage(null);
    try { const response = await fetch(`${route}/sync`, { method: "POST" }); if (!response.ok) throw new Error(await responseError(response, "网页刷新失败")); setMessage("网页已刷新，新的资料版本已经发布。"); await onReload(); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "网页刷新失败"); }
    finally { setPending(false); }
  }
  async function saveCredential(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try { const response = await fetch(`${route}/credential`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ bearerToken }) }); if (!response.ok) throw new Error(await responseError(response, "凭据更新失败")); setBearerToken(""); setMessage("凭据已加密保存；旧的待审核版本已失效。"); await onReload(); setCredentialOpen(false); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "凭据更新失败"); }
    finally { setPending(false); }
  }
  async function revokeCredential() {
    setPending(true); setMessage(null);
    try { const response = await fetch(`${route}/credential`, { method: "DELETE" }); if (!response.ok) throw new Error(await responseError(response, "凭据撤销失败")); setReview(null); setMessage("凭据已撤销，认证模式保持不变；该来源不会自动抓取。"); await onReload(); setCredentialOpen(false); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "凭据撤销失败"); }
    finally { setPending(false); }
  }
  async function authenticatedFetch() {
    setPending(true); setMessage(null);
    try { const response = await fetch(`${route}/fetch`, { method: "POST" }); if (!response.ok) throw new Error(await responseError(response, "手动抓取失败")); setMessage("抓取完成，内容已进入待审核状态。"); await onReload(); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "手动抓取失败"); await onReload(); }
    finally { setPending(false); }
  }
  async function loadReview() {
    const revisionId = source.pendingReview?.id;
    if (!revisionId) return;
    setPending(true); setMessage(null);
    try { const response = await fetch(`${route}/reviews/${revisionId}`, { cache: "no-store" }); if (!response.ok) throw new Error(await responseError(response, "待审内容加载失败")); const payload = await response.json() as { review: WebSourceReview }; setReview(payload.review); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "待审内容加载失败"); }
    finally { setPending(false); }
  }
  async function decideReview(decision: "accepted" | "rejected"): Promise<boolean> {
    const revisionId = source.pendingReview?.id;
    if (!revisionId) return false;
    setPending(true); setMessage(null);
    try { const response = await fetch(`${route}/reviews/${revisionId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) }); if (!response.ok) throw new Error(await responseError(response, "审核提交失败")); setReview(null); setMessage(decision === "accepted" ? "审核通过，内容已发布到项目资料库。" : "已拒绝此版本，内容不会进入项目资料库。"); await onReload(); setReviewOperationOpen(false); return true; }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "审核提交失败"); return false; }
    finally { setPending(false); }
  }
  const tone = source.status === "active" ? "bg-app-success-soft text-app-success-ink" : source.status === "error" ? "bg-app-danger-soft text-app-danger-ink" : "bg-app-surface-soft text-app-muted";
  const authenticated = source.authenticationMode === "bearer";
  const needsAuthenticatedNetworkReconfirmation = authenticated && canManageCredentials && source.status !== "disabled" && source.lastErrorCode === "WEB_SOURCE_NETWORK_CHANGED";
  return <article className="rounded-panel border border-app-border bg-app-surface p-6 app-panel">
    <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate text-lg font-semibold">{source.name}</h3><span className={`rounded-full px-2.5 py-1 text-[12px] font-semibold ${tone}`}>{source.status === "active" ? <UiText text={"已启用"} /> : source.status === "error" ? <UiText text={"需要处理"} /> : <UiText text={"已停用"} />}</span>{authenticated ? <span className="rounded-full bg-app-accent-soft px-2.5 py-1 text-[12px] font-semibold text-app-link"><UiText text={"Bearer 认证"} /></span> : null}</div><a href={source.url} target="_blank" rel="noreferrer" className="mt-2 block max-w-xl truncate text-xs text-app-link hover:underline">{source.url}</a></div><span className="text-xs text-app-muted">{authenticated ? <UiText text={"公网 HTTPS · 手动抓取"} /> : source.allowPrivateNetwork ? <UiText text={"已授权内网"} /> : <UiText text={"仅公网"} />}</span></div>
    <div className="mt-5 grid gap-3 sm:grid-cols-3"><Info label={translateUi("最近抓取")} value={formatDate(source.lastFetchedAt, language, translateUi)} /><Info label={translateUi("发布状态")} value={source.pointer ? "已有活动版本" : source.pendingReview ? "等待审核" : "尚未发布"} /><Info label={translateUi("内容大小")} value={source.pointer ? `${Math.ceil(source.pointer.revision.contentBytes / 1024)} KiB` : source.pendingReview ? `${Math.ceil(source.pendingReview.contentBytes / 1024)} KiB 待审` : "—"} /></div>
    {source.pendingReview && !review ? <p className="mt-4 rounded-panel bg-app-warning-soft px-4 py-3 text-xs text-app-warning-ink"><UiText text={"有一个待审核版本："} />{source.pendingReview.title} {" "}<UiText text={"· 抓取于"} />{" "}{formatDate(source.pendingReview.fetchedAt, language, translateUi)}</p> : null}{source.lastErrorCode ? <p className="mt-4 rounded-panel bg-app-danger-soft px-4 py-3 text-xs text-app-danger-ink"><UiText text={"安全错误码："} />{source.lastErrorCode}</p> : null}{needsAuthenticatedNetworkReconfirmation ? <p className="mt-4 rounded-panel border border-app-warning-border bg-app-warning-soft px-4 py-3 text-xs leading-5 text-app-warning-ink"><UiText text={"检测到域名解析地址变化。Owner 重新确认当前公网地址后，会立即退役此来源已发布的版本；请之后重新手动抓取并审核。"} /></p> : null}{message ? <p role="status" className="mt-4 text-xs text-app-muted"><UiFeedbackText text={message} /></p> : null}
    {authenticated && canManageCredentials ? <OperationPanel title={translateUi("管理网页凭据")} triggerLabel="管理凭据" open={credentialOpen} onOpenChange={(open) => { setCredentialOpen(open); if (open) setMessage(null); }} disabled={pending} description="Bearer 令牌只在服务端加密保存，页面不会回显已保存的值。">
      {message ? <p role="alert" className="mb-3 rounded-field bg-app-danger-soft px-3 py-2 text-xs leading-5 text-app-danger-ink app-feedback-error"><UiFeedbackText text={message} /></p> : null}
      <DialogForm onSubmit={saveCredential} className="w-full"><label className="block text-sm font-semibold text-app-text">{source.bearerConfigured ? <UiText text={"轮换 Bearer 令牌"} /> : <UiText text={"配置 Bearer 令牌"} />}<input type="password" value={bearerToken} onChange={(event) => setBearerToken(event.target.value)} autoComplete="new-password" required minLength={8} maxLength={4096} className="mt-2 w-full rounded-field border border-app-border bg-app-surface px-4 py-2.5 text-sm app-field" /></label><p className="mt-2 text-xs text-app-muted"><UiText text={"当前状态："} />{source.bearerConfigured ? <UiText text={"已配置（值不显示）"} /> : <UiText text={"已撤销"} />}</p><DialogActions><DialogSubmit disabled={pending} className="app-button-primary rounded-control font-semibold disabled:cursor-not-allowed disabled:opacity-50"><UiText text={"保存新令牌"} /></DialogSubmit>{source.bearerConfigured ? <button type="button" onClick={() => void revokeCredential()} disabled={pending} className="app-button-danger rounded-control border font-semibold disabled:cursor-not-allowed disabled:opacity-50"><UiText text={"撤销令牌"} /></button> : null}</DialogActions></DialogForm>
    </OperationPanel> : null}
    <div className="mt-5 flex flex-wrap justify-end gap-2">{needsAuthenticatedNetworkReconfirmation ? <button onClick={() => void patch({ trustCurrentNetwork: true }, "当前公网解析已重新确认。旧发布版本已退役，请重新手动抓取并审核后发布。")} disabled={pending} className="rounded-control border px-3 py-2 text-xs font-semibold disabled:opacity-50 app-button-warning"><UiText text={"确认网络并退役旧版本"} /></button> : source.status === "error" && !authenticated ? <button onClick={() => void patch({ trustCurrentNetwork: true })} disabled={pending} className="rounded-control border px-3 py-2 text-xs font-semibold disabled:opacity-50 app-button-warning"><UiText text={"重新确认网络"} /></button> : null}<button onClick={() => void patch({ enabled: source.status === "disabled" })} disabled={pending} className="rounded-control px-3 py-2 text-xs font-semibold text-app-muted hover:bg-app-surface-soft disabled:opacity-50">{source.status === "disabled" ? <UiText text={"启用"} /> : <UiText text={"停用"} />}</button>{authenticated ? canManageCredentials && source.status !== "disabled" && source.bearerConfigured ? <button onClick={() => void authenticatedFetch()} disabled={pending} className="rounded-control px-4 py-2 text-xs font-semibold disabled:opacity-50 app-button-primary"><UiText text={"手动抓取"} /></button> : null : source.status !== "disabled" ? <button onClick={() => void sync()} disabled={pending} className="rounded-control px-4 py-2 text-xs font-semibold disabled:opacity-50 app-button-primary"><UiText text={"立即刷新"} /></button> : null}{authenticated && source.pendingReview && canReview ? <button onClick={() => review ? setReview(null) : void loadReview()} disabled={pending} className="rounded-control border border-app-accent-border px-3 py-2 text-xs font-semibold text-app-link disabled:opacity-50">{review ? <UiText text={"收起审核内容"} /> : <UiText text={"查看待审内容"} />}</button> : null}</div>
    {review ? <section className="mt-5 rounded-panel border border-app-accent-border bg-app-accent-soft p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-semibold text-app-text">{review.title}</h4><a href={review.finalUrl} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-app-link hover:underline">{review.finalUrl}</a><p className="mt-1 text-xs text-app-muted"><UiText text={"SHA-256"} />{" "}{review.contentHash}</p></div><span className="text-xs text-app-muted">{Math.ceil(review.contentBytes / 1024)} {" "}<UiText text={"KiB"} /></span></div><pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-panel bg-app-surface p-4 text-xs leading-6 text-app-text">{review.contentText}</pre>{canReview ? <div className="mt-4"><OperationPanel title={translateUi("审核网页版本")} triggerLabel="审核并发布" open={reviewOperationOpen} onOpenChange={(open) => { setReviewOperationOpen(open); if (open) setMessage(null); }} disabled={pending} description="通过后此版本会发布到项目资料库；拒绝后不会进入项目资料库。">{message ? <p role="alert" className="mb-3 rounded-field bg-app-danger-soft px-3 py-2 text-xs leading-5 text-app-danger-ink app-feedback-error"><UiFeedbackText text={message} /></p> : null}<DialogActions><button type="button" onClick={() => void decideReview("rejected")} disabled={pending} className="app-button-danger rounded-control border font-semibold disabled:cursor-not-allowed disabled:opacity-50"><UiText text={"拒绝"} /></button><button type="button" onClick={() => void decideReview("accepted")} disabled={pending} className="app-button-primary rounded-control font-semibold disabled:cursor-not-allowed disabled:opacity-50"><UiText text={"审核通过并发布"} /></button></DialogActions></OperationPanel></div> : null}</section> : null}
  </article>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-panel bg-app-surface-soft px-4 py-3"><span className="block text-[12px] text-app-muted">{label}</span><strong className="mt-1 block truncate text-xs font-semibold text-app-text">{value}</strong></div>; }
