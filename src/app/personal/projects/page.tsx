import { requirePageSession } from "@/lib/auth";
import { ProjectsClient } from "@/app/projects/projects-client";

export const dynamic = "force-dynamic";

export default async function PersonalProjectsPage() {
  const user = await requirePageSession();
  return <ProjectsClient username={user.username} isSystemAdmin={user.role === "admin"} />;
}
