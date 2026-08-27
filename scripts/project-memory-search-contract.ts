import { isAbsolute } from "node:path";

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
  return Object.freeze({
    projectId,
    query: query.trim(),
    take,
    queryVectorFile,
  });
}
