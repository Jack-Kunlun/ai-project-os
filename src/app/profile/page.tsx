import { requirePageSession } from "@/lib/auth";
import { ProfileClient } from "./profile-client";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const user = await requirePageSession();
  return <ProfileClient username={user.username} />;
}
