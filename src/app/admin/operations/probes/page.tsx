import { AdminHeader } from "@/components/admin-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { PlatformProbeBudgetClient } from "@/app/admin/operations/probes/platform-probe-budget-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminProbeBudgetPage() {
  const user = await requireSystemAdminPage();
  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950"><AdminHeader username={user.username} /><AdminPageFrame active="probes"><div className="mx-auto max-w-6xl px-6 py-8 sm:px-10 lg:px-12">
    <header className="pb-2 pt-4">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-indigo-600">Operations budget</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">连接探测预算</h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">配置平台供应商连接测试的单位上限、告警阈值和有效期；探测不会自动重试未知外发。</p>
    </header>
    <PlatformProbeBudgetClient />
  </div></AdminPageFrame></main>;
}
