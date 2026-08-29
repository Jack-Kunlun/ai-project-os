import { requirePageSession } from "@/lib/auth";
import { ProjectToolsClient } from "./project-tools-client";

export const dynamic = "force-dynamic";

export default async function ProjectToolsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  return <ProjectToolsClient username={user.username} projectId={(await params).projectId} />;
}
