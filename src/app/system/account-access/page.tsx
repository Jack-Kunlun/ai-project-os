import { redirect } from "next/navigation";
import { requireSystemAdminPage } from "@/lib/system-admin";

export const dynamic = "force-dynamic";

export default async function AccountAccessPage() {
  await requireSystemAdminPage();
  redirect("/admin/users");
}
