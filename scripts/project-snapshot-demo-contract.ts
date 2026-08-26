import { projectIdSchema } from "../src/lib/validation";
import {
  PROJECT_SNAPSHOT_DEMO_DESCRIPTION,
  PROJECT_SNAPSHOT_DEMO_MARKER,
  PROJECT_SNAPSHOT_DEMO_PROJECT_NAME,
  PROJECT_SNAPSHOT_DEMO_SLUG_PREFIX,
} from "../test/fixtures/project-snapshot-demo";

export const DEFAULT_BASE_URL = "http://localhost:3000";
const DEMO_SLUG_PATTERN = new RegExp(`^${PROJECT_SNAPSHOT_DEMO_SLUG_PREFIX}-[a-f0-9]{12}$`);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ProjectSnapshotDemoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectSnapshotDemoError";
  }
}

export type DemoRecovery = {
  projectId: string;
  slug: string;
  command: string;
};

export type DemoCleanupResult =
  | {
      ok: true;
      operation: "cleanup";
      projectId: string;
      slug: string;
      deleted: true;
    }
  | {
      ok: false;
      operation: "cleanup";
      projectId: string;
      slug: string;
      error: { code: string; message: string };
      recovery?: DemoRecovery;
    };

export type DemoProjectIdentity = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
};

function failArguments(message: string): never {
  throw new ProjectSnapshotDemoError("INVALID_ARGUMENTS", message);
}

function hasOnlyRootPathInRawUrl(value: string): boolean {
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator <= 0) return false;

  const authorityStart = schemeSeparator + 3;
  let authorityEnd = value.length;
  for (let index = authorityStart; index < value.length; index += 1) {
    const character = value[index];
    if (character === "/" || character === "?" || character === "#" || character === "\\") {
      authorityEnd = index;
      break;
    }
  }

  const rawSuffix = value.slice(authorityEnd);
  return rawSuffix === "" || rawSuffix === "/";
}

export function parseBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    failArguments("base URL must be a valid http(s) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    failArguments("base URL must use http or https");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    failArguments("base URL must target localhost or a loopback address");
  }
  if (parsed.pathname !== "/" || !hasOnlyRootPathInRawUrl(value)) {
    failArguments("base URL must use the root path");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    value.includes("?") ||
    value.includes("#")
  ) {
    failArguments("base URL must not contain credentials, query parameters, or a fragment");
  }

  return parsed.origin;
}

export function parseSeedArgs(args: string[]): { baseUrl: string } {
  let baseUrl = DEFAULT_BASE_URL;
  let seenBaseUrl = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base-url") {
      if (seenBaseUrl) failArguments("--base-url may be provided only once");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) failArguments("--base-url requires a URL");
      baseUrl = parseBaseUrl(value);
      seenBaseUrl = true;
      index += 1;
      continue;
    }
    failArguments("unknown seed option");
  }

  return { baseUrl };
}

export function parseCleanupArgs(args: string[]): { projectId: string; slug: string } {
  let projectId: string | undefined;
  let slug: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--project-id") {
      if (projectId || !args[index + 1] || args[index + 1].startsWith("--")) {
        failArguments("--project-id must be provided exactly once");
      }
      projectId = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--slug") {
      if (slug || !args[index + 1] || args[index + 1].startsWith("--")) {
        failArguments("--slug must be provided exactly once");
      }
      slug = args[index + 1];
      index += 1;
      continue;
    }
    failArguments("unknown cleanup option");
  }

  if (!projectId || !projectIdSchema.safeParse(projectId).success) {
    failArguments("--project-id must be a valid UUID");
  }
  if (!slug || !DEMO_SLUG_PATTERN.test(slug)) {
    failArguments("--slug must be the exact Project Snapshot demo slug returned by seed");
  }

  return { projectId, slug };
}

export function cleanupCommand(projectId: string, slug: string): string {
  return `pnpm project-snapshot:demo -- cleanup --project-id ${projectId} --slug ${slug}`;
}

export function recovery(projectId: string, slug: string): DemoRecovery {
  return { projectId, slug, command: cleanupCommand(projectId, slug) };
}

export function isProjectSnapshotDemo(project: DemoProjectIdentity): boolean {
  return (
    project.name === PROJECT_SNAPSHOT_DEMO_PROJECT_NAME &&
    project.description === PROJECT_SNAPSHOT_DEMO_DESCRIPTION &&
    project.description.includes(PROJECT_SNAPSHOT_DEMO_MARKER)
  );
}

export function isExactDemoProjectTarget(project: DemoProjectIdentity, projectId: string, slug: string): boolean {
  return project.id === projectId && project.slug === slug && isProjectSnapshotDemo(project);
}
