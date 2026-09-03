import { requirePageSession } from "@/lib/auth";
import { getMembershipStatus } from "@/lib/ai-entitlements";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requirePageSession();
  const membership = await getMembershipStatus(user.id);
  return <SettingsClient username={user.username} canManageProviders={user.role === "admin"} activeMembership={membership.status === "active"} membershipStatus={membership.status} />;
}
