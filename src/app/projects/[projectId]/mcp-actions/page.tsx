import { notFound } from "next/navigation";
import { requirePageSession } from "@/lib/auth";
import { AccessControlError, assertProjectAccess } from "@/lib/access-control";
import { getDb } from "@/lib/db";
import { isProjectMcpActionApiEnabled } from "@/lib/project-mcp-action-api-gate";
import { ProjectMcpActionsClient } from "./mcp-actions-client";

export const dynamic = "force-dynamic";

export default async function ProjectMcpActionsPage({ params }: { params: Promise<{ projectId: string }> }) {
  if (!isProjectMcpActionApiEnabled()) notFound();
  const user = await requirePageSession();
  const { projectId } = await params;
  try {
    await assertProjectAccess(user, projectId, "view");
  } catch (error) {
    if (error instanceof AccessControlError) notFound();
    throw error;
  }
  const ownerMembership = await getDb().projectMembership.count({
    where: { projectId, userId: user.id, role: "owner", accessState: "confirmed" },
  });
  if (ownerMembership === 0) notFound();
  return <ProjectMcpActionsClient username={user.username} projectId={projectId} isSystemAdmin={user.role === "admin"} />;
}
