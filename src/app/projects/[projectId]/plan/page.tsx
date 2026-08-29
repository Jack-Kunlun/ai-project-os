import { requirePageSession } from "@/lib/auth";
import { ProjectPlanClient } from "./project-plan-client";

export const dynamic = "force-dynamic";

export default async function ProjectPlanPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  return <ProjectPlanClient username={user.username} projectId={(await params).projectId} />;
}
