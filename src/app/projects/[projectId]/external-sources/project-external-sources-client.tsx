"use client";

import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useState, type FormEvent } from "react";
import { AppHeader } from "@/components/app-header";
import { ListPagination } from "@/components/list-pagination";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";

type WebSource = {
  id: string;
  name: string;
  url: string;
  allowPrivateNetwork: boolean;
  status: "active" | "disabled" | "error";
  lastFetchedAt: string | null;
  lastErrorCode: string | null;
  pointer: null | { publishedAt: string; revision: { id: string; finalUrl: string | null; title: string | null; contentBytes: number; contentHash: string | null; fetchedAt: string } };
};

async function responseError(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch { return fallback; }
}

function formatDate(value: string | null) {
  return value === null ? "尚未抓取" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function ProjectExternalSourcesClient({ username, projectId }: { username: string; projectId: string }) {
  const [sources, setSources] = useState<WebSource[]>([]);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [status, setStatus] = useState<"all" | WebSource["status"]>("all");
  const [pagination, setPagination] = useState({ page: 1, pageSize: 10, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
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
        sources: WebSource[];
        pagination: { page: number; pageSize: number; total: number; totalPages: number };
      };
      setSources(payload.sources);
      setPagination(payload.pagination);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "外部资料加载失败");
    } finally {
      if (showLoading) setLoading(false);
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
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={username} active="projects" projectId={projectId} projectSection="externalSources" />
      <div className="mx-auto max-w-7xl px-6 py-9 sm:px-10 lg:px-12">
        <div className="mb-5"><ProjectMaterialsParentLink projectId={projectId} /></div>
        <section className="rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950 px-8 py-10 text-white shadow-xl shadow-slate-950/10">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">External knowledge</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">外部资料入口</h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">添加公开网页或经你明确授权的内网页面。系统固定 DNS 解析、逐跳检查重定向、限制响应体并只提取文本；网页内容作为不可信资料保存，不会被当作系统指令执行。</p>
        </section>
        {error ? <div role="alert" className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">{error}</div> : null}
        <div className="mt-8 grid gap-7 xl:grid-cols-[.78fr_1.22fr]">
          <div className="space-y-5">
            <WebSourceForm projectId={projectId} onCreated={() => { setPage(1); void reload({ showLoading: true }); }} />
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Local folders</p>
              <h2 className="mt-2 text-xl font-semibold">本地文件夹批量导入</h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">从文件资料页选择一个文件夹。浏览器只上传你选中的、受支持且满足大小限制的文件，并逐个保留原文件名和审核状态。</p>
              <Link href={`/projects/${projectId}/assets`} className="mt-5 inline-flex rounded-xl bg-slate-950 px-4 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700">前往文件资料</Link>
            </section>
          </div>
          <section>
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3 px-1">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Web sources</p>
                <h2 className="mt-2 text-2xl font-semibold">网页资料</h2>
              </div>
              <span className="text-xs text-slate-400">{loading ? "读取中…" : `${pagination.total} 个`}</span>
            </div>
            <div className="mb-4 grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-[1fr_auto]">
              <label>
                <span className="sr-only">搜索网页资料</span>
                <input value={search} onChange={(event) => resetFilters({ search: event.target.value })} placeholder="搜索来源名称、地址或页面标题" className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-cyan-400 focus:ring-4 focus:ring-cyan-100" />
              </label>
              <label>
                <span className="sr-only">筛选网页资料状态</span>
                <select value={status} onChange={(event) => resetFilters({ status: event.target.value as "all" | WebSource["status"] })} className="h-full min-h-11 rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-600">
                  <option value="all">全部状态</option>
                  <option value="active">已启用</option>
                  <option value="error">需要处理</option>
                  <option value="disabled">已停用</option>
                </select>
              </label>
            </div>
            <div className="space-y-4">
              {!loading && sources.length === 0 ? (
                <div className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">
                  {search.trim() || status !== "all" ? "没有匹配的网页资料。" : "还没有网页来源。添加后会立即抓取一次并发布为可追溯资料。"}
                </div>
              ) : sources.map((source) => <WebSourceCard key={source.id} projectId={projectId} source={source} onReload={reload} />)}
            </div>
            <ListPagination {...pagination} disabled={loading} onPageChange={setPage} />
          </section>
        </div>
      </div>
    </main>
  );
}
function WebSourceForm({ projectId, onCreated }: { projectId: string; onCreated: (source: WebSource) => void }) {
  const [name, setName] = useState(""); const [url, setUrl] = useState(""); const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false); const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/web-sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, url, allowPrivateNetwork }) });
      if (!response.ok) throw new Error(await responseError(response, "网页来源添加失败"));
      onCreated((await response.json() as { source: WebSource }).source); setName(""); setUrl(""); setAllowPrivateNetwork(false); setMessage("网页已抓取并发布到项目资料库。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "网页来源添加失败"); }
    finally { setPending(false); }
  }
  return <form onSubmit={submit} className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">Add webpage</p><h2 className="mt-2 text-2xl font-semibold">添加网页来源</h2><label className="mt-5 block text-sm font-medium text-slate-700">来源名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：产品文档" required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-cyan-500" /></label><label className="mt-5 block text-sm font-medium text-slate-700">网页地址<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://docs.example.com/guide" required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-cyan-500" /></label><label className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-800"><input type="checkbox" checked={allowPrivateNetwork} onChange={(event) => setAllowPrivateNetwork(event.target.checked)} className="mt-1" /><span><strong className="block">允许访问内网地址</strong>仅在该项目确实需要读取公司内网页面时启用。云元数据地址始终被阻止；HTTP 也只有在此开关启用时才允许。</span></label>{message ? <p role="status" className="mt-4 text-xs text-slate-600">{message}</p> : null}<button disabled={pending} className="mt-6 w-full rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50">{pending ? "验证并抓取中…" : "添加并抓取"}</button></form>;
}

