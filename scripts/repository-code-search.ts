import "dotenv/config";
import { getDb } from "../src/lib/db";
import {
  RepositoryCodeSearchError,
  createRepositoryCodeSearchService,
} from "../src/lib/github";
import {
  RepositoryCodeSearchCliError,
  parseRepositoryCodeSearchArgs,
} from "./repository-code-search-contract";
import { readCliArguments } from "./cli-arguments";

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  REPOSITORY_CODE_SEARCH_INVALID_INPUT: "搜索输入无效",
  REPOSITORY_CODE_SEARCH_PROJECT_NOT_FOUND: "项目不存在",
  REPOSITORY_CODE_SEARCH_LINK_NOT_FOUND: "仓库连接不存在",
  REPOSITORY_CODE_SEARCH_SNAPSHOT_NOT_READY: "项目还没有一致的代码快照",
  REPOSITORY_CODE_SEARCH_SNAPSHOT_INELIGIBLE: "代码快照因仓库范围或策略变化已失效",
  REPOSITORY_CODE_SEARCH_SCOPE_TOO_LARGE: "代码范围过大，请收窄 include roots",
  REPOSITORY_CODE_SEARCH_CONFLICT: "代码快照不一致，需要重新扫描",
});

async function main(): Promise<void> {
  let db: ReturnType<typeof getDb> | undefined;
  try {
    const command = parseRepositoryCodeSearchArgs(readCliArguments());
    db = getDb();
    const result = await createRepositoryCodeSearchService({ db }).search({
      projectId: command.projectId,
      query: command.query,
      take: command.take,
      scope: command.projectRepositoryLinkId === null
        ? { kind: "project" }
        : { kind: "repository", projectRepositoryLinkId: command.projectRepositoryLinkId },
    });
    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } catch (error) {
    const code = error instanceof RepositoryCodeSearchCliError ||
      error instanceof RepositoryCodeSearchError
      ? error.code
      : "REPOSITORY_CODE_SEARCH_FAILED";
    console.log(JSON.stringify({
      ok: false,
      error: { code, message: ERROR_MESSAGES[code] ?? "仓库代码搜索失败" },
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (db !== undefined) await db.$disconnect().catch(() => undefined);
  }
}

void main();
