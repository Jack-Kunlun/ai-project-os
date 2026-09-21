import { requirePageSession } from "@/lib/auth";
import { KnowledgeClient } from "./knowledge-client";

export const dynamic = "force-dynamic";

/**
 * Protect the personal workspace entry point on the server. The shared page
 * guard redirects platform administrators to their separate admin surface.
 */
export default async function PersonalKnowledgePage() {
  const user = await requirePageSession();
  return <KnowledgeClient username={user.username} isSystemAdmin={user.role === "admin"} />;
}
