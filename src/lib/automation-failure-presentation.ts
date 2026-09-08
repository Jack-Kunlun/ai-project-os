export type AutomationFailurePresentation = Readonly<{
  code: string | null;
  title: string;
  reason: string;
  nextStep: string;
}>;

const FAILURE_PRESENTATIONS: Record<string, Omit<AutomationFailurePresentation, "code">> = {
  AUTOMATION_REPOSITORY_SYNC_FROZEN: {
    title: "代码仓库自动化尚未开放",
    reason: "历史规则已被安全暂停，系统没有读取 Git 凭据，也没有发起网络请求。",
    nextStep: "如需读取仓库，请前往项目仓库页发起一次受限的手动只读操作。",
  },
  AUTOMATION_WEB_SOURCE_PARTIAL_FAILURE: {
    title: "部分网页来源刷新失败",
    reason: "本次刷新有来源未完成，因此整次自动化已标记为失败；已保留成功和失败数量。",
    nextStep: "检查失败来源的安全域名、网络状态或来源配置后，再手动运行。",
  },
  AUTOMATION_LEASE_EXPIRED: {
    title: "Worker 租约已过期",
    reason: "执行 Worker 未能在租约内完成，系统已安全标记本次运行失败。",
    nextStep: "确认 Worker 状态正常；连续失败达到三次时规则会保持暂停。",
  },
  AUTOMATION_EXECUTION_FAILED: {
    title: "自动化执行失败",
    reason: "执行未完成，系统只保留稳定错误码，不展示外部服务的敏感细节。",
    nextStep: "根据错误码修复配置或来源后，再手动运行。",
  },
};

export function automationFailurePresentation(code: string | null | undefined): AutomationFailurePresentation {
  const normalized = code === undefined || code === null || code.length === 0 ? null : code;
  const presentation = normalized === null ? null : FAILURE_PRESENTATIONS[normalized];
  return Object.freeze({
    code: normalized,
    ...(presentation ?? FAILURE_PRESENTATIONS.AUTOMATION_EXECUTION_FAILED!),
  });
}
