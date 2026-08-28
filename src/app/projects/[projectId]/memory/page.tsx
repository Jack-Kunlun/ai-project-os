import { requirePageSession } from "@/lib/auth";
import { ProjectMemoryClient } from "./project-memory-client";

export const dynamic = "force-dynamic";

export default async function ProjectMemoryPage() {
  const user = await requirePageSession();
  return <ProjectMemoryClient username={user.username} />;
}
