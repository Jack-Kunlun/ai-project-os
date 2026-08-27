import { MODEL_TRANSFER_CONSENT_VERSION } from "../src/lib/ai-memory";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SOURCE_COUNT = 100;

export class ProjectAiConfigCliError extends Error {
  readonly code = "PROJECT_AI_CONFIG_CLI_INVALID_ARGUMENTS";

  constructor(message: string) {
    super(message);
    this.name = "ProjectAiConfigCliError";
  }
}

export type ProjectAiConfigCliCommand =
  | Readonly<{ operation: "status"; projectId: string }>
  | Readonly<{
      operation: "configure";
      projectId: string;
      sourceIds: readonly string[];
      consentVersion: typeof MODEL_TRANSFER_CONSENT_VERSION;
    }>
  | Readonly<{ operation: "revoke"; projectId: string }>;

function fail(message: string): never {
  throw new ProjectAiConfigCliError(message);
}

function canonicalUuid(value: string | undefined, option: string): string {
  if (value === undefined || !UUID_PATTERN.test(value)) {
    return fail(`${option} must be followed by one canonical UUID`);
  }
  return value;
}

function nextValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return fail(`${option} requires one value`);
  }
  return value;
}

export function parseProjectAiConfigArgs(
  args: readonly string[],
): ProjectAiConfigCliCommand {
  const operation = args[0];
  if (operation !== "status" && operation !== "configure" && operation !== "revoke") {
    return fail("the first argument must be status, configure, or revoke");
  }

  let projectId: string | undefined;
  const sourceIds: string[] = [];
  let consentVersion: string | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--project-id") {
      if (projectId !== undefined) return fail("--project-id may be provided only once");
      projectId = canonicalUuid(
        nextValue(args, index, "--project-id"),
        "--project-id",
      );
      index += 1;
      continue;
    }
    if (argument === "--source-id") {
      sourceIds.push(canonicalUuid(
        nextValue(args, index, "--source-id"),
        "--source-id",
      ));
      if (sourceIds.length > MAX_SOURCE_COUNT) {
        return fail(`--source-id may be provided at most ${MAX_SOURCE_COUNT} times`);
      }
      index += 1;
      continue;
    }
    if (argument === "--acknowledge-external-model-transfer") {
      if (consentVersion !== undefined) {
        return fail("--acknowledge-external-model-transfer may be provided only once");
      }
      consentVersion = nextValue(
        args,
        index,
        "--acknowledge-external-model-transfer",
      );
      index += 1;
      continue;
    }
    return fail("unknown option");
  }

  if (projectId === undefined) return fail("--project-id is required");

  if (operation === "configure") {
    if (sourceIds.length === 0) return fail("at least one --source-id is required");
    const canonicalSources = [...sourceIds].sort();
    if (new Set(canonicalSources).size !== canonicalSources.length) {
      return fail("--source-id values must be unique");
    }
    if (consentVersion !== MODEL_TRANSFER_CONSENT_VERSION) {
      return fail(
        `--acknowledge-external-model-transfer must equal ${MODEL_TRANSFER_CONSENT_VERSION}`,
      );
    }
    return Object.freeze({
      operation,
      projectId,
      sourceIds: Object.freeze(canonicalSources),
      consentVersion: MODEL_TRANSFER_CONSENT_VERSION,
    });
  }

  if (sourceIds.length > 0 || consentVersion !== undefined) {
    return fail("source and acknowledgement options are only valid for configure");
  }
  return Object.freeze({ operation, projectId });
}
