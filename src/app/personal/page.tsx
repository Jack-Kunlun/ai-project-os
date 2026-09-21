import { AppHeader } from "@/components/app-header";
import { PersonalWorkspaceNav } from "@/components/personal-workspace-nav";
import { requirePageSession } from "@/lib/auth";
import { PersonalOverviewClient } from "./personal-overview-client";

export const dynamic = "force-dynamic";

/** Render the authenticated account-owned workspace and its project summary. */
export default async function PersonalWorkspacePage(): Promise<React.JSX.Element> {
  const user = await requirePageSession();
  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={user.username} active="personalKnowledge" isSystemAdmin={user.role === "admin"} />
      <PersonalWorkspaceNav active="overview" />
      <PersonalOverviewClient />
    </main>
  );
}
