import { AdminHeader } from "@/components/admin-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { PlatformDefaultRoutesPanel } from "@/app/settings/platform-default-routes-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminModelRoutesPage() {
  const user = await requireSystemAdminPage();
  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AdminHeader username={user.username} /><AdminPageFrame active="modelRoutes"><div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
    <header className="pb-2 pt-4">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Platform default routes</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">默认模型路由</h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">按能力配置、验证和激活平台默认路由；路由、倍率和影响预览在这里集中管理。</p>
    </header>
    <PlatformDefaultRoutesPanel />
  </div></AdminPageFrame></main>;
}
