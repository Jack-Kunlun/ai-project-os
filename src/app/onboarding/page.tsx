import { AdminHeader } from "@/components/admin-header";
import { AdminPageHeader } from "@/components/admin-page-header";
import { requireFirstAdminOnboardingPage } from "@/lib/auth";
import { FirstAdminOnboardingClient } from "./first-admin-onboarding-client";

export const dynamic = "force-dynamic";

export default async function FirstAdminOnboardingPage() {
  const user = await requireFirstAdminOnboardingPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
    <AdminHeader username={user.username} />
    <section className="w-full px-4 pb-2 pt-5 sm:px-5 lg:px-6"><AdminPageHeader title="初始化业务 Owner" description="平台管理员只负责运营和安全治理；创建独立普通账号作为默认工作区 Owner 后，业务负责人使用自己的账号进入用户工作台。" /></section>
    <FirstAdminOnboardingClient />
  </main>;
}
