import { requirePageSession } from "@/lib/auth";
import { isInitialSuperAdmin } from "@/lib/system-operations";
import { ProfileClient } from "./profile-client";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const user = await requirePageSession();
  const canViewSystemOperations = await isInitialSuperAdmin(user);
  return <ProfileClient username={user.username} canViewSystemOperations={canViewSystemOperations} />;
}
