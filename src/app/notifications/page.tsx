import { requirePageSession } from "@/lib/auth";
import { NotificationsClient } from "./notifications-client";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await requirePageSession();
  return <NotificationsClient username={user.username} />;
}
