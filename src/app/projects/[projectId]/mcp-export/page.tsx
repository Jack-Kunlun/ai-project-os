import { AppHeader } from "@/components/app-header";
import { notFound } from "next/navigation";
import { ProjectOverviewParentLink } from "@/components/project-parent-link";
import { requirePageSession } from "@/lib/auth";
import { AccessControlError, assertProjectAccess } from "@/lib/access-control";
import { isMcpExportEnabled } from "@/lib/mcp-export-grants";
import { isMcpExportLegacyBearerEnabled } from "@/lib/mcp-export-oauth-config";
import { McpExportClient } from "./mcp-export-client";

export const dynamic = "force-dynamic";

export default async function ProjectMcpExportPage({ params }: { params: Promise<{ projectId: string }> }) {
  if (!isMcpExportEnabled()) notFound();
  const user = await requirePageSession();
  const { projectId } = await params;
  try {
    await assertProjectAccess(user, projectId, "owner");
  } catch (error) {
    if (error instanceof AccessControlError) notFound();
    throw error;
  }
  return <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
    <AppHeader username={user.username} active="projects" projectId={projectId} projectSection="tools" isSystemAdmin={user.role === "admin"} />
    <div className="mx-auto max-w-4xl px-5 py-7 sm:px-8 lg:px-10">
      <ProjectOverviewParentLink projectId={projectId} />
      <McpExportClient projectId={projectId} legacyBearerEnabled={isMcpExportLegacyBearerEnabled()} />
    </div>
  </main>;
}
