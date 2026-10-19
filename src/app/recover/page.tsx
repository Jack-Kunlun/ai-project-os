import { redirect } from "next/navigation";
import { AuthPage } from "@/components/auth-page";
import styles from "@/components/auth-page.module.css";
import { isApplicationInitialized } from "@/lib/auth";
import { getPhoneAuthStatus } from "@/lib/phone-auth-config";
import { RecoveryForm } from "./recovery-form";

export const dynamic = "force-dynamic";

export default async function RecoverPage() {
  if (!(await isApplicationInitialized())) redirect("/setup");
  return (
    <AuthPage sectionLabel="找回账号与密码工作区">
      <div className={styles.form}>
        <div className={styles.formHeading}>
          <p className={styles.formEyebrow}>账户恢复</p>
          <h2>找回账号与密码</h2>
          <p>验证已绑定的手机号，找回登录名并设置新密码。</p>
        </div>
        <RecoveryForm phoneAuthStatus={await getPhoneAuthStatus()} />
      </div>
    </AuthPage>
  );
}
