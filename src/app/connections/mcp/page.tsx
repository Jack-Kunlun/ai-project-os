import { requirePageSession } from "@/lib/auth";
import { McpConnectionsClient } from "./mcp-connections-client";

export const dynamic = "force-dynamic";

export default async function McpConnectionsPage() {
  const user = await requirePageSession();
  return <McpConnectionsClient username={user.username} />;
}
