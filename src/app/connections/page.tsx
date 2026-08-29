import { requirePageSession } from "@/lib/auth";
import { ConnectionsClient } from "./connections-client";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const user = await requirePageSession();
  return <ConnectionsClient username={user.username} />;
}
