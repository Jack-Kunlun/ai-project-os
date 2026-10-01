"use client";

import { useState, type FormEvent } from "react";

export type BrowserWebSourceSummary = {
  id: string;
  name: string;
  url: string;
  authenticationMode: "rendered" | "siteForm";
  browserCredentialConfigured: boolean;
  status: "active" | "disabled" | "error";
  lastFetchedAt: string | null;
  lastErrorCode: string | null;
  pendingReview: null | { id: string; title: string; contentBytes: number; fetchedAt: string };
  pointer: null | { revision: { contentBytes: number } };
};

type Review = { id: string; title: string; finalUrl: string; contentHash: string; contentBytes: number; contentText: string; fetchedAt: string };

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch { return fallback; }
}

function time(value: string | null): string {
  return value === null ? "尚未抓取" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function BrowserWebSourceForm({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [mode, setMode] = useState<"rendered" | "siteForm">("rendered");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [submitUrl, setSubmitUrl] = useState("");
  const [usernameSelector, setUsernameSelector] = useState('input[name="username"]');
  const [passwordSelector, setPasswordSelector] = useState('input[name="password"]');
  const [submitSelector, setSubmitSelector] = useState('button[type="submit"]');
  const [successSelector, setSuccessSelector] = useState("#signed-in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const siteForm = mode === "siteForm" ? {
        loginUrl, submitUrl, usernameSelector, passwordSelector, submitSelector, successSelector, username, password,
      } : undefined;
      const response = await fetch(`/api/projects/${projectId}/web-sources/browser`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, url, mode, ...(siteForm === undefined ? {} : { siteForm }) }),
      });
      if (!response.ok) throw new Error(await responseError(response, "浏览器网页来源添加失败"));
      setName(""); setUrl(""); setUsername(""); setPassword("");
      setMessage(mode === "siteForm" ? "来源已保存。手动抓取后仅项目 Owner 可私有预览。" : "来源已保存。请手动抓取并审核后发布。");
      onCreated();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "浏览器网页来源添加失败"); }
    finally { setPending(false); }
  }

  const inputClass = "mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-cyan-500";
  return <form onSubmit={submit} className="rounded-3xl border border-cyan-200 bg-white p-7 shadow-sm">
    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700">Isolated browser</p>
    <h2 className="mt-2 text-xl font-semibold">添加浏览器网页来源</h2>
    <p className="mt-3 text-xs leading-5 text-slate-600">读取需要 JavaScript 的公网 HTTPS 页面。站点登录仅支持同源账号密码表单，抓取内容只供项目 Owner 私有预览，不会进入项目资料、搜索或 AI；普通 JavaScript 页面须人工审核后发布。</p>
    <label className="mt-5 block text-sm font-medium text-slate-700">读取方式<select value={mode} onChange={(event) => setMode(event.target.value as "rendered" | "siteForm")} className={inputClass}><option value="rendered">JavaScript 渲染</option><option value="siteForm">站点表单登录</option></select></label>
    <label className="mt-4 block text-sm font-medium text-slate-700">来源名称<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} className={inputClass} /></label>
    <label className="mt-4 block text-sm font-medium text-slate-700">精确页面地址<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://docs.example.com/private" required className={inputClass} /></label>
    {mode === "siteForm" ? <div className="mt-5 space-y-4 rounded-2xl bg-slate-50 p-4">
      <p className="text-xs leading-5 text-slate-600">登录页、提交地址和目标页必须同源。登录表单必须使用 POST，且仅向指定提交地址发送一次。</p>
      <label className="block text-xs font-medium text-slate-700">登录页地址<input type="url" value={loginUrl} onChange={(event) => setLoginUrl(event.target.value)} required className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700">表单提交地址<input type="url" value={submitUrl} onChange={(event) => setSubmitUrl(event.target.value)} required className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700">用户名输入框选择器<input value={usernameSelector} onChange={(event) => setUsernameSelector(event.target.value)} required maxLength={160} className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700">密码输入框选择器<input value={passwordSelector} onChange={(event) => setPasswordSelector(event.target.value)} required maxLength={160} className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700">提交按钮选择器<input value={submitSelector} onChange={(event) => setSubmitSelector(event.target.value)} required maxLength={160} className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700">登录成功标识选择器<input value={successSelector} onChange={(event) => setSuccessSelector(event.target.value)} required maxLength={160} className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700">站点用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required maxLength={512} className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700">站点密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required maxLength={4096} className={inputClass} /></label>
    </div> : null}
    {message ? <p role="status" className="mt-4 text-xs text-slate-600">{message}</p> : null}
    <button disabled={pending} className="mt-5 w-full rounded-xl bg-cyan-700 px-4 py-3 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-50">{pending ? "安全保存中…" : "保存浏览器来源"}</button>
  </form>;
}

