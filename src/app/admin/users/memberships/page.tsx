import { MembershipsClient } from "@/app/system/memberships/memberships-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminMembershipsPage() {
  const user = await requireSystemAdminPage();
  return <MembershipsClient username={user.username} adminMode />;
}
