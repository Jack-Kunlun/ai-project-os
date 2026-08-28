import { requirePageSession } from "@/lib/auth";
import { ProjectDetailClient } from "./project-client";

export default async function ProjectDetailPage() {
  const user = await requirePageSession();
  return <ProjectDetailClient username={user.username} />;
}
