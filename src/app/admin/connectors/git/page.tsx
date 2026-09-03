import { ConnectionsClient } from "@/app/connections/connections-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminGitConnectionsPage() {
  const user = await requireSystemAdminPage();
  return <ConnectionsClient username={user.username} adminMode />;
}
