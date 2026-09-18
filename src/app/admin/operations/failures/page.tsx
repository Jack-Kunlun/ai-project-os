import { AdminFailureInboxClient } from "@/app/admin/operations/failures/failure-inbox-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminFailureInboxPage() {
  await requireSystemAdminPage();
  return <AdminFailureInboxClient />;
}
