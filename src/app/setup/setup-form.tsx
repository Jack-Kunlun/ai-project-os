"use client";
import { UiErrorText } from "@/components/ui-error-text";


import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UiText } from "@/components/appearance-provider";
import { InfoSection, PublicInfoPage } from "@/components/public-info-page";
import styles from "@/components/public-info-page.module.css";

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? "初始化失败";
  } catch {
    return "初始化失败";
  }
}

export function SetupForm() {
  const router = useRouter();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      router.replace("/admin");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "初始化失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <PublicInfoPage eyebrow="本地管理员" title="初始化 AI Project OS" description="管理员账号用于平台运营、安全治理和模型连接配置。供应商 API Key 将在页面录入并由服务端加密保存；普通用户登录后各自在“我的空间”管理个人资源。">
      <InfoSection title="创建管理员并进入">
        <form onSubmit={submit} className={styles.form}>
          <label className={styles.formLabel} htmlFor="setup-username"><UiText text="用户名" /></label>
          <input id="setup-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={64} required className={styles.formInput} />
          <label className={styles.formLabel} htmlFor="setup-password"><UiText text="密码" /></label>
          <input id="setup-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required className={styles.formInput} />
          <p className="mt-2 text-xs leading-5 text-slate-500"><UiText text="8–128 位，并同时包含字母和数字。" /></p>
          <label className={styles.formLabel} htmlFor="setup-password-confirm"><UiText text="再次输入密码" /></label>
          <input id="setup-password-confirm" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} required className={styles.formInput} />
          {error ? <p role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"><UiErrorText text={error} /></p> : null}
          <button type="submit" disabled={pending} className={`app-action-button ${styles.formSubmit}`}><UiText text={pending ? "正在初始化…" : "创建管理员并进入"} /></button>
          <p className="mt-5 text-center text-xs text-slate-500"><UiText text="第一次使用？" /><Link href="/guide#first-run" className="ml-1 font-semibold text-indigo-600 hover:text-indigo-700"><UiText text="查看完整使用指南" /></Link></p>
        </form>
      </InfoSection>
    </PublicInfoPage>
  );
}
