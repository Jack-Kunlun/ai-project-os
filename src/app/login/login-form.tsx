"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { normalizeMainlandPhoneInput, SmsCodeInput } from "@/components/sms-code-input";
import styles from "./login.module.css";

type PhoneAuthStatus = "disabled" | "unavailable" | "available";

type LoginFormProps = {
  notice?: string;
  noticeTone?: "success" | "error";
  oidcProviders?: Array<{ id: string; name: string }>;
  returnTo?: string;
  githubLoginAvailable?: boolean;
  githubAvailability?: "notConfigured" | "configurationInvalid" | "bootstrapPending" | "available";
  phoneAuthStatus?: PhoneAuthStatus;
  phoneAutoRegistrationEnabled?: boolean;
  emailAuthEnabled?: boolean;
};

export function LoginForm({
  notice,
  noticeTone = "success",
  oidcProviders = [],
  returnTo = "/dashboard",
  githubLoginAvailable = false,
  githubAvailability = githubLoginAvailable ? "available" : "notConfigured",
  phoneAuthStatus = "disabled",
  phoneAutoRegistrationEnabled = false,
  emailAuthEnabled = false,
}: LoginFormProps) {
  const router = useRouter();
  const [method, setMethod] = useState<"password" | "sms">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsChallengeId, setSmsChallengeId] = useState<string | null>(null);
  const remember = true;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [smsSuccessNotice, setSmsSuccessNotice] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (method === "sms" && phoneAuthStatus !== "available") return;
    setPending(true);
    setError(null);
    setSmsSuccessNotice(null);
    try {
      if (method === "sms") {
        if (!smsChallengeId || smsCode.length !== 6) {
          throw new Error("请先获取并填写短信验证码。");
        }
        const response = await fetch("/api/auth/sms/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone: `+86${phone}`, challengeId: smsChallengeId, code: smsCode, remember }),
        });
        const payload = await response.json().catch(() => null) as {
          error?: { code?: string };
          user?: { role?: "admin" | "user" };
          registered?: boolean;
        } | null;
        if (!response.ok || !payload?.user?.role) {
          const safeMessage = payload?.error?.code === "LOCAL_REGISTRATION_DISABLED"
            ? "该手机号尚未注册，当前暂未开放新账号注册。"
            : "验证码登录失败，请检查验证码或稍后重试。";
          throw new Error(safeMessage);
        }
        if (payload.registered === true && phoneAutoRegistrationEnabled) {
          setSmsSuccessNotice("该手机号尚未注册，已为你创建账号和个人工作区。");
          await new Promise((resolve) => window.setTimeout(resolve, 900));
        }
        router.replace(payload.user.role === "admin" ? "/admin" : returnTo);
        router.refresh();
        return;
      }

      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, remember }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? "登录失败");
      }
      const payload = await response.json() as { user: { role: "admin" | "user" } };
      router.replace(payload.user.role === "admin" ? "/admin" : returnTo);
      router.refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败");
    } finally {
      setPending(false);
    }
  }

  const githubHref = `/api/auth/github/start?intent=login&remember=${remember ? "true" : "false"}&returnTo=${encodeURIComponent(returnTo)}`;
  const githubUnavailableMessage = {
    notConfigured: "GitHub 登录尚未配置，请联系工作区管理员",
    configurationInvalid: "GitHub 登录配置无效，请联系工作区管理员",
    bootstrapPending: "平台管理员尚未完成初始化，GitHub 登录暂不可用",
    available: "",
  }[githubAvailability];
  const smsLoginAvailable = phoneAuthStatus === "available";

  function changeLoginMethod(nextMethod: "password" | "sms") {
    if (nextMethod === "sms" && !smsLoginAvailable) return;
    setMethod(nextMethod);
    setError(null);
    setSmsCode("");
    setSmsChallengeId(null);
  }

  return (
    <main className={styles.page}>
      <div className={styles.layout}>
        <section className={styles.productPanel} aria-label="产品介绍">
          <div className={styles.brand}>
            <BrandMark size={36} priority className={styles.brandMark} />
            <span className={styles.brandName}>AI Project OS</span>
          </div>

          <div className={styles.productSummary}>
            <p className={styles.eyebrow}>项目工作空间</p>
            <h1 className={styles.headline}>让项目知识可追溯</h1>
            <p className={styles.introText}>项目资料、计划与协作信息集中在一个工作区，帮助团队沿着可靠来源推进工作。</p>
          </div>

          <ul className={styles.capabilities} aria-label="工作区能力">
            <li><span>01</span><p>问答按轮保留范围与资料引用</p></li>
            <li><span>02</span><p>知识图谱连接事实和原始资料</p></li>
            <li><span>03</span><p>项目、计划与成员协作信息集中查看</p></li>
          </ul>
        </section>

        <section className={styles.loginPanel} aria-label="登录工作区">
          <form onSubmit={submit} className={styles.form}>
            <div className={styles.formHeading}>
              <p className={styles.formEyebrow}>欢迎回来</p>
              <h2>登录 AI Project OS</h2>
              <p>使用你的账号进入工作区。</p>
            </div>

            {phoneAuthStatus !== "disabled" ? (
              <div className={styles.methodSection}>
                <div role="tablist" aria-label="选择登录方式" className={styles.methodTabs}>
                  <button type="button" role="tab" aria-selected={method === "password"} onClick={() => changeLoginMethod("password")} className={`${styles.methodTab} ${method === "password" ? styles.methodTabSelected : ""}`}>用户名密码</button>
                  <button type="button" role="tab" aria-selected={method === "sms"} disabled={!smsLoginAvailable} onClick={() => changeLoginMethod("sms")} className={`${styles.methodTab} ${method === "sms" ? styles.methodTabSelected : ""}`}>手机号验证码</button>
                </div>
                {smsLoginAvailable ? (
                  <p className={styles.methodHint}>
                    {phoneAutoRegistrationEnabled ? "验证码验证后登录；手机号首次使用时会自动创建账号和个人工作区。" : "验证码用于登录已有账号；如需新账号，请先完成注册。"}
                  </p>
                ) : <p role="status" className={`${styles.methodHint} ${styles.statusWarning}`}>短信服务暂不可用，请稍后重试或联系管理员。</p>}
              </div>
            ) : null}

            {method === "password" ? (
              <>
                <label className={styles.fieldLabel} htmlFor="login-username">{emailAuthEnabled ? "用户名、手机号或已验证邮箱" : "用户名或手机号"}</label>
                <div className={styles.inputShell}>
                  <span className={styles.inputIcon}><UserIcon /></span>
                  <input id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={emailAuthEnabled ? 320 : 64} required placeholder={emailAuthEnabled ? "输入用户名、手机号或已验证邮箱" : "输入用户名或手机号"} className={styles.textInput} />
                </div>

                <label className={`${styles.fieldLabel} ${styles.nextFieldLabel}`} htmlFor="login-password">密码</label>
                <div className={styles.inputShell}>
                  <span className={styles.inputIcon}><LockIcon /></span>
                  <input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required placeholder="输入密码" className={styles.textInput} />
                </div>
              </>
            ) : (
              <div className={styles.smsFields}>
                <div className={styles.smsPhoneField}>
                  <label className={styles.fieldLabel} htmlFor="login-phone">手机号</label>
                  <div className={styles.phoneShell}>
                    <span aria-hidden="true" className={styles.phonePrefix}>+86</span>
                    <input
                      id="login-phone"
                      type="tel"
                      inputMode="numeric"
                      value={phone}
                      onChange={(event) => {
                        setPhone(normalizeMainlandPhoneInput(event.target.value));
                        setSmsCode("");
                        setSmsChallengeId(null);
                      }}
                      autoComplete="tel-national"
                      minLength={11}
                      maxLength={11}
                      required
                      pattern="1[3-9][0-9]{9}"
                      placeholder="输入 11 位手机号"
                      className={styles.phoneInput}
                    />
                  </div>
                </div>
                <div className={styles.smsCodeField}>
                  <SmsCodeInput
                    key={phone}
                    id="login-sms-code"
                    size="large"
                    phoneE164={`+86${phone}`}
                    purpose="login"
                    availability="available"
                    code={smsCode}
                    onCodeChange={setSmsCode}
                    onChallengeIdChange={setSmsChallengeId}
                  />
                </div>
              </div>
            )}

            {method === "password" ? (
              <div className={styles.recoverLink}>
                <Link href="/recover">忘记账号或密码？</Link>
              </div>
            ) : null}

            {notice ? <p role={noticeTone === "error" ? "alert" : "status"} className={`${styles.notice} ${noticeTone === "error" ? styles.noticeError : styles.noticeSuccess}`}>{notice}</p> : null}
            {smsSuccessNotice ? <p role="status" className={`${styles.notice} ${styles.noticeSuccess}`}>{smsSuccessNotice}</p> : null}
            {error ? <p role="alert" className={`${styles.notice} ${styles.noticeError}`}>{error}</p> : null}

            <button type="submit" disabled={pending} className={styles.submitButton}>{pending ? "登录中…" : "登 录"}</button>

            <p className={styles.registerPrompt}>还没有账号？ <Link href="/register">创建账号</Link></p>

            <div className={styles.alternativeHeading}><span />其他登录方式<span /></div>

            {githubLoginAvailable ? (
              <div className={styles.providerBlock}>
                <a href={githubHref} className={styles.providerLink}><GitHubIcon />使用 GitHub 登录</a>
                <p className={styles.providerHint}>首次使用 GitHub 登录会自动创建普通用户账号。</p>
              </div>
            ) : (
              <div className={styles.providerBlock}>
                <button type="button" disabled className={`${styles.providerLink} ${styles.providerUnavailable}`}><GitHubIcon />使用 GitHub 登录</button>
                <p className={styles.providerHint}>{githubUnavailableMessage}</p>
              </div>
            )}

            {oidcProviders.length > 0 ? <div className={styles.oidcProviders}>{oidcProviders.map((provider) => <a key={provider.id} href={`/api/auth/oidc/start/${provider.id}?returnTo=${encodeURIComponent(returnTo)}`} className={styles.oidcLink}>使用 {provider.name} 登录</a>)}</div> : null}
          </form>
        </section>
      </div>

      <footer className={styles.footer}>
        <Link href="/privacy"><SmallShieldIcon />隐私政策</Link>
        <span aria-hidden="true" />
        <Link href="/terms"><TermsIcon />服务条款</Link>
        <span aria-hidden="true" />
        <Link href="/help"><HelpIcon />帮助文档</Link>
        <span aria-hidden="true" />
        <Link href="/contact"><ContactIcon />联系作者</Link>
      </footer>
    </main>
  );
}

