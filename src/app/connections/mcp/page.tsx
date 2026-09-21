import { redirect } from "next/navigation";
import { requirePageSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function McpConnectionsPage() {
  await requirePageSession();
  redirect("/personal/connections/mcp");
}
