import Link from "next/link";
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
  const steps = [
    { label: "项目资料", route: "materials" as const, state: { from }, active: stage === "materials" },
    { label: "整理结果", route: "materials" as const, state: { view: "review", from }, active: stage === "review" },
    { label: "智能问答", route: "materials" as const, state: { view: "ask", from }, active: stage === "memory" },
    { label: "安排任务", route: "plan" as const, state: { from }, active: stage === "plan" },
  ];
  const next = projectFlowNextStep({ stage, sourceCount, pendingCount, confirmedCount, indexReady, archived });
  return <section aria-label="项目使用流程" className="my-6 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4 sm:p-5">
    <nav aria-label="项目操作步骤"><ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">{steps.map((step) => <li key={step.label}>
      <Link href={step.state.view === "ask" ? questionHref : buildProjectHref(projectId, step.route, step.state)} aria-current={step.active ? "page" : undefined} className={`flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-indigo-500 ${step.active ? "bg-indigo-600 text-white" : "bg-white text-slate-700 hover:bg-indigo-100"}`}>{step.label}</Link>
    </li>)}</ol></nav>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-3xl text-sm leading-6 text-slate-600">{archived ? "项目已归档，可查看已有资料和记录。" : "先放资料，再核对整理结果。提问和安排任务都从这里继续。"}</p>
      <Link href={next.state.view === "ask" ? questionHref : buildProjectHref(projectId, next.route, { ...next.state, from })} className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 py-2 text-sm font-semibold text-indigo-700 underline underline-offset-4">{next.label} →</Link>
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
  return { label: "打开智能问答", route: "materials" as const, state: { view: "ask" }, detail: "直接输入问题，发送前确认本次资料范围。" };
}
