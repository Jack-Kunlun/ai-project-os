import { redirect } from "next/navigation";
import { requirePageSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function MembershipsPage() {
  const user = await requirePageSession();
  redirect(user.role === "admin" ? "/admin/users/memberships" : "/dashboard");
}
