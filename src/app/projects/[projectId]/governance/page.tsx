import { requirePageSession } from "@/lib/auth";
import { ProjectGovernanceClient } from "./project-governance-client";

export const dynamic = "force-dynamic";

export default async function ProjectGovernancePage() {
  const user = await requirePageSession();
  return <ProjectGovernanceClient username={user.username} />;
}
