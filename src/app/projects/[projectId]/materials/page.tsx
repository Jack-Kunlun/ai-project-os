import { requirePageSession } from "@/lib/auth";
import { ProjectDetailClient } from "../project-client";

export const dynamic = "force-dynamic";

export default async function ProjectMaterialsPage() {
  const user = await requirePageSession();
  return <ProjectDetailClient username={user.username} />;
}
