import { AdminAccountClient } from "./admin-account-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminAccountPage() {
  const user = await requireSystemAdminPage();
  return <AdminAccountClient initialUsername={user.username} />;
}
