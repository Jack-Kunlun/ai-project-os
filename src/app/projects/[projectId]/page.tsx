import { requirePageSession } from "@/lib/auth";
import { ProjectOverviewClient } from "./project-overview-client";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage() {
  const user = await requirePageSession();
  return <ProjectOverviewClient username={user.username} />;
}
