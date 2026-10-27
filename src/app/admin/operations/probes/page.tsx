import { PlatformProbeBudgetClient } from "@/app/admin/operations/probes/platform-probe-budget-client";
import { requireSystemAdminPage } from "@/lib/system-admin";
import { AdminPageHeader } from "@/components/admin-page-header";

export default async function AdminProbeBudgetPage() {
  await requireSystemAdminPage();
  return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6">
    <AdminPageHeader title="模型测试额度" description="查看当前可用测试次数，并设置次数上限与有效期限；这不是 Token 或人民币余额。结果未知的请求会占用额度并留待核对，不会自动重试。" />
    <PlatformProbeBudgetClient />
  </div>;
}
