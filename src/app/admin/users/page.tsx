import { AdminUsersClient } from "@/app/admin/users/users-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const user = await requireSystemAdminPage();
  return <AdminUsersClient username={user.username} />;
}
