import { requirePageSession } from "@/lib/auth";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requirePageSession();
  return <SettingsClient username={user.username} />;
}

