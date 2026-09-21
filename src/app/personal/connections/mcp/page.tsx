import { McpConnectionsClient } from "@/app/profile/connections/mcp/mcp-connections-client";
import { AppHeader } from "@/components/app-header";
import { PersonalWorkspaceNav } from "@/components/personal-workspace-nav";
import { requirePageSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Render the owner-scoped MCP resource in the personal workspace shell. */
export default async function PersonalMcpConnectionsPage(): Promise<React.JSX.Element> {
  const user = await requirePageSession();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AppHeader username={user.username} active="personalKnowledge" isSystemAdmin={user.role === "admin"} /><PersonalWorkspaceNav active="mcp" /><McpConnectionsClient /></main>;
}
