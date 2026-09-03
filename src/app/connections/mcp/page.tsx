import { redirect } from "next/navigation";
import { requirePageSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function McpConnectionsPage() {
  const user = await requirePageSession();
  redirect(user.role === "admin" ? "/admin/connectors/mcp" : "/dashboard");
}
