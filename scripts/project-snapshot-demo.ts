import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getDb } from "../src/lib/db";
import { projectIdSchema } from "../src/lib/validation";
import {
  cleanupCommand,
  ProjectSnapshotDemoError,
  isProjectSnapshotDemo,
  isExactDemoProjectTarget,
  parseCleanupArgs,
  parseSeedArgs,
  recovery,
  type DemoCleanupResult,
} from "./project-snapshot-demo-contract";
import { readCliArguments } from "./cli-arguments";
import {
  projectSnapshotFixtureItems,
  projectSnapshotFixtureSources,
  PROJECT_SNAPSHOT_DEMO_DESCRIPTION,
  PROJECT_SNAPSHOT_DEMO_PROJECT_NAME,
  PROJECT_SNAPSHOT_DEMO_SLUG_PREFIX,
} from "../test/fixtures/project-snapshot-demo";

type JsonObject = Record<string, unknown>;

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function requestJson(baseUrl: string, path: string, init: RequestInit, step: string): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, init);
  } catch {
    throw new ProjectSnapshotDemoError("API_UNREACHABLE", `${step} could not reach the local application`);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Keep failures safe and stable even if the development server returns HTML.
  }

  if (!response.ok) {
    throw new ProjectSnapshotDemoError("API_REQUEST_FAILED", `${step} failed with HTTP ${response.status}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProjectSnapshotDemoError("API_RESPONSE_INVALID", `${step} returned an invalid JSON response`);
  }

  return payload as JsonObject;
}

function readString(payload: JsonObject, key: string, step: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProjectSnapshotDemoError("API_RESPONSE_INVALID", `${step} did not return ${key}`);
  }
  return value;
}

function readObject(payload: JsonObject, key: string, step: string): JsonObject {
  const value = payload[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectSnapshotDemoError("API_RESPONSE_INVALID", `${step} did not return ${key}`);
  }
  return value as JsonObject;
}

function makeDemoSlug(): string {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return `${PROJECT_SNAPSHOT_DEMO_SLUG_PREFIX}-${suffix}`;
}

async function cleanupDemoProject(projectId: string, slug: string): Promise<DemoCleanupResult> {
  let db: ReturnType<typeof getDb> | undefined;

  try {
    db = getDb();
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, slug: true, name: true, description: true },
    });

    if (!project) {
      return {
        ok: false,
        operation: "cleanup",
        projectId,
        slug,
        error: { code: "DEMO_PROJECT_NOT_FOUND", message: "No project matched the exact projectId" },
      };
    }

    if (project.id !== projectId) {
      return {
        ok: false,
        operation: "cleanup",
        projectId,
        slug,
        error: { code: "DEMO_PROJECT_ID_MISMATCH", message: "The projectId verification did not match" },
      };
    }

    if (project.slug !== slug) {
      const actualRecovery = isProjectSnapshotDemo(project) ? recovery(projectId, project.slug) : undefined;
      return {
        ok: false,
        operation: "cleanup",
        projectId,
        slug,
        error: { code: "DEMO_SLUG_MISMATCH", message: "The exact slug does not match this project" },
        ...(actualRecovery ? { recovery: actualRecovery } : {}),
      };
    }

    if (!isExactDemoProjectTarget(project, projectId, slug)) {
      return {
        ok: false,
        operation: "cleanup",
        projectId,
        slug,
        error: { code: "DEMO_MARKER_MISMATCH", message: "The project is not the exact Project Snapshot demo fixture" },
      };
    }

    const deleted = await db.project.deleteMany({
      where: {
        id: projectId,
        slug,
        name: PROJECT_SNAPSHOT_DEMO_PROJECT_NAME,
        description: PROJECT_SNAPSHOT_DEMO_DESCRIPTION,
      },
    });

    if (deleted.count !== 1) {
      return {
        ok: false,
        operation: "cleanup",
        projectId,
        slug,
        error: { code: "DEMO_CLEANUP_NOT_APPLIED", message: "The exact demo project changed before cleanup" },
      };
    }

    return { ok: true, operation: "cleanup", projectId, slug, deleted: true };
  } catch {
    return {
      ok: false,
      operation: "cleanup",
      projectId,
      slug,
      error: { code: "DEMO_CLEANUP_FAILED", message: "The exact demo project could not be verified or removed" },
    };
  } finally {
    if (db) {
      try {
        await db.$disconnect();
      } catch {
        // Do not replace the safe cleanup result with a connection-close detail.
      }
    }
  }
}

async function seedDemo(baseUrl: string): Promise<JsonObject> {
  const slug = makeDemoSlug();
  let projectId: string | undefined;

  try {
    const projectPayload = await requestJson(
      baseUrl,
      "/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: PROJECT_SNAPSHOT_DEMO_PROJECT_NAME,
          slug,
          description: PROJECT_SNAPSHOT_DEMO_DESCRIPTION,
        }),
      },
      "project creation",
    );
    const project = readObject(projectPayload, "project", "project creation");
    projectId = readString(project, "id", "project creation");
    if (!projectIdSchema.safeParse(projectId).success) {
      throw new ProjectSnapshotDemoError("API_RESPONSE_INVALID", "project creation returned an invalid projectId");
    }
    if (readString(project, "slug", "project creation") !== slug) {
      throw new ProjectSnapshotDemoError("API_RESPONSE_INVALID", "project creation returned an unexpected slug");
    }

    const sourceIds = new Map<string, string>();
    for (const fixtureSource of projectSnapshotFixtureSources) {
      const sourcePayload = await requestJson(
        baseUrl,
        `/api/projects/${projectId}/sources`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contentText: fixtureSource.contentText,
            externalRef: fixtureSource.externalRef,
            capturedAt: fixtureSource.capturedAt,
          }),
        },
        `source ${fixtureSource.key} creation`,
      );
      const source = readObject(sourcePayload, "source", `source ${fixtureSource.key} creation`);
      sourceIds.set(fixtureSource.key, readString(source, "id", `source ${fixtureSource.key} creation`));
    }

    const confirmedItems: JsonObject[] = [];
    for (const fixtureItem of projectSnapshotFixtureItems) {
      const sourceId = sourceIds.get(fixtureItem.sourceKey);
      if (!sourceId) throw new ProjectSnapshotDemoError("FIXTURE_INVALID", `fixture source ${fixtureItem.sourceKey} is missing`);

      const itemPayload = await requestJson(
        baseUrl,
        `/api/projects/${projectId}/items`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: fixtureItem.type,
            sourceId,
            title: fixtureItem.title,
            content: fixtureItem.content,
            sourceExcerpt: fixtureItem.sourceExcerpt,
            occurredAt: fixtureItem.occurredAt,
          }),
        },
        `item ${fixtureItem.key} creation`,
      );
      const itemPayloadObject = readObject(itemPayload, "item", `item ${fixtureItem.key} creation`);
      const itemId = readString(itemPayloadObject, "id", `item ${fixtureItem.key} creation`);
      const updatedAt = readString(itemPayloadObject, "updatedAt", `item ${fixtureItem.key} creation`);
      const confirmPayload = await requestJson(
        baseUrl,
        `/api/projects/${projectId}/items/${itemId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "confirm", expectedUpdatedAt: updatedAt }),
        },
        `item ${fixtureItem.key} confirmation`,
      );
      confirmedItems.push(readObject(confirmPayload, "item", `item ${fixtureItem.key} confirmation`));
    }

    const snapshotPayload = await requestJson(
      baseUrl,
      `/api/projects/${projectId}/snapshots`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      "initial snapshot generation",
    );
    const snapshot = readObject(snapshotPayload, "snapshot", "initial snapshot generation");

    return {
      ok: true,
      operation: "seed",
      projectId,
      slug,
      browserUrl: `${baseUrl}/projects/${projectId}`,
      cleanupCommand: cleanupCommand(projectId, slug),
      sourceCount: projectSnapshotFixtureSources.length,
      confirmedItemCount: confirmedItems.length,
      snapshotId: readString(snapshot, "id", "initial snapshot generation"),
    };
  } catch (error) {
    if (!projectId) throw error;

    const cleanupResult = await cleanupDemoProject(projectId, slug);
    throw new ProjectSnapshotDemoError(
      "SEED_FAILED",
      JSON.stringify({
        message: error instanceof ProjectSnapshotDemoError ? error.message : "Project Snapshot demo seed failed",
        projectId,
        slug,
        cleanup: cleanupResult,
        recovery: recovery(projectId, slug),
      }),
    );
  }
}

async function main(): Promise<void> {
  const rawArgs = readCliArguments();
  const [command, ...args] = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (command === "seed") {
    const { baseUrl } = parseSeedArgs(args);
    printJson(await seedDemo(baseUrl));
    return;
  }
  if (command === "cleanup") {
    const { projectId, slug } = parseCleanupArgs(args);
    const result = await cleanupDemoProject(projectId, slug);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  throw new ProjectSnapshotDemoError("INVALID_ARGUMENTS", "usage: seed [--base-url <URL>] | cleanup --project-id <UUID> --slug <exact-slug>");
}

main().catch((error: unknown) => {
  const message = error instanceof ProjectSnapshotDemoError ? error.message : "Project Snapshot demo command failed";
  printJson({ ok: false, operation: "project-snapshot-demo", error: { code: error instanceof ProjectSnapshotDemoError ? error.code : "DEMO_COMMAND_FAILED", message } });
  process.exitCode = 1;
});
