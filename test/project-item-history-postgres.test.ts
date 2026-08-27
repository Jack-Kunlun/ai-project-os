import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { createSourceChunkService } from "@/lib/ai-memory";
import { hashSourceContent } from "@/lib/source";

const execFile = promisify(execFileCallback);
const repositoryRoot = process.cwd();
const databaseName = "ai_project_os_ai_runtime_test";
const databasePort = "56432";
const configuredUrl = process.env.ITEM_HISTORY_TEST_DATABASE_URL;
const gate = process.env.ITEM_HISTORY_POSTGRES_GATE;
const hasUrl = typeof configuredUrl === "string" && configuredUrl.length > 0;
const shouldRun = hasUrl && gate === "1";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const otherSourceId = "44444444-4444-4444-8444-444444444444";
const legacyItemId = "55555555-5555-4555-8555-555555555555";
const sourceText = "First evidence. Second evidence.";
const sourceHash = hashSourceContent(sourceText);

const migrationPaths = [
  "20260826021100_init",
  "20260826030732_integrity_boundaries",
  "20260827090000_add_ai_runtime_governance",
  "20260827120000_add_ai_memory_candidates",
  "20260827140000_add_item_evidence_history",
  "20260828100000_add_source_chunks",
].map((name) => join(repositoryRoot, "prisma/migrations", name, "migration.sql"));

function validateDisposableUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("ITEM_HISTORY_TEST_DATABASE_URL_INVALID");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ITEM_HISTORY_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    parsed.port !== databasePort ||
    parsed.pathname !== `/${databaseName}` ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("ITEM_HISTORY_TEST_DATABASE_URL_INVALID");
  }
  return value;
}

