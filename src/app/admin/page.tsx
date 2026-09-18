import { AdminOverviewClient } from "@/components/admin-overview-client";
import { AdminPageFrame } from "@/components/admin-shell";
import { AdminHeader } from "@/components/admin-header";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminPage() {
  const user = await requireSystemAdminPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AdminHeader username={user.username} /><AdminPageFrame active="overview"><AdminOverviewClient /></AdminPageFrame></main>;
}
