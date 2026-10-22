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
    <AuthPage sectionLabel="账号恢复表单">
      <div className={styles.form}>
        <RecoveryForm phoneAuthStatus={await getPhoneAuthStatus()} />
      </div>
    </AuthPage>
  );
}
