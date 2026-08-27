import "dotenv/config";
import { getDb } from "../src/lib/db";
import {
  RepositoryRagSnapshotError,
  createRepositoryRagSnapshotService,
} from "../src/lib/github";
import {
  ProjectMemoryPublishCliError,
  parseProjectMemoryPublishArgs,
} from "./project-memory-publish-contract";
import { readCliArguments } from "./cli-arguments";

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PROJECT_MEMORY_PUBLISH_CLI_INVALID_ARGUMENTS: "项目记忆快照命令参数无效",
  REPOSITORY_RAG_SNAPSHOT_INVALID_INPUT: "记忆快照输入无效",
  REPOSITORY_RAG_SNAPSHOT_PROJECT_NOT_FOUND: "项目不存在",
  REPOSITORY_RAG_SNAPSHOT_LINK_NOT_FOUND: "仓库连接不存在",
  REPOSITORY_RAG_SNAPSHOT_LINK_INELIGIBLE: "仓库连接当前不可发布",
  REPOSITORY_RAG_SNAPSHOT_POLICY_INELIGIBLE: "项目 AI 策略当前不可发布",
  REPOSITORY_RAG_SNAPSHOT_INDEX_NOT_READY: "仓库所需索引尚未全部就绪",
  REPOSITORY_RAG_SNAPSHOT_REQUIRED_REPOSITORIES_NOT_CONFIGURED:
    "项目尚未配置必需仓库",
  REPOSITORY_RAG_SNAPSHOT_NOT_FOUND: "记忆快照不存在",
  REPOSITORY_RAG_SNAPSHOT_BOUNDARY_CONFLICT: "记忆快照边界不一致",
  REPOSITORY_RAG_SNAPSHOT_WRITE_CONFLICT: "记忆快照发生并发冲突，请重试",
});

async function main(): Promise<void> {
  let db: ReturnType<typeof getDb> | undefined;
  try {
    const command = parseProjectMemoryPublishArgs(readCliArguments());
    db = getDb();
    const service = createRepositoryRagSnapshotService({ db });
    const snapshot = command.scope === "repository"
      ? await service.publishRepository({
          projectId: command.projectId,
          projectRepositoryLinkId: command.linkId,
        })
      : await service.publishProject({ projectId: command.projectId });
    console.log(JSON.stringify({
      ok: true,
      scope: command.scope,
      snapshot,
    }, null, 2));
  } catch (error) {
    const code = error instanceof ProjectMemoryPublishCliError ||
      error instanceof RepositoryRagSnapshotError
      ? error.code
      : "PROJECT_MEMORY_PUBLISH_FAILED";
    console.log(JSON.stringify({
      ok: false,
      error: {
        code,
        message: ERROR_MESSAGES[code] ?? "项目记忆快照发布失败",
      },
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (db !== undefined) await db.$disconnect().catch(() => undefined);
  }
}

void main();
