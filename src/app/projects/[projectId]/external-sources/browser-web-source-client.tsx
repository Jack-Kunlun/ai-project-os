"use client";
import { UiFeedbackText } from "@/components/ui-error-text";


import { UiText, useTranslate } from "@/components/appearance-provider";
import { useState, type FormEvent } from "react";
import { OperationPanel } from "@/components/operation-panel";

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
  const translateUi = useTranslate();
  const [open, setOpen] = useState(false);
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
      setOpen(false);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "浏览器网页来源添加失败"); }
    finally { setPending(false); }
  }

  const inputClass = "mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-cyan-500";
  return <OperationPanel title={translateUi("添加浏览器网页来源")} triggerLabel="添加浏览器来源" open={open} onOpenChange={setOpen} disabled={pending} description="浏览器来源只在手动抓取时执行；站点登录凭据会被安全保存。">
  <form onSubmit={submit} className="max-w-2xl rounded-3xl border border-cyan-200 bg-white p-7 shadow-sm">
    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700"><UiText text={"Isolated browser"} /></p>
    <h2 className="mt-2 text-xl font-semibold"><UiText text={"添加浏览器网页来源"} /></h2>
    <p className="mt-3 text-xs leading-5 text-slate-600"><UiText text={"读取需要 JavaScript 的公网 HTTPS 页面。站点登录仅支持同源账号密码表单，抓取内容只供项目 Owner 私有预览，不会进入项目资料、搜索或 AI；普通 JavaScript 页面须人工审核后发布。"} /></p>
    <label className="mt-5 block text-sm font-medium text-slate-700"><UiText text={"读取方式"} /><select value={mode} onChange={(event) => setMode(event.target.value as "rendered" | "siteForm")} className={inputClass}><option value="rendered"><UiText text={"JavaScript 渲染"} /></option><option value="siteForm"><UiText text={"站点表单登录"} /></option></select></label>
    <label className="mt-4 block text-sm font-medium text-slate-700"><UiText text={"来源名称"} /><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} className={inputClass} /></label>
    <label className="mt-4 block text-sm font-medium text-slate-700"><UiText text={"精确页面地址"} /><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://docs.example.com/private" required className={inputClass} /></label>
    {mode === "siteForm" ? <div className="mt-5 space-y-4 rounded-2xl bg-slate-50 p-4">
      <p className="text-xs leading-5 text-slate-600"><UiText text={"登录页、提交地址和目标页必须同源。登录表单必须使用 POST，且仅向指定提交地址发送一次。"} /></p>
      <label className="block text-xs font-medium text-slate-700"><UiText text={"登录页地址"} /><input type="url" value={loginUrl} onChange={(event) => setLoginUrl(event.target.value)} required className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700"><UiText text={"表单提交地址"} /><input type="url" value={submitUrl} onChange={(event) => setSubmitUrl(event.target.value)} required className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700"><UiText text={"用户名输入框选择器"} /><input value={usernameSelector} onChange={(event) => setUsernameSelector(event.target.value)} required maxLength={160} className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700"><UiText text={"密码输入框选择器"} /><input value={passwordSelector} onChange={(event) => setPasswordSelector(event.target.value)} required maxLength={160} className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700"><UiText text={"提交按钮选择器"} /><input value={submitSelector} onChange={(event) => setSubmitSelector(event.target.value)} required maxLength={160} className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700"><UiText text={"登录成功标识选择器"} /><input value={successSelector} onChange={(event) => setSuccessSelector(event.target.value)} required maxLength={160} className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700"><UiText text={"站点用户名"} /><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required maxLength={512} className={inputClass} /></label>
      <label className="block text-xs font-medium text-slate-700"><UiText text={"站点密码"} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required maxLength={4096} className={inputClass} /></label>
    </div> : null}
    {message ? <p role="status" className="mt-4 text-xs text-slate-600"><UiFeedbackText text={message} /></p> : null}
    <button disabled={pending} className="mt-5 w-full rounded-xl bg-cyan-700 px-4 py-3 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-50">{pending ? <UiText text={"安全保存中…"} /> : <UiText text={"保存浏览器来源"} />}</button>
  </form>
  </OperationPanel>;
}

