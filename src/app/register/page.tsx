import { getPhoneAuthStatus } from "@/lib/phone-auth-config";
import { getEmailAuthStatus } from "@/lib/email-auth-config";
import { redirect } from "next/navigation";
import { AuthPage } from "@/components/auth-page";
import styles from "@/components/auth-page.module.css";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { isLocalRegistrationEnabled } from "@/lib/local-registration-config";
import { RegisterForm } from "./register-form";
import { UiText } from "@/components/appearance-provider";
import Link from "next/link";
import { canonicalInternalReturnPath } from "@/lib/redirects";

export const dynamic = "force-dynamic";

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const params = await searchParams;
  const returnTo = canonicalInternalReturnPath(params.returnTo);
  if (!(await isApplicationInitialized())) redirect("/setup");
  const existingSession = await getPageSession();
  if (existingSession !== null) redirect(existingSession.role === "admin" ? "/admin" : "/dashboard");

  return (
    <AuthPage sectionLabel="账号注册表单">
      <div className={styles.form}>
        <RegisterForm phoneAuthStatus={await getPhoneAuthStatus()} emailAuthStatus={await getEmailAuthStatus()} localRegistrationEnabled={isLocalRegistrationEnabled()} returnTo={returnTo} />
        <footer className={styles.formReturnLink}><UiText text="已有账号？" /> <Link href={returnTo === "/dashboard" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`}><UiText text="返回登录" /></Link></footer>
      </div>
    </AuthPage>
  );
}
