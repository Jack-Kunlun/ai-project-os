import { AdminOverviewClient } from "@/components/admin-overview-client";
import { AdminShell } from "@/components/admin-shell";
import { AppHeader } from "@/components/app-header";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminPage() {
  const user = await requireSystemAdminPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AppHeader username={user.username} active="admin" isSystemAdmin /><AdminShell active="overview" /><AdminOverviewClient /></main>;
}
