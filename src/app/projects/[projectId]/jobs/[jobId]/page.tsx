import { requirePageSession } from "@/lib/auth";
import { ProjectJobDetailClient } from "./project-job-detail-client";

export const dynamic = "force-dynamic";

export default async function ProjectJobDetailPage() {
  const user = await requirePageSession();
  return <ProjectJobDetailClient username={user.username} />;
}
