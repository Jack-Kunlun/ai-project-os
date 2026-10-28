"use client";
import { UiErrorText, UiFeedbackText } from "@/components/ui-error-text";


import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { UiText, useAppearance } from "@/components/appearance-provider";
import { AccountClosurePanel } from "@/components/account-closure-panel";
import { AccountPhonePanel } from "@/components/account-phone-panel";
import { AppHeader } from "@/components/app-header";
import { EmailCodeInput } from "@/components/email-code-input";
import { OperationPanel } from "@/components/operation-panel";
import { DialogActions, DialogForm, DialogSubmit } from "@/components/dialog-actions";
import styles from "../support-pages.module.css";
import profileStyles from "./profile-page.module.css";

type Profile = {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  role: "admin" | "user";
  hasLocalPassword: boolean;
  phoneE164: string | null;
  phoneAuthStatus: "disabled" | "unavailable" | "available";
  emailAuthStatus: "disabled" | "unavailable" | "available";
  workspaceMemberships: Array<{ role: "owner" | "admin" | "member" | "viewer"; workspace: { id: string; name: string } }>;
  oidcIdentities: Array<{ email: string | null; lastLoginAt: string; provider: { id: string; name: string } }>;
  oidcLinkableProviders: Array<{ id: string; name: string; workspace: { id: string; name: string } }>;
  githubIdentity: { githubUserId: string; login: string; email: string; displayName: string | null; lastLoginAt: string } | null;
  createdAt: string;
  updatedAt: string;
  activeSessionCount: number;
  lastSeenAt: string | null;
  sessionExpiresAt: string | null;
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function formatDate(value: string | null, language: "zh-CN" | "en"): string {
  if (!value) return language === "en" ? "No record" : "暂无记录";
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { dateStyle: "long", timeStyle: "short" }).format(new Date(value));
}

