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
} from "@/lib/github";
import { ProjectAiRouteError } from "@/lib/project-ai-routes";
import { WebGitHubError } from "@/lib/web-github";
import { WebAiGovernanceError } from "@/lib/web-ai-governance";
import { WebAutoExtractError } from "@/lib/web-auto-extract";
import { WebMemoryIndexError } from "@/lib/web-memory-index";
import { ProjectIntelligenceError } from "@/lib/web-project-intelligence";
import { WebRagError } from "@/lib/web-rag";

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
  if (error instanceof AuthError) {
    const mapping = {
      AUTH_INVALID_INPUT: [400, "账户或登录信息格式无效"],
      AUTH_ALREADY_INITIALIZED: [409, "应用已经完成初始化"],
      AUTH_INVALID_CREDENTIALS: [401, "用户名或密码错误"],
      AUTH_CURRENT_PASSWORD_INVALID: [401, "当前密码不正确"],
      AUTH_PASSWORD_UNCHANGED: [400, "新密码不能与当前密码相同"],
      AUTH_REQUIRED: [401, "请先登录"],
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
      AI_PROVIDER_IN_USE: [409, "供应商仍被项目路由使用，无法停用"],
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
    error instanceof GitHubMaterialSyncServiceError
  ) {
    const notFound = error.code.includes("NOT_FOUND") || error.code.includes("PROJECT_NOT_FOUND");
    const conflict = error.code.includes("CONFLICT") || error.code.includes("ALREADY_RUNNING");
    return {
      status: notFound ? 404 : conflict ? 409 : 422,
      body: { error: { code: error.code, message: "GitHub 仓库任务未能完成，请检查配置与任务状态" } },
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
      MEMORY_INDEX_PUBLICATION_CONFLICT: "索引发布发生并发冲突，请重试",
    } as const;
    const status = error.code === "MEMORY_INDEX_PUBLICATION_CONFLICT" ? 409 : 422;
    return { status, body: { error: { code: error.code, message: messages[error.code] } } };
  }

  if (error instanceof WebAutoExtractError) {
    const messages = {
      AUTO_EXTRACT_INVALID_INPUT: "自动抽取输入无效",
      AUTO_EXTRACT_SOURCE_NOT_FOUND: "一个或多个资料不存在",
      AUTO_EXTRACT_SOURCE_TOO_LARGE: "所选资料超过单次抽取上限",
      AUTO_EXTRACT_INVALID_MODEL_OUTPUT: "模型未返回可验证的结构化候选",
      AUTO_EXTRACT_SOURCE_EXCERPT_MISMATCH: "模型候选无法精确回溯到原文",
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
