import { redirect } from "next/navigation";
import { requireAuthenticatedPageSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireAuthenticatedPageSession();
  redirect(user.role === "admin" ? "/admin/models" : "/dashboard");
}
