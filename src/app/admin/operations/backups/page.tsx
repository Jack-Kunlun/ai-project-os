import { AdminShell } from "@/components/admin-shell";
import { AppHeader } from "@/components/app-header";
import { requireSystemAdminPage } from "@/lib/system-admin";
import { isInitialSuperAdmin, readBackupOperationsSnapshot } from "@/lib/system-operations";
import { SystemOperationsClient } from "@/app/system/operations/system-operations-client";

export default async function AdminBackupsPage() {
  const user = await requireSystemAdminPage();
  if (!(await isInitialSuperAdmin(user))) {
    return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AppHeader username={user.username} active="admin" isSystemAdmin /><AdminShell active="operations" /><div className="mx-auto max-w-4xl px-5 py-10 sm:px-8"><section className="rounded-3xl border border-amber-200 bg-amber-50 p-7"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">Restricted operations</p><h1 className="mt-3 text-2xl font-semibold">备份与运维仅限初始超级管理员</h1><p className="mt-3 text-sm leading-7 text-amber-900">普通系统管理员可以查看其他管理能力，但不能读取服务器备份状态或触碰恢复边界。</p></section></div></main>;
  }
  return <SystemOperationsClient username={user.username} initialSnapshot={await readBackupOperationsSnapshot()} adminMode />;
}
