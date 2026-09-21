import { redirect } from "next/navigation";
import { requirePageSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Keep bookmarked profile URLs safe while the resource owner surface moves. */
export default async function LegacyPersonalModelsPage(): Promise<never> {
  await requirePageSession();
  redirect("/personal/models");
}
