import { AppHeader } from "@/components/app-header";
import { requirePageSession } from "@/lib/auth";
import { GitConnectionsClient } from "./git-connections-client";

export const dynamic = "force-dynamic";

export default async function PersonalGitConnectionsPage() {
  const user = await requirePageSession();
  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={user.username} active="profile" isSystemAdmin={user.role === "admin"} />
      <GitConnectionsClient />
    </main>
  );
}
