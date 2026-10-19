import { getPhoneAuthStatus } from "@/lib/phone-auth-config";
import { getEmailAuthStatus } from "@/lib/email-auth-config";
import { redirect } from "next/navigation";
import { AuthPage } from "@/components/auth-page";
import styles from "@/components/auth-page.module.css";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { isLocalRegistrationEnabled } from "@/lib/local-registration-config";
import { RegisterForm } from "./register-form";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (!(await isApplicationInitialized())) redirect("/setup");
  const existingSession = await getPageSession();
  if (existingSession !== null) redirect(existingSession.role === "admin" ? "/admin" : "/dashboard");

  return (
    <AuthPage sectionLabel="创建账号工作区">
      <div className={styles.form}>
        <div className={styles.formHeading}>
          <p className={styles.formEyebrow}>开始使用</p>
          <h2>创建账号</h2>
          <p>注册后会创建一个只属于你的个人工作区，你将成为该工作区的 Owner。</p>
        </div>
        <RegisterForm phoneAuthStatus={await getPhoneAuthStatus()} emailAuthStatus={await getEmailAuthStatus()} localRegistrationEnabled={isLocalRegistrationEnabled()} />
        <footer className={styles.formReturnLink}>已有账号？ <a href="/login">返回登录</a></footer>
      </div>
    </AuthPage>
  );
}
