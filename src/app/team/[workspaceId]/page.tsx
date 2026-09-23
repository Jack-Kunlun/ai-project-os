import { requirePageSession } from "@/lib/auth";
import { WorkspaceTeamClient } from "../team-client";

export const dynamic = "force-dynamic";

export default async function WorkspaceTeamPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const user = await requirePageSession();
  const { workspaceId } = await params;
  return <WorkspaceTeamClient workspaceId={workspaceId} username={user.username} currentUserId={user.id} isSystemAdmin={user.role === "admin"} />;
}
