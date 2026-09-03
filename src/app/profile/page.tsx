import { requirePageSession } from "@/lib/auth";
import { ProfileClient } from "./profile-client";
import { isGitHubOAuthConfigured } from "@/lib/github-oauth";

export const dynamic = "force-dynamic";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ github?: string }> }) {
  const user = await requirePageSession();
  return <ProfileClient username={user.username} isSystemAdmin={user.role === "admin"} githubLoginAvailable={isGitHubOAuthConfigured()} githubStatus={(await searchParams).github} />;
}