export function BrowserWebSourceCard({ projectId, source, canManage, canReview, onReload }: {
  projectId: string; source: BrowserWebSourceSummary; canManage: boolean; canReview: boolean; onReload: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const route = `/api/projects/${projectId}/web-sources/${source.id}`;

  async function action(path: string, method: "POST" | "PUT" | "DELETE" | "PATCH", body?: unknown, success?: string) {
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`${route}${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(await responseError(response, "浏览器来源操作失败"));
      setUsername(""); setPassword(""); setReview(null);
      if (success) setMessage(success);
      await onReload();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "浏览器来源操作失败"); }
    finally { setPending(false); }
  }

  async function loadReview() {
    if (!source.pendingReview) return;
    setPending(true); setMessage(null);
    try {
      const response = await fetch(`${route}/browser/reviews/${source.pendingReview.id}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "待审内容加载失败"));
      setReview((await response.json() as { review: Review }).review);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "待审内容加载失败"); }
    finally { setPending(false); }
  }

  return <article className="rounded-3xl border border-cyan-200 bg-white p-6 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-lg font-semibold">{source.name}</h3><a href={source.url} target="_blank" rel="noreferrer" className="mt-1 block max-w-lg truncate text-xs text-cyan-700 hover:underline">{source.url}</a></div><span className="rounded-full bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-800">{source.authenticationMode === "siteForm" ? "站点表单登录" : "JavaScript 渲染"}</span></div>
    <div className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3"><div>状态：{source.status === "disabled" ? "已停用" : source.status === "error" ? "需要处理" : "已启用"}</div><div>最近抓取：{time(source.lastFetchedAt)}</div><div>{source.authenticationMode === "siteForm" ? `私有预览：${source.pendingReview ? "可查看" : "暂无内容"}` : `发布：${source.pointer ? "已有活动版本" : source.pendingReview ? "等待审核" : "尚未发布"}`}</div></div>
    {source.pendingReview ? <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">{source.authenticationMode === "siteForm" ? "Owner 私有预览" : "待审核"}：{source.pendingReview.title} · {time(source.pendingReview.fetchedAt)}</p> : null}
    {source.lastErrorCode ? <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-700">安全错误码：{source.lastErrorCode}</p> : null}
    {message ? <p role="status" className="mt-4 text-xs text-slate-600">{message}</p> : null}
    {source.authenticationMode === "siteForm" && canManage ? <form onSubmit={(event) => { event.preventDefault(); void action("/browser/credential", "PUT", { username, password }, "站点凭据已更新，旧预览已清除。"); }} className="mt-4 rounded-2xl bg-slate-50 p-4">
      <p className="text-xs font-semibold text-slate-700">{source.browserCredentialConfigured ? "轮换站点凭据" : "重新设置站点凭据"}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2"><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required maxLength={512} placeholder="站点用户名" className="rounded-xl border border-slate-200 px-3 py-2 text-xs" /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required maxLength={4096} placeholder="新密码" className="rounded-xl border border-slate-200 px-3 py-2 text-xs" /></div>
      <div className="mt-3 flex justify-end gap-2"><button disabled={pending} className="rounded-xl bg-cyan-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">保存新凭据</button>{source.browserCredentialConfigured ? <button type="button" onClick={() => void action("/browser/credential", "DELETE", undefined, "凭据已撤销，旧预览已清除。") } disabled={pending} className="rounded-xl border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50">撤销凭据</button> : null}</div>
    </form> : null}
    <div className="mt-5 flex flex-wrap justify-end gap-2">
      {canManage && !(source.status === "disabled" && source.authenticationMode === "siteForm" && !source.browserCredentialConfigured) ? <button onClick={() => void action("", "PATCH", { enabled: source.status === "disabled" }, source.status === "disabled" ? "来源已启用。" : source.authenticationMode === "siteForm" ? "来源已停用，私有预览已清除。" : "来源已停用，当前发布已退役。") } disabled={pending} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50">{source.status === "disabled" ? "启用" : "停用"}</button> : null}
      {canManage ? <button onClick={() => void action("/browser/profile", "POST", undefined, source.authenticationMode === "siteForm" ? "浏览器执行配置已确认；若发生变化，旧预览已清除。" : "浏览器执行配置已确认；若发生变化，旧发布版本已退役。") } disabled={pending} className="rounded-xl border border-cyan-200 px-3 py-2 text-xs font-semibold text-cyan-800 disabled:opacity-50">确认浏览器配置</button> : null}
      {canManage && source.status !== "disabled" && (source.authenticationMode === "rendered" || source.browserCredentialConfigured) ? <button onClick={() => void action("/browser/fetch", "POST", undefined, source.authenticationMode === "siteForm" ? "抓取完成，仅项目 Owner 可私有预览。" : "抓取完成，内容等待人工审核。") } disabled={pending} className="rounded-xl bg-cyan-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">手动抓取</button> : null}
      {(source.authenticationMode === "siteForm" ? canManage : canReview) && source.pendingReview ? <button onClick={() => review ? setReview(null) : void loadReview()} disabled={pending} className="rounded-xl border border-cyan-200 px-3 py-2 text-xs font-semibold text-cyan-800 disabled:opacity-50">{review ? "收起内容" : source.authenticationMode === "siteForm" ? "查看私有预览" : "查看待审内容"}</button> : null}
    </div>
    {review ? <section className="mt-5 rounded-2xl border border-cyan-200 bg-cyan-50/50 p-4"><h4 className="font-semibold">{review.title}</h4><p className="mt-1 break-all text-xs text-slate-500">{review.finalUrl} · SHA-256 {review.contentHash}</p>{source.authenticationMode === "siteForm" ? <p className="mt-3 text-xs leading-5 text-cyan-900">仅项目 Owner 可查看此预览。内容不会发布到项目资料，也不会进入搜索或 AI。</p> : null}<pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs leading-6 text-slate-700">{review.contentText}</pre><div className="mt-4 flex justify-end gap-2"><button onClick={() => void action(`/browser/reviews/${review.id}`, "POST", { decision: "rejected" }, source.authenticationMode === "siteForm" ? "私有预览已丢弃。" : "该版本已拒绝。") } disabled={pending} className="rounded-xl border border-rose-200 px-4 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50">{source.authenticationMode === "siteForm" ? "丢弃预览" : "拒绝"}</button>{source.authenticationMode === "rendered" ? <button onClick={() => void action(`/browser/reviews/${review.id}`, "POST", { decision: "accepted" }, "审核通过，内容已发布。") } disabled={pending} className="rounded-xl bg-cyan-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">审核通过并发布</button> : null}</div></section> : null}
  </article>;
}
