import "dotenv/config";
import { getDb } from "../src/lib/db";
import {
  RepositoryMaterialModelGrantError,
  createRepositoryMaterialModelGrantService,
} from "../src/lib/github";
import {
  RepositoryMaterialModelGrantCliError,
  parseRepositoryMaterialModelGrantArgs,
} from "./repository-material-model-grant-contract";
import { readCliArguments } from "./cli-arguments";

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  REPOSITORY_MATERIAL_MODEL_GRANT_INVALID_INPUT: "授权输入无效",
  REPOSITORY_MATERIAL_MODEL_GRANT_PROJECT_NOT_FOUND: "项目不存在",
  REPOSITORY_MATERIAL_MODEL_GRANT_LINK_NOT_FOUND: "仓库连接不存在",
  REPOSITORY_MATERIAL_MODEL_GRANT_LINK_INELIGIBLE: "仓库连接当前不可用于资料模型处理",
  REPOSITORY_MATERIAL_MODEL_GRANT_MATERIAL_NOT_READY: "仓库资料快照尚未就绪",
  REPOSITORY_MATERIAL_MODEL_GRANT_POLICY_INELIGIBLE: "项目模型策略未启用该处理能力",
  REPOSITORY_MATERIAL_MODEL_GRANT_WRITE_CONFLICT: "资料授权发生并发冲突，请重试",
});

async function main(): Promise<void> {
  let db: ReturnType<typeof getDb> | undefined;
  try {
    const command = parseRepositoryMaterialModelGrantArgs(readCliArguments());
    db = getDb();
    const service = createRepositoryMaterialModelGrantService({ db });
    const status = command.operation === "issue"
      ? await service.issue(command.request)
      : command.operation === "revoke"
        ? await service.revoke({
            projectId: command.projectId,
            projectRepositoryLinkId: command.projectRepositoryLinkId,
          })
        : await service.getStatus({
            projectId: command.projectId,
            projectRepositoryLinkId: command.projectRepositoryLinkId,
          });
    console.log(JSON.stringify({ ok: true, operation: command.operation, status }, null, 2));
  } catch (error) {
    const code = error instanceof RepositoryMaterialModelGrantCliError ||
      error instanceof RepositoryMaterialModelGrantError
      ? error.code
      : "REPOSITORY_MATERIAL_MODEL_GRANT_FAILED";
    console.log(JSON.stringify({
      ok: false,
      error: { code, message: ERROR_MESSAGES[code] ?? "仓库资料模型授权失败" },
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (db !== undefined) await db.$disconnect().catch(() => undefined);
  }
}

void main();
