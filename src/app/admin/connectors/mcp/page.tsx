import { McpReviewWorkbench } from "@/app/admin/connectors/mcp/mcp-review-workbench";
import { AdminHeader } from "@/components/admin-header";
import { AdminPageFrame } from "@/components/admin-shell";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminMcpConnectionsPage() {
  const user = await requireSystemAdminPage();
  return <main className="min-h-screen bg-[#f4f6fb] text-slate-950"><AdminHeader username={user.username} /><AdminPageFrame active="mcp"><McpReviewWorkbench /></AdminPageFrame></main>;
}
