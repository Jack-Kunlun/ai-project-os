import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import { getDb } from "../src/lib/db";
import {
  GitHubCodeScanServiceError,
  GitHubLedgerError,
  GitHubMaterialSyncServiceError,
  GitHubReadError,
  ProjectRepositoryStatusError,
  createGitHubCodeScanService,
  createGitHubMaterialSyncService,
  createGitHubReadOnlyClient,
  createGitHubRepositoryLedgerService,
  createProjectRepositoryStatusService,
  loadGitHubCredential,
} from "../src/lib/github";
import {
  GitHubRepositoryCliError,
  parseGitHubRepositoryArgs,
} from "./github-repository-contract";
import { readCliArguments } from "./cli-arguments";

const MAX_CONFIG_FILE_BYTES = 64_000;
const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  GITHUB_REPOSITORY_CLI_INVALID_ARGUMENTS: "GitHub 仓库命令参数无效",
  GITHUB_DISABLED: "GitHub 连接器未启用",
  GITHUB_CREDENTIAL_UNAVAILABLE: "GitHub 凭据不可用",
  GITHUB_INVALID_REQUEST: "GitHub 请求参数无效",
  GITHUB_ACCESS_UNKNOWN: "无法确认 GitHub 仓库读取权限",
  GITHUB_RATE_LIMITED: "GitHub 读取触发限流，请稍后重试",
  GITHUB_REDIRECT_REJECTED: "GitHub 请求发生了不允许的重定向",
  GITHUB_RESPONSE_TOO_LARGE: "GitHub 响应超过受控大小限制",
  GITHUB_INVALID_RESPONSE: "GitHub 返回了无法验证的响应",
  GITHUB_REQUEST_TIMEOUT: "GitHub 读取超时",
  GITHUB_REQUEST_FAILED: "GitHub 读取失败",
  GITHUB_LEDGER_INVALID_INPUT: "仓库连接配置无效",
  PROJECT_NOT_FOUND: "项目不存在",
  GITHUB_REPOSITORY_IDENTITY_MISMATCH: "GitHub 仓库身份不一致",
  GITHUB_LINK_NOT_FOUND: "仓库连接不存在",
  GITHUB_LINK_UNLINKED: "仓库连接已解除",
  GITHUB_LEDGER_WRITE_CONFLICT: "仓库连接发生并发冲突，请重试",
  GITHUB_LEDGER_INTEGRITY_ERROR: "仓库连接账本不一致",
  PROJECT_REPOSITORY_STATUS_INVALID_INPUT: "仓库记忆状态输入无效",
  PROJECT_REPOSITORY_STATUS_PROJECT_NOT_FOUND: "项目不存在",
  PROJECT_REPOSITORY_STATUS_CONFLICT: "仓库记忆状态不一致",
});

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  const file = await stat(path);
  if (!file.isFile() || file.size < 2 || file.size > MAX_CONFIG_FILE_BYTES) {
    throw new GitHubRepositoryCliError();
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new GitHubRepositoryCliError();
  }
  if (!isPlainRecord(value)) throw new GitHubRepositoryCliError();
  return value;
}

async function requireClient() {
  const credential = await loadGitHubCredential();
  if (credential === null) throw new GitHubReadError("GITHUB_DISABLED");
  return createGitHubReadOnlyClient({ credential });
}

async function main(): Promise<void> {
  let db: ReturnType<typeof getDb> | undefined;
  try {
    const command = parseGitHubRepositoryArgs(readCliArguments());
    db = getDb();
    const ledger = createGitHubRepositoryLedgerService({ db });
    let result: unknown;
    switch (command.operation) {
      case "list":
        result = await ledger.list(command.projectId);
        break;
      case "status":
        result = await createProjectRepositoryStatusService({ db })
          .getStatus(command.projectId);
        break;
      case "disable":
        result = await ledger.disable({
          projectId: command.projectId,
          linkId: command.linkId,
        });
        break;
      case "unlink":
        result = await ledger.unlink({
          projectId: command.projectId,
          linkId: command.linkId,
        });
        break;
      case "connect": {
        const client = await requireClient();
        const [repository, config] = await Promise.all([
          client.getRepository({
            owner: command.owner,
            repository: command.repository,
          }),
          readConfig(command.configFile),
        ]);
        result = await ledger.connect({
          projectId: command.projectId,
          repository,
          config,
        });
        break;
      }
      case "scan-code": {
        const client = await requireClient();
        result = await createGitHubCodeScanService({ db, client })
          .scanProject(command.projectId);
        break;
      }
      case "sync-material": {
        const client = await requireClient();
        result = await createGitHubMaterialSyncService({ db, client })
          .syncRepository({
            projectId: command.projectId,
            linkId: command.linkId,
          });
        break;
      }
    }
    printJson({ ok: true, operation: command.operation, result });
  } catch (error) {
    const code = error instanceof GitHubRepositoryCliError ||
      error instanceof GitHubReadError ||
      error instanceof GitHubLedgerError ||
      error instanceof GitHubCodeScanServiceError ||
      error instanceof GitHubMaterialSyncServiceError ||
      error instanceof ProjectRepositoryStatusError
      ? error.code
      : "GITHUB_REPOSITORY_FAILED";
    printJson({
      ok: false,
      error: {
        code,
        message: ERROR_MESSAGES[code] ?? "GitHub 仓库操作失败",
      },
    });
    process.exitCode = 1;
  } finally {
    if (db !== undefined) await db.$disconnect().catch(() => undefined);
  }
}

void main();
