import { requirePageSession } from "@/lib/auth";
import { ProjectSourceDetailClient } from "./source-detail-client";

export const dynamic = "force-dynamic";

export default async function ProjectSourceDetailPage() {
  const user = await requirePageSession();
  return <ProjectSourceDetailClient username={user.username} />;
}
