import { redirect } from "next/navigation";
import { requirePageSession } from "@/lib/auth";
import { MembershipsClient } from "./memberships-client";

export const dynamic = "force-dynamic";

export default async function MembershipsPage() {
  const user = await requirePageSession();
  if (user.role !== "admin") redirect("/profile");
  return <MembershipsClient username={user.username} />;
}
