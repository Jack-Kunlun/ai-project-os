import { requirePageSession } from "@/lib/auth";
import { ProjectActionsClient } from "./project-actions-client";

export const dynamic = "force-dynamic";

export default async function ProjectActionsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  return <ProjectActionsClient username={user.username} projectId={(await params).projectId} />;
}
