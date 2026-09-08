import { AccountAccessClient } from "@/app/system/account-access/account-access-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export const dynamic = "force-dynamic";

export default async function AccountAccessPage() {
  const user = await requireSystemAdminPage();
  return <AccountAccessClient username={user.username} />;
}
