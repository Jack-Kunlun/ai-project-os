import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import {
  PROJECT_QUERY_TRANSFER_CONSENT_VERSION,
  ProjectQueryEmbeddingError,
  ProjectSearchError,
  createOpenAiProjectQueryEmbedding,
  createProjectSearchService,
  type ProjectQueryEmbedding,
} from "../src/lib/ai-memory";
import {
  checkAiRuntimeAvailability,
  loadAiRuntimeConfig,
  loadOpenAiCredential,
} from "../src/lib/ai-runtime";
import { getDb } from "../src/lib/db";
import {
  ProjectRepositorySearchError,
  createProjectRepositorySearchService,
} from "../src/lib/github";
import {
  ProjectMemorySearchCliError,
  parseProjectMemorySearchArgs,
} from "./project-memory-search-contract";
import { readCliArguments } from "./cli-arguments";

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PROJECT_SEARCH_INVALID_INPUT: "搜索输入无效",
  PROJECT_SEARCH_PROJECT_NOT_FOUND: "项目不存在",
  PROJECT_SEARCH_SNAPSHOT_NOT_READY: "项目还没有可查询的 RAG 快照",
  PROJECT_SEARCH_SNAPSHOT_INELIGIBLE: "项目 RAG 快照已失去查询资格",
  PROJECT_SEARCH_SNAPSHOT_TOO_LARGE: "项目 RAG 快照超过当前检索规模限制",
  PROJECT_SEARCH_SNAPSHOT_CONFLICT: "项目 RAG 快照不一致，需要重新构建",
  PROJECT_REPOSITORY_SEARCH_INVALID_INPUT: "跨仓库搜索输入无效",
  PROJECT_REPOSITORY_SEARCH_PROJECT_NOT_FOUND: "项目不存在",
  PROJECT_REPOSITORY_SEARCH_SNAPSHOT_NOT_READY: "项目还没有跨仓库 RAG 快照",
  PROJECT_REPOSITORY_SEARCH_SNAPSHOT_INELIGIBLE: "跨仓库 RAG 快照已失去查询资格",
  PROJECT_REPOSITORY_SEARCH_SCOPE_TOO_LARGE: "跨仓库 RAG 快照超过当前检索规模限制",
  PROJECT_REPOSITORY_SEARCH_SNAPSHOT_CONFLICT: "跨仓库 RAG 快照不一致，需要重新构建",
  PROJECT_QUERY_EMBEDDING_INVALID_INPUT: "查询向量输入无效",
  PROJECT_QUERY_EMBEDDING_PROVIDER_FAILED: "查询向量生成失败",
  AI_DISABLED: "AI 运行时未启用",
  AI_PROVIDER_DISABLED: "OpenAI 运行时或凭据未就绪",
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
    const command = parseProjectMemorySearchArgs(readCliArguments());
    let queryEmbedding = await readQueryEmbedding(command.queryVectorFile);
    db = getDb();
    const repositoryPointer = command.scope === "project"
      ? null
      : await db.projectRepositoryRagSnapshotPointer.findUnique({
          where: { projectId: command.projectId },
          select: { projectRepositoryRagSnapshotId: true },
        });
    const useRepositories = command.scope === "repositories" ||
      (command.scope === "auto" && repositoryPointer !== null);

    if (command.generateQueryEmbedding) {
      const validateSnapshot = useRepositories
        ? createProjectRepositorySearchService({ db }).search({
            projectId: command.projectId,
            query: command.query,
            take: 1,
          })
        : createProjectSearchService({ db }).search({
            projectId: command.projectId,
            query: command.query,
            take: 1,
          });
      await validateSnapshot;
      const availability = checkAiRuntimeAvailability(loadAiRuntimeConfig());
      if (!availability.available) {
        throw new ProjectQueryEmbeddingError(
          "PROJECT_QUERY_EMBEDDING_PROVIDER_FAILED",
          availability.errorCode,
        );
      }
      const credential = loadOpenAiCredential();
      if (credential === null) {
        throw new ProjectQueryEmbeddingError(
          "PROJECT_QUERY_EMBEDDING_PROVIDER_FAILED",
          "AI_PROVIDER_DISABLED",
        );
      }
      queryEmbedding = await createOpenAiProjectQueryEmbedding({
        query: command.query,
        consentVersion: PROJECT_QUERY_TRANSFER_CONSENT_VERSION,
        acknowledgeExternalQueryTransfer: true,
      }, credential);
    }

    const search = useRepositories
      ? await createProjectRepositorySearchService({ db }).search({
          projectId: command.projectId,
          query: command.query,
          take: command.take,
          queryEmbedding,
        })
      : await createProjectSearchService({ db }).search({
          projectId: command.projectId,
          query: command.query,
          take: command.take,
          queryEmbedding,
        });
    printJson({
      ok: true,
      scope: useRepositories ? "repositories" : "project",
      search,
    });
  } catch (error) {
    if (error instanceof ProjectMemorySearchCliError) {
      printJson({ ok: false, error: { code: error.code, message: error.message } });
    } else if (
      error instanceof ProjectSearchError ||
      error instanceof ProjectRepositorySearchError ||
      error instanceof ProjectQueryEmbeddingError
    ) {
      const code = error instanceof ProjectQueryEmbeddingError && error.safeCode !== null
        ? error.safeCode
        : error.code;
      printJson({
        ok: false,
        error: {
          code,
          message: ERROR_MESSAGES[code] ?? "项目记忆搜索失败",
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

void main();
