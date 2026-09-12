"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { LogoutButton } from "@/app/logout-button";
import { AppHeader } from "@/components/app-header";

type Profile = {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  role: "admin" | "user";
  hasLocalPassword: boolean;
  workspaceMemberships: Array<{ role: "owner" | "admin" | "member" | "viewer"; workspace: { id: string; name: string } }>;
  oidcIdentities: Array<{ email: string | null; lastLoginAt: string; provider: { id: string; name: string } }>;
  githubIdentity: { githubUserId: string; login: string; email: string; displayName: string | null; lastLoginAt: string } | null;
  createdAt: string;
  updatedAt: string;
  activeSessionCount: number;
  lastSeenAt: string | null;
  sessionExpiresAt: string | null;
  entitlements: {
    unit: "platform_credit";
    totalCredits: number;
    availableCredits: number;
    usedCredits: number;
    reservedCredits: number;
    heldCredits: number;
    nextExpiryAt: string | null;
    routeSnapshots: Array<{ operation: string; version: number; quotaMultiplierBps: number }>;
    membership: { status: "active" | "expired" | "revoked" | "none"; startsAt: string | null; expiresAt: string | null; version: number | null };
    membershipApplication: {
      id: string;
      status: "pending" | "fulfilled" | "rejected" | "withdrawn";
      statusVersion: number;
      submittedAt: string;
      fulfilledAt: string | null;
      rejectedAt: string | null;
      withdrawnAt: string | null;
      rejectionReason?: string | null;
    } | null;
  };
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeStyle: "short" }).format(new Date(value));
}

type ApplicationPreviewPayload = {
  application: Profile["entitlements"]["membershipApplication"];
  preview: {
    id: string;
    action: "submit" | "withdraw";
    applicationId: string | null;
    requestKey: string;
    requestFingerprint: string;
    impactFingerprint: string;
    issuedAt: string;
    expiresAt: string;
    reason: string | null;
  };
};

