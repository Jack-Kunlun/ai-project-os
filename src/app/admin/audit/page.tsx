import { AdminPageFrame } from "@/components/admin-shell";
import { AppHeader } from "@/components/app-header";
import { AdminAuditClient } from "@/app/admin/audit/audit-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminAuditPage() {
  const user = await requireSystemAdminPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AppHeader username={user.username} active="admin" isSystemAdmin={user.role === "admin"} /><AdminPageFrame active="audit"><AdminAuditClient /></AdminPageFrame></main>;
}
