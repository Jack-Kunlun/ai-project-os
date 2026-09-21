import { requirePageSession } from "@/lib/auth";
import { ProjectConfigurationClient } from "./project-configuration-client";

export const dynamic = "force-dynamic";

export default async function ProjectConfigurationPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  const { projectId } = await params;
  return <ProjectConfigurationClient username={user.username} projectId={projectId} isSystemAdmin={user.role === "admin"} />;
}
