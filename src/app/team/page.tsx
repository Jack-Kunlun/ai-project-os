import { requirePageSession } from "@/lib/auth";
import { getMembershipStatus } from "@/lib/ai-entitlements";
import { TeamClient } from "./team-client";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const user = await requirePageSession();
  const membership = await getMembershipStatus(user.id);
  return <TeamClient username={user.username} currentUserId={user.id} activeMembership={membership.status === "active"} />;
}