export function BrowserWebSourceCard({ projectId, source, canManage, canReview, onReload }: {
  projectId: string; source: BrowserWebSourceSummary; canManage: boolean; canReview: boolean; onReload: () => Promise<void>;
}) {
  const translateUi = useTranslate();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [operationOpen, setOperationOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const route = `/api/projects/${projectId}/web-sources/${source.id}`;

  async function action(path: string, method: "POST" | "PUT" | "DELETE" | "PATCH", body?: unknown, success?: string): Promise<boolean> {
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
      setOperationOpen(false);
      return true;
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "浏览器来源操作失败"); return false; }
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
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-lg font-semibold">{source.name}</h3><a href={source.url} target="_blank" rel="noreferrer" className="mt-1 block max-w-lg truncate text-xs text-cyan-700 hover:underline">{source.url}</a></div><span className="rounded-full bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-800">{source.authenticationMode === "siteForm" ? <UiText text={"站点表单登录"} /> : <UiText text={"JavaScript 渲染"} />}</span></div>
    <div className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-3"><div><UiText text={"状态："} />{source.status === "disabled" ? <UiText text={"已停用"} /> : source.status === "error" ? <UiText text={"需要处理"} /> : <UiText text={"已启用"} />}</div><div><UiText text={"最近抓取："} />{time(source.lastFetchedAt)}</div><div>{source.authenticationMode === "siteForm" ? `私有预览：${source.pendingReview ? "可查看" : "暂无内容"}` : `发布：${source.pointer ? "已有活动版本" : source.pendingReview ? "等待审核" : "尚未发布"}`}</div></div>
    {source.pendingReview ? <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">{source.authenticationMode === "siteForm" ? <UiText text={"Owner 私有预览"} /> : <UiText text={"待审核"} />}：{source.pendingReview.title} · {time(source.pendingReview.fetchedAt)}</p> : null}
    {source.lastErrorCode ? <p className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-xs text-rose-700"><UiText text={"安全错误码："} />{source.lastErrorCode}</p> : null}
    {message ? <p role="status" className="mt-4 text-xs text-slate-600"><UiFeedbackText text={message} /></p> : null}
    {canManage ? <OperationPanel title={translateUi("管理浏览器来源")} triggerLabel="管理来源" open={operationOpen} onOpenChange={setOperationOpen} disabled={pending} description="停用来源会退役已发布版本；手动抓取不会自动发布内容。">
      <div className="flex max-w-2xl flex-wrap justify-end gap-2">
        {source.authenticationMode === "siteForm" ? <form onSubmit={(event) => { event.preventDefault(); void action("/browser/credential", "PUT", { username, password }, "站点凭据已更新，旧预览已清除。"); }} className="w-full rounded-2xl bg-slate-50 p-4">
          <p className="text-xs font-semibold text-slate-700">{source.browserCredentialConfigured ? <UiText text={"轮换站点凭据"} /> : <UiText text={"重新设置站点凭据"} />}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2"><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required maxLength={512} placeholder={translateUi("站点用户名")} className="rounded-xl border border-slate-200 px-3 py-2 text-xs" /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required maxLength={4096} placeholder={translateUi("新密码")} className="rounded-xl border border-slate-200 px-3 py-2 text-xs" /></div>
          <div className="mt-3 flex justify-end gap-2"><button disabled={pending} className="rounded-xl bg-cyan-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><UiText text={"保存新凭据"} /></button>{source.browserCredentialConfigured ? <button type="button" onClick={() => void action("/browser/credential", "DELETE", undefined, "凭据已撤销，旧预览已清除。")} disabled={pending} className="rounded-xl border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50"><UiText text={"撤销凭据"} /></button> : null}</div>
        </form> : null}
        {!(source.status === "disabled" && source.authenticationMode === "siteForm" && !source.browserCredentialConfigured) ? <button onClick={() => void action("", "PATCH", { enabled: source.status === "disabled" }, source.status === "disabled" ? "来源已启用。" : source.authenticationMode === "siteForm" ? "来源已停用，私有预览已清除。" : "来源已停用，当前发布已退役。")} disabled={pending} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50">{source.status === "disabled" ? <UiText text={"启用"} /> : <UiText text={"停用"} />}</button> : null}
        <button onClick={() => void action("/browser/profile", "POST", undefined, source.authenticationMode === "siteForm" ? "浏览器执行配置已确认；若发生变化，旧预览已清除。" : "浏览器执行配置已确认；若发生变化，旧发布版本已退役。")} disabled={pending} className="rounded-xl border border-cyan-200 px-3 py-2 text-xs font-semibold text-cyan-800 disabled:opacity-50"><UiText text={"确认浏览器配置"} /></button>
        {source.status !== "disabled" && (source.authenticationMode === "rendered" || source.browserCredentialConfigured) ? <button onClick={() => void action("/browser/fetch", "POST", undefined, source.authenticationMode === "siteForm" ? "抓取完成，仅项目 Owner 可私有预览。" : "抓取完成，内容等待人工审核。")} disabled={pending} className="rounded-xl bg-cyan-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"><UiText text={"手动抓取"} /></button> : null}
      </div>
    </OperationPanel> : null}
    {(source.authenticationMode === "siteForm" ? canManage : canReview) && source.pendingReview ? <button onClick={() => review ? setReview(null) : void loadReview()} disabled={pending} className="mt-5 rounded-xl border border-cyan-200 px-3 py-2 text-xs font-semibold text-cyan-800 disabled:opacity-50">{review ? <UiText text={"收起内容"} /> : source.authenticationMode === "siteForm" ? <UiText text={"查看私有预览"} /> : <UiText text={"查看待审内容"} />}</button> : null}
    {review ? <section className="mt-5 rounded-2xl border border-cyan-200 bg-cyan-50/50 p-4"><h4 className="font-semibold">{review.title}</h4><p className="mt-1 break-all text-xs text-slate-500">{review.finalUrl} {" "}<UiText text={"· SHA-256"} />{" "}{review.contentHash}</p>{source.authenticationMode === "siteForm" ? <p className="mt-3 text-xs leading-5 text-cyan-900"><UiText text={"仅项目 Owner 可查看此预览。内容不会发布到项目资料，也不会进入搜索或 AI。"} /></p> : null}<pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-4 text-xs leading-6 text-slate-700">{review.contentText}</pre>{source.authenticationMode === "rendered" && canReview ? <OperationPanel title={translateUi("审核浏览器网页版本")} triggerLabel="审核并发布" disabled={pending} description="通过后内容会发布到项目资料；拒绝后该版本不会发布。"><div className="flex max-w-xl flex-wrap justify-end gap-2"><button type="button" onClick={() => void action(`/browser/reviews/${review.id}`, "POST", { decision: "rejected" }, "该版本已拒绝。")} disabled={pending} className="rounded-xl border border-rose-200 px-4 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50"><UiText text={"拒绝"} /></button><button type="button" onClick={() => void action(`/browser/reviews/${review.id}`, "POST", { decision: "accepted" }, "审核通过，内容已发布。")} disabled={pending} className="rounded-xl bg-cyan-700 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"><UiText text={"审核通过并发布"} /></button></div></OperationPanel> : source.authenticationMode === "siteForm" && canManage ? <OperationPanel title={translateUi("丢弃浏览器网页预览")} triggerLabel="丢弃预览" disabled={pending} description="私有预览不会发布到项目资料；丢弃后将无法查看当前预览内容。"><button type="button" onClick={() => void action(`/browser/reviews/${review.id}`, "POST", { decision: "rejected" }, "私有预览已丢弃。")} disabled={pending} className="rounded-xl border border-rose-200 px-4 py-2 text-xs font-semibold text-rose-700 disabled:opacity-50"><UiText text={"确认丢弃预览"} /></button></OperationPanel> : null}</section> : null}
  </article>;
}
