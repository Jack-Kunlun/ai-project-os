import { redirect } from "next/navigation";
import { requireAuthenticatedPageSession, type SafeSessionUser } from "@/lib/auth";

export async function requireSystemAdminPage(): Promise<SafeSessionUser> {
  const user = await requireAuthenticatedPageSession();
  if (user.role !== "admin") redirect("/dashboard");
  return user;
}

export function isSystemAdmin(user: Pick<SafeSessionUser, "role">): boolean {
  return user.role === "admin";
}
