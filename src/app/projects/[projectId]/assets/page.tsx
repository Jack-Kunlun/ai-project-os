import { requirePageSession } from "@/lib/auth";
import { ProjectAssetsClient } from "./project-assets-client";

export const dynamic = "force-dynamic";

export default async function ProjectAssetsPage() {
  const user = await requirePageSession();
  return <ProjectAssetsClient username={user.username} />;
}
