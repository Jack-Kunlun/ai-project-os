import { McpReviewWorkbench } from "@/app/admin/connectors/mcp/mcp-review-workbench";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminMcpConnectionsPage() {
  await requireSystemAdminPage();
  return <McpReviewWorkbench />;
}
