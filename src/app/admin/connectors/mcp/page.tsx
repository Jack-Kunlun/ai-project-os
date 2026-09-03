import { McpConnectionsClient } from "@/app/connections/mcp/mcp-connections-client";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminMcpConnectionsPage() {
  const user = await requireSystemAdminPage();
  return <McpConnectionsClient username={user.username} adminMode />;
}
