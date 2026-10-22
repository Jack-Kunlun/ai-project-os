import { UiText } from "@/components/appearance-provider";
import { Suspense } from "react";
import { requirePageSession } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";
import { ProjectMaterialReviewQueue } from "../../project-material-review-queue";

export const dynamic = "force-dynamic";

function ReviewLoading() {
  return <div className="mt-10 h-96 animate-pulse rounded-3xl bg-slate-100" role="status" aria-labelledby="candidate-review-loading-label"><span id="candidate-review-loading-label" className="sr-only"><UiText text="正在加载 AI 候选审核工作区" /></span></div>;
}

export default async function ProjectMaterialReviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  const { projectId } = await params;
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={user.username} active="projects" projectId={projectId} projectSection="materials" isSystemAdmin={user.role === "admin"} />
      <div data-page-content className="mx-auto max-w-6xl px-6 pb-16 pt-8 sm:px-10 lg:px-12">
        <ProjectMaterialsParentLink projectId={projectId} />
        <section className="mt-8 border-b border-slate-200/80 pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600"><UiText text={"AI candidate review"} /></p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-slate-950"><UiText text={"审核 AI 候选"} /></h1>
          <p className="mt-3 max-w-3xl text-base leading-7 text-slate-600"><UiText text={"在独立工作区处理冲突、改写或不确定内容。有充分原文证据的普通结果已自动形成事实；这里保留人工核对与纠错入口。"} /></p>
        </section>
        <Suspense fallback={<ReviewLoading />}>
          <ProjectMaterialReviewQueue projectId={projectId} />
        </Suspense>
      </div>
    </main>
  );
}
