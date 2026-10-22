"use client";
import { UiFeedbackText } from "@/components/ui-error-text";


import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AdminPageHeader } from "@/components/admin-page-header";
import { AccountPhonePanel } from "@/components/account-phone-panel";
import { OperationPanel } from "@/components/operation-panel";
import { useAppearance } from "@/components/appearance-provider";

type AdminProfile = Readonly<{
  username: string;
  displayName: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  hasLocalPassword: boolean;
  phoneE164: string | null;
  phoneAuthStatus: "disabled" | "unavailable" | "available";
  activeSessionCount: number;
  lastSeenAt: string | null;
}>;

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

function dateTime(value: string | null, language: "zh-CN" | "en", t: (text: string) => string): string {
  return value === null ? t("暂无记录") : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function AdminAccountClient({ initialUsername }: { initialUsername: string }) {
  const { language, t } = useAppearance();
  const router = useRouter();
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openOperation, setOpenOperation] = useState<"profile" | "password" | "phone" | null>(null);
  const phoneSubmissionPending = useRef(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/account", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseMessage(response, "管理员账户读取失败"));
    const next = (await response.json() as { profile: AdminProfile }).profile;
    setProfile(next);
    setDisplayName(next.displayName ?? "");
    setEmail(next.email ?? "");
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "管理员账户读取失败")), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/admin/account", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "updateProfile", displayName: displayName || null, email: email || null }) });
      if (!response.ok) throw new Error(await responseMessage(response, "账户资料保存失败"));
      await load(); setMessage("账户资料已保存"); setOpenOperation(null);
    } catch (error) { setMessage(error instanceof Error ? error.message : "账户资料保存失败"); }
    finally { setPending(false); }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setMessage(null);
    try {
      const response = await fetch("/api/admin/account", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: profile?.hasLocalPassword ? "changePassword" : "setLocalPassword", ...(profile?.hasLocalPassword ? { currentPassword } : {}), newPassword }) });
      if (!response.ok) throw new Error(await responseMessage(response, "密码更新失败"));
      router.replace("/login"); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "密码更新失败"); setPending(false); }
  }

  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="管理员账户" description="维护平台管理员的登录资料与密码；这里不显示项目、团队、工作区角色、个人连接或业务额度。" />
    <section className="mt-6 grid gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-3">
      <div><p className="text-xs font-semibold text-slate-400">{t("登录名")}</p><p className="mt-2 font-semibold">{profile?.username ?? initialUsername}</p></div>
      <div><p className="text-xs font-semibold text-slate-400">{t("活动会话")}</p><p className="mt-2 font-semibold">{profile ? profile.activeSessionCount.toLocaleString(language) : t("读取中…")}</p></div>
      <div><p className="text-xs font-semibold text-slate-400">{t("最近活动")}</p><p className="mt-2 text-sm font-semibold">{profile ? dateTime(profile.lastSeenAt, language, t) : t("读取中…")}</p></div>
    </section>
    {message && openOperation === null ? <p role="status" className="mt-5 rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-800"><UiFeedbackText text={message} /></p> : null}
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">{t("基本资料")}</h2>
        <dl className="mt-4 space-y-3 text-sm"><div><dt className="text-xs text-slate-400">{t("显示名称")}</dt><dd className="mt-1 font-medium text-slate-700">{profile?.displayName ?? t("未设置")}</dd></div><div><dt className="text-xs text-slate-400">{t("邮箱")}</dt><dd className="mt-1 font-medium text-slate-700">{profile?.email ?? t("未设置")}{profile?.emailVerifiedAt ? ` · ${t("已验证")}` : ""}</dd></div></dl>
        <OperationPanel title={t("编辑管理员账户资料")} triggerLabel={t("编辑资料")} description={t("更新显示名称或邮箱。")} open={openOperation === "profile"} onOpenChange={(open) => { setOpenOperation(open ? "profile" : null); if (open) setMessage(null); }}>
          <form onSubmit={updateProfile} className="max-w-2xl space-y-4">
            <label className="block text-sm font-medium text-slate-700">{t("显示名称")}<input aria-label={t("显示名称")} value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={160} className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400" /></label>
            <label className="block text-sm font-medium text-slate-700">{t("邮箱")}<input aria-label={t("邮箱")} type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={320} className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400" /></label>
            {message && openOperation === "profile" ? <p role="status" className="text-sm text-rose-700"><UiFeedbackText text={message} /></p> : null}
            <button disabled={pending || profile === null} className="min-h-11 rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{t(pending ? "保存中…" : "保存个人资料")}</button>
          </form>
        </OperationPanel>
      </section>
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold">{t("登录密码")}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">{t(profile?.hasLocalPassword ? "更新密码后需要重新登录。" : "当前尚未设置本地密码。")}</p>
        <OperationPanel title={t(profile?.hasLocalPassword ? "修改管理员登录密码" : "设置管理员登录密码")} triggerLabel={t(profile?.hasLocalPassword ? "修改密码" : "设置密码")} description={t("更新后需要重新登录。")} open={openOperation === "password"} onOpenChange={(open) => { setOpenOperation(open ? "password" : null); if (open) setMessage(null); }}>
          <form onSubmit={changePassword} className="max-w-2xl space-y-4">
            {profile?.hasLocalPassword ? <label className="block text-sm font-medium text-slate-700">{t("当前密码")}<input aria-label={t("当前密码")} type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400" /></label> : null}
            <label className="block text-sm font-medium text-slate-700">{t("新密码")}<input aria-label={t("新密码")} type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required className="mt-2 w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-400" /></label>
            <p className="text-xs leading-5 text-slate-500">{t("8–128 位，同时包含字母和数字。更新后需要重新登录。")}</p>
            {message && openOperation === "password" ? <p role="alert" className="text-sm text-rose-700"><UiFeedbackText text={message} /></p> : null}
            <button disabled={pending || profile === null} className="min-h-11 rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{t(pending ? "更新中…" : "更新密码")}</button>
          </form>
        </OperationPanel>
      </section>
    </div>
    {profile ? <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">{t("绑定手机号")}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">{profile.phoneE164 ? `${profile.phoneE164.slice(0, 6)} **** ${profile.phoneE164.slice(-4)}` : t("尚未绑定")}{t("。绑定后可用于登录和找回密码。")}</p>
      {profile.phoneAuthStatus !== "available" ? <p role="status" className="mt-3 text-sm leading-6 text-amber-800">{t("短信服务暂不可用，请稍后重试。")}</p> : null}
      {!profile.phoneE164 && !profile.hasLocalPassword ? <p className="mt-3 text-sm leading-6 text-slate-600">{t("请先设置本地密码并重新登录，再验证密码和手机号完成绑定。")}</p> : null}
      <OperationPanel
        title={profile.phoneE164 ? "更换手机号" : "绑定手机号"}
        triggerLabel={profile.phoneE164 ? "更换手机号" : "绑定手机号"}
        description={profile.phoneE164 ? "需同时验证原号码和新号码。原号码不可用时，暂无法自助换绑。" : "绑定需要验证当前密码及手机号。"}
        disabled={profile.phoneAuthStatus !== "available" || (!profile.phoneE164 && !profile.hasLocalPassword)}
        open={openOperation === "phone"}
        onOpenChange={(open) => {
          if (!open && phoneSubmissionPending.current) return;
          if (open) { phoneSubmissionPending.current = false; setMessage(null); }
          else phoneSubmissionPending.current = false;
          setOpenOperation(open ? "phone" : null);
        }}
      >
        {openOperation === "phone" ? <AccountPhonePanel
          key={profile.phoneE164 ?? "unbound"}
          embedded
          phoneE164={profile.phoneE164}
          hasLocalPassword={profile.hasLocalPassword}
          phoneAuthStatus={profile.phoneAuthStatus}
          onPendingChange={(pending) => { phoneSubmissionPending.current = pending; }}
        /> : null}
      </OperationPanel>
    </section> : null}
  </div>;
}
