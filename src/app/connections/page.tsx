import { redirect } from "next/navigation";
import { requirePageSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  await requirePageSession();
  redirect("/profile/connections/git");
}
