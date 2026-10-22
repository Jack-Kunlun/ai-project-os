import { getPhoneAuthStatus } from "@/lib/phone-auth-config";
import { getEmailAuthStatus } from "@/lib/email-auth-config";
import { redirect } from "next/navigation";
import { AuthPage } from "@/components/auth-page";
import styles from "@/components/auth-page.module.css";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { isLocalRegistrationEnabled } from "@/lib/local-registration-config";
import { RegisterForm } from "./register-form";
import { UiText } from "@/components/appearance-provider";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (!(await isApplicationInitialized())) redirect("/setup");
  const existingSession = await getPageSession();
  if (existingSession !== null) redirect(existingSession.role === "admin" ? "/admin" : "/dashboard");

  return (
    <AuthPage sectionLabel="账号注册表单">
      <div className={styles.form}>
        <RegisterForm phoneAuthStatus={await getPhoneAuthStatus()} emailAuthStatus={await getEmailAuthStatus()} localRegistrationEnabled={isLocalRegistrationEnabled()} />
        <footer className={styles.formReturnLink}><UiText text="已有账号？" /> <a href="/login"><UiText text="返回登录" /></a></footer>
      </div>
    </AuthPage>
  );
}
