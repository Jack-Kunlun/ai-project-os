import { AppHeader } from "@/components/app-header";
import { AdminOverviewClient } from "@/components/admin-overview-client";
import { requireFirstAdminOnboardingPage } from "@/lib/auth";
import { FirstAdminOnboardingClient } from "./first-admin-onboarding-client";

export const dynamic = "force-dynamic";

export default async function FirstAdminOnboardingPage() {
  const user = await requireFirstAdminOnboardingPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
    <AppHeader username={user.username} active="admin" isSystemAdmin={user.role === "admin"} />
    <section className="mx-auto max-w-7xl px-4 pb-2 pt-8 sm:px-8 lg:px-10">
      <div className="rounded-[2rem] bg-slate-950 px-6 py-8 text-white shadow-xl shadow-slate-950/10 sm:px-10 sm:py-10">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-300">First administrator onboarding</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">管理工作台首次就绪</h1>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-300">先查看现有的平台首次就绪清单，再明确确认进入日常工作区。页面不会自动完成，也不会因为清单存在待处理项而阻止你继续。</p>
      </div>
    </section>
    <AdminOverviewClient />
    <FirstAdminOnboardingClient />
  </main>;
}
