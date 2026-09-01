import { GIT_REPOSITORY_SCAN_POLICY } from "@/lib/git/scan-policy";

export type ProjectJobFailurePresentation = Readonly<{
  code: string | null;
  summary: string;
  action: string;
}>;

type FailureCopy = Readonly<Omit<ProjectJobFailurePresentation, "code">>;

const SAFE_FAILURE_CODE = /^[A-Z0-9_]{3,64}$/u;
const SCAN_FILE_LIMIT = GIT_REPOSITORY_SCAN_POLICY.maxScannedFiles.toLocaleString("zh-CN");
const SCAN_FILE_BYTES = `${GIT_REPOSITORY_SCAN_POLICY.maxFileBytes / 1024} KiB`;
const SCAN_TOTAL_BYTES = `${GIT_REPOSITORY_SCAN_POLICY.maxTotalBytes / 1024 / 1024} MiB`;

const FAILURE_COPY: Readonly<Record<string, FailureCopy>> = Object.freeze({
  GIT_CONNECTION_INVALID_INPUT: {
    summary: "Git 服务配置不完整或格式不正确。",
    action: "检查服务地址、认证方式和必填字段后重新验证连接。",
  },
  GIT_CONNECTION_NOT_FOUND: {
    summary: "项目关联的 Git 服务已不存在。",
    action: "重新选择一个可用的 Git 服务并关联仓库。",
  },
  GIT_CONNECTION_NAME_CONFLICT: {
    summary: "已经存在同名的 Git 服务连接。",
    action: "使用不同名称，或更新已有连接。",
  },
  GIT_CONNECTION_IN_USE: {
    summary: "该 Git 服务仍被项目仓库使用，当前不能停用。",
    action: "先处理关联仓库，再停用连接。",
  },
  GIT_CONNECTION_DISABLED: {
    summary: "项目关联的 Git 服务已停用。",
    action: "先在连接器中启用并重新验证该服务，再发起扫描。",
  },
  GIT_REPOSITORY_NOT_FOUND: {
    summary: "未找到指定仓库，或当前凭据没有读取权限。",
    action: "核对仓库路径、分支和只读凭据权限后重试。",
  },
  GIT_REPOSITORY_CONFLICT: {
    summary: "这个项目已经关联了同一仓库。",
    action: "直接使用现有仓库卡片配置或发起扫描。",
  },
  GIT_REPOSITORY_EMPTY: {
    summary: "所选分支没有可扫描的 Git 内容。",
    action: "确认分支名称正确且已经包含提交和文件。",
  },
  GIT_REPOSITORY_BINARY_ONLY: {
    summary: "当前扫描范围内没有可识别的文本文件；文件可能均为二进制、过大或被排除。",
    action: "在“配置扫描范围”中调整包含目录和排除规则后重新扫描。",
  },
  GIT_REPOSITORY_TOO_LARGE: {
    summary: `扫描范围超过当前安全上限：最多 ${SCAN_FILE_LIMIT} 个文本文件、单文件 ${SCAN_FILE_BYTES}、文本合计 ${SCAN_TOTAL_BYTES}。`,
    action: "在仓库的“配置扫描范围”中缩小包含目录或增加排除规则后重新扫描。",
  },
  GIT_REPOSITORY_LINK_NOT_FOUND: {
    summary: "项目中的仓库关联已不存在。",
    action: "重新关联仓库后再发起扫描。",
  },
  GIT_REPOSITORY_LINK_DISABLED: {
    summary: "该项目仓库已停用，当前不能扫描。",
    action: "启用或重新关联仓库后再试。",
  },
  GIT_REPOSITORY_SYNC_FAILED: {
    summary: "仓库扫描发生未分类错误，本次快照没有发布。",
    action: "重新验证连接后再试；若持续出现，请将错误代码交给管理员排查。",
  },
  GIT_REMOTE_UNAVAILABLE: {
    summary: "无法连接远端仓库，仓库地址、分支或服务网络可能不可用。",
    action: "重新验证 Git 服务，并核对仓库路径和跟踪分支。",
  },
  GIT_AUTHENTICATION_FAILED: {
    summary: "远端仓库拒绝了当前凭据。",
    action: "更新具有只读仓库权限的凭据并重新验证连接。",
  },
  GIT_HOST_KEY_REJECTED: {
    summary: "SSH 主机密钥校验失败。",
    action: "核对连接器中配置的 SSH known host，确认主机身份后再更新。",
  },
  GIT_OPERATION_TIMEOUT: {
    summary: "仓库读取超过执行时限，未能完成扫描。",
    action: "检查网络状态并缩小扫描范围，然后手动重试。",
  },
  GIT_OUTPUT_TOO_LARGE: {
    summary: "Git 返回的数据超过单次读取安全上限。",
    action: "缩小包含目录或增加排除规则后重新扫描。",
  },
  GIT_OPERATION_FAILED: {
    summary: "Git 操作没有成功，远端未返回可安全分类的具体原因。",
    action: "重新验证连接并核对仓库和分支；若持续出现，请将错误代码交给管理员排查。",
  },
  GIT_EXECUTABLE_UNAVAILABLE: {
    summary: "运行环境中无法使用 Git 执行程序。",
    action: "请管理员检查服务运行环境中的 Git 安装。",
  },
  GIT_SCAN_SCOPE_INVALID: {
    summary: "扫描目录或排除规则格式不正确。",
    action: "检查“配置扫描范围”中的路径和规则后重新保存。",
  },
  GIT_BASE_URL_INVALID: {
    summary: "Git 服务地址格式不正确或包含不允许的参数。",
    action: "使用规范的 HTTPS 或 SSH 服务根地址后重新验证。",
  },
  GIT_REPOSITORY_PATH_INVALID: {
    summary: "仓库路径格式不正确。",
    action: "使用“组织/仓库”格式，不要包含协议、查询参数或上级目录。",
  },
  GIT_REF_INVALID: {
    summary: "跟踪分支名称格式不正确。",
    action: "填写远端已经存在的普通分支名称后重新验证。",
  },
  GIT_HOST_UNRESOLVED: {
    summary: "无法解析 Git 服务的主机地址。",
    action: "检查服务域名和 DNS 后重新验证连接。",
  },
  GIT_NETWORK_BLOCKED: {
    summary: "Git 服务地址被网络安全策略阻止。",
    action: "核对服务地址；若确需访问私有网络，请由管理员明确启用并重新验证。",
  },
  GIT_NETWORK_CHANGED: {
    summary: "Git 服务解析出的网络地址与上次验证不一致。",
    action: "重新验证连接，确认新的服务地址可信后再扫描。",
  },
  GIT_TLS_CA_INVALID: {
    summary: "Git 服务的 TLS CA 证书配置无效。",
    action: "检查连接器中的 CA 证书后重新验证。",
  },
  GIT_SSH_KNOWN_HOST_INVALID: {
    summary: "SSH known host 配置无效。",
    action: "使用服务方公布的主机密钥重新配置连接器。",
  },
  GITHUB_DISABLED: {
    summary: "GitHub 连接器当前未启用。",
    action: "先启用连接器并完成只读凭据配置。",
  },
  GITHUB_CREDENTIAL_UNAVAILABLE: {
    summary: "没有可用的 GitHub 只读凭据。",
    action: "配置或更新 fine-grained PAT，并验证仓库读取权限。",
  },
  GITHUB_ACCESS_UNKNOWN: {
    summary: "GitHub 没有返回可安全确认的访问结果。",
    action: "检查仓库权限和连接状态，并在任务详情中人工确认后再重试。",
  },
  GITHUB_RATE_LIMITED: {
    summary: "GitHub API 请求次数已达到当前限额。",
    action: "等待限额恢复后手动重试；不要连续重复发起扫描。",
  },
  GITHUB_REQUEST_TIMEOUT: {
    summary: "GitHub 请求超时，扫描结果没有完成。",
    action: "检查网络状态，等待服务恢复后手动重试。",
  },
  GITHUB_REQUEST_FAILED: {
    summary: "GitHub 请求失败，未能读取完整扫描数据。",
    action: "重新验证连接和仓库权限，确认 GitHub 可用后再试。",
  },
  GITHUB_RESPONSE_TOO_LARGE: {
    summary: "GitHub 返回的数据超过单次读取安全上限。",
    action: "缩小扫描目录或减少启用的资料类型后重新扫描。",
  },
  GITHUB_INVALID_RESPONSE: {
    summary: "GitHub 返回的数据格式不符合预期，系统未发布本次结果。",
    action: "稍后重试；若持续出现，请将错误代码交给管理员排查。",
  },
  GITHUB_REDIRECT_REJECTED: {
    summary: "GitHub 请求发生了不受信任的重定向。",
    action: "检查连接器地址，确认仅使用官方 GitHub API 端点。",
  },
  PROJECT_WORKFLOW_FAILED: {
    summary: "任务执行遇到未分类的内部错误，系统没有发布本次结果。",
    action: "可以手动重试一次；若再次失败，请将错误代码和执行阶段交给管理员排查。",
  },
});

