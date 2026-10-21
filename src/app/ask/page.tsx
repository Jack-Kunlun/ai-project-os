import { Suspense } from "react";
import { UiText } from "@/components/appearance-provider";
import { requirePageSession } from "@/lib/auth";
import { AskClient } from "./ask-client";

export const dynamic = "force-dynamic";

export default async function AskPage() {
  const user = await requirePageSession();
  return <Suspense fallback={<p role="status"><UiText text="正在加载智能问答…" /></p>}><AskClient username={user.username} isSystemAdmin={user.role === "admin"} /></Suspense>;
}