function UserIcon() { return <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="3.2" /><path d="M5.8 20v-2.1A4.9 4.9 0 0 1 10.7 13h2.6a4.9 4.9 0 0 1 4.9 4.9V20" /></svg>; }
function LockIcon() { return <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5.5" y="10" width="13" height="10" rx="2" /><path d="M8.5 10V7.2a3.5 3.5 0 0 1 7 0V10" /><path d="M12 14.4v2.3" /></svg>; }
function GitHubIcon() { return <svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .7A11.5 11.5 0 0 0 8.36 23.1c.58.1.79-.25.79-.56v-2.23c-3.23.7-3.91-1.37-3.91-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.58-.29-5.29-1.29-5.29-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.4-2.72 5.38-5.3 5.67.42.36.79 1.06.79 2.14v3.25c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" /></svg>; }
function SmallShieldIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3 19 6v5c0 4.6-2.8 7.7-7 10-4.2-2.3-7-5.4-7-10V6z" /><path d="m9 12 2 2 4-4" /></svg>; }
function TermsIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M6 3.5h9l3 3V20H6z" /><path d="M15 3.5V7h3M9 11h6M9 14.5h6M9 18h4" /></svg>; }
function HelpIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M9.7 9.3a2.5 2.5 0 1 1 3.7 2.2c-.9.45-1.4 1-1.4 2" /><path d="M12 17.5h.01" /></svg>; }
function ContactIcon() { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /></svg>; }
