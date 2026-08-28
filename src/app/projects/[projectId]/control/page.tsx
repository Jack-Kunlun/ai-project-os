import { requirePageSession } from "@/lib/auth";
import { ProjectControlClient } from "./project-control-client";

export const dynamic = "force-dynamic";

export default async function ProjectControlPage() {
  await requirePageSession();
  return <ProjectControlClient />;
}

