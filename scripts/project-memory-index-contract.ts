import { MODEL_TRANSFER_CONSENT_VERSION } from "../src/lib/ai-memory";
import {
  REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
  REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
} from "../src/lib/github";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ProjectMemoryIndexCliError extends Error {
  readonly code = "PROJECT_MEMORY_INDEX_CLI_INVALID_ARGUMENTS" as const;

  constructor() {
    super("项目记忆索引命令参数无效");
    this.name = "ProjectMemoryIndexCliError";
  }
}

export type ProjectMemoryIndexCommand =
  | Readonly<{
      scope: "project";
      projectId: string;
      grantId: string;
      consentVersion: typeof MODEL_TRANSFER_CONSENT_VERSION;
    }>
  | Readonly<{
      scope: "repository-code";
      projectId: string;
      linkId: string;
      grantId: string;
      consentVersion: typeof REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION;
    }>
  | Readonly<{
      scope: "repository-material";
      projectId: string;
      linkId: string;
      grantId: string;
      consentVersion: typeof REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION;
    }>;

function fail(): never {
  throw new ProjectMemoryIndexCliError();
}

function canonicalUuid(value: string | undefined): string {
  return value !== undefined && UUID_PATTERN.test(value) ? value : fail();
}

export function parseProjectMemoryIndexArgs(
  args: readonly string[],
): ProjectMemoryIndexCommand {
  const scope = args[0];
  if (
    scope !== "project" &&
    scope !== "repository-code" &&
    scope !== "repository-material"
  ) {
    return fail();
  }

  const values = new Map<string, string>();
  let acknowledgedRights = false;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--acknowledge-processing-rights") {
      if (acknowledgedRights) return fail();
      acknowledgedRights = true;
      continue;
    }
    if (
      flag !== "--project-id" &&
      flag !== "--link-id" &&
      flag !== "--grant-id" &&
      flag !== "--acknowledge-external-model-transfer"
    ) {
      return fail();
    }
    const value = args[index + 1];
    if (
      value === undefined ||
      value.startsWith("--") ||
      value.length === 0 ||
      value.includes("\0") ||
      values.has(flag)
    ) {
      return fail();
    }
    values.set(flag, value);
    index += 1;
  }

  const projectId = canonicalUuid(values.get("--project-id"));
  const grantId = canonicalUuid(values.get("--grant-id"));
  const consent = values.get("--acknowledge-external-model-transfer");
  if (scope === "project") {
    if (
      values.size !== 3 ||
      values.has("--link-id") ||
      acknowledgedRights ||
      consent !== MODEL_TRANSFER_CONSENT_VERSION
    ) {
      return fail();
    }
    return Object.freeze({
      scope,
      projectId,
      grantId,
      consentVersion: MODEL_TRANSFER_CONSENT_VERSION,
    });
  }

  if (values.size !== 4 || !acknowledgedRights) return fail();
  const linkId = canonicalUuid(values.get("--link-id"));
  if (scope === "repository-code") {
    if (consent !== REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION) return fail();
    return Object.freeze({
      scope,
      projectId,
      linkId,
      grantId,
      consentVersion: REPOSITORY_MODEL_TRANSFER_CONSENT_VERSION,
    });
  }
  if (consent !== REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION) {
    return fail();
  }
  return Object.freeze({
    scope,
    projectId,
    linkId,
    grantId,
    consentVersion: REPOSITORY_MATERIAL_MODEL_TRANSFER_CONSENT_VERSION,
  });
}
