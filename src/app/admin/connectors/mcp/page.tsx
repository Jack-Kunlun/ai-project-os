import { McpReviewWorkbench } from "@/app/admin/connectors/mcp/mcp-review-workbench";
import { AppHeader } from "@/components/app-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminMcpConnectionsPage() {
  const user = await requireSystemAdminPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AppHeader username={user.username} active="admin" isSystemAdmin={user.role === "admin"} /><AdminPageFrame active="mcp"><McpReviewWorkbench /></AdminPageFrame></main>;
}
