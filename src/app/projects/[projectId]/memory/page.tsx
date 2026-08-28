import { requirePageSession } from "@/lib/auth";
import { ProjectMemoryClient } from "./project-memory-client";

export const dynamic = "force-dynamic";

export default async function ProjectMemoryPage() {
  await requirePageSession();
  return <ProjectMemoryClient />;
}

