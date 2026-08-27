const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class RepositoryCodeSearchCliError extends Error {
  readonly code = "REPOSITORY_CODE_SEARCH_CLI_INVALID_ARGUMENTS";
  constructor() {
    super("仓库代码搜索命令参数无效");
    this.name = "RepositoryCodeSearchCliError";
  }
}

export type RepositoryCodeSearchCommand = Readonly<{
  projectId: string;
  query: string;
  take: number;
  projectRepositoryLinkId: string | null;
}>;

function invalid(): never {
  throw new RepositoryCodeSearchCliError();
}

export function parseRepositoryCodeSearchArgs(
  args: readonly string[],
): RepositoryCodeSearchCommand {
  const allowed = new Set(["--project", "--query", "--take", "--link"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined || value === undefined || !allowed.has(flag) ||
      values.has(flag) || value.startsWith("--")
    ) {
      return invalid();
    }
    values.set(flag, value);
  }
  const projectId = values.get("--project");
  const query = values.get("--query");
  const linkId = values.get("--link") ?? null;
  const takeText = values.get("--take") ?? "10";
  const take = Number(takeText);
  if (
    projectId === undefined || !UUID_PATTERN.test(projectId) ||
    query === undefined || query.trim().length === 0 ||
    (linkId !== null && !UUID_PATTERN.test(linkId)) ||
    !Number.isSafeInteger(take) || take < 1 || take > 20
  ) {
    return invalid();
  }
  return Object.freeze({ projectId, query, take, projectRepositoryLinkId: linkId });
}
