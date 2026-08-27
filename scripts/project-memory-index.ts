import "dotenv/config";
import {
  CorpusIndexError,
  createCorpusIndexService,
} from "../src/lib/ai-memory";
import {
  AiRuntimeServiceError,
  checkAiRuntimeAvailability,
  loadAiRuntimeConfig,
  loadOpenAiCredential,
} from "../src/lib/ai-runtime";
import { getDb } from "../src/lib/db";
import {
  RepositoryCodeIndexError,
  RepositoryMaterialIndexError,
  createRepositoryCodeIndexService,
  createRepositoryMaterialIndexService,
} from "../src/lib/github";
import {
  ProjectMemoryIndexCliError,
  parseProjectMemoryIndexArgs,
} from "./project-memory-index-contract";

const ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PROJECT_MEMORY_INDEX_CLI_INVALID_ARGUMENTS: "项目记忆索引命令参数无效",
  AI_DISABLED: "AI 运行时未启用",
  AI_PROVIDER_DISABLED: "OpenAI 运行时或凭据未就绪",
  AI_INVALID_OPERATION_KEY_INPUT: "模型传输计划无效",
  AI_INVALID_PROVIDER_RESPONSE: "模型服务返回了无法验证的响应",
  CORPUS_INDEX_INVALID_INPUT: "项目资料索引输入无效",
  CORPUS_INDEX_PROJECT_NOT_FOUND: "项目不存在",
  CORPUS_INDEX_GRANT_INELIGIBLE: "项目资料模型授权不可用",
  CORPUS_INDEX_CORPUS_NOT_FOUND: "项目资料语料不存在",
  CORPUS_INDEX_INDEX_NOT_FOUND: "项目资料索引不存在",
  CORPUS_INDEX_RECONCILIATION_REQUIRED: "项目资料索引需要人工对账",
  CORPUS_INDEX_BUILD_TERMINAL: "项目资料索引已进入终态",
  CORPUS_INDEX_CONFLICT: "项目资料索引边界不一致",
  CORPUS_INDEX_WRITE_CONFLICT: "项目资料索引发生并发冲突，请重试",
});

class ProjectMemoryIndexRuntimeError extends Error {
  constructor(readonly code: "AI_DISABLED" | "AI_PROVIDER_DISABLED") {
    super(code);
    this.name = "ProjectMemoryIndexRuntimeError";
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function safeErrorCode(error: unknown): string {
  return error instanceof ProjectMemoryIndexCliError ||
    error instanceof ProjectMemoryIndexRuntimeError ||
    error instanceof CorpusIndexError ||
    error instanceof RepositoryCodeIndexError ||
    error instanceof RepositoryMaterialIndexError ||
    error instanceof AiRuntimeServiceError
    ? error.code
    : "PROJECT_MEMORY_INDEX_FAILED";
}

async function main(): Promise<void> {
  let db: ReturnType<typeof getDb> | undefined;
  try {
    const command = parseProjectMemoryIndexArgs(process.argv.slice(2));
    const availability = checkAiRuntimeAvailability(loadAiRuntimeConfig());
    if (!availability.available) {
      throw new ProjectMemoryIndexRuntimeError(availability.errorCode);
    }
    const credential = loadOpenAiCredential();
    if (credential === null) {
      throw new ProjectMemoryIndexRuntimeError("AI_PROVIDER_DISABLED");
    }

    db = getDb();
    let prepared: unknown;
    let execution:
      | Awaited<ReturnType<ReturnType<typeof createCorpusIndexService>["executeProjectCorpusIndex"]>>
      | Awaited<ReturnType<ReturnType<typeof createRepositoryCodeIndexService>["executeRepositoryCodeIndex"]>>
      | Awaited<ReturnType<ReturnType<typeof createRepositoryMaterialIndexService>["executeRepositoryMaterialIndex"]>>;

    if (command.scope === "project") {
      const service = createCorpusIndexService({ db });
      const corpus = await service.ensureProjectCorpusGeneration({
        projectId: command.projectId,
        grantId: command.grantId,
      });
      const index = await service.prepareProjectCorpusIndex({
        projectId: command.projectId,
        corpusGenerationId: corpus.id,
      });
      prepared = { corpus, index };
      execution = await service.executeProjectCorpusIndex({
        projectId: command.projectId,
        indexGenerationId: index.id,
      }, credential);
    } else if (command.scope === "repository-code") {
      const service = createRepositoryCodeIndexService({ db });
      const index = await service.prepareRepositoryCodeIndex({
        projectId: command.projectId,
        projectRepositoryLinkId: command.linkId,
        grantId: command.grantId,
      });
      prepared = { index };
      execution = await service.executeRepositoryCodeIndex({
        projectId: command.projectId,
        projectRepositoryLinkId: command.linkId,
        indexGenerationId: index.id,
      }, credential);
    } else {
      const service = createRepositoryMaterialIndexService({ db });
      const index = await service.prepareRepositoryMaterialIndex({
        projectId: command.projectId,
        projectRepositoryLinkId: command.linkId,
        grantId: command.grantId,
      });
      prepared = { index };
      execution = await service.executeRepositoryMaterialIndex({
        projectId: command.projectId,
        projectRepositoryLinkId: command.linkId,
        indexGenerationId: index.id,
      }, credential);
    }

    if (execution.kind !== "published") {
      printJson({
        ok: false,
        scope: command.scope,
        prepared,
        error: {
          code: execution.safeCode,
          message: "索引构建未发布，请按安全状态对账后重试",
        },
        execution,
      });
      process.exitCode = 1;
      return;
    }
    printJson({
      ok: true,
      scope: command.scope,
      prepared,
      execution,
    });
  } catch (error) {
    const code = safeErrorCode(error);
    printJson({
      ok: false,
      error: {
        code,
        message: ERROR_MESSAGES[code] ?? "项目记忆索引失败",
      },
    });
    process.exitCode = 1;
  } finally {
    if (db !== undefined) await db.$disconnect().catch(() => undefined);
  }
}

await main();
