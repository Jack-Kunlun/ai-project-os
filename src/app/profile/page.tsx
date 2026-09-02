import { requirePageSession } from "@/lib/auth";
import { isInitialSuperAdmin } from "@/lib/system-operations";
import { ProfileClient } from "./profile-client";
import { isGitHubOAuthConfigured } from "@/lib/github-oauth";

export const dynamic = "force-dynamic";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ github?: string }> }) {
  const user = await requirePageSession();
  const canViewSystemOperations = await isInitialSuperAdmin(user);
  return <ProfileClient username={user.username} canViewSystemOperations={canViewSystemOperations} githubLoginAvailable={isGitHubOAuthConfigured()} githubStatus={(await searchParams).github} />;
}
