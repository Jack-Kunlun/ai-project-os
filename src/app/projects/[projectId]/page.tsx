import { requirePageSession } from "@/lib/auth";
import { ProjectDetailClient } from "./project-client";

export default async function ProjectDetailPage() {
  await requirePageSession();
  return <ProjectDetailClient />;
}