function patternCopy(code: string): FailureCopy | null {
  if (code.includes("RECONCILIATION_REQUIRED") || code.includes("ACCESS_UNKNOWN")) {
    return {
      summary: "任务结果无法安全确认，系统没有自动发布或重试。",
      action: "打开任务详情核对执行记录，并通过人工协调关闭未知结果。",
    };
  }
  if (code.includes("RATE_LIMITED")) {
    return {
      summary: "外部服务请求次数达到当前限额。",
      action: "等待限额恢复后手动重试。",
    };
  }
  if (code.includes("CREDENTIAL") || code.includes("AUTHENTICATION")) {
    return {
      summary: "连接凭据缺失、失效或没有所需的只读权限。",
      action: "更新凭据并重新验证连接后再试。",
    };
  }
  if (code.includes("TIMEOUT") || code.includes("DEADLINE_EXCEEDED")) {
    return {
      summary: "外部读取超过执行时限，任务未能完成。",
      action: "检查网络与服务状态，必要时缩小范围后手动重试。",
    };
  }
  if (code.includes("TOO_LARGE")) {
    return {
      summary: "本次读取的数据超过安全上限，系统未发布不完整结果。",
      action: "缩小扫描范围或减少启用的资料类型后重新运行。",
    };
  }
  if (code.includes("LINK_INELIGIBLE") || code.includes("NO_ELIGIBLE") || code.includes("NO_ENABLED_TARGETS")) {
    return {
      summary: "当前没有满足条件且已启用的仓库或资料来源。",
      action: "检查仓库状态、读取权限和扫描开关后重新运行。",
    };
  }
  if (code.includes("IDENTITY_MISMATCH")) {
    return {
      summary: "扫描过程中检测到仓库身份或提交发生变化，结果已被拒绝。",
      action: "重新验证仓库身份和分支后发起一次新扫描。",
    };
  }
  if (code.includes("PUBLISH_CONFLICT") || code.includes("WRITE_CONFLICT")) {
    return {
      summary: "发布结果时检测到并发更新，本次结果没有覆盖现有数据。",
      action: "刷新项目状态后重新发起任务。",
    };
  }
  if (code.includes("INTEGRITY_ERROR")) {
    return {
      summary: "扫描结果未通过完整性校验，因此没有发布。",
      action: "重新发起任务；若持续出现，请将错误代码交给管理员排查。",
    };
  }
  if (code.includes("ALREADY_RUNNING") || code.includes("DIRECT_OPERATION_ACTIVE")) {
    return {
      summary: "同一项目已有互斥的仓库任务正在执行。",
      action: "等待当前任务结束后再试。",
    };
  }
  if (code.includes("SCANNER_UNAVAILABLE")) {
    return {
      summary: "仓库扫描器当前不可用，本次结果没有发布。",
      action: "稍后手动重试；若持续出现，请管理员检查扫描服务。",
    };
  }
  if (code.endsWith("_INVALID_INPUT") || code.endsWith("_INVALID_REQUEST")) {
    return {
      summary: "仓库扫描请求或已保存配置不符合当前要求。",
      action: "刷新页面，检查扫描范围与启用项后重新提交。",
    };
  }
  if (code.includes("NOT_FOUND")) {
    return {
      summary: "任务所需的项目、仓库或执行记录已经不存在。",
      action: "刷新页面并重新选择有效来源后再试。",
    };
  }
  if (code.endsWith("_FAILED")) {
    return {
      summary: "仓库任务执行失败，本次不完整结果没有发布。",
      action: "重新验证连接后再试；若持续出现，请将错误代码交给管理员排查。",
    };
  }
  return null;
}

export function projectJobFailurePresentation(value: unknown): ProjectJobFailurePresentation {
  const code = typeof value === "string" && SAFE_FAILURE_CODE.test(value) ? value : null;
  const copy = code === null ? null : FAILURE_COPY[code] ?? patternCopy(code);
  return Object.freeze({
    code,
    summary: copy?.summary ?? "任务未完成，系统没有可安全公开的更具体原因。",
    action: copy?.action ?? "打开任务详情查看执行阶段；若再次失败，请将错误代码交给管理员排查。",
  });
}
