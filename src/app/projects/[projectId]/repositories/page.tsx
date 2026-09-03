import { requirePageSession } from "@/lib/auth";
import { ProjectRepositoriesClient } from "./project-repositories-client";

export const dynamic = "force-dynamic";

export default async function ProjectRepositoriesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  return <ProjectRepositoriesClient username={user.username} projectId={(await params).projectId} isSystemAdmin={user.role === "admin"} />;
}
