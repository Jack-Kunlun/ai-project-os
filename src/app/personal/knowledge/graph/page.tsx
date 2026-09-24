import { requirePageSession } from "@/lib/auth";
import { PersonalKnowledgeGraphClient } from "./personal-knowledge-graph-client";

export const dynamic = "force-dynamic";

export default async function PersonalKnowledgeGraphPage() {
  const user = await requirePageSession();
  return <PersonalKnowledgeGraphClient username={user.username} isSystemAdmin={user.role === "admin"} />;
}
