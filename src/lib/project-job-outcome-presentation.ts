type UnknownJobInput = Readonly<{
  kind: string;
  status: string;
  stage: string;
  failureCode?: string | null;
  reconciliationRequired: boolean;
}>;

export type UnknownJobPresentation = Readonly<{
  label: string;
  stageLabel: string;
  summary: string;
  recordNotice: string;
  emptyResultText: string;
  tone: "danger" | "warning";
}>;

/** Business output and the external-call audit are separate outcomes. */
export function projectJobUnknownPresentation(job: UnknownJobInput): UnknownJobPresentation | null {
  if (job.status !== "unknown") return null;

  const invalidExtraction = job.kind === "autoExtract" && job.failureCode === "AI_PROVIDER_INVALID_RESPONSE";
  const reconciled = !job.reconciliationRequired && job.stage === "reconciled_unknown";
  return {
    label: invalidExtraction ? "抽取未完成" : "结果未知",
    stageLabel: reconciled ? "任务记录已收口" : "外部调用结果未知",
    summary: invalidExtraction
      ? "模型响应未通过校验，本次资料抽取未正常完成。"
      : "外部调用的最终结果无法确认，本任务不能按已完成处理。",
    recordNotice: job.reconciliationRequired
      ? "外部调用记录仍需核对，请到项目概览的任务运行记录中处理。这是核对调用记录，不是审核任务结果；系统不会自动重试。"
      : reconciled
        ? "任务记录已人工收口，无须再确认任务状态。收口不代表任务成功或用量已结算，系统不会自动重试。"
        : "外部调用结果仍无法确认，系统不会自动重试。",
    emptyResultText: invalidExtraction
      ? "本任务没有完整的抽取结果可供确认。可能已有部分候选保存，请在项目资料中逐条核对原文；候选审核与任务状态是两回事。"
      : "本任务没有可安全确认为成功的完整结果，请先查看执行记录。",
    tone: invalidExtraction ? "danger" : "warning",
  };
}
