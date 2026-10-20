import { AppHeader } from "@/components/app-header";
import { requirePageSession } from "@/lib/auth";
import { UsageClient } from "./usage-client";

export const dynamic = "force-dynamic";

export default async function PersonalUsagePage() {
  const user = await requirePageSession();
  const today = new Date();
  const initialTo = today.toISOString().slice(0, 10);
  const initialFrom = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  return (
    <main className="min-h-screen bg-[var(--app-bg)] text-[var(--app-text)]">
      <AppHeader username={user.username} active="profile" isSystemAdmin={user.role === "admin"} />
      <UsageClient initialFrom={initialFrom} initialTo={initialTo} />
    </main>
  );
}
