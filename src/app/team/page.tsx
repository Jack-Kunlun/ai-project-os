import { requirePageSession } from "@/lib/auth";
import { TeamClient } from "./team-client";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const user = await requirePageSession();
  return <TeamClient username={user.username} />;
}
