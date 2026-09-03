import { requirePageSession } from "@/lib/auth";
import { DashboardClient } from "./dashboard-client";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requirePageSession();
  return <DashboardClient username={user.username} isSystemAdmin={user.role === "admin"} />;
}
