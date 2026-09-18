import { requireSystemAdminPage } from "@/lib/system-admin";
import { isInitialSuperAdmin, readBackupOperationsSnapshot } from "@/lib/system-operations";
import { SystemOperationsClient } from "@/app/system/operations/system-operations-client";
import { AdminPageHeader } from "@/components/admin-page-header";

export default async function AdminBackupsPage() {
  const user = await requireSystemAdminPage();
  if (!(await isInitialSuperAdmin(user))) {
    return <div className="w-full px-4 pb-12 pt-5 sm:px-5 lg:px-6"><AdminPageHeader title="备份与运维" description="备份状态和恢复边界仅对初始超级管理员开放。" /><section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-6"><h2 className="text-base font-semibold text-amber-950">当前账号无权读取服务器备份状态</h2><p className="mt-2 text-sm leading-6 text-amber-900">普通系统管理员可以查看其他管理能力，但不能读取服务器备份状态或触碰恢复边界。</p></section></div>;
  }
  return <SystemOperationsClient username={user.username} initialSnapshot={await readBackupOperationsSnapshot()} adminMode={user.role === "admin"} />;
}
