import { SettingsClient } from "@/app/settings/settings-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminModelsPage() {
  const user = await requireSystemAdminPage();
  return <SettingsClient username={user.username} canManageProviders activeMembership membershipStatus="active" adminMode />;
}
