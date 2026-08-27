const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ProjectMemoryPublishCliError extends Error {
  readonly code = "PROJECT_MEMORY_PUBLISH_CLI_INVALID_ARGUMENTS" as const;

  constructor() {
    super("项目记忆快照命令参数无效");
    this.name = "ProjectMemoryPublishCliError";
  }
}

export type ProjectMemoryPublishCommand =
  | Readonly<{
      scope: "repository";
      projectId: string;
      linkId: string;
    }>
  | Readonly<{
      scope: "project";
      projectId: string;
    }>;

function fail(): never {
  throw new ProjectMemoryPublishCliError();
}

export function parseProjectMemoryPublishArgs(
  args: readonly string[],
): ProjectMemoryPublishCommand {
  const scope = args[0];
  if (scope !== "repository" && scope !== "project") return fail();
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      (flag !== "--project-id" && flag !== "--link-id") ||
      value.startsWith("--") ||
      values.has(flag)
    ) {
      return fail();
    }
    values.set(flag, value);
  }
  const projectId = values.get("--project-id");
  if (projectId === undefined || !UUID_PATTERN.test(projectId)) return fail();
  if (scope === "project") {
    if (values.size !== 1) return fail();
    return Object.freeze({ scope, projectId });
  }
  const linkId = values.get("--link-id");
  if (
    values.size !== 2 ||
    linkId === undefined ||
    !UUID_PATTERN.test(linkId)
  ) {
    return fail();
  }
  return Object.freeze({ scope, projectId, linkId });
}
