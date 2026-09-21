import { redirect } from "next/navigation";
import { requirePageSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Preserve old bookmarks without moving credential ownership or API scope. */
export default async function LegacyPersonalMcpConnectionsPage(): Promise<never> {
  await requirePageSession();
  redirect("/personal/connections/mcp");
}
