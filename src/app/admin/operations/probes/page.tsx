import { redirect } from "next/navigation";
import { requireSystemAdminPage } from "@/lib/system-admin";

export default async function LegacyModelTestBudgetPage() {
  await requireSystemAdminPage();
  redirect("/admin/models");
}
