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
  const steps = [
    { label: "添加资料", route: "materials" as const, state: { view: archived ? null : "add", kind: "manual", from }, active: stage === "materials" },
    { label: "整理与核对", route: "memory" as const, state: { focus: "memory-extract", from }, active: stage === "review" },
    { label: "检索与问答", route: "memory" as const, state: { focus: indexReady ? "memory-query" : "memory-index", from }, active: stage === "memory" },
    { label: "安排任务", route: "plan" as const, state: { from }, active: stage === "plan" },
  ];
  const next = projectFlowNextStep({ stage, sourceCount, pendingCount, confirmedCount, indexReady, archived });
  return <section aria-label="项目使用流程" className="my-6 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4 sm:p-5">
    <nav aria-label="项目操作步骤"><ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">{steps.map((step, index) => <li key={step.label}>
      <Link href={buildProjectHref(projectId, step.route, step.state)} aria-current={step.active ? "step" : undefined} className={`flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-indigo-500 ${step.active ? "bg-indigo-600 text-white" : "bg-white text-slate-700 hover:bg-indigo-100"}`}><span aria-hidden="true">{index + 1}.</span>{step.label}</Link>
    </li>)}</ol></nav>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-3xl text-sm leading-6 text-slate-600">{next.detail}</p>
      <Link href={buildProjectHref(projectId, next.route, { ...next.state, from })} className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 py-2 text-sm font-semibold text-indigo-700 underline underline-offset-4">{next.label} →</Link>
    </div>
  </section>;
}

export function projectFlowNextStep(input: { stage: FlowStage; sourceCount?: number; pendingCount?: number; confirmedCount?: number; indexReady?: boolean; archived?: boolean }) {
  if (input.archived) return { label: "查看项目现状", route: "overview" as const, state: {}, detail: "项目已归档，当前只读。可查看已有资料、事实和计划。" };
  if (input.sourceCount === 0 && input.indexReady !== true) return { label: "添加第一份资料", route: "materials" as const, state: { view: "add", kind: "manual" }, detail: "从一份需求文档或会议记录开始。保存并解析后，在导入窗口继续 AI 整理。" };
  if ((input.pendingCount ?? 0) > 0) return { label: "核对待处理项", route: "materials" as const, state: { status: "candidate", focus: "items-heading" }, detail: `还有 ${input.pendingCount} 条待确认内容。核对原文后决定保留或驳回。` };
  if (input.stage === "review" || (input.stage === "materials" && (input.confirmedCount ?? 0) > 0)) return { label: "更新索引并问答", route: "memory" as const, state: { focus: "memory-index" }, detail: "查看事实后，可单独确认更新问答索引，再向项目提问；需要落实的工作仍由你创建任务。" };
  if (input.stage === "materials") return { label: "继续整理已有资料", route: "memory" as const, state: { focus: "memory-extract" }, detail: "新资料在导入窗口继续整理；以前保存的资料可打开详情继续整理。整理结果与问答索引分别更新。" };
  if (input.stage === "plan") return { label: "查看项目进展", route: "overview" as const, state: { focus: "current-state" }, detail: "手动创建工作项、指定负责人和验收标准；完成时关联证据。项目事实不会自动变成任务。" };
  if (input.indexReady === false) return { label: "建立或更新索引", route: "memory" as const, state: { focus: "memory-index" }, detail: "想向项目提问，先确认本次范围并更新索引。完成后可在同一页直接提问。" };
  return { label: "向项目提问", route: "memory" as const, state: { focus: "memory-query" }, detail: "查资料去检索与问答，推进工作去安排任务。每次 AI 发送仍需核对并确认。" };
}
