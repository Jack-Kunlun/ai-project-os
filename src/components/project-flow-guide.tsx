import Link from "next/link";
import { UiText } from "./appearance-provider";
import { buildProjectHref, type ProjectNavigationSource } from "@/lib/project-navigation";

type FlowStage = "materials" | "review" | "memory" | "overview" | "plan";

/** Navigation only: opening a step never saves content or calls a model. */
export function ProjectFlowGuide({ projectId, stage, sourceCount, pendingCount, confirmedCount, indexReady, archived = false }: {
  projectId: string;
  stage: FlowStage;
  sourceCount?: number;
  pendingCount?: number;
  confirmedCount?: number;
  indexReady?: boolean;
  archived?: boolean;
}) {
  const from: ProjectNavigationSource = stage === "review" ? "materials" : stage === "memory" ? "intelligence" : stage;
  const questionHref = `/ask?scope=project&projectId=${encodeURIComponent(projectId)}`;
  const next = projectFlowNextStep({ stage, sourceCount, pendingCount, confirmedCount, indexReady, archived });
  const nextLabel = next.label.startsWith("核对待处理项（") ? <><UiText text="核对待处理项" /> ({pendingCount})</> : <UiText text={next.label} />;
  return <section aria-labelledby="project-flow-title" className="my-5 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-3xl"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500"><UiText text="下一步" /></p><h2 id="project-flow-title" className="mt-1 text-sm font-semibold text-slate-900"><UiText text="项目使用流程" /></h2><p className="mt-1 text-sm leading-6 text-slate-600"><UiText text={next.detail} /></p></div>
      <Link href={next.state.view === "ask" ? questionHref : buildProjectHref(projectId, next.route, { ...next.state, from })} className="inline-flex min-h-10 shrink-0 items-center rounded-lg px-3 py-2 text-sm font-semibold text-indigo-700 underline underline-offset-4">{nextLabel} →</Link>
    </div>
  </section>;
}

export function projectFlowNextStep(input: { stage: FlowStage; sourceCount?: number; pendingCount?: number; confirmedCount?: number; indexReady?: boolean; archived?: boolean }) {
  if (input.archived) return { label: "查看项目现状", route: "overview" as const, state: {}, detail: "项目已归档，当前只读。可查看已有资料、事实和计划。" };
  if (input.sourceCount === 0 && input.indexReady !== true) return { label: "查看项目资料", route: "materials" as const, state: {}, detail: "从一份需求文档或会议记录开始。" };
  if ((input.pendingCount ?? 0) > 0) return { label: `核对待处理项（${input.pendingCount}）`, route: "materials" as const, state: { view: "review", status: "candidate", focus: "items-heading" }, detail: "核对原文后决定保留或驳回。" };
  if (input.stage === "review" || (input.stage === "materials" && (input.confirmedCount ?? 0) > 0)) return { label: "打开智能问答", route: "materials" as const, state: { view: "ask" }, detail: "直接输入问题，系统会引导准备资料。" };
  if (input.stage === "materials") return { label: "查看整理结果", route: "materials" as const, state: { view: "review" }, detail: "整理结果和待核对内容放在同一处。" };
  if (input.stage === "plan") return { label: "查看项目进展", route: "overview" as const, state: { focus: "current-state" }, detail: "手动创建工作项、指定负责人和验收标准；完成时关联证据。项目事实不会自动变成任务。" };
  return { label: "打开智能问答", route: "materials" as const, state: { view: "ask" }, detail: "在输入框核对模型与资料范围，点击发送即授权本轮。" };
}
