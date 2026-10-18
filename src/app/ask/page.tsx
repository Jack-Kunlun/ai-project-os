import { Suspense } from "react";
import { requirePageSession } from "@/lib/auth";
import { AskClient } from "./ask-client";

export const dynamic = "force-dynamic";

export default async function AskPage() {
  const user = await requirePageSession();
  return <Suspense fallback={<p role="status">正在加载智能问答…</p>}><AskClient username={user.username} isSystemAdmin={user.role === "admin"} /></Suspense>;
}
