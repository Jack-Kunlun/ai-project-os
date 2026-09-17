import { redirect } from "next/navigation";
import { requireAuthenticatedPageSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function MembershipsPage() {
  const user = await requireAuthenticatedPageSession();
  redirect(user.role === "admin" ? "/admin/users/memberships" : "/dashboard");
}
