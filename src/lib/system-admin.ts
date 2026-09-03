import { redirect } from "next/navigation";
import { requirePageSession, type SafeSessionUser } from "@/lib/auth";

export async function requireSystemAdminPage(): Promise<SafeSessionUser> {
  const user = await requirePageSession();
  if (user.role !== "admin") redirect("/dashboard");
  return user;
}

export function isSystemAdmin(user: Pick<SafeSessionUser, "role">): boolean {
  return user.role === "admin";
}
