import { AdminPageFrame } from "@/components/admin-shell";
import { AdminHeader } from "@/components/admin-header";
import { AdminAuditClient } from "@/app/admin/audit/audit-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminAuditPage() {
  const user = await requireSystemAdminPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AdminHeader username={user.username} /><AdminPageFrame active="audit"><AdminAuditClient /></AdminPageFrame></main>;
}
