import { ZodError } from "zod";
import { AuthError } from "@/lib/auth";
import { CredentialVaultError } from "@/lib/credential-vault";
import { ProviderServiceError, ProviderTransportError } from "@/lib/ai-providers";
import { BackgroundJobError } from "@/lib/background-jobs";
import {
  GitHubCodeScanServiceError,
  GitHubLedgerError,
  GitHubMaterialSyncServiceError,
  GitHubReadError,
  ProjectGitHubSyncError,
} from "@/lib/github";
import { ProjectAiRouteError } from "@/lib/project-ai-routes";
import { WebGitHubError } from "@/lib/web-github";
import { WebAiGovernanceError } from "@/lib/web-ai-governance";
import { WebAutoExtractError } from "@/lib/web-auto-extract";
import { WebMemoryIndexError } from "@/lib/web-memory-index";
import { ProjectIntelligenceError } from "@/lib/web-project-intelligence";
import { WebRagError } from "@/lib/web-rag";
import { ProjectWorkflowError } from "@/lib/project-workflow";
import { ProjectGovernanceError } from "@/lib/project-governance";
import { ProjectLifecycleError } from "@/lib/project-lifecycle";
import { ProjectExportError } from "@/lib/project-export";
import { ProjectAssetError } from "@/lib/project-assets/service";
import { ProjectAssetStorageError } from "@/lib/project-assets/storage";
import { ProjectAssetParserError } from "@/lib/project-assets/parser";
import { ProjectAssetArchiveError } from "@/lib/project-assets/archive";
import { UploadAdmissionError } from "@/lib/project-assets/admission";
import { UploadQuotaError } from "@/lib/project-assets/quota";
import { UploadPolicyConfigurationError } from "@/lib/project-assets/policy";
import { GitRunnerError, GitSafetyError, GitServiceError } from "@/lib/git";
import { AutomationError } from "@/lib/automation";
import { MemoryQualityError } from "@/lib/memory-quality";
import { WebSourceError } from "@/lib/web-sources";
import { AccessControlError } from "@/lib/access-control";
import { WorkspaceError } from "@/lib/workspaces";
import { OidcError } from "@/lib/oidc";
import { ActionEngineError } from "@/lib/action-engine";
import { ActionResultIntakeError } from "@/lib/action-result-intake";
import { McpCapabilityError } from "@/lib/mcp";
import { ProjectPlanError } from "@/lib/project-plan";
import { ProjectWorldError } from "@/lib/project-world";

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Array<{ path: string; message: string }>;
  };
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function mapApiError(error: unknown): { status: number; body: ApiErrorBody } {
  if (error instanceof ProjectWorldError) {
    const mapping: Record<string, readonly [number, string]> = {
      PROJECT_WORLD_INVALID_INPUT: [400, "项目世界模型请求无效"],
      PROJECT_WORLD_PROJECT_NOT_FOUND: [404, "项目不存在"],
      PROJECT_WORLD_TOO_MANY_FACTS: [413, "项目事实超过单次状态计算上限"],
      PROJECT_WORLD_FACT_NOT_FOUND: [404, "项目事实不存在"],
      PROJECT_WORLD_CONFIRMED_FACTS_REQUIRED: [422, "关系两端必须是当前已确认事实"],
      PROJECT_WORLD_RELATION_NOT_FOUND: [404, "事实关系不存在"],
      PROJECT_WORLD_RELATION_CONFLICT: [409, "该事实关系已经存在"],
      PROJECT_WORLD_RELATION_CHANGED: [409, "事实关系已变化，请刷新后重试"],
      PROJECT_WORLD_SUPERSESSION_INVALID: [400, "事实替代请求无效"],
      PROJECT_WORLD_SUPERSESSION_CONFLICT: [409, "事实状态或版本已变化，请刷新后重试"],
      PROJECT_WORLD_SUPERSESSION_CYCLE: [409, "事实替代会形成循环"],
      PROJECT_WORLD_SNAPSHOT_TOO_LARGE: [413, "项目状态快照超过安全上限"],
    };
    const [status, message] = mapping[error.code] ?? [500, "项目世界模型处理失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof ProjectPlanError) {
    const mapping: Record<string, readonly [number, string]> = {
      PROJECT_PLAN_INVALID_INPUT: [400, "项目计划请求无效"],
      PROJECT_PLAN_PROJECT_NOT_FOUND: [404, "项目不存在"],
      PROJECT_PLAN_OBJECTIVE_NOT_FOUND: [404, "项目目标不存在"],
      PROJECT_PLAN_WORK_ITEM_NOT_FOUND: [404, "工作项不存在"],
      PROJECT_PLAN_DEPENDENCY_NOT_FOUND: [404, "工作项依赖不存在"],
      PROJECT_PLAN_EVIDENCE_NOT_FOUND: [404, "可关联证据不存在、未确认或已经失效"],
      PROJECT_PLAN_IMPACT_NOT_FOUND: [404, "仓库变更影响信号不存在"],
      PROJECT_PLAN_RECOMMENDATION_NOT_FOUND: [404, "智能体建议不存在或已变化"],
      PROJECT_PLAN_EVIDENCE_INVALID: [422, "智能体建议缺少完整、可验证的证据快照"],
      PROJECT_PLAN_ASSIGNEE_NOT_ELIGIBLE: [422, "负责人必须是当前项目可编辑成员或工作区管理员"],
      PROJECT_PLAN_VERSION_CONFLICT: [409, "项目计划已被其他成员更新，请刷新后重试"],
      PROJECT_PLAN_STATUS_CONFLICT: [409, "当前状态不能执行该计划变更"],
      PROJECT_PLAN_READINESS_REQUIRED: [422, "工作项开始或完成前必须设置负责人和验收标准"],
      PROJECT_PLAN_COMPLETION_EVIDENCE_REQUIRED: [422, "工作项完成前必须至少关联一条有效证据"],
      PROJECT_PLAN_DEPENDENCY_CONFLICT: [409, "该工作项依赖已经存在"],
      PROJECT_PLAN_DEPENDENCY_CYCLE: [409, "该依赖会形成循环，不能保存"],
      PROJECT_PLAN_EVIDENCE_CONFLICT: [409, "该证据已经关联到工作项"],
      PROJECT_PLAN_IMPACT_CONFLICT: [409, "仓库变更影响信号已经被其他成员处理"],
    };
    const [status, message] = mapping[error.code] ?? [500, "项目计划处理失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof ActionResultIntakeError) {
    const mapping: Record<string, readonly [number, string]> = {
      ACTION_RESULT_INTAKE_INVALID_INPUT: [400, "动作结果导入请求无效"],
      ACTION_RESULT_INTAKE_ACTION_NOT_FOUND: [404, "动作不存在"],
      ACTION_RESULT_INTAKE_NOT_IMPORTABLE: [409, "只有已成功的 MCP 只读调用结果可以导入"],
      ACTION_RESULT_INTAKE_VERSION_CONFLICT: [409, "动作记录已变化，请刷新后重新确认"],
      ACTION_RESULT_INTAKE_RESULT_CHANGED: [409, "动作输入或结果指纹已变化，请刷新后重新确认"],
      ACTION_RESULT_INTAKE_TOO_LARGE: [413, "动作结果超过单条项目资料的安全上限"],
    };
    const [status, message] = mapping[error.code] ?? [500, "动作结果导入失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof McpCapabilityError) {
    const mapping: Record<string, readonly [number, string]> = {
      MCP_INVALID_INPUT: [400, "MCP 配置或请求无效"],
      MCP_CONNECTION_NOT_FOUND: [404, "MCP 连接不存在"],
      MCP_CONNECTION_NAME_CONFLICT: [409, "MCP 连接名称已存在"],
      MCP_CONNECTION_CONFLICT: [409, "MCP 连接已被其他管理员更新，请刷新后重试"],
      MCP_CONNECTION_DISABLED: [409, "MCP 连接已停用"],
      MCP_CONNECTION_NOT_VERIFIED: [409, "MCP 连接尚未成功发现工具"],
      MCP_CONNECTION_IN_USE: [409, "MCP 连接仍被项目工具授权或历史审计引用，无法永久删除"],
      MCP_CONNECTION_DELETE_REQUIRES_DISABLED: [409, "请先停用 MCP 连接，再执行永久删除"],
      MCP_CONNECTION_CONFIRMATION_MISMATCH: [400, "连接名称确认不一致，未执行删除"],
      MCP_NETWORK_BLOCKED: [403, "MCP 地址位于未授权的内网或保留网络"],
      MCP_NETWORK_CHANGED: [409, "MCP 域名解析地址已变化，请管理员重新确认网络"],
      MCP_TRANSPORT_FAILED: [502, "MCP 远程连接失败"],
      MCP_PROTOCOL_UNSUPPORTED: [422, "该服务不支持当前 Streamable HTTP MCP 协议"],
      MCP_RESPONSE_INVALID: [502, "MCP 服务返回了无效响应"],
      MCP_RESPONSE_TOO_LARGE: [413, "MCP 响应超过安全上限"],
      MCP_TOOL_CATALOG_INVALID: [422, "MCP 工具目录不符合受控接入要求"],
      MCP_TOOL_NOT_FOUND: [404, "MCP 工具定义不存在或已更新"],
      MCP_TOOL_NOT_READ_ONLY: [403, "该工具未明确声明只读和非破坏性，不能授权"],
      MCP_ADMIN_REQUIRED: [403, "只有系统管理员可以认证或撤销 MCP 工具"],
      MCP_TOOL_NOT_ATTESTED: [403, "该工具尚未完成管理员认证，不能授权或调用"],
      MCP_ATTESTATION_NOT_FOUND: [404, "MCP 工具管理员认证不存在或已撤销"],
      MCP_ATTESTATION_CONFLICT: [409, "MCP 工具管理员认证已被其他管理员更新，请刷新后重试"],
      MCP_TOOL_DEFINITION_STALE: [409, "MCP 工具、凭据或授权快照已变化，请重新授权并创建动作"],
      MCP_GRANT_NOT_FOUND: [404, "项目 MCP 工具授权不存在"],
      MCP_GRANT_REVOKED: [403, "项目 MCP 工具授权已撤销"],
      MCP_GRANT_CONFLICT: [409, "MCP 工具授权已被其他用户更新，请刷新后重试"],
      MCP_TOOL_INPUT_INVALID: [400, "工具参数不符合已固化的输入 Schema"],
      MCP_TOOL_INPUT_REQUIRED_UNSUPPORTED: [422, "当前版本不允许 MCP 工具在执行中继续索取输入"],
      MCP_TOOL_CALL_FAILED: [502, "MCP 工具调用失败"],
    };
    const [status, message] = mapping[error.code] ?? [500, "MCP 能力处理失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof ActionEngineError) {
    const mapping: Record<string, readonly [number, string]> = {
      ACTION_INVALID_INPUT: [400, "动作请求无效"],
      ACTION_PROJECT_NOT_FOUND: [404, "项目不存在"],
      ACTION_PROJECT_ARCHIVED: [409, "已归档项目不能创建或审批动作"],
      ACTION_NOT_FOUND: [404, "动作不存在"],
      ACTION_POLICY_DENIED: [403, "项目策略禁止执行该能力"],
      ACTION_POLICY_CONFLICT: [409, "动作策略已被其他用户更新，请刷新后重试"],
      ACTION_IDEMPOTENCY_CONFLICT: [409, "同一请求标识已经用于另一项动作"],
      ACTION_APPROVAL_REQUIRED: [409, "该动作需要项目 Owner 审批"],
      ACTION_APPROVAL_EXPIRED: [410, "动作审批已经过期，请重新创建"],
      ACTION_DECISION_CONFLICT: [409, "动作内容或状态已变化，请刷新后重试"],
      ACTION_CANCEL_FORBIDDEN: [403, "只有动作申请人或项目 Owner 可以取消"],
      ACTION_STATE_CONFLICT: [409, "动作状态已变化，当前操作不能继续"],
      ACTION_EXECUTION_FAILED: [500, "动作执行失败"],
    };
    const [status, message] = mapping[error.code] ?? [500, "动作处理失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof WorkspaceError) {
    const mapping: Record<string, readonly [number, string]> = {
      WORKSPACE_INVALID_INPUT: [400, "工作区请求无效"],
      WORKSPACE_NOT_FOUND: [404, "工作区不存在"],
      WORKSPACE_MEMBER_NOT_FOUND: [404, "成员不存在"],
      WORKSPACE_MEMBER_CONFLICT: [409, "用户名或邮箱已经存在"],
      WORKSPACE_INVITATION_NOT_FOUND: [404, "邀请不存在或已使用"],
      WORKSPACE_INVITATION_EXPIRED: [410, "邀请已经过期"],
      WORKSPACE_INVITATION_EMAIL_MISMATCH: [403, "当前账户邮箱与邀请对象不一致"],
      WORKSPACE_LAST_OWNER_REQUIRED: [409, "工作区必须至少保留一位所有者"],
    };
    const [status, message] = mapping[error.code] ?? [500, "工作区操作失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof OidcError) {
    const mapping: Record<string, readonly [number, string]> = {
      OIDC_INVALID_INPUT: [400, "OIDC 配置或登录请求无效"],
      OIDC_PROVIDER_NOT_FOUND: [404, "OIDC 身份源不存在"],
      OIDC_PROVIDER_CONFLICT: [409, "OIDC 身份源名称或客户端配置已存在"],
      OIDC_PROVIDER_NOT_VERIFIED: [409, "OIDC 身份源尚未验证或已停用"],
      OIDC_PROVIDER_IN_USE: [409, "OIDC 身份源仍有关联账户身份，无法永久删除；请先迁移并解除身份绑定"],
      OIDC_PROVIDER_DELETE_REQUIRES_DISABLED: [409, "请先停用 OIDC 身份源，再执行永久删除"],
      OIDC_PROVIDER_CONFIRMATION_MISMATCH: [400, "身份源名称确认不一致，未执行删除"],
      OIDC_DISCOVERY_FAILED: [422, "OIDC Discovery 文档不符合安全要求"],
      OIDC_NETWORK_BLOCKED: [403, "OIDC 地址位于未授权的内网或保留网络"],
      OIDC_NETWORK_CHANGED: [409, "OIDC 域名解析地址已变化，请管理员重新验证"],
      OIDC_FLOW_INVALID: [400, "OIDC 登录状态无效或已经使用"],
      OIDC_FLOW_EXPIRED: [410, "OIDC 登录已过期，请重新开始"],
      OIDC_TOKEN_EXCHANGE_FAILED: [502, "OIDC 授权码交换失败"],
      OIDC_ID_TOKEN_INVALID: [401, "OIDC ID Token 验证失败"],
      OIDC_ACCOUNT_NOT_ALLOWED: [403, "该身份尚未被邀请，且不满足自动加入规则"],
      OIDC_ACCOUNT_DISABLED: [403, "账户已停用"],
    };
    const [status, message] = mapping[error.code] ?? [500, "OIDC 操作失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof AccessControlError) {
    const mapping: Record<string, readonly [number, string]> = {
      ACCESS_FORBIDDEN: [403, "你没有执行此操作所需的权限"],
      ACCESS_PROJECT_NOT_FOUND: [404, "项目不存在"],
      ACCESS_WORKSPACE_NOT_FOUND: [404, "工作区不存在"],
      ACCESS_LAST_OWNER_REQUIRED: [409, "工作区必须至少保留一位所有者"],
    };
    const [status, message] = mapping[error.code] ?? [403, "访问被拒绝"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof AutomationError) {
    const mapping: Record<string, readonly [number, string]> = {
      AUTOMATION_INVALID_INPUT: [400, "自动化规则输入无效"],
      AUTOMATION_PROJECT_NOT_FOUND: [404, "项目不存在"],
      AUTOMATION_RULE_NOT_FOUND: [404, "自动化规则不存在"],
      AUTOMATION_RULE_CONFLICT: [409, "自动化规则名称已存在"],
      AUTOMATION_RULE_PAUSED: [409, "已暂停的自动化规则不能立即运行"],
      AUTOMATION_RUN_CONFLICT: [409, "自动化运行状态已变化"],
      NOTIFICATION_NOT_FOUND: [404, "通知不存在"],
    };
    const [status, message] = mapping[error.code] ?? [500, "自动化操作失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof MemoryQualityError) {
    const mapping: Record<string, readonly [number, string]> = {
      MEMORY_QUALITY_INVALID_INPUT: [400, "记忆质量参数无效"],
      MEMORY_QUALITY_PROJECT_NOT_FOUND: [404, "项目不存在"],
      MEMORY_QUALITY_ITEM_NOT_FOUND: [404, "记忆条目不存在"],
      MEMORY_QUALITY_ISSUE_NOT_FOUND: [404, "质量问题不存在或已处理"],
      MEMORY_QUALITY_VERSION_CONFLICT: [409, "记忆条目已被更新，请刷新后重试"],
      MEMORY_QUALITY_TOO_MANY_ITEMS: [413, "待分析记忆超过单次质量检查上限"],
    };
    const [status, message] = mapping[error.code] ?? [500, "记忆质量操作失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof WebSourceError) {
    const mapping: Record<string, readonly [number, string]> = {
      WEB_SOURCE_INVALID_INPUT: [400, "网页来源配置无效；公网地址必须使用 HTTPS"],
      WEB_SOURCE_PROJECT_NOT_FOUND: [404, "项目不存在"],
      WEB_SOURCE_NOT_FOUND: [404, "网页来源不存在"],
      WEB_SOURCE_CONFLICT: [409, "该网页已经添加到项目"],
      WEB_SOURCE_DISABLED: [409, "网页来源已停用"],
      WEB_SOURCE_NETWORK_BLOCKED: [403, "网页地址位于未授权的内网或保留网络"],
      WEB_SOURCE_NETWORK_CHANGED: [409, "网页域名解析地址已变化，请在页面重新确认网络"],
      WEB_SOURCE_HOST_UNRESOLVED: [422, "网页域名无法解析"],
      WEB_SOURCE_REDIRECT_REJECTED: [422, "网页发生了不允许的跨域或不安全重定向"],
      WEB_SOURCE_FETCH_FAILED: [502, "网页抓取失败"],
      WEB_SOURCE_HTTP_STATUS: [502, "网页返回了非成功状态"],
      WEB_SOURCE_TOO_LARGE: [413, "网页响应超过 5 MiB 安全上限"],
      WEB_SOURCE_TYPE_UNSUPPORTED: [422, "网页内容类型不受支持"],
      WEB_SOURCE_CONTENT_EMPTY: [422, "网页中没有可识别文本"],
    };
    const [status, message] = mapping[error.code] ?? [500, "网页来源操作失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof GitServiceError) {
    const mapping: Record<string, readonly [number, string]> = {
      GIT_CONNECTION_INVALID_INPUT: [400, "Git 服务配置无效"],
      GIT_CONNECTION_NOT_FOUND: [404, "Git 服务连接不存在"],
      GIT_CONNECTION_NAME_CONFLICT: [409, "Git 服务连接名称已存在"],
      GIT_CONNECTION_IN_USE: [409, "Git 服务仍被项目仓库关联或历史记录引用，无法停用或永久删除"],
      GIT_CONNECTION_DISABLED: [409, "Git 服务连接已停用"],
      GIT_CONNECTION_DELETE_REQUIRES_DISABLED: [409, "请先停用 Git 服务连接，再执行永久删除"],
      GIT_CONNECTION_CONFIRMATION_MISMATCH: [400, "连接名称确认不一致，未执行删除"],
      GIT_REPOSITORY_NOT_FOUND: [404, "Git 仓库或分支不存在"],
      GIT_REPOSITORY_CONFLICT: [409, "该项目已经关联此仓库"],
      GIT_REPOSITORY_EMPTY: [422, "仓库或所选分支没有可扫描内容"],
      GIT_REPOSITORY_TOO_LARGE: [413, "仓库扫描范围超过安全上限，请缩小目录范围"],
      GIT_REPOSITORY_BINARY_ONLY: [422, "扫描范围内没有可识别的文本代码文件"],
      GIT_REPOSITORY_LINK_NOT_FOUND: [404, "项目仓库关联不存在"],
      GIT_REPOSITORY_LINK_DISABLED: [409, "项目仓库关联已停用"],
      GIT_REPOSITORY_SYNC_FAILED: [502, "Git 仓库同步失败"],
    };
    const [status, message] = mapping[error.code] ?? [500, "Git 仓库操作失败"];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof GitSafetyError) {
    const messages: Record<string, string> = {
      GIT_BASE_URL_INVALID: "Git 服务地址无效",
      GIT_REPOSITORY_PATH_INVALID: "仓库路径无效",
      GIT_REF_INVALID: "分支名称无效",
      GIT_SCAN_SCOPE_INVALID: "仓库扫描范围无效",
      GIT_HOST_UNRESOLVED: "Git 服务域名无法解析",
      GIT_NETWORK_BLOCKED: "Git 服务地址位于未授权的内网或保留网络",
      GIT_NETWORK_CHANGED: "Git 服务解析地址已变化，请重新执行连接测试",
      GIT_TLS_CA_INVALID: "自定义 CA 证书格式无效",
      GIT_SSH_KNOWN_HOST_INVALID: "SSH 主机公钥记录格式无效",
    };
    const status = error.code === "GIT_NETWORK_CHANGED" ? 409 : error.code.includes("NETWORK") ? 403 : 400;
    return { status, body: { error: { code: error.code, message: messages[error.code] ?? "Git 安全校验失败" } } };
  }

  if (error instanceof GitRunnerError) {
    const messages: Record<string, string> = {
      GIT_EXECUTABLE_UNAVAILABLE: "运行环境缺少 Git 客户端",
      GIT_REMOTE_UNAVAILABLE: "Git 仓库不可访问",
      GIT_AUTHENTICATION_FAILED: "Git 凭据无效或没有只读权限",
      GIT_HOST_KEY_REJECTED: "SSH 主机公钥校验失败",
      GIT_OPERATION_TIMEOUT: "Git 仓库操作超时",
      GIT_OUTPUT_TOO_LARGE: "Git 仓库响应超过安全上限",
      GIT_OPERATION_FAILED: "Git 仓库操作失败",
    };
    const status = error.code === "GIT_AUTHENTICATION_FAILED" ? 401 : error.code === "GIT_OUTPUT_TOO_LARGE" ? 413 : 502;
    return { status, body: { error: { code: error.code, message: messages[error.code] ?? "Git 仓库操作失败" } } };
  }

  if (error instanceof ProjectAssetError) {
    const mapping = {
      PROJECT_ASSET_INVALID_INPUT: [400, "文件资料请求无效"],
      PROJECT_ASSET_NOT_FOUND: [404, "文件资料不存在"],
      PROJECT_ASSET_DUPLICATE: [409, "相同内容的文件已经上传"],
      PROJECT_ASSET_INVALID_STATE: [409, "文件资料状态已变化，请刷新后重试"],
      PROJECT_ASSET_SEGMENT_NOT_FOUND: [404, "待审核识别片段不存在"],
      PROJECT_ASSET_SEGMENT_ALREADY_REVIEWED: [409, "该识别片段已经审核"],
      PROJECT_ASSET_PROJECT_QUOTA_EXCEEDED: [413, "项目文件容量已达上限"],
      PROJECT_ASSET_WORKSPACE_QUOTA_EXCEEDED: [413, "工作区文件容量已达上限"],
      PROJECT_ASSET_DEPLOYMENT_QUOTA_EXCEEDED: [413, "部署文件容量已达上限"],
      PROJECT_ASSET_COUNT_QUOTA_EXCEEDED: [413, "项目活动文件数量已达上限"],
    } as const;
    const [status, message] = mapping[error.code];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof UploadQuotaError) {
    const mapping = {
      PROJECT_ASSET_PROJECT_QUOTA_EXCEEDED: [413, "项目文件容量已达上限"],
      PROJECT_ASSET_WORKSPACE_QUOTA_EXCEEDED: [413, "工作区文件容量已达上限"],
      PROJECT_ASSET_DEPLOYMENT_QUOTA_EXCEEDED: [413, "部署文件容量已达上限"],
      PROJECT_ASSET_COUNT_QUOTA_EXCEEDED: [413, "项目活动文件数量已达上限"],
      PROJECT_ASSET_PROJECT_RETAINED_OBJECTS_EXCEEDED: [413, "项目保留文件对象数量已达上限"],
      PROJECT_ASSET_WORKSPACE_RETAINED_OBJECTS_EXCEEDED: [413, "工作区保留文件对象数量已达上限"],
      PROJECT_ASSET_DEPLOYMENT_RETAINED_OBJECTS_EXCEEDED: [413, "部署保留文件对象数量已达上限"],
    } as const;
    const [status, message] = mapping[error.code];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof UploadAdmissionError) {
    const mapping = {
      UPLOAD_ADMISSION_PROJECT_NOT_FOUND: [404, "项目不存在"],
      UPLOAD_RATE_LIMITED: [429, "上传请求过于频繁，请稍后再试"],
      UPLOAD_CONCURRENCY_LIMITED: [429, "当前已有过多上传进行中，请稍后再试"],
      UPLOAD_GLOBAL_CONCURRENCY_LIMITED: [429, "服务器当前已有过多上传进行中，请稍后再试"],
    } as const;
    const [status, message] = mapping[error.code];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof UploadPolicyConfigurationError) {
    return { status: 503, body: { error: { code: "UPLOAD_POLICY_INVALID", message: "上传策略配置无效，服务暂不可用" } } };
  }

  if (error instanceof ProjectAssetStorageError) {
    const messages = {
      ASSET_FILE_EMPTY: "文件内容为空",
      ASSET_FILE_TOO_LARGE: "文件超过允许大小",
      ASSET_FILE_TYPE_UNSUPPORTED: "暂不支持该文件类型",
      ASSET_FILE_SIGNATURE_INVALID: "文件扩展名与真实内容不一致或文件已损坏",
      ASSET_IMAGE_TOO_LARGE: "图片像素尺寸超过安全限制",
      ASSET_STORAGE_INVALID_KEY: "文件存储标识无效",
      ASSET_STORAGE_UNAVAILABLE: "本地文件存储不可用",
    } as const;
    const status = error.code === "ASSET_STORAGE_UNAVAILABLE"
      ? 503
      : error.code === "ASSET_FILE_TOO_LARGE" || error.code === "ASSET_IMAGE_TOO_LARGE"
        ? 413
        : 422;
    return { status, body: { error: { code: error.code, message: messages[error.code] } } };
  }

  if (error instanceof ProjectAssetParserError || error instanceof ProjectAssetArchiveError) {
    const messages: Record<string, string> = {
      ASSET_DOCUMENT_INVALID: "文件内容已损坏或无法解析",
      ASSET_DOCUMENT_TOO_LARGE: "文件页数、单元格或解析内容超过安全限制",
      ASSET_DOCUMENT_EMPTY: "文件中没有可识别内容",
      ASSET_DOCUMENT_TYPE_UNSUPPORTED: "暂不支持解析该文件类型",
      ASSET_ARCHIVE_INVALID: "Office 文件结构无效",
      ASSET_ARCHIVE_ENCRYPTED: "不支持加密或带密码的 Office 文件",
      ASSET_ARCHIVE_TOO_LARGE: "Office 文件解压后超过安全限制",
      ASSET_ARCHIVE_UNSAFE_PATH: "Office 文件包含不安全的内部路径",
    };
    return { status: 422, body: { error: { code: error.code, message: messages[error.code] ?? "文件解析失败" } } };
  }

  if (error instanceof AuthError) {
    const mapping = {
      AUTH_INVALID_INPUT: [400, "账户或登录信息格式无效"],
      AUTH_ALREADY_INITIALIZED: [409, "应用已经完成初始化"],
      AUTH_INVALID_CREDENTIALS: [401, "用户名或密码错误"],
      AUTH_CURRENT_PASSWORD_INVALID: [401, "当前密码不正确"],
      AUTH_PASSWORD_UNCHANGED: [400, "新密码不能与当前密码相同"],
      AUTH_LOCAL_PASSWORD_EXISTS: [409, "该账户已经设置本地密码"],
      AUTH_REQUIRED: [401, "请先登录"],
      AUTH_FORBIDDEN: [403, "你没有执行此操作所需的权限"],
      AUTH_ACCOUNT_DISABLED: [403, "账户已停用"],
      AUTH_CSRF_REJECTED: [403, "请求来源校验失败"],
    } as const;
    const [status, message] = mapping[error.code];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof CredentialVaultError) {
    const status = error.code === "CREDENTIAL_NOT_FOUND" ? 404 : 400;
    return {
      status,
      body: {
        error: {
          code: error.code,
          message: error.code === "CREDENTIAL_MASTER_KEY_INSECURE"
            ? "本机主密钥文件权限不安全"
            : "凭据操作失败",
        },
      },
    };
  }

  if (error instanceof ProviderServiceError) {
    const mapping = {
      AI_PROVIDER_INVALID_INPUT: [400, "供应商配置无效"],
      AI_PROVIDER_NOT_FOUND: [404, "供应商连接不存在"],
      AI_PROVIDER_NAME_CONFLICT: [409, "供应商连接名称已存在"],
      AI_PROVIDER_IN_USE: [409, "供应商仍被项目路由或历史审计记录引用，无法停用或永久删除"],
      AI_PROVIDER_DELETE_REQUIRES_DISABLED: [409, "请先停用供应商连接，再执行永久删除"],
      AI_PROVIDER_CONFIRMATION_MISMATCH: [400, "连接名称确认不一致，未执行删除"],
    } as const;
    const [status, message] = mapping[error.code];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof ProviderTransportError) {
    const messages = {
      AI_PROVIDER_AUTH_FAILED: "API Key 无效或没有所需权限",
      AI_PROVIDER_RATE_LIMITED: "供应商请求频率受限，请稍后重试",
      AI_PROVIDER_REJECTED: "供应商拒绝了当前模型或请求参数",
      AI_PROVIDER_UNAVAILABLE: "供应商暂时不可用",
      AI_PROVIDER_TIMEOUT: "供应商连接超时",
      AI_PROVIDER_RESPONSE_TOO_LARGE: "供应商响应超过安全上限",
      AI_PROVIDER_INVALID_RESPONSE: "供应商返回了无法验证的响应",
      AI_PROVIDER_EMBEDDING_UNSUPPORTED: "该供应商不支持向量模型",
      AI_PROVIDER_VISION_UNSUPPORTED: "所选供应商或模型不支持图片识别",
    } as const;
    return {
      status: error.status,
      body: { error: { code: error.code, message: messages[error.code] } },
    };
  }

  if (error instanceof ProjectAiRouteError) {
    const mapping = {
      PROJECT_AI_ROUTE_INVALID_INPUT: [400, "项目模型路由配置无效"],
      PROJECT_AI_ROUTE_CONFLICT: [409, "项目模型路由已被其他操作更新，请刷新后重试"],
      PROJECT_AI_ROUTE_CONFIRMATION_REQUIRED: [409, "切换向量模型前请确认并在完成后重建索引"],
      PROJECT_NOT_FOUND: [404, "项目不存在"],
      AI_PROVIDER_NOT_FOUND: [404, "模型供应商不存在"],
      AI_PROVIDER_NOT_VERIFIED: [409, "请先通过供应商连接测试"],
      AI_PROVIDER_CAPABILITY_MISMATCH: [422, "所选供应商或模型不支持该能力"],
    } as const;
    const [status, message] = mapping[error.code];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof WebGitHubError) {
    const mapping = {
      GITHUB_WEB_INVALID_INPUT: [400, "GitHub 项目配置无效"],
      GITHUB_WEB_CREDENTIAL_REQUIRED: [409, "请先提供 GitHub fine-grained PAT"],
      GITHUB_WEB_CREDENTIAL_CONFLICT: [409, "项目存在多个不一致的 GitHub 凭据"],
      PROJECT_NOT_FOUND: [404, "项目不存在"],
    } as const;
    const [status, message] = mapping[error.code];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof BackgroundJobError) {
    const status = error.code === "BACKGROUND_JOB_NOT_FOUND" ? 404 : 409;
    return { status, body: { error: { code: error.code, message: "任务状态无效，请刷新后重试" } } };
  }

  if (error instanceof ProjectWorkflowError) {
    const mapping = {
      PROJECT_WORKFLOW_INVALID_INPUT: [400, "任务请求无效"],
      PROJECT_WORKFLOW_JOB_NOT_FOUND: [404, "任务不存在"],
      PROJECT_WORKFLOW_PROJECT_MISMATCH: [404, "任务不存在"],
      PROJECT_WORKFLOW_INVALID_STATE: [409, "任务状态已变化，请刷新后重试"],
      PROJECT_WORKFLOW_CLAIM_CONFLICT: [409, "任务已被其他执行尝试领取"],
      PROJECT_WORKFLOW_ATTEMPT_NOT_FOUND: [409, "任务执行尝试不存在或已失效"],
      PROJECT_WORKFLOW_STALE_ATTEMPT: [409, "任务执行尝试已失效，请刷新任务状态"],
      PROJECT_WORKFLOW_LEASE_EXPIRED: [409, "任务租约已过期，请执行协调确认"],
      PROJECT_WORKFLOW_RECONCILIATION_NOT_DUE: [409, "任务仍在租约内，暂不能协调确认"],
      PROJECT_WORKFLOW_CANCEL_NOT_ALLOWED: [409, "当前任务状态不允许取消"],
      PROJECT_WORKFLOW_SPECIALIZED_OPERATION_REQUIRED: [409, "该任务必须使用专用协调或取消入口"],
      PROJECT_WORKFLOW_RETRY_NOT_SUPPORTED: [409, "未知结果任务不支持自动重试，请重新发起并重新确认"],
    } as const;
    const [status, message] = mapping[error.code];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof ProjectGovernanceError) {
    return {
      status: 400,
      body: {
        error: {
          code: error.code,
          message: error.code === "GOVERNANCE_CURSOR_INVALID" ? "分页游标无效" : "分页数量无效",
        },
      },
    };
  }

  if (error instanceof ProjectLifecycleError) {
    const errors = {
      PROJECT_NOT_FOUND: { status: 404, message: "项目不存在" },
      PROJECT_ARCHIVED: { status: 409, message: "项目已归档，请先恢复后再操作" },
      PROJECT_ALREADY_ACTIVE: { status: 409, message: "项目当前未归档" },
      PROJECT_LIFECYCLE_STALE: { status: 409, message: "项目状态已变化，请刷新后重试" },
      PROJECT_HAS_UNRESOLVED_JOBS: { status: 409, message: "项目仍有运行中或待人工收口的任务，暂不能归档或永久删除" },
      PROJECT_LIFECYCLE_CONFLICT: { status: 409, message: "项目状态正在变化，请稍后重试" },
      PROJECT_DELETE_REQUIRES_ARCHIVED: { status: 409, message: "只有已归档项目可以永久删除" },
      PROJECT_DELETE_CONFIRMATION_MISMATCH: { status: 400, message: "项目名称确认不一致，未执行删除" },
      PROJECT_DELETE_ACTIVE_UPLOAD: { status: 409, message: "项目仍有上传请求或文件解析租约，请稍后再删除" },
      PROJECT_DELETE_CONFLICT: { status: 409, message: "项目删除依赖正在变化或仍有受保护引用，请刷新后重试" },
    } as const;
    const mapped = errors[error.code];
    return { status: mapped.status, body: { error: { code: error.code, message: mapped.message } } };
  }

  if (error instanceof ProjectExportError) {
    const errors = {
      PROJECT_EXPORT_NOT_FOUND: { status: 404, message: "项目不存在" },
      PROJECT_EXPORT_STALE: { status: 409, message: "项目已发生变化，请刷新后重新导出" },
      PROJECT_EXPORT_TOO_LARGE: { status: 413, message: "安全导出超过 20 MiB 限制，请缩小项目资料后重试" },
      PROJECT_EXPORT_CONFLICT: { status: 409, message: "项目正在变化，请稍后重新导出" },
    } as const;
    const mapped = errors[error.code];
    return { status: mapped.status, body: { error: { code: error.code, message: mapped.message } } };
  }

  if (error instanceof GitHubReadError) {
    const status = error.code === "GITHUB_RATE_LIMITED" ? 429 : error.code === "GITHUB_INVALID_REQUEST" ? 400 : 502;
    const messages = {
      GITHUB_DISABLED: "GitHub 连接器未启用",
      GITHUB_CREDENTIAL_UNAVAILABLE: "GitHub 凭据不可用",
      GITHUB_INVALID_REQUEST: "GitHub 仓库请求无效",
      GITHUB_ACCESS_UNKNOWN: "无法读取仓库，请检查 PAT 权限和仓库范围",
      GITHUB_RATE_LIMITED: "GitHub API 已限流，请稍后重试",
      GITHUB_REDIRECT_REJECTED: "GitHub 返回了不允许的重定向",
      GITHUB_RESPONSE_TOO_LARGE: "GitHub 响应超过安全上限",
      GITHUB_INVALID_RESPONSE: "GitHub 返回了无法验证的响应",
      GITHUB_REQUEST_TIMEOUT: "GitHub 请求超时",
      GITHUB_REQUEST_FAILED: "GitHub 请求失败",
    } as const;
    return { status, body: { error: { code: error.code, message: messages[error.code] } } };
  }

  if (
    error instanceof GitHubLedgerError ||
    error instanceof GitHubCodeScanServiceError ||
    error instanceof GitHubMaterialSyncServiceError ||
    error instanceof ProjectGitHubSyncError
  ) {
    const notFound = error.code.includes("NOT_FOUND") || error.code.includes("PROJECT_NOT_FOUND");
    const conflict = error.code.includes("CONFLICT") || error.code.includes("ALREADY_RUNNING") ||
      error.code.includes("DIRECT_OPERATION_ACTIVE") || error.code.includes("RECONCILIATION_REQUIRED") ||
      error.code.includes("RECONCILIATION_NOT_DUE") || error.code.includes("CANCEL_NOT_ALLOWED");
    return {
      status: notFound ? 404 : conflict ? 409 : 422,
      body: {
        error: {
          code: error.code,
          message: error instanceof ProjectGitHubSyncError
            ? error.code === "PROJECT_GITHUB_SYNC_NO_ENABLED_TARGETS"
              ? "当前项目没有可同步的已启用 GitHub 内容"
              : "GitHub 项目同步未能完成，请检查配置与任务状态"
            : "GitHub 仓库任务未能完成，请检查配置与任务状态",
        },
      },
    };
  }

  if (error instanceof WebAiGovernanceError) {
    const status = error.code === "WEB_AI_JOB_NOT_FOUND" ? 404 : 409;
    const message = error.code === "WEB_AI_CONSENT_REQUIRED"
      ? "请先确认本次内容会发送给所选模型供应商"
      : "AI 任务状态已变化，请刷新后重试";
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof WebMemoryIndexError) {
    const messages = {
      MEMORY_INDEX_EMPTY: "当前没有可建立索引的项目资料或仓库内容",
      MEMORY_INDEX_TOO_LARGE: "当前索引输入超过单次安全上限",
      MEMORY_INDEX_INPUT_INVALID: "索引输入或向量配置无效",
      MEMORY_INDEX_ROUTE_MISSING: "请先配置项目向量路由",
      MEMORY_INDEX_PROVIDER_UNAVAILABLE: "当前向量供应商未验证或已停用",
      MEMORY_INDEX_INCREMENTAL_BASELINE_REQUIRED: "增量构建需要一代兼容且带完整指纹的活动索引，请先执行全量构建",
      MEMORY_INDEX_PLAN_STALE: "索引计划已变化，请重新读取计划并确认后再构建",
      MEMORY_INDEX_DEADLINE_EXCEEDED: "当前索引规模无法在单次请求期限内安全完成",
      MEMORY_INDEX_ALREADY_RUNNING: "项目已有索引构建正在进行或等待人工收口",
      MEMORY_INDEX_RECONCILIATION_REQUIRED: "该索引结果尚未完成协调确认",
      MEMORY_INDEX_PUBLICATION_CONFLICT: "索引发布发生并发冲突，请重试",
    } as const;
    const status = [
      "MEMORY_INDEX_PLAN_STALE",
      "MEMORY_INDEX_ALREADY_RUNNING",
      "MEMORY_INDEX_RECONCILIATION_REQUIRED",
      "MEMORY_INDEX_PUBLICATION_CONFLICT",
    ].includes(error.code) ? 409 : 422;
    return { status, body: { error: { code: error.code, message: messages[error.code] } } };
  }

  if (error instanceof WebAutoExtractError) {
    const messages = {
      AUTO_EXTRACT_INVALID_INPUT: "自动抽取输入无效",
      AUTO_EXTRACT_SOURCE_NOT_FOUND: "一个或多个资料不存在",
      AUTO_EXTRACT_SOURCE_TOO_LARGE: "所选资料超过单次抽取上限",
      AUTO_EXTRACT_INVALID_MODEL_OUTPUT: "模型返回的 JSON 结构不完整或无法验证；可减少单次资料量、缩短资料或切换生成模型后重试",
      AUTO_EXTRACT_SOURCE_EXCERPT_MISMATCH: "模型候选无法精确回溯到原文；系统未写入这些候选，请缩小资料范围或切换生成模型后重试",
      AUTO_EXTRACT_CANDIDATE_CONFLICT: "候选已被其他操作更新，请刷新",
    } as const;
    const status = error.code.includes("CONFLICT") ? 409 : 422;
    return { status, body: { error: { code: error.code, message: messages[error.code] } } };
  }

  if (error instanceof WebRagError) {
    const messages = {
      SEMANTIC_INDEX_NOT_READY: "请先使用当前向量模型建立项目索引",
      SEMANTIC_QUERY_INVALID: "检索问题无效",
      SEMANTIC_QUERY_VECTOR_INVALID: "查询向量无法验证",
      RAG_INVALID_MODEL_OUTPUT: "模型未返回可验证的引用式回答",
      RAG_INVALID_CITATION: "模型引用了检索范围之外的证据",
    } as const;
    return { status: 422, body: { error: { code: error.code, message: messages[error.code] } } };
  }

  if (error instanceof ProjectIntelligenceError) {
    const mapping = {
      PROJECT_INTELLIGENCE_INVALID_INPUT: [400, "项目智能分析输入无效"],
      PROJECT_INTELLIGENCE_INVALID_PLAN: [422, "模型未返回可执行的只读调查计划"],
      PROJECT_INTELLIGENCE_INVALID_MODEL_OUTPUT: [422, "模型未返回可验证的项目分析"],
      PROJECT_INTELLIGENCE_INVALID_CITATION: [422, "模型引用了本次调查范围之外的证据"],
      PROJECT_INTELLIGENCE_EVIDENCE_EMPTY: [422, "当前没有足够的项目证据"],
    } as const;
    const [status, message] = mapping[error.code];
    return { status, body: { error: { code: error.code, message } } };
  }

  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      },
    },
  };
}
