import {
  REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
  type IssueRepositoryModelGrantsRequest,
} from "../src/lib/github";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATIONS = [
  "embedding",
  "sourceSummary",
  "projectAnalysis",
  "generateWithContext",
] as const;

type SupportedOperation = (typeof OPERATIONS)[number];

export class RepositoryModelGrantCliError extends Error {
  readonly code = "REPOSITORY_MODEL_GRANT_CLI_INVALID_ARGUMENTS";
  constructor() {
    super("仓库模型授权命令参数无效");
    this.name = "RepositoryModelGrantCliError";
  }
}

export type RepositoryModelGrantCommand =
  | Readonly<{ operation: "status" | "revoke"; projectId: string; projectRepositoryLinkId: string }>
  | Readonly<{ operation: "issue"; request: IssueRepositoryModelGrantsRequest }>;

function invalid(): never {
  throw new RepositoryModelGrantCliError();
}

function uuid(value: string | undefined): string {
  if (value === undefined || !UUID_PATTERN.test(value)) return invalid();
  return value;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length || args[index + 1]!.startsWith("--")) {
    return undefined;
  }
  return args[index + 1];
}

export function parseRepositoryModelGrantArgs(
  args: readonly string[],
): RepositoryModelGrantCommand {
  const operation = args[0];
  if (!new Set(["status", "issue", "revoke"]).has(operation ?? "")) return invalid();
  const projectId = uuid(valueAfter(args, "--project"));
  const projectRepositoryLinkId = uuid(valueAfter(args, "--link"));
  if (operation === "status" || operation === "revoke") {
    if (args.length !== 5) return invalid();
    return Object.freeze({ operation, projectId, projectRepositoryLinkId });
  }
  const rawOperations = valueAfter(args, "--operations");
  const consent = valueAfter(args, "--consent");
  if (
    args.length !== 11 || rawOperations === undefined ||
    consent !== REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION ||
    !args.includes("--acknowledge-external-transfer") ||
    !args.includes("--acknowledge-processing-rights")
  ) {
    return invalid();
  }
  const operations = rawOperations.split(",") as SupportedOperation[];
  if (
    operations.length < 1 || new Set(operations).size !== operations.length ||
    operations.some((item) => !OPERATIONS.includes(item))
  ) {
    return invalid();
  }
  return Object.freeze({
    operation: "issue" as const,
    request: Object.freeze({
      projectId,
      projectRepositoryLinkId,
      operations: Object.freeze(operations),
      consentVersion: REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
      acknowledgeExternalModelTransfer: true as const,
      acknowledgeProcessingRights: true as const,
    }),
  });
}
