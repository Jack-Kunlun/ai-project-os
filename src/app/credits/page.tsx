import { requirePageSession } from "@/lib/auth";
import { CreditsClient } from "./credits-client";

export const dynamic = "force-dynamic";

export default async function CreditsPage({ searchParams }: { searchParams?: Promise<{ projectId?: string }> }) {
  const user = await requirePageSession();
  const projectId = (await searchParams)?.projectId;
  return <CreditsClient username={user.username} isSystemAdmin={user.role === "admin"} initialProjectId={typeof projectId === "string" ? projectId : null} />;
}
