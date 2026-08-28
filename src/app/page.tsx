import { redirect } from "next/navigation";
import { requirePageSession } from "@/lib/auth";

export default async function HomePage() {
  await requirePageSession();
  redirect("/dashboard");
}
