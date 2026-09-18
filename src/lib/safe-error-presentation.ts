export type SafeErrorPresentation = Readonly<{
  code: string | null;
  summary: string;
  nextStep: string;
  message: string;
}>;

const EXACT_PRESENTATIONS: Readonly<Record<string, Readonly<{ summary: string; nextStep: string }>>> = Object.freeze({
  ACCESS_FORBIDDEN: { summary: "当前账号没有执行此操作的权限。", nextStep: "返回项目并请项目 Owner 或管理员核对你的访问权限。" },
  ACCOUNT_DISABLED: { summary: "当前账号已停用，不能继续操作。", nextStep: "联系管理员恢复账号后重新登录。" },
  PROJECT_NOT_FOUND: { summary: "未找到该项目，或你已不能访问它。", nextStep: "返回项目列表，确认项目仍存在且你仍有权限。" },
  ACCESS_PROJECT_NOT_FOUND: { summary: "未找到该项目，或你已不能访问它。", nextStep: "返回项目列表，确认项目仍存在且你仍有权限。" },
  INVALID_JSON: { summary: "提交内容格式无效。", nextStep: "刷新页面后重新填写并提交。" },
  REQUEST_BODY_TOO_LARGE: { summary: "提交内容超过允许大小。", nextStep: "缩小本次提交内容后重试。" },
  WEB_AI_CONFIRMATION_EXPIRED: { summary: "本次外发确认已过期。", nextStep: "重新读取外发摘要并再次确认。" },
  WEB_AI_CONFIRMATION_STALE: { summary: "项目资料、索引或模型路由已变化。", nextStep: "重新读取最新外发摘要并再次确认。" },
  WEB_AI_CONFIRMATION_CONSUMED: { summary: "本次外发确认已经使用。", nextStep: "重新读取外发摘要并创建新的确认。" },
  WEB_AI_CONFIRMATION_REQUIRED: { summary: "本次操作还没有有效的外发确认。", nextStep: "先读取外发摘要，再确认并执行。" },
  PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED: { summary: "尚未启用平台连接测试额度。", nextStep: "先创建测试预算周期，再验证供应商连接。" },
  PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED: { summary: "平台连接测试额度不足。", nextStep: "创建新的测试预算周期后再验证供应商连接。" },
  PLATFORM_PROVIDER_PROBE_PROVIDER_AUTH_FAILED: { summary: "供应商凭据无效或权限不足。", nextStep: "检查 API Key 是否有效，重新保存后再测试。" },
  PLATFORM_PROVIDER_PROBE_PROVIDER_REJECTED: { summary: "供应商拒绝了当前探测请求。", nextStep: "检查模型 ID 与能力配置，修正后再测试。" },
  PLATFORM_PROVIDER_PROBE_PROVIDER_INVALID_RESPONSE: { summary: "供应商响应无法验证。", nextStep: "检查模型 ID 和协议；DeepSeek 探测会关闭思考模式后重试。" },
  PLATFORM_PROVIDER_PROBE_PROVIDER_TIMEOUT: { summary: "供应商响应超时。", nextStep: "检查网络或供应商状态，稍后再试。" },
  PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE: { summary: "供应商当前不可用。", nextStep: "检查供应商状态和连接配置后再试。" },
});

const SAFE_PRESENTATION_CODES = new Set([
  ...Object.keys(EXACT_PRESENTATIONS),
  "AI_CANDIDATE_INVALID_INPUT",
  "ASSET_FILE_REQUIRED",
  "ASSET_UPLOAD_CONTENT_TYPE_INVALID",
  "ASSET_UPLOAD_INVALID",
  "ASSET_UPLOAD_ONE_FILE_ONLY",
  "ASSET_UPLOAD_REQUEST_TOO_LARGE",
  "ASSET_UPLOAD_TIMEOUT",
  "ASSET_UPLOAD_TOO_MANY_FILES",
  "AUTH_REQUIRED",
  "INVALID_QUERY",
  "ITEM_EVIDENCE_INVALID",
  "ITEM_INVALID_TRANSITION",
  "ITEM_NOT_FOUND",
  "ITEM_VERSION_CONFLICT",
  "PROJECT_PLAN_WRITE_CONFLICT",
  "SNAPSHOT_DATA_INVALID",
  "SNAPSHOT_GENERATION_CONFLICT",
  "SNAPSHOT_GENERATION_IN_PROGRESS",
  "SOURCE_CONTENT_DUPLICATE",
  "SOURCE_EXCERPT_MISMATCH",
  "SOURCE_IN_USE",
  "SOURCE_NOT_FOUND",
  "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED",
  "PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_AUTH_FAILED",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_REJECTED",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_INVALID_RESPONSE",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_TIMEOUT",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_RATE_LIMITED",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_RESPONSE_TOO_LARGE",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_EMBEDDING_UNSUPPORTED",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_VISION_UNSUPPORTED",
  "PLATFORM_PROVIDER_PROBE_RECONCILIATION_REQUIRED",
  "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD",
  "PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH",
]);

function normalizedCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_PRESENTATION_CODES.has(value) ? value : null;
}

function presentationForCode(code: string | null, fallback: string): Readonly<{ summary: string; nextStep: string }> {
  if (code === null) return { summary: fallback, nextStep: "刷新页面后重试；如果问题持续，请记录发生时间并联系管理员。" };
  const exact = EXACT_PRESENTATIONS[code];
  if (exact !== undefined) return exact;
  if (code.endsWith("_NOT_FOUND")) return { summary: "目标记录不存在，或当前账号已不能访问。", nextStep: "返回上一级并刷新列表后重新选择。" };
  if (code.includes("STALE") || code.includes("CONFLICT") || code.includes("WRITE_CONFLICT")) return { summary: "页面状态已变化，本次操作未应用。", nextStep: "刷新最新状态，核对后再提交。" };
  if (code.includes("ROUTE_MISSING") || code.includes("PROVIDER_UNAVAILABLE") || code.endsWith("_UNAVAILABLE")) return { summary: "所需能力当前未就绪。", nextStep: "按页面上的唯一下一步补齐模型或连接配置后重试。" };
  if (code.includes("INVALID") || code.includes("VALIDATION")) return { summary: "提交内容未通过校验。", nextStep: "检查页面输入并重新提交。" };
  if (code.includes("FORBIDDEN") || code.includes("PERMISSION")) return { summary: "当前账号没有执行此操作的权限。", nextStep: "请项目 Owner 或管理员核对你的权限。" };
  return { summary: fallback, nextStep: "刷新页面后重试；如果问题持续，请将安全错误码提供给管理员。" };
}

export function safeErrorPresentation(payload: unknown, fallback: string): SafeErrorPresentation {
  const error = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as { error?: unknown }).error
    : null;
  const code = typeof error === "object" && error !== null && !Array.isArray(error)
    ? normalizedCode((error as { code?: unknown }).code)
    : null;
  const presentation = presentationForCode(code, fallback);
  const codeSuffix = code === null ? "" : `（错误代码：${code}）`;
  return Object.freeze({
    code,
    summary: presentation.summary,
    nextStep: presentation.nextStep,
    message: `${presentation.summary} 下一步：${presentation.nextStep}${codeSuffix}`,
  });
}

export async function safeResponseError(response: Response, fallback: string): Promise<SafeErrorPresentation> {
  const payload = await response.json().catch(() => null) as unknown;
  return safeErrorPresentation(payload, fallback);
}
