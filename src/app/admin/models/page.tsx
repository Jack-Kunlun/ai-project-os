import { SettingsClient } from "@/app/settings/settings-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminModelsPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  const user = await requireSystemAdminPage();
  const params = await searchParams;
  const returnTo = params.returnTo === "/admin/models/routes" ? params.returnTo : undefined;
  return <SettingsClient username={user.username} canManageProviders activeMembership membershipStatus="active" adminMode={user.role === "admin"} returnTo={returnTo} />;
}
