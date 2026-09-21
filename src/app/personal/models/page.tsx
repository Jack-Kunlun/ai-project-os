import { AppHeader } from "@/components/app-header";
import { PersonalWorkspaceNav } from "@/components/personal-workspace-nav";
import { requirePageSession } from "@/lib/auth";
import { getMembershipStatus } from "@/lib/ai-entitlements";
import { PersonalModelsClient } from "@/app/profile/models/personal-models-client";

export const dynamic = "force-dynamic";

/**
 * The canonical personal model page keeps membership evaluation server-side
 * while reusing the existing client and its owner-scoped API contract.
 */
export default async function PersonalModelsPage(): Promise<React.JSX.Element> {
  const user = await requirePageSession();
  const membership = await getMembershipStatus(user.id);

  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={user.username} active="personalKnowledge" isSystemAdmin={user.role === "admin"} />
      <PersonalWorkspaceNav active="models" />
      <PersonalModelsClient
        membership={{
          status: membership.status,
          startsAt: membership.startsAt?.toISOString() ?? null,
          expiresAt: membership.expiresAt?.toISOString() ?? null,
          version: membership.version,
        }}
      />
    </main>
  );
}
