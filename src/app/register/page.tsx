import { getPhoneAuthStatus } from "@/lib/phone-auth-config";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { getPageSession, isApplicationInitialized } from "@/lib/auth";
import { isLocalRegistrationEnabled } from "@/lib/local-registration-config";
import { RegisterForm } from "./register-form";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (!(await isApplicationInitialized())) redirect("/setup");
  const existingSession = await getPageSession();
  if (existingSession !== null) redirect(existingSession.role === "admin" ? "/admin" : "/dashboard");

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_8%_5%,rgba(224,231,255,.72),transparent_24%),radial-gradient(circle_at_92%_94%,rgba(237,233,254,.68),transparent_25%),#f7f9fd] px-4 py-4 text-slate-950 sm:px-6">
      <section className="w-full max-w-[920px] rounded-[28px] border border-white/90 bg-white p-6 shadow-[0_20px_58px_rgba(15,23,42,.12)] sm:p-6">
        <div className="flex items-center gap-3">
          <BrandMark size={32} priority className="rounded-[14px]" />
          <span className="text-base font-semibold text-slate-900">AI Project OS</span>
        </div>
        <p className="mt-3 text-xs font-bold uppercase tracking-[0.27em] text-indigo-600">Create account</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">创建账号</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">注册后会创建一个只属于你的个人工作区，你将成为该工作区的 Owner。</p>
        <RegisterForm phoneAuthStatus={await getPhoneAuthStatus()} localRegistrationEnabled={isLocalRegistrationEnabled()} />
        <footer className="mt-3 text-center text-xs text-slate-400">已有账号？ <a href="/login" className="font-semibold text-indigo-600 hover:text-indigo-500">返回登录</a></footer>
      </section>
    </main>
  );
}
