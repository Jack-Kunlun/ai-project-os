import { requirePageSession } from "@/lib/auth";
import { AccessControlError, assertProjectAccess } from "@/lib/access-control";
import { getDb } from "@/lib/db";
import { notFound } from "next/navigation";
import { isMcpExportEnabled } from "@/lib/mcp-export-grants";
import { isProjectMcpActionApiEnabled } from "@/lib/project-mcp-action-api-gate";
import { ProjectToolsClient } from "./project-tools-client";

export const dynamic = "force-dynamic";

export default async function ProjectToolsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  const projectId = (await params).projectId;
  try {
    await assertProjectAccess(user, projectId, "view");
  } catch (error) {
    if (error instanceof AccessControlError) notFound();
    throw error;
  }
  const directOwner = await getDb().projectMembership.count({
    where: { projectId, userId: user.id, role: "owner", accessState: "confirmed" },
  });
  return <ProjectToolsClient username={user.username} projectId={projectId} isSystemAdmin={user.role === "admin"} mcpExportEnabled={isMcpExportEnabled() && directOwner > 0} mcpActionsEnabled={isProjectMcpActionApiEnabled() && directOwner > 0} />;
}
