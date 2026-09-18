import { PlatformProbeBudgetClient } from "@/app/admin/operations/probes/platform-probe-budget-client";
import { requireSystemAdminPage } from "@/lib/system-admin";
import { AdminPageHeader } from "@/components/admin-page-header";

export default async function AdminProbeBudgetPage() {
  await requireSystemAdminPage();
  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="连接探测预算" description="配置平台供应商连接测试的单位上限、告警阈值和有效期；探测不会自动重试未知外发。" />
    <PlatformProbeBudgetClient />
  </div>;
}
