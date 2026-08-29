import { requirePageSession } from "@/lib/auth";
import { ProjectExternalSourcesClient } from "./project-external-sources-client";

export const dynamic = "force-dynamic";

export default async function ProjectExternalSourcesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  return <ProjectExternalSourcesClient username={user.username} projectId={(await params).projectId} />;
}
