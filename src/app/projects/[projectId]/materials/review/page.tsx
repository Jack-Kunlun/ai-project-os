import { Suspense } from "react";
import { requirePageSession } from "@/lib/auth";
import { AppHeader } from "@/components/app-header";
import { ProjectMaterialsParentLink } from "@/components/project-parent-link";
import { ProjectMaterialReviewQueue } from "../../project-material-review-queue";

export const dynamic = "force-dynamic";

function ReviewLoading() {
  return <div className="mt-10 h-96 animate-pulse rounded-3xl bg-slate-100" aria-label="正在加载 AI 候选审核工作区" />;
}

export default async function ProjectMaterialReviewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requirePageSession();
  const { projectId } = await params;
  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-950">
      <AppHeader username={user.username} active="projects" projectId={projectId} projectSection="materials" />
      <div className="mx-auto max-w-6xl px-6 pb-16 pt-8 sm:px-10 lg:px-12">
        <ProjectMaterialsParentLink projectId={projectId} />
        <section className="mt-8 border-b border-slate-200/80 pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">AI candidate review</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em] text-slate-950">审核 AI 候选</h1>
          <p className="mt-3 max-w-3xl text-base leading-7 text-slate-600">在独立工作区核对原始资料证据。确认后只进入已确认事实，后续是否进入 AI 可引用记忆由记忆流程和索引状态决定。</p>
        </section>
        <Suspense fallback={<ReviewLoading />}>
          <ProjectMaterialReviewQueue projectId={projectId} />
        </Suspense>
      </div>
    </main>
  );
}
