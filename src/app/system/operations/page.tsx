import { notFound, redirect } from "next/navigation";
import { requireAuthenticatedPageSession } from "@/lib/auth";
import {
  isInitialSuperAdmin,
} from "@/lib/system-operations";

export const dynamic = "force-dynamic";

export default async function SystemOperationsPage() {
  const user = await requireAuthenticatedPageSession();
  if (user.role !== "admin") redirect("/dashboard");
  if (!(await isInitialSuperAdmin(user))) notFound();
  redirect("/admin/operations/backups");
}