function WebSourceCard({ projectId, source, onReload }: { projectId: string; source: WebSource; onReload: () => Promise<void> }) {
  const [pending, setPending] = useState(false); const [message, setMessage] = useState<string | null>(null);
  async function patch(body: unknown) { setPending(true); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/web-sources/${source.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await responseError(response, "网页来源更新失败")); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "网页来源更新失败"); } finally { setPending(false); } }
  async function sync() { setPending(true); setMessage(null); try { const response = await fetch(`/api/projects/${projectId}/web-sources/${source.id}/sync`, { method: "POST" }); if (!response.ok) throw new Error(await responseError(response, "网页刷新失败")); setMessage("网页已刷新，新的资料版本已经原子发布。"); await onReload(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "网页刷新失败"); } finally { setPending(false); } }
  const tone = source.status === "active" ? "bg-emerald-50 text-emerald-700" : source.status === "error" ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-500";
  return <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate text-lg font-semibold">{source.name}</h3><span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone}`}>{source.status === "active" ? "已启用" : source.status === "error" ? "需要处理" : "已停用"}</span></div><a href={source.url} target="_blank" rel="noreferrer" className="mt-2 block max-w-xl truncate text-xs text-cyan-700 hover:underline">{source.url}</a></div><span className="text-xs text-slate-400">{source.allowPrivateNetwork ? "已授权内网" : "仅公网"}</span></div><div className="mt-5 grid gap-3 sm:grid-cols-3"><Info label="最近抓取" value={formatDate(source.lastFetchedAt)} /><Info label="发布状态" value={source.pointer ? "已有活动版本" : "尚未发布"} /><Info label="内容大小" value={source.pointer ? `${Math.ceil(source.pointer.revision.contentBytes / 1024)} KiB` : "—"} /></div>{source.lastErrorCode ? <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-700">安全错误码：{source.lastErrorCode}</p> : null}{message ? <p role="status" className="mt-4 text-xs text-slate-600">{message}</p> : null}<div className="mt-5 flex flex-wrap justify-end gap-2">{source.status === "error" ? <button onClick={() => void patch({ trustCurrentNetwork: true })} disabled={pending} className="rounded-xl border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50">重新确认网络</button> : null}<button onClick={() => void patch({ enabled: source.status === "disabled" })} disabled={pending} className="rounded-xl px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50">{source.status === "disabled" ? "启用" : "停用"}</button>{source.status !== "disabled" ? <button onClick={() => void sync()} disabled={pending} className="rounded-xl bg-cyan-700 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-600 disabled:opacity-50">立即刷新</button> : null}</div></article>;
}

function Info({ label, value }: { label: string; value: string }) { return <div className="rounded-2xl bg-slate-50 px-4 py-3"><span className="block text-[11px] text-slate-400">{label}</span><strong className="mt-1 block truncate text-xs font-semibold text-slate-700">{value}</strong></div>; }