async function resetPublic(client: Client): Promise<void> {
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

async function applyMigration(client: Client, index: number): Promise<void> {
  await client.query(await readFile(migrationPaths[index]!, "utf8"));
}

async function seedLegacyRows(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "Project" ("id", "name", "slug", "updatedAt")
     VALUES ($1, 'Legacy project', 'legacy-project', CURRENT_TIMESTAMP)`,
    [projectId],
  );
  await client.query(
    `INSERT INTO "ProjectSource"
       ("id", "projectId", "kind", "contentText", "contentHash")
     VALUES ($1, $2, 'manual', $3, $4)`,
    [sourceId, projectId, sourceText, sourceHash],
  );
  await client.query(
    `INSERT INTO "ProjectItem"
       ("id", "projectId", "type", "reviewStatus", "sourceId", "title",
        "content", "sourceExcerpt", "updatedAt")
     VALUES ($1, $2, 'decision', 'candidate', $3, 'Legacy item',
             'Legacy content', 'Second evidence', CURRENT_TIMESTAMP)`,
    [legacyItemId, projectId, sourceId],
  );
}

async function applyUpgradePath(client: Client): Promise<void> {
  await resetPublic(client);
  await applyMigration(client, 0);
  await applyMigration(client, 1);
  await seedLegacyRows(client);
  await client.query("BEGIN");
  try {
    await applyMigration(client, 2);
    await applyMigration(client, 3);
    await applyMigration(client, 4);
    await applyMigration(client, 5);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function expectRejected(action: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
}

test(
  "project item history PostgreSQL gate requires an explicit disposable target",
  { skip: !hasUrl || gate === "1" },
  () => {
    throw new Error("ITEM_HISTORY_POSTGRES_GATE must equal 1");
  },
);

test(
  "project item evidence and revision history preserve legacy data and route contracts",
  { skip: !shouldRun ? "explicit disposable PostgreSQL gate is required" : false },
  async () => {
    const url = validateDisposableUrl(configuredUrl);
    const raw = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await raw.connect();
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;

    try {
      await applyUpgradePath(raw);
      const legacy = await raw.query<{
        action: string;
        range_start: number;
        range_end: number;
        evidences: string;
        revisions: string;
        links: string;
        dedupe_matches: boolean;
      }>(
        `SELECT
           r."action"::text AS action,
           e."rangeStart" AS range_start,
           e."rangeEnd" AS range_end,
           (SELECT COUNT(*)::text FROM "ProjectItemEvidence"
             WHERE "projectItemId" = $1) AS evidences,
           (SELECT COUNT(*)::text FROM "ProjectItemRevision"
             WHERE "projectItemId" = $1) AS revisions,
           (SELECT COUNT(*)::text FROM "ProjectItemRevisionEvidence"
             WHERE "projectItemId" = $1) AS links,
           s."manualContentDedupeKey" = s."contentHash" AS dedupe_matches
         FROM "ProjectItemRevision" r
         JOIN "ProjectItemEvidence" e
           ON e."projectId" = r."projectId" AND e."projectItemId" = r."projectItemId"
         JOIN "ProjectSource" s
           ON s."projectId" = e."projectId" AND s."id" = e."projectSourceId"
         WHERE r."projectItemId" = $1 AND r."revisionNumber" = 1`,
        [legacyItemId],
      );
      assert.deepEqual(legacy.rows[0], {
        action: "legacy_import",
        range_start: Buffer.byteLength("First evidence. ", "utf8"),
        range_end: Buffer.byteLength("First evidence. Second evidence", "utf8"),
        evidences: "1",
        revisions: "1",
        links: "1",
        dedupe_matches: true,
      });

      await resetPublic(raw);
      await execFile(
        "pnpm",
        ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
        { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: url } },
      );

      const adapter = new PrismaPg({ connectionString: url });
      const prisma = new PrismaClient({ adapter });
      try {
        const extensions = await raw.query<{ extname: string; extversion: string }>(
          `SELECT extname, extversion
             FROM pg_extension
            WHERE extname = ANY($1::text[])
            ORDER BY extname`,
          [["pg_trgm", "vector"]],
        );
        assert.deepEqual(extensions.rows, [
          { extname: "pg_trgm", extversion: "1.6" },
          { extname: "vector", extversion: "0.8.6" },
        ]);
        const profile = await prisma.embeddingProfile.findUnique({
          where: {
            profileFingerprint: "b6ea9b216ae969788bdf629f9cb31be5fd4d4e221fc87d433303bc3c363ee8d6",
          },
          select: { provider: true, modelId: true, dimensions: true, normalization: true },
        });
        assert.deepEqual(profile, {
          provider: "openai",
          modelId: "text-embedding-3-small",
          dimensions: 1536,
          normalization: "unit_length",
        });

        await prisma.project.createMany({
          data: [
            { id: projectId, name: "History project", slug: "history-project" },
            { id: otherProjectId, name: "Other project", slug: "other-history-project" },
          ],
        });
        await prisma.projectSource.createMany({
          data: [
            {
              id: sourceId,
              projectId,
              kind: "manual",
              contentText: sourceText,
              contentHash: sourceHash,
              manualContentDedupeKey: sourceHash,
            },
            {
              id: otherSourceId,
              projectId: otherProjectId,
              kind: "manual",
              contentText: "Other evidence",
              contentHash: hashSourceContent("Other evidence"),
              manualContentDedupeKey: hashSourceContent("Other evidence"),
            },
          ],
        });

        const chunkService = createSourceChunkService({ db: prisma });
        const [firstChunks, replayedChunks] = await Promise.all([
          chunkService.ensureProjectSourceChunks({ projectId, sourceId }),
          chunkService.ensureProjectSourceChunks({ projectId, sourceId }),
        ]);
        assert.deepEqual(
          firstChunks.map((chunk) => chunk.id),
          replayedChunks.map((chunk) => chunk.id),
        );
        assert.equal(firstChunks.length, 1);
        assert.equal(firstChunks[0]?.contentText, sourceText);
        assert.equal(await prisma.sourceChunk.count({ where: { projectId } }), 1);

        await expectRejected(() => prisma.projectSource.update({
          where: { projectId_id: { projectId, id: sourceId } },
          data: { contentText: "forged source revision" },
        }));
        await expectRejected(() => prisma.sourceChunk.update({
          where: { id: firstChunks[0]!.id },
          data: { contentText: "forged chunk" },
        }));

        const itemRoute = await import("@/app/api/projects/[projectId]/items/route");
        const itemDetailRoute = await import("@/app/api/projects/[projectId]/items/[itemId]/route");
        const sourceDetailRoute = await import("@/app/api/projects/[projectId]/sources/[sourceId]/route");

        const createdResponse = await itemRoute.POST(
          new Request("http://localhost/api/items", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "decision",
              sourceId,
              title: "Tracked item",
              content: "Tracked content",
              sourceExcerpt: "First evidence",
            }),
          }),
          { params: Promise.resolve({ projectId }) },
        );
        assert.equal(createdResponse.status, 201);
        const createdBody = await createdResponse.json() as {
          item: { id: string; updatedAt: string; reviewStatus: string };
        };
        assert.equal(createdBody.item.reviewStatus, "candidate");

        const confirmOnce = () => itemDetailRoute.PATCH(
          new Request("http://localhost/api/items", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "confirm",
              expectedUpdatedAt: createdBody.item.updatedAt,
            }),
          }),
          { params: Promise.resolve({ projectId, itemId: createdBody.item.id }) },
        );
        const confirmResponses = await Promise.all([confirmOnce(), confirmOnce()]);
        assert.deepEqual(confirmResponses.map((response) => response.status).sort(), [200, 409]);
        const confirmedResponse = confirmResponses.find((response) => response.status === 200)!;
        const confirmedBody = await confirmedResponse.json() as {
          item: { updatedAt: string; reviewStatus: string };
        };
        assert.equal(confirmedBody.item.reviewStatus, "confirmed");

        const editedResponse = await itemDetailRoute.PATCH(
          new Request("http://localhost/api/items", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "edit",
              type: "risk",
              title: "Edited item",
              content: "Edited content",
              sourceExcerpt: "Second evidence",
              occurredAt: null,
              expectedUpdatedAt: confirmedBody.item.updatedAt,
            }),
          }),
          { params: Promise.resolve({ projectId, itemId: createdBody.item.id }) },
        );
        assert.equal(editedResponse.status, 200);
        const editedBody = await editedResponse.json() as {
          item: { reviewStatus: string };
        };
        assert.equal(editedBody.item.reviewStatus, "candidate");

        const staleResponse = await itemDetailRoute.PATCH(
          new Request("http://localhost/api/items", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "dismiss",
              expectedUpdatedAt: confirmedBody.item.updatedAt,
            }),
          }),
          { params: Promise.resolve({ projectId, itemId: createdBody.item.id }) },
        );
        assert.equal(staleResponse.status, 409);

        const history = await prisma.projectItemRevision.findMany({
          where: { projectId, projectItemId: createdBody.item.id },
          orderBy: { revisionNumber: "asc" },
          select: { action: true, revisionNumber: true },
        });
        assert.deepEqual(history, [
          { action: "manualCreated", revisionNumber: 1 },
          { action: "confirmed", revisionNumber: 2 },
          { action: "edited", revisionNumber: 3 },
        ]);
        assert.equal(await prisma.projectItemEvidence.count({
          where: { projectId, projectItemId: createdBody.item.id },
        }), 2);
        assert.equal(await prisma.projectItemEvidence.count({
          where: { projectId, projectItemId: createdBody.item.id, isActive: true, role: "primary" },
        }), 1);

        const deleteResponse = await sourceDetailRoute.DELETE(
          new Request("http://localhost/api/sources", { method: "DELETE" }),
          { params: Promise.resolve({ projectId, sourceId }) },
        );
        assert.equal(deleteResponse.status, 409);

        await expectRejected(async () => {
          await raw.query("BEGIN");
          try {
            await raw.query(
              `INSERT INTO "ProjectItem"
                 ("id", "projectId", "type", "reviewStatus", "sourceId",
                  "title", "content", "sourceExcerpt", "updatedAt")
               VALUES ('66666666-6666-4666-8666-666666666666', $1,
                       'decision', 'candidate', $2, 'No history', 'No history',
                       'First evidence', CURRENT_TIMESTAMP)`,
              [projectId, sourceId],
            );
            await raw.query("COMMIT");
          } catch (error) {
            await raw.query("ROLLBACK");
            throw error;
          }
        });

        await prisma.project.delete({ where: { id: projectId } });
        assert.equal(await prisma.sourceChunk.count({ where: { projectId } }), 0);
        assert.equal(await prisma.projectItemEvidence.count({ where: { projectId } }), 0);
        assert.equal(await prisma.projectItemRevision.count({ where: { projectId } }), 0);
      } finally {
        await prisma.$disconnect();
        const { getDb } = await import("@/lib/db");
        await getDb().$disconnect();
      }
    } finally {
      try {
        await resetPublic(raw);
      } finally {
        await raw.end();
        if (previousDatabaseUrl === undefined) {
          delete process.env.DATABASE_URL;
        } else {
          process.env.DATABASE_URL = previousDatabaseUrl;
        }
      }
    }
  },
);
