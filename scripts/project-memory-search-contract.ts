import { isAbsolute } from "node:path";
import { PROJECT_QUERY_TRANSFER_CONSENT_VERSION } from "../src/lib/ai-memory";

export class ProjectMemorySearchCliError extends Error {
  readonly code = "PROJECT_MEMORY_SEARCH_CLI_INVALID" as const;

  constructor() {
    super("搜索参数无效");
    this.name = "ProjectMemorySearchCliError";
  }
}

export type ProjectMemorySearchCommand = Readonly<{
  projectId: string;
  query: string;
  take: number;
  queryVectorFile: string | null;
  scope: "auto" | "project" | "repositories";
  generateQueryEmbedding: boolean;
}>;

function fail(): never {
  throw new ProjectMemorySearchCliError();
}

export function parseProjectMemorySearchArgs(
  args: readonly string[],
): ProjectMemorySearchCommand {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--project-id",
    "--query",
    "--take",
    "--query-vector-file",
    "--scope",
    "--acknowledge-external-query-transfer",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !allowed.has(key) ||
      values.has(key) ||
      value.length === 0 ||
      value.includes("\0")
    ) {
      return fail();
    }
    values.set(key, value);
  }
  const projectId = values.get("--project-id");
  const query = values.get("--query");
  if (
    projectId === undefined ||
    query === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(projectId) ||
    query.trim().length === 0 ||
    Buffer.byteLength(query, "utf8") > 2_000
  ) {
    return fail();
  }
  const takeValue = values.get("--take");
  const take = takeValue === undefined ? 10 : Number(takeValue);
  if (
    !Number.isSafeInteger(take) ||
    take < 1 ||
    take > 20 ||
    (takeValue !== undefined && String(take) !== takeValue)
  ) {
    return fail();
  }
  const queryVectorFile = values.get("--query-vector-file") ?? null;
  if (
    queryVectorFile !== null &&
    (!isAbsolute(queryVectorFile) || !queryVectorFile.endsWith(".json"))
  ) {
    return fail();
  }
  const scope = values.get("--scope") ?? "auto";
  if (scope !== "auto" && scope !== "project" && scope !== "repositories") {
    return fail();
  }
  const queryTransferConsent = values.get(
    "--acknowledge-external-query-transfer",
  );
  const generateQueryEmbedding = queryTransferConsent !== undefined;
  if (
    (generateQueryEmbedding &&
      queryTransferConsent !== PROJECT_QUERY_TRANSFER_CONSENT_VERSION) ||
    (generateQueryEmbedding && queryVectorFile !== null)
  ) {
    return fail();
  }
  return Object.freeze({
    projectId,
    query: query.trim(),
    take,
    queryVectorFile,
    scope,
    generateQueryEmbedding,
  });
}
