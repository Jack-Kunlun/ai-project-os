import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import {
  ProjectSearchError,
  createProjectSearchService,
  type ProjectQueryEmbedding,
} from "../src/lib/ai-memory";
import { getDb } from "../src/lib/db";
import {
  ProjectMemorySearchCliError,
  parseProjectMemorySearchArgs,
} from "./project-memory-search-contract";

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PROJECT_SEARCH_INVALID_INPUT: "搜索输入无效",
  PROJECT_SEARCH_PROJECT_NOT_FOUND: "项目不存在",
  PROJECT_SEARCH_SNAPSHOT_NOT_READY: "项目还没有可查询的 RAG 快照",
  PROJECT_SEARCH_SNAPSHOT_INELIGIBLE: "项目 RAG 快照已失去查询资格",
  PROJECT_SEARCH_SNAPSHOT_TOO_LARGE: "项目 RAG 快照超过当前检索规模限制",
  PROJECT_SEARCH_SNAPSHOT_CONFLICT: "项目 RAG 快照不一致，需要重新构建",
});

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function readQueryEmbedding(path: string | null): Promise<ProjectQueryEmbedding | undefined> {
  if (path === null) return undefined;
  const file = await stat(path);
  if (!file.isFile() || file.size <= 0 || file.size > 64_000) {
    throw new ProjectMemorySearchCliError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new ProjectMemorySearchCliError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProjectMemorySearchCliError();
  }
  return parsed as ProjectQueryEmbedding;
}

async function main(): Promise<void> {
  let db: ReturnType<typeof getDb> | undefined;
  try {
    const command = parseProjectMemorySearchArgs(process.argv.slice(2));
    const queryEmbedding = await readQueryEmbedding(command.queryVectorFile);
    db = getDb();
    const search = await createProjectSearchService({ db }).search({
      projectId: command.projectId,
      query: command.query,
      take: command.take,
      queryEmbedding,
    });
    printJson({ ok: true, search });
  } catch (error) {
    if (error instanceof ProjectMemorySearchCliError) {
      printJson({ ok: false, error: { code: error.code, message: error.message } });
    } else if (error instanceof ProjectSearchError) {
      printJson({
        ok: false,
        error: {
          code: error.code,
          message: ERROR_MESSAGES[error.code] ?? "项目记忆搜索失败",
        },
      });
    } else {
      printJson({
        ok: false,
        error: { code: "PROJECT_MEMORY_SEARCH_FAILED", message: "项目记忆搜索失败" },
      });
    }
    process.exitCode = 1;
  } finally {
    if (db !== undefined) {
      try {
        await db.$disconnect();
      } catch {
        // Keep the safe operation result; connection-close details are internal.
      }
    }
  }
}

await main();
