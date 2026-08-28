import { ZodError } from "zod";
import { AuthError } from "@/lib/auth";
import { CredentialVaultError } from "@/lib/credential-vault";
import { ProviderServiceError, ProviderTransportError } from "@/lib/ai-providers";

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
      AUTH_INVALID_INPUT: [400, "初始化或登录信息无效"],
      AUTH_ALREADY_INITIALIZED: [409, "应用已经完成初始化"],
      AUTH_INVALID_CREDENTIALS: [401, "用户名或密码错误"],
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
