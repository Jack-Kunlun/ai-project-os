import "dotenv/config";
import {
  MODEL_TRANSFER_CONSENT_VERSION,
  ProjectAiConfigError,
  createProjectAiConfigService,
} from "../src/lib/ai-memory";
import { getDb } from "../src/lib/db";
import {
  ProjectAiConfigCliError,
  parseProjectAiConfigArgs,
} from "./project-ai-config-contract";

const CONFIG_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  PROJECT_AI_CONFIG_INVALID_INPUT: "配置输入无效",
  PROJECT_NOT_FOUND: "项目不存在",
  SOURCE_NOT_FOUND: "至少一个来源不存在或不属于该项目",
  SOURCE_CHANGED: "至少一个来源内容与其指纹不一致",
  SOURCE_SCAN_BLOCKED: "至少一个来源未通过本地敏感信息扫描",
  SOURCE_TOO_LARGE: "至少一个来源超过受控抽取大小限制",
  PROJECT_AI_CONFIG_WRITE_CONFLICT: "配置发生并发冲突，请重试",
});

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  let db: ReturnType<typeof getDb> | undefined;
  try {
    const command = parseProjectAiConfigArgs(process.argv.slice(2));
    db = getDb();
    const service = createProjectAiConfigService({ db });
    const aiMemory = command.operation === "status"
      ? await service.getStatus(command.projectId)
      : command.operation === "revoke"
        ? await service.revoke(command.projectId)
        : await service.configure({
            projectId: command.projectId,
            sourceIds: command.sourceIds,
            consentVersion: MODEL_TRANSFER_CONSENT_VERSION,
            acknowledgeExternalModelTransfer: true,
          });
    printJson({ ok: true, operation: command.operation, aiMemory });
  } catch (error) {
    if (error instanceof ProjectAiConfigCliError) {
      printJson({
        ok: false,
        error: { code: error.code, message: error.message },
      });
    } else if (error instanceof ProjectAiConfigError) {
      printJson({
        ok: false,
        error: {
          code: error.code,
          message: CONFIG_ERROR_MESSAGES[error.code] ?? "AI 记忆配置失败",
        },
      });
    } else {
      printJson({
        ok: false,
        error: {
          code: "PROJECT_AI_CONFIG_FAILED",
          message: "AI 记忆配置失败",
        },
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
