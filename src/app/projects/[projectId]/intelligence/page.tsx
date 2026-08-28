import { requirePageSession } from "@/lib/auth";
import { ProjectIntelligenceClient } from "./project-intelligence-client";

export const dynamic = "force-dynamic";

export default async function ProjectIntelligencePage() {
  const user = await requirePageSession();
  return <ProjectIntelligenceClient username={user.username} />;
}
