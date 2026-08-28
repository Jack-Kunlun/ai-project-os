import { requirePageSession } from "@/lib/auth";
import { ProjectsClient } from "./projects-client";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const user = await requirePageSession();
  return <ProjectsClient username={user.username} />;
}
