import { requirePageSession } from "@/lib/auth";
import { ProfileClient } from "./profile-client";
import { getGitHubOAuthAvailability } from "@/lib/github-oauth";

export const dynamic = "force-dynamic";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ github?: string }> }) {
  const user = await requirePageSession();
  const githubAvailability = await getGitHubOAuthAvailability();
  return <ProfileClient username={user.username} isSystemAdmin={user.role === "admin"} githubLoginAvailable={githubAvailability.status === "available"} githubAvailability={githubAvailability.status} githubStatus={(await searchParams).github} />;
}
