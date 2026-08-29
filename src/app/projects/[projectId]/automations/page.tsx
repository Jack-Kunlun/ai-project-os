import { requirePageSession } from "@/lib/auth";
import { ProjectAutomationsClient } from "./project-automations-client";

export const dynamic = "force-dynamic";

export default async function ProjectAutomationsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  return <ProjectAutomationsClient username={user.username} projectId={(await params).projectId} />;
}