function workspaceRoleLabel(role: Profile["workspaceMemberships"][number]["role"]): string {
  return role === "owner" ? "所有者" : role === "admin" ? "管理员" : role === "member" ? "成员" : "查看者";
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 6)} **** ${phone.slice(-4)}`;
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

const oidcStatusMessages: Record<string, { tone: "success" | "error"; text: string }> = {
  linked: { tone: "success", text: "企业 OIDC 登录身份已绑定到当前账户。" },
  failed: { tone: "error", text: "OIDC 身份绑定未完成。请确认仍使用发起绑定的登录会话后重试。" },
};

export function ProfileClient({
  username: initialUsername,
  isSystemAdmin = false,
  githubLoginAvailable,
  githubAvailability = githubLoginAvailable ? "available" : "notConfigured",
  githubStatus,
  oidcStatus,
}: {
  username: string;
  isSystemAdmin?: boolean;
  githubLoginAvailable: boolean;
  githubAvailability?: "notConfigured" | "configurationInvalid" | "bootstrapPending" | "available";
  githubStatus?: string;
  oidcStatus?: string;
}) {
  const { language, t } = useAppearance();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [headerUsername, setHeaderUsername] = useState(initialUsername);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openOperation, setOpenOperation] = useState<"profile" | "username" | "email" | "phone" | "password" | "closure" | null>(null);
  const [operationMessage, setOperationMessage] = useState<string | null>(null);

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
    <main className={styles.page}>
      <AppHeader username={headerUsername} active="profile" isSystemAdmin={isSystemAdmin} />
      <div data-page-content className={styles.content}>
        <section className={styles.pageHeader}>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">ACCOUNT</p>
            <h1 className={styles.pageTitle}><UiText text="账户设置" /></h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600"><UiText text="管理个人信息、安全与私有资源。" /></p>
          </div>
        </section>

        {error ? <div role="alert" className="mt-5 flex items-center justify-between gap-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><span><UiErrorText text={error} /></span><button type="button" onClick={() => void load()} className="font-semibold underline"><UiText text="重试" /></button></div> : null}
        {githubStatus ? <Message {...(githubStatusMessages[githubStatus] ?? githubStatusMessages.failed)} /> : null}
        {oidcStatus ? <Message {...(oidcStatusMessages[oidcStatus] ?? oidcStatusMessages.failed)} /> : null}

        <section className={profileStyles.profileCover}>
          <div className={profileStyles.profileCoverBanner} />
          <div className={profileStyles.profileContent}>
            <span className={profileStyles.profileAvatar} aria-hidden="true">{(profile?.displayName || headerUsername).slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0">
              <h2 className={profileStyles.profileName}>{profile?.displayName || headerUsername}</h2>
              <p className={profileStyles.profileMeta}>{profile?.email ?? headerUsername}{profile?.emailVerifiedAt ? <> · <UiText text="已验证" /></> : profile?.email ? <> · <UiText text="未验证" /></> : null}</p>
            </div>
            <OperationPanel title="编辑个人资料" triggerLabel="编辑资料" description="修改显示名称或邮箱；更改邮箱后需要重新验证。" disabled={profile === null} variant="drawer" open={openOperation === "profile"} onOpenChange={(open) => setOpenOperation(open ? "profile" : null)}>
              <ProfileDetailsForm key={`${profile?.displayName ?? ""}:${profile?.email ?? ""}:${profile?.emailVerifiedAt ?? ""}`} profile={profile} onUpdated={(details) => { setProfile((current) => current ? { ...current, ...details } : current); setOpenOperation(null); setOperationMessage("个人资料已更新。"); }} />
            </OperationPanel>
          </div>
        </section>

        {operationMessage ? <p role="status" className="mt-3 text-sm text-emerald-700"><UiFeedbackText text={operationMessage} /></p> : null}

        <div className={profileStyles.settingsColumns}>
          <section className={profileStyles.settingsColumn}>
            <h2 className={profileStyles.settingsHeading}><UiText text="个人资源" /></h2>
            <div className={profileStyles.settingsList}>
              <Link href="/connections" className={profileStyles.settingsNavRow}>
                <div className={profileStyles.settingsRowCopy}><h3 className={profileStyles.settingsRowTitle}><UiText text="个人连接" /></h3><p className={profileStyles.settingsRowDescription}><UiText text="Git 与 MCP 连接由你管理" /></p></div>
                <span className={profileStyles.settingsChevron} aria-hidden="true">›</span>
              </Link>
              <Link href="/personal/models" className={profileStyles.settingsNavRow}>
                <div className={profileStyles.settingsRowCopy}><h3 className={profileStyles.settingsRowTitle}><UiText text="模型与额度" /></h3><p className={profileStyles.settingsRowDescription}><UiText text="平台默认能力、个人模型和用量" /></p></div>
                <span className={profileStyles.settingsChevron} aria-hidden="true">›</span>
              </Link>
              <Link href="/personal/knowledge" className={profileStyles.settingsNavRow}>
                <div className={profileStyles.settingsRowCopy}><h3 className={profileStyles.settingsRowTitle}><UiText text="我的知识" /></h3><p className={profileStyles.settingsRowDescription}><UiText text="个人知识与明确标记的通用记忆" /></p></div>
                <span className={profileStyles.settingsChevron} aria-hidden="true">›</span>
              </Link>
            </div>
          </section>

          <section className={profileStyles.settingsColumn}>
            <h2 className={profileStyles.settingsHeading}><UiText text="账户安全" /></h2>
            <div className={profileStyles.settingsList}>
              <AccountSettingRow title="邮箱与验证" summary={profile ? <>{profile.email ?? <UiText text="未设置" />} · <UiText text={profile.emailVerifiedAt ? "已验证" : profile.email ? "未验证" : "尚未设置邮箱"} /></> : <UiText text="读取中…" />} description="查看邮箱验证状态，或继续验证当前邮箱。" disabled={!profile} open={openOperation === "email"} onOpenChange={(open) => setOpenOperation(open ? "email" : null)}>
                <div>
                  {profile?.email ? <p className="mb-4 text-sm text-slate-600">{profile.email}{profile.emailVerifiedAt ? <> · <UiText text="已验证" /></> : null}</p> : <p className="mb-4 text-sm text-slate-600"><UiText text="尚未设置邮箱；请先编辑个人资料添加邮箱。" /></p>}
                  {profile?.email && !profile.emailVerifiedAt && profile.emailAuthStatus === "disabled" ? <p className="mb-4 text-sm text-amber-700"><UiText text="邮箱验证服务当前未启用。" /></p> : null}
                  {profile?.email ? <EmailVerificationSection key={`${profile.email}:${profile.emailVerifiedAt ?? ""}`} email={profile.email} emailVerifiedAt={profile.emailVerifiedAt} availability={profile.emailAuthStatus} onVerified={(verifiedAt) => { setProfile((current) => current ? { ...current, emailVerifiedAt: verifiedAt } : current); setOpenOperation(null); }} /> : null}
                </div>
              </AccountSettingRow>
              <AccountSettingRow title="手机号" summary={profile?.phoneE164 ? maskPhone(profile.phoneE164) : <UiText text={profile ? "尚未绑定" : "读取中…"} />} description="绑定后可用于登录和找回密码。" disabled={!profile} open={openOperation === "phone"} onOpenChange={(open) => setOpenOperation(open ? "phone" : null)}>
                {profile ? <AccountPhonePanel embedded hasLocalPassword={profile.hasLocalPassword} phoneE164={profile.phoneE164} phoneAuthStatus={profile.phoneAuthStatus} /> : null}
              </AccountSettingRow>
              <AccountSettingRow title="登录名" summary={profile?.username ?? t("读取中…")} description="用于登录当前本地部署，修改后下次登录生效。" disabled={!profile} open={openOperation === "username"} onOpenChange={(open) => setOpenOperation(open ? "username" : null)}>
                <UsernameForm key={profile?.username ?? "loading"} profile={profile} loading={loading} onUpdated={(username) => { setHeaderUsername(username); setProfile((current) => current ? { ...current, username } : current); setOpenOperation(null); setOperationMessage("登录名已更新，下次请使用新登录名。"); }} />
              </AccountSettingRow>
              <AccountSettingRow title="登录密码" summary={profile ? <UiText text={profile.hasLocalPassword ? "已设置" : "未设置"} /> : <UiText text="读取中…" />} description="更新密码后会撤销全部登录会话，并要求重新登录。" disabled={!profile} open={openOperation === "password"} onOpenChange={(open) => setOpenOperation(open ? "password" : null)}>
                <PasswordForm key={`${profile?.email ?? ""}:${profile?.emailVerifiedAt ?? ""}:${profile?.emailAuthStatus ?? "disabled"}`} hasLocalPassword={profile?.hasLocalPassword ?? true} email={profile?.email ?? null} emailVerifiedAt={profile?.emailVerifiedAt ?? null} emailAuthStatus={profile?.emailAuthStatus ?? "disabled"} />
              </AccountSettingRow>
              <AccountSettingRow title="注销账户" summary={<UiText text="永久停用账户，封存独占个人空间" />} description="核对注销影响并完成身份验证。" danger disabled={!profile} open={openOperation === "closure"} onOpenChange={(open) => setOpenOperation(open ? "closure" : null)}>
                {profile ? <AccountClosurePanel embedded hasLocalPassword={profile.hasLocalPassword} phoneE164={profile.phoneE164} phoneAuthStatus={profile.phoneAuthStatus} /> : null}
              </AccountSettingRow>
            </div>
          </section>
        </div>

        <details className={profileStyles.accountDetails}>
          <summary className={profileStyles.accountDetailsSummary}><span><strong><UiText text="账户详情" /></strong><span className="ml-2 text-sm text-slate-500"><UiText text="身份、工作区与会话信息" /></span></span><span className={profileStyles.accountDetailsChevron} aria-hidden="true">⌄</span></summary>
          {profile ? <div className={profileStyles.accountDetailsContent}>
            <section className={profileStyles.accountDetailsSection}>
              <h3><UiText text="身份与会话" /></h3>
              <dl className={profileStyles.accountDetailsList}>
                <AccountDetailsItem label="用户名" value={profile.username} />
                <AccountDetailsItem label="账户身份" value={t(profile.role === "admin" ? "系统管理员" : "普通用户")} />
                <AccountDetailsItem label="登录状态" value={t("已登录")} />
                <AccountDetailsItem label="活动会话" value={t("{count} 个活动会话").replace("{count}", String(profile.activeSessionCount))} />
                <AccountDetailsItem label="最近活动" value={formatDate(profile.lastSeenAt, language)} />
                <AccountDetailsItem label="创建时间" value={formatDate(profile.createdAt, language)} />
                <AccountDetailsItem label="最近会话到期" value={formatDate(profile.sessionExpiresAt, language)} />
              </dl>
              <h3 className="mt-6"><UiText text="工作区身份" /></h3>
              {profile.workspaceMemberships.length ? <div className={profileStyles.identityList}>{profile.workspaceMemberships.map((membership) => <div className={profileStyles.identityItem} key={membership.workspace.id}><strong>{membership.workspace.name}</strong><p><UiText text={workspaceRoleLabel(membership.role)} /></p></div>)}</div> : <p className={profileStyles.settingsRowDescription}><UiText text="尚未加入工作区" /></p>}
            </section>
            <section className={profileStyles.accountDetailsSection}>
              <h3><UiText text="登录方式" /></h3>
              <div className={profileStyles.identityList}>
                <div className={profileStyles.identityItem}><strong><UiText text="本地密码" /></strong><p><UiText text={profile.hasLocalPassword ? "已配置" : "未配置"} /></p></div>
                {profile.githubIdentity ? <div className={profileStyles.identityItem}><strong>GitHub · @{profile.githubIdentity.login}</strong><p>{profile.githubIdentity.email}</p></div> : githubLoginAvailable ? <a href="/api/auth/github/start?intent=link&returnTo=%2Fprofile" className={profileStyles.identityItem}><strong><UiText text="GitHub 尚未绑定" /></strong><p><UiText text="立即绑定 →" /></p></a> : <div className={profileStyles.identityItem}><strong>GitHub</strong><p><UiText text={githubAvailability === "bootstrapPending" ? "平台管理员尚未完成初始化，GitHub 登录暂不可用" : githubAvailability === "configurationInvalid" ? "GitHub 登录配置无效，请联系工作区管理员" : "GitHub 登录尚未配置，请联系工作区管理员"} /></p></div>}
                {profile.oidcIdentities.map((identity) => <div key={identity.provider.id} className={profileStyles.identityItem}><strong>{identity.provider.name}</strong><p>{identity.email ?? <UiText text="没有邮箱声明" />}</p></div>)}
              </div>
            </section>
          </div> : <div className="grid gap-4 p-5 sm:grid-cols-2">{[1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-lg bg-slate-50" />)}</div>}
          {profile && !isSystemAdmin ? <div className="border-t border-slate-200 px-5 pb-5"><OidcIdentityLinkSection providers={profile.oidcLinkableProviders} /></div> : null}
        </details>
      </div>
    </main>
  );
}

function OidcIdentityLinkSection({ providers }: { providers: Profile["oidcLinkableProviders"] }) {
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function beginLink(providerId: string) {
    setPendingProviderId(providerId);
    setError(null);
    try {
      const response = await fetch("/api/auth/oidc/link/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      if (!response.ok) throw new Error(await readError(response, "无法开始 OIDC 身份绑定"));
      const result = await response.json() as { authorizationUrl: string };
      const authorizationUrl = new URL(result.authorizationUrl);
      if (authorizationUrl.protocol !== "https:" && authorizationUrl.protocol !== "http:") throw new Error("身份源授权地址无效");
      window.location.assign(authorizationUrl.toString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法开始 OIDC 身份绑定");
      setPendingProviderId(null);
    }
  }

  return (
    <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-7">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400"><UiText text={"工作区登录"} /></p>
      <h2 className="mt-2 text-lg font-semibold"><UiText text={"绑定企业 OIDC 登录身份"} /></h2>
      <p className="mt-2 text-sm leading-6 text-slate-600"><UiText text={"仅显示你已确认加入工作区中的启用身份源。绑定需要再次通过该身份源验证；邮箱相同不会自动绑定到账户。"} /></p>
      {providers.length === 0 ? <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500"><UiText text={"当前没有可绑定的工作区 OIDC 身份源。"} /></p> : (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              disabled={pendingProviderId !== null}
              onClick={() => void beginLink(provider.id)}
              className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-4 py-3 text-left text-sm transition hover:border-violet-300 hover:bg-violet-50 disabled:opacity-50"
            >
              <span><span className="block font-semibold text-slate-800">{provider.name}</span><span className="mt-1 block text-xs text-slate-500">{provider.workspace.name}</span></span>
              <span className="shrink-0 font-semibold text-violet-700"><UiText text={pendingProviderId === provider.id ? "正在跳转…" : "绑定 →"} /></span>
            </button>
          ))}
        </div>
      )}
      {error ? <Message tone="error" text={error} /> : null}
    </section>
  );
}

function ProfileDetailsForm({ profile, onUpdated }: { profile: Profile | null; onUpdated: (value: { displayName: string | null; email: string | null; emailVerifiedAt: string | null }) => void }) {
  const { t } = useAppearance();
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const verifiedEmailLocked = Boolean(profile?.email && profile.emailVerifiedAt && profile.emailAuthStatus !== "disabled");
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
  return <section className="grid gap-5 sm:grid-cols-[0.72fr_1.28fr]"><div><p className="text-xs leading-5 text-slate-400"><UiText text={"显示名称用于页面展示；修改邮箱后需要验证新地址。"} /></p><p className={`mt-2 text-xs leading-5 ${verifiedEmailLocked ? "text-emerald-700" : profile?.emailVerifiedAt ? "text-emerald-700" : "text-amber-700"}`}><UiText text={verifiedEmailLocked ? "已验证邮箱目前不能修改或移除。" : profile?.emailVerifiedAt ? "邮箱已验证，可用于工作区邀请匹配。" : "邮箱未验证前不能用于工作区邀请；你可以在下方验证当前保存的邮箱。"} /></p></div><DialogForm onSubmit={submit} className="grid gap-3 sm:grid-cols-2"><input aria-label={t("显示名称")} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={t("显示名称")} maxLength={160} className="rounded-xl border border-slate-200 px-4 py-3 text-sm" /><input aria-label={t("邮箱")} type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("邮箱")} maxLength={320} readOnly={verifiedEmailLocked} className={`rounded-xl border border-slate-200 px-4 py-3 text-sm ${verifiedEmailLocked ? "cursor-not-allowed bg-slate-50 text-slate-500" : ""}`} /><div className="sm:col-span-2"><DialogActions><DialogSubmit disabled={pending || !profile} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-40"><UiText text={pending ? "保存中…" : "保存个人资料"} /></DialogSubmit></DialogActions>{message ? <Message {...message} /> : null}</div></DialogForm></section>;
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
    <section className="grid gap-5 sm:grid-cols-[0.72fr_1.28fr]">
      <div>
        <p className="text-xs leading-5 text-slate-400"><UiText text={"用于登录当前本地部署，修改后下次登录生效。"} /></p>
      </div>
      <DialogForm onSubmit={submit}>
        <label htmlFor="profile-username" className="sr-only"><UiText text={"登录名"} /></label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input id="profile-username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}" required disabled={loading || !profile} className="min-w-0 flex-1 rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50" />
          <DialogActions><DialogSubmit disabled={pending || loading || !profile || username === profile.username} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-600 disabled:opacity-40"><UiText text={pending ? "保存中…" : "保存"} /></DialogSubmit></DialogActions>
        </div>
        <p className="mt-2 text-xs text-slate-400"><UiText text={"3–64 位，可使用字母、数字、点、下划线和连字符。"} /></p>
        {message ? <Message {...message} /> : null}
      </DialogForm>
    </section>
  );
}

function EmailVerificationSection({ email, emailVerifiedAt, availability, onVerified }: { email: string | null; emailVerifiedAt: string | null; availability: Profile["emailAuthStatus"]; onVerified: (value: string) => void }) {
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challengeId || code.length !== 6 || !email) return;
    setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/auth/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId, code }),
      });
      if (!response.ok) throw new Error(await readError(response, "邮箱验证失败，请重新获取验证码。"));
      const result = await response.json() as { user: { emailVerifiedAt: string } };
      onVerified(result.user.emailVerifiedAt);
      setCode(""); setChallengeId(null);
      setMessage({ tone: "success", text: "当前邮箱已验证。" });
    } catch (cause) {
      setMessage({ tone: "error", text: cause instanceof Error ? cause.message : "邮箱验证失败，请重新获取验证码。" });
    } finally { setPending(false); }
  }

  if (!email || emailVerifiedAt || availability === "disabled") return null;
  return <section className="grid gap-4 sm:grid-cols-[0.72fr_1.28fr]"><div><p className="text-xs leading-5 text-slate-500"><UiText text={"验证码将发送到当前保存的邮箱"} /> {email}<UiText text={"。验证后可用于工作区邀请匹配和密码修改。"} /></p></div><DialogForm onSubmit={submit} className="grid gap-3"><EmailCodeInput key={email} id="profile-email-verification-code" email={email} purpose="verify" availability={availability === "available" ? "available" : "unavailable"} code={code} onCodeChange={setCode} onChallengeIdChange={setChallengeId} /><DialogActions><DialogSubmit disabled={pending || !challengeId || code.length !== 6} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-40"><UiText text={pending ? "正在验证…" : "确认验证邮箱"} /></DialogSubmit></DialogActions>{message ? <Message {...message} /> : null}</DialogForm></section>;
}

function PasswordForm({ hasLocalPassword, email, emailVerifiedAt, emailAuthStatus }: { hasLocalPassword: boolean; email: string | null; emailVerifiedAt: string | null; emailAuthStatus: Profile["emailAuthStatus"] }) {
  const router = useRouter();
  const { t } = useAppearance();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailChallengeId, setEmailChallengeId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setMessage({ tone: "error", text: "两次输入的新密码不一致" });
      return;
    }
    const emailProofRequired = emailAuthStatus !== "disabled" && email !== null;
    if (emailProofRequired && (!emailVerifiedAt || emailAuthStatus !== "available")) {
      setMessage({ tone: "error", text: emailVerifiedAt ? "邮箱服务暂不可用，请稍后重试。" : "请先验证当前邮箱，再修改密码。" });
      return;
    }
    if (emailProofRequired && (!emailChallengeId || emailCode.length !== 6)) {
      setMessage({ tone: "error", text: "请先获取并填写邮箱验证码。" });
      return;
    }
    setPending(true); setMessage(null);
    try {
      const emailProof = emailChallengeId && emailCode.length === 6 ? { challengeId: emailChallengeId, code: emailCode } : {};
      const response = await fetch("/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(hasLocalPassword ? { action: "changePassword", currentPassword, newPassword, ...emailProof } : { action: "setLocalPassword", newPassword, ...emailProof }) });
      if (!response.ok) throw new Error(await readError(response, "密码更新失败"));
      router.replace("/login?password=updated");
      router.refresh();
    } catch (submitError) {
      setMessage({ tone: "error", text: submitError instanceof Error ? submitError.message : "密码更新失败" });
      setPending(false);
    }
  }

  return (
      <DialogForm onSubmit={submit} className="grid max-w-3xl gap-4">
        <p className="text-sm leading-6 text-slate-600"><UiText text={hasLocalPassword ? "输入当前密码和新密码。" : "为企业身份账号设置本地恢复密码。"} /><UiText text={"更新后会撤销全部登录会话，并要求重新登录。"} /></p>
        {hasLocalPassword ? <PasswordField id="profile-current-password" label="当前密码" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" /> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <PasswordField id="profile-new-password" label="新密码" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
          <PasswordField id="profile-confirm-password" label="再次输入新密码" value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" />
        </div>
        <p className="text-xs text-slate-400"><UiText text={"新密码 8–128 位，并同时包含字母和数字。"} /></p>
        {emailAuthStatus !== "disabled" && email ? <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="mb-3 text-xs leading-5 text-slate-600">{emailVerifiedAt ? t("当前邮箱 {email} 需要通过验证码确认后才能修改密码。").replace("{email}", email) : <UiText text="请先在上方验证当前邮箱。" />}</p>{emailVerifiedAt ? <EmailCodeInput key={email} id="profile-password-email-code" email={email} purpose="password" availability={emailAuthStatus === "available" ? "available" : "unavailable"} code={emailCode} onCodeChange={setEmailCode} onChallengeIdChange={setEmailChallengeId} /> : null}</div> : null}
        {message ? <Message {...message} /> : null}
        <div><DialogActions><DialogSubmit disabled={pending || (hasLocalPassword && !currentPassword) || !newPassword || !confirmPassword || (emailAuthStatus !== "disabled" && email !== null && (!emailVerifiedAt || emailAuthStatus !== "available" || !emailChallengeId || emailCode.length !== 6))} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/15 transition hover:bg-indigo-500 disabled:opacity-40"><UiText text={pending ? "正在更新…" : hasLocalPassword ? "更新密码并重新登录" : "设置本地密码并重新登录"} /></DialogSubmit></DialogActions></div>
      </DialogForm>
  );
}

function PasswordField({ id, label, value, onChange, autoComplete }: { id: string; label: string; value: string; onChange: (value: string) => void; autoComplete: string }) {
  return <label htmlFor={id} className="text-sm font-semibold text-slate-700"><UiText text={label} /><input id={id} type="password" value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} minLength={8} maxLength={128} required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100" /></label>;
}

function Message({ tone, text }: { tone: "success" | "error"; text: string }) {
  return <p role={tone === "error" ? "alert" : "status"} className={`mt-4 rounded-xl px-4 py-3 text-sm ${tone === "success" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{tone === "error" ? <UiErrorText text={text} /> : <UiFeedbackText text={text} />}</p>;
}

function AccountSettingRow({ title, summary, description, children, disabled, danger = false, open, onOpenChange }: Readonly<{
  title: string;
  summary: ReactNode;
  description: string;
  children: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>): React.JSX.Element {
  return <div className={`${profileStyles.settingsOperationRow} ${danger ? profileStyles.settingsOperationRowDanger : ""}`}>
    <div className={profileStyles.settingsRowCopy}>
      <h3 className={profileStyles.settingsRowTitle}><UiText text={title} /></h3>
      <p className={profileStyles.settingsRowDescription}>{summary}</p>
    </div>
    <OperationPanel className={profileStyles.operationTrigger} title={title} triggerLabel={title} description={description} disabled={disabled} variant="drawer" open={open} onOpenChange={onOpenChange}>
      {children}
    </OperationPanel>
  </div>;
}

function AccountDetailsItem({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return <div className={profileStyles.accountDetailsItem}><dt><UiText text={label} /></dt><dd>{value}</dd></div>;
}
