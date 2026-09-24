import { requirePageSession } from "@/lib/auth";
import { ProjectMembersClient } from "./project-members-client";

export const dynamic = "force-dynamic";

export default async function ProjectMembersPage({ params }: { params: Promise<{ projectId: string }> }) {
  const [user, { projectId }] = await Promise.all([requirePageSession(), params]);
  return <ProjectMembersClient projectId={projectId} username={user.username} isSystemAdmin={user.role === "admin"} />;
}
