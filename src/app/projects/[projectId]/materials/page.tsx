import { Suspense } from "react";
import { requirePageSession } from "@/lib/auth";
import { ProjectDetailClient } from "../project-client";

export const dynamic = "force-dynamic";

export default async function ProjectMaterialsPage() {
  const user = await requirePageSession();
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f5f7fb] p-8"><div className="mx-auto h-64 max-w-6xl animate-pulse rounded-3xl bg-slate-100" aria-label="正在加载项目资料" /></div>}>
      <ProjectDetailClient username={user.username} />
    </Suspense>
  );
}
