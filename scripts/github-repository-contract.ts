import { isAbsolute } from "node:path";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;

export class GitHubRepositoryCliError extends Error {
  readonly code = "GITHUB_REPOSITORY_CLI_INVALID_ARGUMENTS" as const;

  constructor() {
    super("GitHub 仓库命令参数无效");
    this.name = "GitHubRepositoryCliError";
  }
}

export type GitHubRepositoryCommand =
  | Readonly<{ operation: "list" | "status"; projectId: string }>
  | Readonly<{
      operation: "connect";
      projectId: string;
      owner: string;
      repository: string;
      configFile: string;
    }>
  | Readonly<{
      operation: "disable" | "unlink" | "sync-material";
      projectId: string;
      linkId: string;
    }>
  | Readonly<{ operation: "scan-code"; projectId: string }>;

function fail(): never {
  throw new GitHubRepositoryCliError();
}

function parsePairs(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      value.startsWith("--") ||
      value.length === 0 ||
      value.includes("\0") ||
      values.has(flag)
    ) {
      return fail();
    }
    values.set(flag, value);
  }
  return values;
}

function exactFlags(values: ReadonlyMap<string, string>, expected: readonly string[]): void {
  if (
    values.size !== expected.length ||
    expected.some((flag) => !values.has(flag))
  ) {
    return fail();
  }
}

function uuid(value: string | undefined): string {
  return value !== undefined && UUID_PATTERN.test(value) ? value : fail();
}

export function parseGitHubRepositoryArgs(
  args: readonly string[],
): GitHubRepositoryCommand {
  const operation = args[0];
  if (
    operation !== "list" &&
    operation !== "status" &&
    operation !== "connect" &&
    operation !== "disable" &&
    operation !== "unlink" &&
    operation !== "scan-code" &&
    operation !== "sync-material"
  ) {
    return fail();
  }
  const values = parsePairs(args.slice(1));
  const projectId = uuid(values.get("--project-id"));

  if (operation === "list" || operation === "status" || operation === "scan-code") {
    exactFlags(values, ["--project-id"]);
    return Object.freeze({ operation, projectId });
  }
  if (operation === "connect") {
    exactFlags(values, ["--project-id", "--repository", "--config-file"]);
    const fullName = values.get("--repository");
    const configFile = values.get("--config-file");
    if (
      fullName === undefined ||
      !REPOSITORY_PATTERN.test(fullName) ||
      configFile === undefined ||
      !isAbsolute(configFile) ||
      !configFile.endsWith(".json")
    ) {
      return fail();
    }
    const separator = fullName.indexOf("/");
    return Object.freeze({
      operation,
      projectId,
      owner: fullName.slice(0, separator),
      repository: fullName.slice(separator + 1),
      configFile,
    });
  }

  exactFlags(values, ["--project-id", "--link-id"]);
  return Object.freeze({
    operation,
    projectId,
    linkId: uuid(values.get("--link-id")),
  });
}
