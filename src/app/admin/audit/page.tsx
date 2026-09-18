import { AdminAuditClient } from "@/app/admin/audit/audit-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminAuditPage() {
  await requireSystemAdminPage();
  return <AdminAuditClient />;
}
