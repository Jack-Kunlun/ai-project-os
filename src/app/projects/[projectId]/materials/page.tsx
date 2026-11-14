import { Suspense } from "react";
import { UiText } from "@/components/appearance-provider";
import { requirePageSession } from "@/lib/auth";
import { ProjectDetailClient } from "../project-client";

export const dynamic = "force-dynamic";

export default async function ProjectMaterialsPage() {
  const user = await requirePageSession();
  return (
    <Suspense fallback={<div className="min-h-screen bg-app-surface p-8"><div className="mx-auto h-64 max-w-6xl animate-pulse rounded-field bg-app-surface-soft app-feedback-info" role="status" aria-labelledby="project-materials-loading-label"><span id="project-materials-loading-label" className="sr-only"><UiText text="正在加载项目资料" /></span></div></div>}>
      <ProjectDetailClient username={user.username} isSystemAdmin={user.role === "admin"} />
    </Suspense>
  );
}