function profileRequestKey(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `membership-application:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
  }
}

function applicationStatusLabel(status: Profile["entitlements"]["membershipApplication"] extends infer T ? T extends { status: infer S } ? S : never : never): string {
  return status === "pending" ? "等待管理员处理" : status === "fulfilled" ? "申请已完成" : status === "rejected" ? "申请未通过" : "已撤回";
}

const githubStatusMessages: Record<string, { tone: "success" | "error"; text: string }> = {
  linked: { tone: "success", text: "GitHub 身份已绑定，现在可以在登录页使用 GitHub 登录。" },
  GITHUB_OAUTH_PROVIDER_REJECTED: { tone: "error", text: "GitHub 授权被取消，账户没有发生变化。" },
  GITHUB_OAUTH_FLOW_EXPIRED: { tone: "error", text: "GitHub 绑定已过期，请重新开始。" },
  GITHUB_OAUTH_IDENTITY_CONFLICT: { tone: "error", text: "该 GitHub 身份已绑定其他账户，或当前账户已绑定其他 GitHub 身份。" },
  GITHUB_OAUTH_EMAIL_REQUIRED: { tone: "error", text: "GitHub 账户必须提供一个已验证的主邮箱。" },
  GITHUB_OAUTH_TOKEN_REVOCATION_FAILED: { tone: "error", text: "GitHub 临时授权令牌未能安全撤销，本次绑定已中止。" },
  failed: { tone: "error", text: "GitHub 身份绑定未完成，请重试或联系工作区管理员。" },
};

export function ProfileClient({
  username: initialUsername,
  isSystemAdmin = false,
  githubLoginAvailable,
  githubStatus,
}: {
  username: string;
  isSystemAdmin?: boolean;
  githubLoginAvailable: boolean;
  githubStatus?: string;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [headerUsername, setHeaderUsername] = useState(initialUsername);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/profile", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "个人信息加载失败"));
      const next = (await response.json() as { profile: Profile }).profile;
      setProfile(next);
      setHeaderUsername(next.username);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "个人信息加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={headerUsername} active="profile" isSystemAdmin={isSystemAdmin} />
      <div className="mx-auto max-w-5xl px-5 pb-16 pt-9 sm:px-8 lg:px-10">
        <section>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">Account</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">个人中心</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">查看身份来源、工作区角色和会话状态，维护个人资料与本地恢复凭据。</p>
        </section>

        {error ? <div role="alert" className="mt-6 flex items-center justify-between gap-4 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => void load()} className="font-semibold underline">重试</button></div> : null}
        {githubStatus ? <Message {...(githubStatusMessages[githubStatus] ?? githubStatusMessages.failed)} /> : null}

        <section className="mt-7 overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm">
          <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
            <div className="flex min-w-0 items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-xl font-bold text-white shadow-lg shadow-indigo-500/20">{headerUsername.slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0">
                <h2 className="truncate text-xl font-semibold tracking-[-0.02em]">{profile?.displayName || headerUsername}</h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full bg-indigo-50 px-2.5 py-1 font-semibold text-indigo-700">{profile?.role === "admin" ? "系统管理员" : "普通用户"}</span>
                  <span className="text-slate-400">@{headerUsername}</span>
                </div>
              </div>
            </div>
            <LogoutButton className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50 sm:w-auto" />
          </div>

          {loading || !profile ? (
            <div className="grid gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-3">
              {[1, 2, 3].map((item) => <div key={item} className="h-24 animate-pulse bg-slate-50 p-5"><div className="h-3 w-16 rounded bg-slate-200" /><div className="mt-3 h-5 w-28 rounded bg-slate-200" /></div>)}
            </div>
          ) : (
            <dl className="grid gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-3">
              <StatusItem label="最近活动" value={formatDate(profile.lastSeenAt)} />
              <StatusItem label="活动会话" value={`${profile.activeSessionCount} 个`} />
              <StatusItem label="登录状态" value="已登录" tone="success" />
            </dl>
          )}

          <details open className="group border-t border-slate-100">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 text-sm transition hover:bg-slate-50 sm:px-7">
              <span><span className="font-semibold text-slate-700">账户详情</span><span className="ml-2 text-slate-400">创建时间与最近会话有效期</span></span>
              <span aria-hidden="true" className="text-lg text-slate-400 transition group-open:rotate-180">⌄</span>
            </summary>
            {profile ? (
              <dl className="grid gap-4 border-t border-slate-100 bg-slate-50/70 px-6 py-5 text-sm sm:grid-cols-2 sm:px-7">
                <DetailItem label="创建时间" value={formatDate(profile.createdAt)} />
                <DetailItem label="最近活动会话到期" value={formatDate(profile.sessionExpiresAt)} />
              </dl>
            ) : null}
          </details>
        </section>

        {profile ? <>
          <PlatformCreditPanel profile={profile} onChanged={() => void load()} />
          <section className="mt-6 flex flex-col gap-4 rounded-3xl border border-indigo-100 bg-indigo-50/50 p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">Personal models</p>
              <h2 className="mt-1.5 text-lg font-semibold text-slate-900">我的模型</h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-600">{profile.entitlements.membership.status === "active" ? "会员可配置、测试和维护自己的模型连接。" : profile.entitlements.membership.status === "none" ? "当前可以使用平台额度；如需配置个人模型，可在上方提交会员申请。" : "会员资格已失效，不能测试、启用或调用；仍可安全清理已有连接。"}</p>
            </div>
            <Link href="/profile/models" className="inline-flex shrink-0 items-center justify-center rounded-xl border border-indigo-200 bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100">{profile.entitlements.membership.status === "active" ? "管理我的模型" : "查看我的模型"} <span aria-hidden="true" className="ml-1">→</span></Link>
          </section>
          <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Personal connections</p><h2 className="mt-1.5 text-lg font-semibold">我的连接</h2><p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-600">Git 与 MCP 连接属于你的个人配置。Git 完成连接所有者与项目 Owner 双确认后，可发起一次性手动只读读取；MCP 的项目授权和自动化仍保持关闭。</p></div>
              <span className="text-xs text-slate-400">凭据仅显示掩码</span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Link href="/profile/connections/git" className="group rounded-2xl border border-slate-200 bg-slate-50/70 p-4 transition hover:border-indigo-200 hover:bg-indigo-50"><span className="flex items-center justify-between gap-3"><span className="font-semibold text-slate-800">我的 Git 连接</span><span aria-hidden="true" className="text-indigo-600 transition group-hover:translate-x-0.5">→</span></span><span className="mt-1.5 block text-xs leading-5 text-slate-500">配置 Git 服务、轮换凭据并执行只读仓库测试。</span></Link>
              <Link href="/profile/connections/mcp" className="group rounded-2xl border border-slate-200 bg-slate-50/70 p-4 transition hover:border-violet-200 hover:bg-violet-50"><span className="flex items-center justify-between gap-3"><span className="font-semibold text-slate-800">我的 MCP 连接</span><span aria-hidden="true" className="text-violet-600 transition group-hover:translate-x-0.5">→</span></span><span className="mt-1.5 block text-xs leading-5 text-slate-500">发现远程工具并查看平台安全摘要，不在此授权项目。</span></Link>
            </div>
          </section>
        </> : null}

        {profile ? <section className="mt-6 grid gap-4 sm:grid-cols-2"><div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Workspace roles</p><h2 className="mt-2 text-lg font-semibold">工作区身份</h2><div className="mt-4 space-y-2">{profile.workspaceMemberships.map((membership) => <div key={membership.workspace.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3 text-sm"><span className="font-medium text-slate-700">{membership.workspace.name}</span><span className="text-xs font-semibold text-indigo-700">{membership.role}</span></div>)}</div></div><div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Sign-in methods</p><h2 className="mt-2 text-lg font-semibold">登录方式</h2><div className="mt-4 space-y-2"><div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">本地密码：{profile.hasLocalPassword ? "已配置" : "未配置"}</div>{profile.githubIdentity ? <div className="rounded-xl bg-slate-950 px-4 py-3 text-sm text-white">GitHub · @{profile.githubIdentity.login}<span className="mt-1 block text-xs text-slate-300">{profile.githubIdentity.email}</span></div> : githubLoginAvailable ? <a href="/api/auth/github/start?intent=link&returnTo=%2Fprofile" className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50"><span>GitHub 尚未绑定</span><span className="text-indigo-600">立即绑定 →</span></a> : <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-400">GitHub 登录：当前部署未配置</div>}{profile.oidcIdentities.map((identity) => <div key={identity.provider.id} className="rounded-xl bg-violet-50 px-4 py-3 text-sm text-violet-700">{identity.provider.name}{identity.email ? ` · ${identity.email}` : ""}</div>)}</div></div></section> : null}

        <section className="mt-6 overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm">
          <div className="px-6 py-6 sm:px-7">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Account settings</p>
            <h2 className="mt-2 text-xl font-semibold">登录与安全</h2>
          </div>
          <ProfileDetailsForm key={`${profile?.displayName ?? ""}:${profile?.email ?? ""}:${profile?.emailVerifiedAt ?? ""}`} profile={profile} onUpdated={(details) => setProfile((current) => current ? { ...current, ...details } : current)} />
          <UsernameForm key={profile?.username ?? "loading"} profile={profile} loading={loading} onUpdated={(username) => { setHeaderUsername(username); setProfile((current) => current ? { ...current, username } : current); }} />
          <PasswordForm hasLocalPassword={profile?.hasLocalPassword ?? true} />
        </section>

      </div>
    </main>
  );
}

function PlatformCreditPanel({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const credits = profile.entitlements;
  const application = credits.membershipApplication;
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ApplicationPreviewPayload | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const requestKeyRef = useRef(profileRequestKey());

  async function previewSubmit(): Promise<void> {
    if (reason.trim().length === 0) {
      setMessage({ tone: "error", text: "请填写申请说明" });
      return;
    }
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/profile/membership-applications/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: requestKeyRef.current, reason }) });
      if (!response.ok) throw new Error(await readError(response, "会员申请预览失败"));
      setPreview(await response.json() as ApplicationPreviewPayload);
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "会员申请预览失败" });
    } finally { setPending(false); }
  }

  async function previewWithdraw(): Promise<void> {
    if (application === null) return;
    requestKeyRef.current = profileRequestKey();
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/profile/membership-applications/withdraw/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ applicationId: application.id, requestKey: requestKeyRef.current }) });
      if (!response.ok) throw new Error(await readError(response, "撤回申请预览失败"));
      setPreview(await response.json() as ApplicationPreviewPayload);
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "撤回申请预览失败" });
    } finally { setPending(false); }
  }

  async function execute(): Promise<void> {
    if (preview === null) return;
    setPending(true); setMessage(null);
    try {
      const endpoint = preview.preview.action === "submit" ? "/api/profile/membership-applications/execute" : "/api/profile/membership-applications/withdraw/execute";
      const body = {
        previewId: preview.preview.id,
        requestKey: preview.preview.requestKey,
        requestFingerprint: preview.preview.requestFingerprint,
        impactFingerprint: preview.preview.impactFingerprint,
        previewIssuedAt: preview.preview.issuedAt,
        previewExpiresAt: preview.preview.expiresAt,
        confirmation: true,
        ...(preview.preview.action === "withdraw" ? { applicationId: preview.preview.applicationId } : {}),
      };
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await readError(response, "会员申请执行失败"));
      setPreview(null); requestKeyRef.current = profileRequestKey(); onChanged();
      setMessage({ tone: "success", text: preview.preview.action === "submit" ? "申请已提交，管理员会在平台内处理。" : "申请已撤回。" });
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "会员申请执行失败" });
    } finally { setPending(false); }
  }

  const status = credits.membership.status;
  const canApply = status !== "active" && (application === null || application.status !== "pending");
  const progress = credits.totalCredits > 0 ? Math.min(100, Math.max(0, (credits.usedCredits / credits.totalCredits) * 100)) : 0;
  return <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">Platform credits</p><h2 className="mt-1.5 text-xl font-semibold">平台额度</h2><p className="mt-1.5 max-w-2xl text-sm leading-6 text-slate-600">当前有效额度池的守恒摘要；单位为平台额度，不是供应商原始 Token、充值余额，也不代表无限额度。</p></div>
      <div className="text-right text-xs text-slate-500"><p>会员：{status === "active" ? `有效至 ${formatDate(credits.membership.expiresAt)}` : status === "none" ? "未开通" : status === "expired" ? "已到期" : "已撤销"}</p><p className="mt-1">最早到期：{formatDate(credits.nextExpiryAt)}</p></div>
    </div>
    <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/50 px-4 py-3 text-xs leading-5 text-indigo-900"><p className="font-semibold">当前等级：{status === "active" ? "平台会员" : "基础账户"}</p><p className="mt-1">会员权益：可配置、测试和使用个人模型，并按项目授权流程发起委托。</p><p className="mt-1 text-indigo-700">会员到期或撤销后，个人模型与项目委托能力会暂停；已保存配置保留，平台额度池不受影响。</p></div>
    <dl className="mt-5 grid gap-px overflow-hidden rounded-2xl border border-slate-100 bg-slate-100 sm:grid-cols-2 lg:grid-cols-5"><StatusItem label="额度总量" value={credits.totalCredits.toLocaleString("zh-CN")} /><StatusItem label="已确认使用" value={credits.usedCredits.toLocaleString("zh-CN")} /><StatusItem label="预留中" value={credits.reservedCredits.toLocaleString("zh-CN")} /><StatusItem label="待核对" value={credits.heldCredits.toLocaleString("zh-CN")} /><StatusItem label="可用" value={credits.availableCredits.toLocaleString("zh-CN")} tone="success" /></dl>
    <div className="mt-4"><div className="flex items-center justify-between text-xs text-slate-500"><span>已确认使用进度</span><span>{Math.round(progress)}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500 transition-[width]" style={{ width: `${progress}%` }} /></div></div>
    <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600"><p className="font-semibold text-slate-700">当前模型规则快照</p><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{credits.routeSnapshots.length === 0 ? <span>暂无已启用的默认路由规则</span> : credits.routeSnapshots.map((route) => <span key={`${route.operation}:${route.version}`}>{route.operation} · v{route.version} · {route.quotaMultiplierBps} bps</span>)}</div><p className="mt-2 text-slate-400">每次调用按当次有效规则结算，历史额度不会随规则展示变化。</p></div>
    {application ? <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-3"><span className="font-semibold text-indigo-900">会员申请：{applicationStatusLabel(application.status)}</span><span className="text-xs text-indigo-700">提交于 {formatDate(application.submittedAt)}</span></div>{application.status === "pending" ? <button type="button" disabled={pending} onClick={() => void previewWithdraw()} className="mt-3 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-xs font-semibold text-indigo-700 disabled:opacity-50">预览撤回申请</button> : <p className="mt-2 text-xs text-indigo-700">状态更新时间：{formatDate(application.fulfilledAt ?? application.rejectedAt ?? application.withdrawnAt)}</p>}</div> : null}
    {canApply ? <div className="mt-4 rounded-2xl border border-dashed border-slate-200 px-4 py-4"><p className="text-sm font-semibold text-slate-800">申请管理员开通</p><p className="mt-1 text-xs leading-5 text-slate-500">提交后只会生成可追踪申请，不包含支付、订单或自动开通承诺。</p><textarea value={reason} onChange={(event) => { setReason(event.target.value); setPreview(null); }} maxLength={500} rows={3} placeholder="请说明需要开通会员的原因" className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" /><button type="button" disabled={pending} onClick={() => void previewSubmit()} className="mt-3 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">预览申请</button></div> : null}
    {preview ? <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4"><p className="text-sm font-semibold text-amber-900">请确认{preview.preview.action === "submit" ? "提交会员申请" : "撤回会员申请"}</p><p className="mt-1 text-xs leading-5 text-amber-800">预览有效至 {formatDate(preview.preview.expiresAt)}。确认后将写入申请状态与审计记录。</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={pending} onClick={() => void execute()} className="rounded-xl bg-amber-600 px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50">确认并执行</button><button type="button" disabled={pending} onClick={() => setPreview(null)} className="rounded-xl border border-amber-200 bg-white px-4 py-2.5 text-xs font-semibold text-amber-800">取消</button></div></div> : null}
    {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`mt-4 text-xs ${message.tone === "error" ? "text-rose-700" : "text-emerald-700"}`}>{message.text}</p> : null}
  </section>;
}

function ProfileDetailsForm({ profile, onUpdated }: { profile: Profile | null; onUpdated: (value: { displayName: string | null; email: string | null; emailVerifiedAt: string | null }) => void }) {
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "updateProfile", displayName: displayName || null, email: email || null }) });
      if (!response.ok) throw new Error(await readError(response, "个人资料更新失败"));
      const next = (await response.json() as { user: { displayName: string | null; email: string | null; emailVerifiedAt: string | null } }).user;
      onUpdated(next); setMessage({ tone: "success", text: "个人资料已更新。" });
    } catch (cause) { setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "个人资料更新失败" }); }
    finally { setPending(false); }
  }
  return <section className="grid gap-5 border-t border-slate-100 px-6 py-6 sm:grid-cols-[0.72fr_1.28fr] sm:px-7"><div><h3 className="text-sm font-semibold text-slate-800">个人资料</h3><p className="mt-1.5 text-xs leading-5 text-slate-400">显示名称用于页面展示；邮箱用于邀请匹配与企业身份关联。</p><p className={`mt-2 text-xs leading-5 ${profile?.emailVerifiedAt ? "text-emerald-700" : "text-amber-700"}`}>{profile?.emailVerifiedAt ? "邮箱已验证，可接受定向工作区邀请。" : "邮箱未验证，不能消费工作区邀请；请通过 GitHub 或企业 OIDC 等可信身份重新确认。"}</p></div><form onSubmit={submit} className="grid gap-3 sm:grid-cols-2"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="显示名称" maxLength={160} className="rounded-xl border border-slate-200 px-4 py-3 text-sm" /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="邮箱" maxLength={320} className="rounded-xl border border-slate-200 px-4 py-3 text-sm" /><div className="sm:col-span-2"><button disabled={pending || !profile} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-40">{pending ? "保存中…" : "保存个人资料"}</button>{message ? <Message {...message} /> : null}</div></form></section>;
}

function UsernameForm({ profile, loading, onUpdated }: { profile: Profile | null; loading: boolean; onUpdated: (username: string) => void }) {
  const [username, setUsername] = useState(profile?.username ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "updateUsername", username }) });
      if (!response.ok) throw new Error(await readError(response, "登录名更新失败"));
      const next = (await response.json() as { user: { username: string } }).user.username;
      onUpdated(next);
      setMessage({ tone: "success", text: "登录名已更新，下次请使用新登录名。" });
    } catch (submitError) {
      setMessage({ tone: "error", text: submitError instanceof Error ? submitError.message : "登录名更新失败" });
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="grid gap-5 border-t border-slate-100 px-6 py-6 sm:grid-cols-[0.72fr_1.28fr] sm:px-7">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">登录名</h3>
        <p className="mt-1.5 text-xs leading-5 text-slate-400">用于登录当前本地部署，修改后下次登录生效。</p>
      </div>
      <form onSubmit={submit}>
        <label htmlFor="profile-username" className="sr-only">登录名</label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input id="profile-username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}" required disabled={loading || !profile} className="min-w-0 flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50" />
          <button disabled={pending || loading || !profile || username === profile.username} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-600 disabled:opacity-40">{pending ? "保存中…" : "保存"}</button>
        </div>
        <p className="mt-2 text-xs text-slate-400">3–64 位，可使用字母、数字、点、下划线和连字符。</p>
        {message ? <Message {...message} /> : null}
      </form>
    </section>
  );
}

function PasswordForm({ hasLocalPassword }: { hasLocalPassword: boolean }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setMessage({ tone: "error", text: "两次输入的新密码不一致" });
      return;
    }
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(hasLocalPassword ? { action: "changePassword", currentPassword, newPassword } : { action: "setLocalPassword", newPassword }) });
      if (!response.ok) throw new Error(await readError(response, "密码更新失败"));
      router.replace("/login?password=updated");
      router.refresh();
    } catch (submitError) {
      setMessage({ tone: "error", text: submitError instanceof Error ? submitError.message : "密码更新失败" });
      setPending(false);
    }
  }

  return (
    <details className="group border-t border-slate-100">
      <summary className="grid cursor-pointer list-none gap-4 px-6 py-6 transition hover:bg-slate-50 sm:grid-cols-[0.72fr_1.28fr] sm:px-7">
        <span>
          <span className="block text-sm font-semibold text-slate-800">修改密码</span>
          <span className="mt-1.5 block text-xs leading-5 text-slate-400">{hasLocalPassword ? "仅在需要轮换密码时展开。" : "为企业身份账号设置本地恢复密码。"}</span>
        </span>
        <span className="flex items-center justify-between gap-4">
          <span className="text-xs leading-5 text-slate-500">设置后会撤销全部登录会话，并要求重新登录。</span>
          <span aria-hidden="true" className="shrink-0 text-lg text-slate-400 transition group-open:rotate-180">⌄</span>
        </span>
      </summary>
      <form onSubmit={submit} className="grid gap-4 border-t border-slate-100 bg-slate-50/70 px-6 py-6 sm:px-7">
        {hasLocalPassword ? <PasswordField id="profile-current-password" label="当前密码" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" /> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <PasswordField id="profile-new-password" label="新密码" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
          <PasswordField id="profile-confirm-password" label="再次输入新密码" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
        </div>
        <p className="text-xs text-slate-400">新密码至少 12 位，并同时包含字母和数字。</p>
        {message ? <Message {...message} /> : null}
        <div><button disabled={pending || (hasLocalPassword && !currentPassword) || !newPassword || !confirmPassword} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/15 transition hover:bg-indigo-500 disabled:opacity-40">{pending ? "正在更新…" : hasLocalPassword ? "更新密码并重新登录" : "设置本地密码并重新登录"}</button></div>
      </form>
    </details>
  );
}

function PasswordField({ id, label, value, onChange, autoComplete }: { id: string; label: string; value: string; onChange: (value: string) => void; autoComplete: string }) {
  return <label htmlFor={id} className="text-sm font-semibold text-slate-700">{label}<input id={id} type="password" value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} minLength={12} maxLength={128} required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /></label>;
}

function StatusItem({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "success" }) {
  return <div className="bg-slate-50/80 px-6 py-5 sm:px-7"><dt className="text-xs font-medium text-slate-400">{label}</dt><dd className={`mt-2 text-sm font-semibold ${tone === "success" ? "text-emerald-700" : "text-slate-700"}`}>{value}</dd></div>;
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-slate-400">{label}</dt><dd className="mt-1 font-medium text-slate-700">{value}</dd></div>;
}

function Message({ tone, text }: { tone: "success" | "error"; text: string }) {
  return <p role={tone === "error" ? "alert" : "status"} className={`mt-4 rounded-xl px-4 py-3 text-sm ${tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{text}</p>;
}
