import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { isApplicationInitialized } from "@/lib/auth";
import { getPhoneAuthStatus } from "@/lib/phone-auth-config";
import { RecoveryForm } from "./recovery-form";

export const dynamic = "force-dynamic";

export default async function RecoverPage() {
  if (!(await isApplicationInitialized())) redirect("/setup");
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f9fd] px-4 py-8 text-slate-950 sm:px-6">
      <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-8">
        <div className="flex items-center gap-3"><BrandMark size={32} priority /><span className="font-semibold">AI Project OS</span></div>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">找回账号与密码</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">验证已绑定的手机号，找回登录名并设置新密码。</p>
        <RecoveryForm phoneAuthStatus={await getPhoneAuthStatus()} />
      </section>
    </main>
  );
}
