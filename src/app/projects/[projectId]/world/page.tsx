import { requirePageSession } from "@/lib/auth";
import { ProjectWorldClient } from "./project-world-client";

export const dynamic = "force-dynamic";

export default async function ProjectWorldPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  return <ProjectWorldClient username={user.username} projectId={(await params).projectId} />;
}
