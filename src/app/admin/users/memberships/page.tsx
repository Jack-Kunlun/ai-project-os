import { redirect } from "next/navigation";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function AdminMembershipsPage() {
  await requireSystemAdminPage();
  redirect("/admin/users");
}
