import { AdminHeader } from "@/components/admin-header";
import { AdminOverviewClient } from "@/components/admin-overview-client";
import { requireFirstAdminOnboardingPage } from "@/lib/auth";
import { FirstAdminOnboardingClient } from "./first-admin-onboarding-client";

export const dynamic = "force-dynamic";

export default async function FirstAdminOnboardingPage() {
  const user = await requireFirstAdminOnboardingPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
    <AdminHeader username={user.username} />
    <section className="mx-auto max-w-7xl px-4 pb-2 pt-8 sm:px-8 lg:px-10">
      <div className="rounded-[2rem] bg-slate-950 px-6 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-10">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">First administrator onboarding</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">建立独立的业务 Owner</h1>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">平台管理员只负责运营和安全治理。创建一个独立普通账号作为默认工作区 Owner 后，管理员将直接进入管理后台，业务负责人使用自己的账号进入用户工作台。</p>
      </div>
    </section>
    <AdminOverviewClient />
    <FirstAdminOnboardingClient />
  </main>;
}
