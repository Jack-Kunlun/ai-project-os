import { AppHeader } from "@/components/app-header";
import { requirePageSession } from "@/lib/auth";
import { getMembershipStatus } from "@/lib/ai-entitlements";
import { PersonalModelsClient } from "./personal-models-client";

export const dynamic = "force-dynamic";

export default async function PersonalModelsPage() {
  const user = await requirePageSession();
  const membership = await getMembershipStatus(user.id);

  return (
    <main className="min-h-screen bg-[#f4f6fb] text-slate-950">
      <AppHeader username={user.username} active="profile" isSystemAdmin={user.role === "admin"} />
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
