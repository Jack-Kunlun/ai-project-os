import { AdminOverviewClient } from "@/components/admin-overview-loader";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminPage() {
  await requireSystemAdminPage();
  return <AdminOverviewClient />;
}
