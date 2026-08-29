import { requirePageSession } from "@/lib/auth";
import { ProjectMemoryQualityClient } from "./project-memory-quality-client";

export const dynamic = "force-dynamic";

export default async function ProjectMemoryQualityPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  return <ProjectMemoryQualityClient username={user.username} projectId={(await params).projectId} />;
}
