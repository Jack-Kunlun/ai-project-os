import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient, ProjectItemType } from "@prisma/client";
import { Client, type QueryResult, type QueryResultRow } from "pg";
import {
  buildOperationKey,
  buildOpenAiCandidateExcerptFingerprint,
  buildOpenAiCandidateSetFingerprint,
  buildOpenAiCandidateStatementFingerprint,
  buildInputManifest,
  buildInputManifestFingerprint,
  calculateFakeBudgetMicros,
  createAiRuntimeService,
  FAKE_PROFILE,
  FakeAdmissibilityGate,
  FakeAdmissibilityRecorder,
  FakeProviderRecorder,
  LOCAL_SOURCE_SCANNER_FINGERPRINT,
  LOCAL_SOURCE_SCANNER_VERSION,
  OPENAI_AUTO_EXTRACT_MODEL_FINGERPRINT,
  OPENAI_AUTO_EXTRACT_MODEL_ID,
  OPENAI_AUTO_EXTRACT_PROCESSOR_FINGERPRINT,
  OPENAI_AUTO_EXTRACT_PROFILE_FINGERPRINT,
  OPENAI_PROCESSOR_REGION_FINGERPRINT,
  OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
  type ClaimAndDispatchRunResult,
  OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION,
  OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
  OPENAI_RESPONSES_RETENTION_FINGERPRINT,
  sumInputBytes,
} from "@/lib/ai-runtime";
import {
  AiCandidateError,
  createAiCandidateService,
} from "@/lib/ai-memory";
import { hashSourceContent } from "@/lib/source";

const execFile = promisify(execFileCallback);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDatabaseName = "ai_project_os_ai_runtime_test";
const testDatabasePort = "56432";
const testDatabaseUrl = process.env.AI_RUNTIME_TEST_DATABASE_URL;
const postgresGate = process.env.AI_RUNTIME_POSTGRES_GATE;
const hasConfiguredTestUrl = typeof testDatabaseUrl === "string" && testDatabaseUrl.length > 0;
const shouldRunPostgresGate = hasConfiguredTestUrl && postgresGate === "1";

const projectAId = "11111111-1111-4111-8111-111111111111";
const projectBId = "22222222-2222-4222-8222-222222222222";
const sourceAId = "33333333-3333-4333-8333-333333333333";
const sourceA2Id = "66666666-6666-4666-8666-666666666666";
const sourceBId = "44444444-4444-4444-8444-444444444444";
const revisionAId = "55555555-5555-4555-8555-555555555555";
const revisionA2Id = "77777777-7777-4777-8777-777777777777";
const grantAId = "88888888-8888-4888-8888-888888888888";
const grantIncompleteId = "99999999-9999-4999-8999-999999999999";
const grantBadOperationId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const grantAfterAdvanceId = "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const grantSourceAId = "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const grantSourceA2Id = "aaaaaaa9-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
const grantOperationAId = "aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const grantSourceIncompleteId = "aaaaaaa5-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
const grantOperationBadId = "aaaaaaa6-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
const grantSourceAfterAdvanceId = "aaaaaaa7-aaaa-4aaa-8aaa-aaaaaaaaaaa7";
const grantOperationAfterAdvanceId = "aaaaaaa8-aaaa-4aaa-8aaa-aaaaaaaaaaa8";
const runMainId = "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const sourceAContent = "runtime-src-a";
const sourceAContentHash = hashSourceContent(sourceAContent);
const sourceA2Content = "runtime-src-b";
const sourceA2ContentHash = hashSourceContent(sourceA2Content);
const operationKeyValues = [
  "1".repeat(64),
  "2".repeat(64),
  "3".repeat(64),
  "4".repeat(64),
  "5".repeat(64),
  "6".repeat(64),
  "7".repeat(64),
  "8".repeat(64),
  "9".repeat(64),
  "a".repeat(64),
  "b".repeat(64),
  "c".repeat(64),
] as const;

function batch2RunId(sequence: number): string {
  return `bbbbbbb2-bbbb-4bbb-8bbb-${sequence.toString(16).padStart(12, "0")}`;
}

function batch2AttemptId(sequence: number): string {
  return `ccccccc2-cccc-4ccc-8ccc-${sequence.toString(16).padStart(12, "0")}`;
}

function batch2InputId(sequence: number): string {
  return `ddddddd2-dddd-4ddd-8ddd-${sequence.toString(16).padStart(12, "0")}`;
}

function batch2OperationKey(sequence: number): string {
  return sequence.toString(16).padStart(64, "0");
}

function batch3RunId(sequence: number): string {
  return `bbbbbbb3-bbbb-4bbb-8bbb-${sequence.toString(16).padStart(12, "0")}`;
}

function batch3AttemptId(sequence: number): string {
  return `ccccccc3-cccc-4ccc-8ccc-${sequence.toString(16).padStart(12, "0")}`;
}

function batch3InputId(sequence: number): string {
  return `ddddddd3-dddd-4ddd-8ddd-${sequence.toString(16).padStart(12, "0")}`;
}

function batch3GrantId(sequence: number): string {
  return `eeeeeee3-eeee-4eee-8eee-${sequence.toString(16).padStart(12, "0")}`;
}

function batch3GrantSourceId(sequence: number): string {
  return `fffffff3-ffff-4fff-8fff-${sequence.toString(16).padStart(12, "0")}`;
}

function batch3GrantOperationId(sequence: number): string {
  return `aaaaaaa3-eeee-4aaa-8aaa-${sequence.toString(16).padStart(12, "0")}`;
}

function batch3AuditId(sequence: number): string {
  return `99999993-eeee-4999-8999-${sequence.toString(16).padStart(12, "0")}`;
}

function batch3OperationKey(sequence: number): string {
  return (0x3000 + sequence).toString(16).padStart(64, "0");
}

const aiTables = [
  "ProjectAiPolicyRevision",
  "ProjectAiPolicyOperationProfile",
  "ProjectAiPolicy",
  "ModelProcessingGrant",
  "ModelProcessingGrantSource",
  "ModelProcessingGrantOperation",
  "AiRun",
  "AiRunAttempt",
  "AiRunInputSource",
  "AiAuditEvent",
  "AiCandidateBatch",
  "AiCandidateClaim",
] as const;

const aiEnums = [
  "ModelProcessingGrantSourceKind",
  "ModelProcessingGrantStatus",
  "ModelProcessingGrantRevocationReasonCode",
  "AiOperation",
  "AiRunStatus",
  "AiRunAttemptStatus",
  "AiBudgetProfile",
  "AiBudgetStatus",
  "AiSafeScanResult",
  "AiAuditEventType",
  "AiSafeErrorCode",
  "AiCandidateReviewStatus",
] as const;

const aiRuntimeMigrationPath = join(
  repositoryRoot,
  "prisma/migrations/20260827090000_add_ai_runtime_governance/migration.sql",
);
const aiCandidateMigrationPath = join(
  repositoryRoot,
  "prisma/migrations/20260827120000_add_ai_memory_candidates/migration.sql",
);
const itemEvidenceHistoryMigrationPath = join(
  repositoryRoot,
  "prisma/migrations/20260827140000_add_item_evidence_history/migration.sql",
);
const sourceChunkMigrationPath = join(
  repositoryRoot,
  "prisma/migrations/20260828100000_add_source_chunks/migration.sql",
);
const indexGenerationMigrationPath = join(
  repositoryRoot,
  "prisma/migrations/20260828123000_add_index_generations/migration.sql",
);
const candidateItemPublicationMigrationPath = join(
  repositoryRoot,
  "prisma/migrations/20260828150000_publish_ai_candidate_items/migration.sql",
);
const operationProfileMigrationPath = join(
  repositoryRoot,
  "prisma/migrations/20260828170000_add_ai_operation_profiles/migration.sql",
);
const v0MigrationPaths = [
  join(repositoryRoot, "prisma/migrations/20260826021100_init/migration.sql"),
  join(repositoryRoot, "prisma/migrations/20260826030732_integrity_boundaries/migration.sql"),
];

function rejectUrl(): never {
  throw new Error("AI_RUNTIME_TEST_DATABASE_URL_INVALID");
}

/**
 * This guard is intentionally independent from pg. It must complete before a
 * Client is constructed so a typo can never turn this gate into a remote DB
 * probe. Credentials are passed through to pg but are never returned/logged.
 */
export function validateAiRuntimeTestDatabaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return rejectUrl();
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return rejectUrl();
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return rejectUrl();
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    return rejectUrl();
  }
  if (parsed.port !== testDatabasePort) {
    return rejectUrl();
  }
  if (parsed.pathname !== `/${testDatabaseName}` || parsed.pathname.includes("%")) {
    return rejectUrl();
  }

  const authorityStart = value.indexOf("://");
  const pathStart = authorityStart < 0 ? -1 : value.indexOf("/", authorityStart + 3);
  if (pathStart < 0) {
    return rejectUrl();
  }
  const rawPathAndSuffix = value.slice(pathStart);
  if (
    rawPathAndSuffix.includes("?") ||
    rawPathAndSuffix.includes("#") ||
    /%[0-9a-f]{2}/iu.test(rawPathAndSuffix)
  ) {
    return rejectUrl();
  }

  return value;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function claimResultHistogram(
  results: readonly { kind: string; status: string; safeCode: string | null }[],
): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    const key = `${result.kind}:${result.status}:${result.safeCode ?? "null"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return JSON.stringify(
    Object.fromEntries(
      [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

type StageCounter = {
  started: number;
  succeeded: number;
  failed: number;
};

type StageDiagnostic = {
  isolationLevel: string | null;
  outcome: "succeeded" | "failed";
  queryRaw: StageCounter;
  executeRaw: StageCounter;
  auditEventCreate: StageCounter;
};

function emptyStageCounter(): StageCounter {
  return { started: 0, succeeded: 0, failed: 0 };
}

function withCountedCall<T>(counter: StageCounter, call: () => PromiseLike<T>): Promise<T> {
  counter.started += 1;
  try {
    return Promise.resolve(call()).then(
      (value) => {
        counter.succeeded += 1;
        return value;
      },
      (error: unknown) => {
        counter.failed += 1;
        throw error;
      },
    );
  } catch (error: unknown) {
    counter.failed += 1;
    throw error;
  }
}

function instrumentStageTransaction(
  transaction: unknown,
  stage: StageDiagnostic,
): unknown {
  if (typeof transaction !== "object" || transaction === null) {
    return transaction;
  }
  const target = transaction as Record<PropertyKey, unknown>;
  return new Proxy(target, {
    get(innerTarget, property, receiver) {
      if (property === "$queryRaw" || property === "$executeRaw") {
        const method = Reflect.get(innerTarget, property, receiver);
        if (typeof method !== "function") {
          return method;
        }
        const counter = property === "$queryRaw" ? stage.queryRaw : stage.executeRaw;
        return (...args: unknown[]) =>
          withCountedCall(counter, () =>
            Reflect.apply(method, innerTarget, args) as PromiseLike<unknown>,
          );
      }
      if (property === "aiAuditEvent") {
        const delegate = Reflect.get(innerTarget, property, receiver);
        if (typeof delegate !== "object" || delegate === null) {
          return delegate;
        }
        return new Proxy(delegate as Record<PropertyKey, unknown>, {
          get(auditTarget, auditProperty, auditReceiver) {
            if (auditProperty !== "create") {
              return Reflect.get(auditTarget, auditProperty, auditReceiver);
            }
            const method = Reflect.get(auditTarget, auditProperty, auditReceiver);
            if (typeof method !== "function") {
              return method;
            }
            return (...args: unknown[]) =>
              withCountedCall(stage.auditEventCreate, () =>
                Reflect.apply(method, auditTarget, args) as PromiseLike<unknown>,
              );
          },
        });
      }
      return Reflect.get(innerTarget, property, receiver);
    },
  });
}

function withStageDiagnostics(client: PrismaClient): {
  client: PrismaClient;
  stages: readonly StageDiagnostic[];
} {
  const stages: StageDiagnostic[] = [];
  const wrapped = new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$transaction") {
        return Reflect.get(target, property, receiver);
      }
      const transaction = Reflect.get(target, property, receiver);
      if (typeof transaction !== "function") {
        return transaction;
      }
      return (...args: unknown[]) => {
        const callback = args[0];
        if (typeof callback !== "function") {
          return Reflect.apply(transaction, target, args);
        }
        const options = args[1];
        const isolationLevel =
          typeof options === "object" && options !== null &&
          typeof (options as { isolationLevel?: unknown }).isolationLevel === "string"
            ? (options as { isolationLevel: string }).isolationLevel
            : null;
        const stage: StageDiagnostic = {
          isolationLevel,
          outcome: "failed",
          queryRaw: emptyStageCounter(),
          executeRaw: emptyStageCounter(),
          auditEventCreate: emptyStageCounter(),
        };
        stages.push(stage);
        const delegatedArgs = [...args];
        delegatedArgs[0] = async (tx: unknown) =>
          Reflect.apply(
            callback,
            undefined,
            [instrumentStageTransaction(tx, stage)],
          );
        return Promise.resolve(
          Reflect.apply(transaction, target, delegatedArgs),
        ).then(
          (value) => {
            stage.outcome = "succeeded";
            return value;
          },
          (error: unknown) => {
            stage.outcome = "failed";
            throw error;
          },
        );
      };
    },
  });
  return { client: wrapped as unknown as PrismaClient, stages };
}

type BackendPidSignal = {
  promise: Promise<number>;
  resolve: (pid: number) => void;
  reject: (error: unknown) => void;
};

function createBackendPidSignal(): BackendPidSignal {
  let resolve!: (pid: number) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<number>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/**
 * Test-only transaction wrapper. It obtains the backend PID from the same
 * transaction connection before delegating the callback, without inspecting
 * or changing the callback arguments, rows, or errors.
 */
function withBackendPidSignal(
  client: PrismaClient,
  signal: BackendPidSignal,
): PrismaClient {
  const wrapped = new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$transaction") {
        return Reflect.get(target, property, receiver);
      }
      const transaction = Reflect.get(target, property, receiver);
      if (typeof transaction !== "function") {
        return transaction;
      }
      return (...args: unknown[]) => {
        const callback = args[0];
        if (typeof callback !== "function") {
          return Reflect.apply(transaction, target, args);
        }
        const delegatedArgs = [...args];
        delegatedArgs[0] = async (tx: unknown) => {
          let rows: Array<{ pid: number }>;
          try {
            rows = await (tx as Prisma.TransactionClient).$queryRaw<
              Array<{ pid: number }>
            >(Prisma.sql`
              SELECT pg_backend_pid()::int AS pid
            `);
          } catch {
            const error = new Error("AI_RUNTIME_POSTGRES_BACKEND_PID_FAILED");
            signal.reject(error);
            throw error;
          }
          const pid = rows[0]?.pid;
          if (!Number.isSafeInteger(pid) || pid <= 0) {
            const error = new Error("AI_RUNTIME_POSTGRES_BACKEND_PID_FAILED");
            signal.reject(error);
            throw error;
          }
          signal.resolve(pid);
          return (callback as (transaction: unknown) => Promise<unknown>)(tx);
        };
        return Reflect.apply(transaction, target, delegatedArgs);
      };
    },
  });
  return wrapped as unknown as PrismaClient;
}

/**
 * Poll catalog lock evidence. The timeout only bounds an absent-evidence
 * failure; success requires pg_blocking_pids plus a Lock wait event.
 */
async function waitForBlockingEvidence(
  client: Client,
  blockedPid: number,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await safeQuery<{
      blocking_count: number;
      wait_event_type: string | null;
      state: string | null;
    }>(
      client,
      `SELECT cardinality(pg_blocking_pids(a.pid)) AS blocking_count,
              a.wait_event_type,
              a.state
         FROM pg_stat_activity AS a
        WHERE a.pid = $1::integer`,
      [blockedPid],
    );
    const row = result.rows[0];
    if (
      row !== undefined &&
      row.blocking_count > 0 &&
      row.wait_event_type === "Lock" &&
      row.state === "active"
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("AI_RUNTIME_POSTGRES_BLOCKING_EVIDENCE_MISSING");
}

type SqlValues = readonly unknown[];
type SqlStatement = { sql: string; values?: SqlValues };

async function safeQuery<T extends QueryResultRow = QueryResultRow>(
  client: Client,
  sql: string,
  values: SqlValues = [],
): Promise<QueryResult<T>> {
  try {
    return await client.query<T>(sql, values as unknown[]);
  } catch {
    throw new Error("AI_RUNTIME_POSTGRES_QUERY_FAILED");
  }
}

async function expectRejected(
  client: Client,
  sql: string,
  values: SqlValues,
  label: string,
): Promise<void> {
  try {
    await client.query(sql, values as unknown[]);
  } catch {
    return;
  }
  throw new Error(`${label} must reject`);
}

async function expectActionRejected(action: () => Promise<void>, label: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`${label} must reject`);
}

async function transaction(client: Client, statements: readonly SqlStatement[]): Promise<void> {
  try {
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query(statement.sql, (statement.values ?? []) as unknown[]);
    }
    await client.query("COMMIT");
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original failure is intentionally replaced with a safe test error.
    }
    throw new Error("AI_RUNTIME_POSTGRES_TRANSACTION_FAILED");
  }
}

async function resetPublic(client: Client): Promise<void> {
  await safeQuery(client, "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

async function connectDedicated(value: unknown): Promise<Client> {
  const url = validateAiRuntimeTestDatabaseUrl(value);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await safeQuery<{ current_database: string }>(
      client,
      "SELECT current_database() AS current_database",
    );
    requireCondition(
      result.rows[0]?.current_database === testDatabaseName,
      "AI_RUNTIME_POSTGRES_DATABASE_MISMATCH",
    );
    return client;
  } catch {
    try {
      await client.end();
    } catch {
      // Do not expose connection details.
    }
    throw new Error("AI_RUNTIME_POSTGRES_CONNECTION_FAILED");
  }
}

async function closeClient(client: Client): Promise<void> {
  try {
    await client.end();
  } catch {
    throw new Error("AI_RUNTIME_POSTGRES_DISCONNECT_FAILED");
  }
}

async function runPrismaMigrateDeploy(url: string): Promise<void> {
  try {
    await execFile(
      "pnpm",
      ["exec", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DATABASE_URL: url },
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  } catch {
    throw new Error("AI_RUNTIME_POSTGRES_MIGRATE_DEPLOY_FAILED");
  }
}

async function loadSql(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error("AI_RUNTIME_POSTGRES_MIGRATION_READ_FAILED");
  }
}

async function applySqlMigration(client: Client, path: string): Promise<void> {
  await safeQuery(client, await loadSql(path));
}

async function applyAiMigrationInTransaction(client: Client): Promise<void> {
  await transaction(client, [
    { sql: await loadSql(aiRuntimeMigrationPath) },
    { sql: await loadSql(aiCandidateMigrationPath) },
    { sql: await loadSql(itemEvidenceHistoryMigrationPath) },
    { sql: await loadSql(sourceChunkMigrationPath) },
    { sql: await loadSql(indexGenerationMigrationPath) },
    { sql: await loadSql(candidateItemPublicationMigrationPath) },
    { sql: await loadSql(operationProfileMigrationPath) },
  ]);
}

async function applyAiMigrationsBeforeCandidatePublication(
  client: Client,
): Promise<void> {
  await transaction(client, [
    { sql: await loadSql(aiRuntimeMigrationPath) },
    { sql: await loadSql(aiCandidateMigrationPath) },
    { sql: await loadSql(itemEvidenceHistoryMigrationPath) },
    { sql: await loadSql(sourceChunkMigrationPath) },
    { sql: await loadSql(indexGenerationMigrationPath) },
  ]);
}

async function assertEmptyDatabaseCatalog(client: Client): Promise<void> {
  const migrations = await safeQuery<{ migration_name: string }>(
    client,
    'SELECT "migration_name" FROM "_prisma_migrations" ORDER BY "started_at"',
  );
  const expectedMigrations = [
    "20260826021100_init",
    "20260826030732_integrity_boundaries",
    "20260827090000_add_ai_runtime_governance",
    "20260827120000_add_ai_memory_candidates",
    "20260827140000_add_item_evidence_history",
    "20260828100000_add_source_chunks",
    "20260828123000_add_index_generations",
    "20260828150000_publish_ai_candidate_items",
    "20260828170000_add_ai_operation_profiles",
  ];
  requireCondition(
    JSON.stringify(migrations.rows.map((row) => row.migration_name)) ===
      JSON.stringify(expectedMigrations),
    "AI_RUNTIME_POSTGRES_MIGRATION_LEDGER_MISMATCH",
  );

  const tables = await safeQuery<{ table_name: string }>(
    client,
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [aiTables],
  );
  requireCondition(
    JSON.stringify(tables.rows.map((row) => row.table_name).sort()) ===
      JSON.stringify([...aiTables].sort()),
    "AI_RUNTIME_POSTGRES_AI_TABLES_MISSING",
  );

  const enums = await safeQuery<{ typname: string }>(
    client,
    `SELECT typname
       FROM pg_type
      WHERE typtype = 'e'
        AND typnamespace = 'public'::regnamespace
        AND typname = ANY($1::text[])
      ORDER BY typname`,
    [aiEnums],
  );
  requireCondition(
    JSON.stringify(enums.rows.map((row) => row.typname).sort()) ===
      JSON.stringify([...aiEnums].sort()),
    "AI_RUNTIME_POSTGRES_AI_ENUMS_MISSING",
  );

  type TriggerExpectation = {
    name: string;
    table: string;
    timing: "BEFORE" | "AFTER";
    events: readonly ("INSERT" | "UPDATE" | "DELETE" | "TRUNCATE")[];
    updateColumns?: readonly string[];
    constraint?: boolean;
    deferred?: boolean;
  };
  const triggerExpectations: readonly TriggerExpectation[] = [
    { name: "ProjectAiPolicyRevision_immutable_trigger", table: "ProjectAiPolicyRevision", timing: "BEFORE", events: ["INSERT", "UPDATE", "DELETE"] },
    { name: "ProjectAiPolicyOperationProfile_immutable_trigger", table: "ProjectAiPolicyOperationProfile", timing: "BEFORE", events: ["INSERT", "UPDATE", "DELETE"] },
    { name: "ProjectAiPolicy_delete_guard_trigger", table: "ProjectAiPolicy", timing: "BEFORE", events: ["DELETE"] },
    { name: "ModelProcessingGrant_lifecycle_trigger", table: "ModelProcessingGrant", timing: "BEFORE", events: ["INSERT", "UPDATE"] },
    { name: "ModelProcessingGrant_issuance_trigger", table: "ModelProcessingGrant", timing: "BEFORE", events: ["UPDATE"], updateColumns: ["status"] },
    { name: "ModelProcessingGrantSource_draft_only_trigger", table: "ModelProcessingGrantSource", timing: "BEFORE", events: ["INSERT", "UPDATE", "DELETE"] },
    { name: "ModelProcessingGrantOperation_draft_only_trigger", table: "ModelProcessingGrantOperation", timing: "BEFORE", events: ["INSERT", "UPDATE", "DELETE"] },
    { name: "AiRun_lifecycle_trigger", table: "AiRun", timing: "BEFORE", events: ["INSERT", "UPDATE", "DELETE"] },
    { name: "AiRunAttempt_lifecycle_trigger", table: "AiRunAttempt", timing: "BEFORE", events: ["INSERT", "UPDATE", "DELETE"] },
    { name: "AiRunInputSource_lifecycle_trigger", table: "AiRunInputSource", timing: "BEFORE", events: ["INSERT", "UPDATE", "DELETE"] },
    { name: "AiAuditEvent_append_only_trigger", table: "AiAuditEvent", timing: "BEFORE", events: ["INSERT", "UPDATE", "DELETE"] },
    { name: "AiRun_attempt_consistency_constraint_trigger", table: "AiRun", timing: "AFTER", events: ["INSERT", "UPDATE", "DELETE"], constraint: true, deferred: true },
    { name: "AiRunAttempt_run_consistency_constraint_trigger", table: "AiRunAttempt", timing: "AFTER", events: ["INSERT", "UPDATE", "DELETE"], constraint: true, deferred: true },
    { name: "AiCandidateBatch_lifecycle_trigger", table: "AiCandidateBatch", timing: "BEFORE", events: ["INSERT", "UPDATE", "DELETE"] },
    { name: "AiCandidateClaim_lifecycle_trigger", table: "AiCandidateClaim", timing: "BEFORE", events: ["INSERT", "UPDATE", "DELETE"] },
    { name: "ProjectItem_ai_candidate_provenance_trigger", table: "ProjectItem", timing: "BEFORE", events: ["UPDATE", "DELETE"] },
    { name: "AiCandidateBatch_count_consistency_constraint_trigger", table: "AiCandidateBatch", timing: "AFTER", events: ["INSERT", "UPDATE", "DELETE"], constraint: true, deferred: true },
    { name: "AiCandidateClaim_count_consistency_constraint_trigger", table: "AiCandidateClaim", timing: "AFTER", events: ["INSERT", "UPDATE", "DELETE"], constraint: true, deferred: true },
    { name: "AiCandidateClaim_item_consistency_constraint_trigger", table: "AiCandidateClaim", timing: "AFTER", events: ["INSERT", "UPDATE", "DELETE"], constraint: true, deferred: true },
    { name: "ProjectItem_ai_candidate_consistency_constraint_trigger", table: "ProjectItem", timing: "AFTER", events: ["INSERT", "UPDATE", "DELETE"], constraint: true, deferred: true },
  ];
  for (const expectation of triggerExpectations) {
    const result = await safeQuery<{
      definition: string;
      is_constraint: boolean;
      is_before: boolean;
      is_instead: boolean;
      on_insert: boolean;
      on_update: boolean;
      on_delete: boolean;
      on_truncate: boolean;
      is_deferrable: boolean;
      initially_deferred: boolean;
    }>(
      client,
      `SELECT pg_get_triggerdef(t.oid) AS definition,
              t.tgconstraint <> 0 AS is_constraint,
              (t.tgtype & 2) <> 0 AS is_before,
              (t.tgtype & 64) <> 0 AS is_instead,
              (t.tgtype & 4) <> 0 AS on_insert,
              (t.tgtype & 16) <> 0 AS on_update,
              (t.tgtype & 8) <> 0 AS on_delete,
              (t.tgtype & 32) <> 0 AS on_truncate,
              t.tgdeferrable AS is_deferrable,
              t.tginitdeferred AS initially_deferred
         FROM pg_trigger AS t
         JOIN pg_class AS c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal
          AND c.relnamespace = 'public'::regnamespace
          AND t.tgname = $1
          AND c.relname = $2`,
      [expectation.name, expectation.table],
    );
    requireCondition(
      result.rows.length === 1,
      `AI_RUNTIME_POSTGRES_TRIGGER_MISSING_${expectation.name}`,
    );
    const row = result.rows[0];
    requireCondition(
      expectation.timing === "BEFORE" ? row.is_before && !row.is_instead : !row.is_before && !row.is_instead,
      `AI_RUNTIME_POSTGRES_TRIGGER_TIMING_MISMATCH_${expectation.name}`,
    );
    const actualEvents = [
      row.on_insert ? "INSERT" : null,
      row.on_update ? "UPDATE" : null,
      row.on_delete ? "DELETE" : null,
      row.on_truncate ? "TRUNCATE" : null,
    ]
      .filter((event): event is string => event !== null)
      .sort();
    requireCondition(
      JSON.stringify(actualEvents) === JSON.stringify([...expectation.events].sort()),
      `AI_RUNTIME_POSTGRES_TRIGGER_EVENTS_MISMATCH_${expectation.name}`,
    );
    if (expectation.updateColumns) {
      requireCondition(
        /UPDATE OF\s+"?STATUS"?/iu.test(row.definition),
        `AI_RUNTIME_POSTGRES_TRIGGER_COLUMNS_MISMATCH_${expectation.name}`,
      );
    }
    requireCondition(
      row.is_constraint === Boolean(expectation.constraint),
      `AI_RUNTIME_POSTGRES_TRIGGER_KIND_MISMATCH_${expectation.name}`,
    );
    requireCondition(
      row.is_deferrable === Boolean(expectation.deferred) &&
        row.initially_deferred === Boolean(expectation.deferred),
      `AI_RUNTIME_POSTGRES_TRIGGER_DEFERRED_MISMATCH_${expectation.name}`,
    );
  }

  const indexes = await safeQuery<{ indexname: string; tablename: string }>(
    client,
    `SELECT indexname, tablename
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1::text[])`,
    [[
      "ModelProcessingGrant_projectId_status_idx",
      "ModelProcessingGrantOperation_projectId_grantId_key",
      "AiAuditEvent_projectId_policyRevisionId_idx",
    ]],
  );
  requireCondition(
    JSON.stringify(indexes.rows.sort((a, b) => a.indexname.localeCompare(b.indexname))) ===
      JSON.stringify([
        {
          indexname: "AiAuditEvent_projectId_policyRevisionId_idx",
          tablename: "AiAuditEvent",
        },
        {
          indexname: "ModelProcessingGrant_projectId_status_idx",
          tablename: "ModelProcessingGrant",
        },
        {
          indexname: "ModelProcessingGrantOperation_projectId_grantId_key",
          tablename: "ModelProcessingGrantOperation",
        },
      ]),
    "AI_RUNTIME_POSTGRES_INDEX_MISMATCH",
  );
}

async function seedV0Rows(client: Client): Promise<void> {
  await safeQuery(
    client,
    `INSERT INTO "Project" ("id", "name", "slug", "description", "updatedAt")
     VALUES ($1, 'Runtime gate project', 'runtime-gate-project', 'V0 fixture', CURRENT_TIMESTAMP),
            ($2, 'Other project', 'other-project', 'Cross-project fixture', CURRENT_TIMESTAMP)`,
    [projectAId, projectBId],
  );
  await safeQuery(
    client,
     `INSERT INTO "ProjectSource"
       ("id", "projectId", "kind", "externalRef", "contentText", "contentHash", "capturedAt")
     VALUES ($1, $2, 'manual', NULL, $3, $4, CURRENT_TIMESTAMP),
            ($5, $6, 'manual', NULL, 'Other project source text', 'runtime-gate-hash-b', CURRENT_TIMESTAMP)`,
    [sourceAId, projectAId, sourceAContent, sourceAContentHash, sourceBId, projectBId],
  );
  await safeQuery(
    client,
     `INSERT INTO "ProjectItem"
       ("id", "projectId", "type", "reviewStatus", "sourceId", "title", "content", "sourceExcerpt", "confirmedAt", "updatedAt")
     VALUES ('aaaaaaa0-aaaa-4aaa-8aaa-aaaaaaaaaaa0', $1, 'decision', 'confirmed', $2,
             'V0 item', 'V0 item content', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [projectAId, sourceAId, sourceAContent],
  );
}

async function assertV0RowsSurviveAiMigration(client: Client): Promise<void> {
  const result = await safeQuery<{ projects: string; sources: string; items: string }>(
    client,
    `SELECT
       (SELECT COUNT(*)::text FROM "Project" WHERE "id" = $1) AS projects,
       (SELECT COUNT(*)::text FROM "ProjectSource" WHERE "id" = $2) AS sources,
       (SELECT COUNT(*)::text FROM "ProjectItem" WHERE "projectId" = $1) AS items`,
    [projectAId, sourceAId],
  );
  requireCondition(
    result.rows[0]?.projects === "1" &&
      result.rows[0]?.sources === "1" &&
      result.rows[0]?.items === "1",
    "AI_RUNTIME_POSTGRES_V0_ROWS_NOT_PRESERVED",
  );
}

async function assertV0ItemHistoryBackfill(client: Client): Promise<void> {
  const result = await safeQuery<{
    origin_scope: string;
    source_identity_present: boolean;
    revision_key_present: boolean;
    dedupe_matches: boolean;
    evidences: string;
    revisions: string;
    revision_links: string;
    action: string;
    range_start: number;
    range_end: number;
  }>(
    client,
    `SELECT
       s."originScope"::text AS origin_scope,
       s."sourceIdentity" IS NOT NULL AS source_identity_present,
       s."revisionKey" IS NOT NULL AS revision_key_present,
       s."manualContentDedupeKey" = s."contentHash" AS dedupe_matches,
       (SELECT COUNT(*)::text FROM "ProjectItemEvidence" e
         WHERE e."projectId" = i."projectId" AND e."projectItemId" = i."id") AS evidences,
       (SELECT COUNT(*)::text FROM "ProjectItemRevision" r
         WHERE r."projectId" = i."projectId" AND r."projectItemId" = i."id") AS revisions,
       (SELECT COUNT(*)::text FROM "ProjectItemRevisionEvidence" re
         WHERE re."projectId" = i."projectId" AND re."projectItemId" = i."id") AS revision_links,
       r."action"::text AS action,
       e."rangeStart" AS range_start,
       e."rangeEnd" AS range_end
     FROM "ProjectItem" i
     JOIN "ProjectSource" s
       ON s."projectId" = i."projectId" AND s."id" = i."sourceId"
     JOIN "ProjectItemEvidence" e
       ON e."projectId" = i."projectId" AND e."projectItemId" = i."id"
      AND e."role" = 'primary' AND e."isActive" = true
     JOIN "ProjectItemRevision" r
       ON r."projectId" = i."projectId" AND r."projectItemId" = i."id"
      AND r."revisionNumber" = 1
     WHERE i."projectId" = $1`,
    [projectAId],
  );
  const row = result.rows[0];
  requireCondition(
    row !== undefined &&
      row.origin_scope === "project" &&
      row.source_identity_present &&
      row.revision_key_present &&
      row.dedupe_matches &&
      row.evidences === "1" &&
      row.revisions === "1" &&
      row.revision_links === "1" &&
      row.action === "legacy_import" &&
      row.range_start === 0 &&
      row.range_end === Buffer.byteLength(sourceAContent, "utf8"),
    "AI_RUNTIME_POSTGRES_V0_HISTORY_BACKFILL_MISMATCH",
  );

  await expectActionRejected(
    () => transaction(client, [{
      sql: `INSERT INTO "ProjectItem"
              ("id", "projectId", "type", "reviewStatus", "sourceId",
               "title", "content", "sourceExcerpt", "updatedAt")
            VALUES ('aaaaaaa0-aaaa-4aaa-8aaa-aaaaaaaaaaa9', $1, 'decision',
                    'candidate', $2, 'Untracked item', 'No history', $3,
                    CURRENT_TIMESTAMP)`,
      values: [projectAId, sourceAId, sourceAContent],
    }]),
    "project item without evidence history",
  );
}

async function insertPolicyRevision(
  client: Client,
  revisionId: string,
  projectId: string,
  revision: number,
  outboundEnabled: boolean,
  projectAnalysisEnabled: boolean,
  autoExtractEnabled = false,
  createOperationProfiles = true,
): Promise<void> {
  await safeQuery(
    client,
    `INSERT INTO "ProjectAiPolicyRevision"
       ("id", "projectId", "revision", "policyFingerprint", "outboundEnabled",
        "embeddingEnabled", "autoExtractEnabled", "sourceSummaryEnabled",
        "projectAnalysisEnabled", "generateWithContextEnabled",
        "profileFingerprint", "processorFingerprint", "regionFingerprint",
        "retentionFingerprint", "endpointFingerprint", "budgetFingerprint", "scannerFingerprint")
     VALUES ($1, $2, $3, $4, $5, false, $7, false, $6, false,
             $4, $4, $4, $4, $4, $4, $4)`,
    [
      revisionId,
      projectId,
      revision,
      fingerprintA,
      outboundEnabled,
      projectAnalysisEnabled,
      autoExtractEnabled,
    ],
  );

  if (!createOperationProfiles) return;
  const operations = [
    ...(projectAnalysisEnabled ? ["projectAnalysis"] : []),
    ...(autoExtractEnabled ? ["autoExtract"] : []),
  ];
  for (const operation of operations) {
    await safeQuery(
      client,
      `INSERT INTO "ProjectAiPolicyOperationProfile"
         ("id", "projectId", "policyRevisionId", "operation",
          "profileFingerprint", "providerFingerprint", "modelFingerprint", "modelId",
          "processorFingerprint", "regionFingerprint", "retentionFingerprint",
          "endpointFingerprint")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $4, $4,
               'synthetic-provider/model-v1', $4, $4, $4, $4)`,
      [projectId, revisionId, operation, fingerprintA],
    );
  }
}

async function insertPolicyPointer(
  client: Client,
  projectId: string,
  revisionId: string,
): Promise<void> {
  await safeQuery(
    client,
    `INSERT INTO "ProjectAiPolicy" ("projectId", "currentRevisionId", "updatedAt")
     VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    [projectId, revisionId],
  );
}

async function insertDraftGrant(
  client: Client,
  grantId: string,
  policyRevisionId = revisionAId,
  effectivePolicyVersion = 1,
): Promise<void> {
  await safeQuery(
    client,
    `INSERT INTO "ModelProcessingGrant"
       ("id", "projectId", "sourceKind", "status", "policyRevisionId",
        "profileFingerprint", "providerFingerprint", "modelFingerprint", "modelId",
        "processorFingerprint", "regionFingerprint", "retentionFingerprint",
        "endpointFingerprint", "grantFingerprint", "effectivePolicyVersion",
        "budgetFingerprint", "scannerFingerprint", "scannerVersion", "budgetProfile",
        "issuedBy", "purposeCode", "issuedAt", "expiresAt", "revokedAt", "revocationReasonCode",
        "updatedAt")
     VALUES ($1, $2, 'manual_text', 'draft', $3,
             $4, $4, $4, 'synthetic-provider/model-v1',
             $4, $4, $4, $4, $4, $5, $4, $4, 'scanner-v1', 'standard',
             'runtime-gate-test', 'runtime-gate', NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP)`,
    [
      grantId,
      projectAId,
      policyRevisionId,
      fingerprintA,
      effectivePolicyVersion,
    ],
  );
}

function insertGrantSourceStatement(
  id: string,
  grantId: string,
  sourceId = sourceAId,
  projectId = projectAId,
  contentFingerprint = sourceAContentHash,
  contentBytes = Buffer.byteLength(sourceAContent, "utf8"),
): SqlStatement {
  return {
    sql: `INSERT INTO "ModelProcessingGrantSource"
       ("id", "projectId", "grantId", "sourceId", "contentFingerprint", "contentBytes")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    values: [id, projectId, grantId, sourceId, contentFingerprint, contentBytes],
  };
}

async function insertGrantSource(
  client: Client,
  id: string,
  grantId: string,
  sourceId = sourceAId,
  projectId = projectAId,
  contentFingerprint = sourceAContentHash,
  contentBytes = Buffer.byteLength(sourceAContent, "utf8"),
): Promise<void> {
  const statement = insertGrantSourceStatement(
    id,
    grantId,
    sourceId,
    projectId,
    contentFingerprint,
    contentBytes,
  );
  await safeQuery(client, statement.sql, statement.values);
}

async function insertGrantOperation(
  client: Client,
  id: string,
  grantId: string,
  operation = "projectAnalysis",
  projectId = projectAId,
): Promise<void> {
  await safeQuery(
    client,
    `INSERT INTO "ModelProcessingGrantOperation"
       ("id", "projectId", "grantId", "operation")
     VALUES ($1, $2, $3, $4)`,
    [id, projectId, grantId, operation],
  );
}

async function issueGrant(client: Client, grantId: string): Promise<void> {
  await safeQuery(
    client,
    `UPDATE "ModelProcessingGrant"
        SET "status" = 'issued',
            "issuedAt" = CURRENT_TIMESTAMP,
            "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '1 day'
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, grantId],
  );
}

function insertQueuedRunStatement(
  runId: string,
  operationKey: string,
  grantId = grantAId,
  policyRevisionId = revisionAId,
  projectId = projectAId,
): SqlStatement {
  return {
    sql: `INSERT INTO "AiRun"
       ("id", "projectId", "grantId", "policyRevisionId", "operation",
        "operationKey", "operationKeySchemaVersion", "inputManifestFingerprint",
        "promptFingerprint", "promptVersion", "providerFingerprint", "modelId",
        "modelFingerprint", "profileFingerprint", "grantFingerprint",
        "effectivePolicyVersion", "processorFingerprint", "processorEndpointFingerprint",
        "processorRegionFingerprint", "processorRetentionFingerprint", "noRagSnapshotMarker",
        "inputBytes", "outputBytes", "maxInputTokens", "maxOutputTokens", "maxRequests",
        "maxBudgetMicros", "inputTokens", "outputTokens", "requestCount", "budgetUsedMicros",
        "pricingSnapshotId", "budgetStatus", "status")
     VALUES ($1, $2, $3, $4, 'projectAnalysis', $5, 'ai-operation-key:v1', $6,
             $6, 'prompt-v1', $6, 'synthetic-provider/model-v1', $6, $6, $6, 1,
             $6, $6, $6, $6, 'no-rag-snapshot:v1', 12, 0, 1000, 1000, 1,
             100000, 0, 0, 0, 0, NULL, 'pending', 'queued')`,
    values: [runId, projectId, grantId, policyRevisionId, operationKey, fingerprintA],
  };
}

async function insertQueuedRun(
  client: Client,
  runId: string,
  operationKey: string,
  grantId = grantAId,
  policyRevisionId = revisionAId,
  projectId = projectAId,
): Promise<void> {
  const statement = insertQueuedRunStatement(
    runId,
    operationKey,
    grantId,
    policyRevisionId,
    projectId,
  );
  await safeQuery(client, statement.sql, statement.values);
}

function operationKeyForManifest(manifest: ReturnType<typeof buildInputManifest>): string {
  return buildOperationKey({
    schemaVersion: "ai-operation-key:v1",
    projectId: projectAId,
    operation: "projectAnalysis",
    sourceManifest: manifest.map((entry) => ({
      sourceId: entry.sourceId,
      contentFingerprint: entry.contentFingerprint,
      contentBytes: entry.contentBytes,
      evidenceManifestFingerprint: entry.evidenceManifestFingerprint,
    })),
    promptFingerprint: FAKE_PROFILE.promptFingerprint,
    promptVersion: FAKE_PROFILE.promptVersion,
    profileFingerprint: fingerprintA,
    providerFingerprint: fingerprintA,
    modelId: FAKE_PROFILE.modelId,
    modelFingerprint: fingerprintA,
    grantFingerprint: fingerprintA,
    effectivePolicyVersion: 1,
    processorFingerprint: fingerprintA,
    processorEndpointFingerprint: fingerprintA,
    processorRegionFingerprint: fingerprintA,
    processorRetentionFingerprint: fingerprintA,
    noRagSnapshotMarker: "no-rag-snapshot:v1",
  });
}

async function insertProfileQueuedRun(
  client: Client,
  runId: string,
  operationKey: string,
  inputManifestFingerprint: string,
  inputBytes: number,
): Promise<void> {
  await safeQuery(
    client,
    `INSERT INTO "AiRun"
       ("id", "projectId", "grantId", "policyRevisionId", "operation",
        "operationKey", "operationKeySchemaVersion", "inputManifestFingerprint",
        "promptFingerprint", "promptVersion", "providerFingerprint", "modelId",
        "modelFingerprint", "profileFingerprint", "grantFingerprint",
        "effectivePolicyVersion", "processorFingerprint", "processorEndpointFingerprint",
        "processorRegionFingerprint", "processorRetentionFingerprint", "noRagSnapshotMarker",
        "inputBytes", "outputBytes", "maxInputTokens", "maxOutputTokens", "maxRequests",
        "maxBudgetMicros", "inputTokens", "outputTokens", "requestCount", "budgetUsedMicros",
        "pricingSnapshotId", "budgetStatus", "status")
     VALUES ($1, $2, $3, $4, 'projectAnalysis', $5, 'ai-operation-key:v1', $6,
             $9, 'fake-prompt-v1', $7, 'synthetic-provider/model-v1', $7, $7, $7, 1,
             $7, $7, $7, $7, 'no-rag-snapshot:v1', $8, 0, 4096, 1024, 1,
             1000000, 0, 0, 0, 0, 'fake-pricing-v1', 'pending', 'queued')`,
    [
      runId,
      projectAId,
      grantAId,
      revisionAId,
      operationKey,
      inputManifestFingerprint,
      fingerprintA,
      inputBytes,
      FAKE_PROFILE.promptFingerprint,
    ],
  );
}

async function insertExactRunInputSource(
  client: Client,
  inputId: string,
  runId: string,
  sourceId: string,
  contentFingerprint: string,
  contentBytes: number,
  scannerVersion: string,
  evidenceManifestFingerprint: string,
): Promise<void> {
  await safeQuery(
    client,
    `INSERT INTO "AiRunInputSource"
       ("id", "projectId", "aiRunId", "grantId", "sourceId", "contentFingerprint",
        "contentBytes", "scannerVersion", "safeScanResult", "evidenceManifestFingerprint")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'passed', $9)`,
    [
      inputId,
      projectAId,
      runId,
      grantAId,
      sourceId,
      contentFingerprint,
      contentBytes,
      scannerVersion,
      evidenceManifestFingerprint,
    ],
  );
}

function claimRunStatement(runId: string, requestCount = 1): SqlStatement {
  return {
    sql: `UPDATE "AiRun"
             SET "status" = 'running',
                 "requestCount" = $3,
                 "claimedAt" = CURRENT_TIMESTAMP,
                 "sentAt" = CURRENT_TIMESTAMP
           WHERE "projectId" = $1 AND "id" = $2`,
    values: [projectAId, runId, requestCount],
  };
}

function insertSentAttemptStatement(
  attemptId: string,
  runId: string,
  attemptNumber = 1,
  projectId = projectAId,
): SqlStatement {
  return {
    sql: `INSERT INTO "AiRunAttempt"
       ("id", "projectId", "aiRunId", "attemptNumber", "dispatchToken", "status",
        "inputTokens", "outputTokens", "requestCount")
     VALUES ($1, $2, $3, $4, $5, 'sent', 0, 0, 1)`,
    values: [attemptId, projectId, runId, attemptNumber, `dispatch-${attemptId}`],
  };
}

async function claimRun(
  client: Client,
  runId: string,
  attemptId: string,
): Promise<void> {
  await transaction(client, [
    claimRunStatement(runId),
    insertSentAttemptStatement(attemptId, runId),
  ]);
}

function insertRunInputSourceStatement(
  inputId: string,
  runId: string,
  projectId = projectAId,
  grantId = grantAId,
  sourceId = sourceAId,
  contentFingerprint = sourceAContentHash,
  contentBytes = Buffer.byteLength(sourceAContent, "utf8"),
  scannerVersion = "scanner-v1",
): SqlStatement {
  return {
    sql: `INSERT INTO "AiRunInputSource"
       ("id", "projectId", "aiRunId", "grantId", "sourceId", "contentFingerprint",
        "contentBytes", "scannerVersion", "safeScanResult", "evidenceManifestFingerprint")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'passed', $6)`,
    values: [
      inputId,
      projectId,
      runId,
      grantId,
      sourceId,
      contentFingerprint,
      contentBytes,
      scannerVersion,
    ],
  };
}

async function insertRunInputSource(
  client: Client,
  inputId: string,
  runId: string,
  projectId = projectAId,
  grantId = grantAId,
  sourceId = sourceAId,
  contentFingerprint = sourceAContentHash,
  contentBytes = Buffer.byteLength(sourceAContent, "utf8"),
  scannerVersion = "scanner-v1",
): Promise<void> {
  const statement = insertRunInputSourceStatement(
    inputId,
    runId,
    projectId,
    grantId,
    sourceId,
    contentFingerprint,
    contentBytes,
    scannerVersion,
  );
  await safeQuery(client, statement.sql, statement.values);
}

function insertAuditEventStatement(
  eventId: string,
  projectId: string,
  eventType: string,
  policyRevisionId: string,
  grantId: string | null = null,
  runId: string | null = null,
  attemptId: string | null = null,
): SqlStatement {
  return {
    sql: `INSERT INTO "AiAuditEvent"
       ("id", "projectId", "policyRevisionId", "eventType", "grantId", "aiRunId", "attemptId")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    values: [eventId, projectId, policyRevisionId, eventType, grantId, runId, attemptId],
  };
}

async function insertAuditEvent(
  client: Client,
  eventId: string,
  projectId: string,
  eventType: string,
  policyRevisionId: string,
  grantId: string | null = null,
  runId: string | null = null,
  attemptId: string | null = null,
): Promise<void> {
  const statement = insertAuditEventStatement(
    eventId,
    projectId,
    eventType,
    policyRevisionId,
    grantId,
    runId,
    attemptId,
  );
  await safeQuery(client, statement.sql, statement.values);
}

function completeAttemptStatement(
  attemptId: string,
  status: "succeeded" | "failed" | "unknown" | "cancelled",
): SqlStatement {
  return {
    sql: `UPDATE "AiRunAttempt"
             SET "status" = $3,
                 "completedAt" = CURRENT_TIMESTAMP
           WHERE "projectId" = $1 AND "id" = $2`,
    values: [projectAId, attemptId, status],
  };
}

function completeRunStatement(
  runId: string,
  status: "succeeded" | "failed" | "unknown" | "cancelled",
): SqlStatement {
  return {
    sql: `UPDATE "AiRun"
             SET "status" = $3,
                 "completedAt" = CURRENT_TIMESTAMP
           WHERE "projectId" = $1 AND "id" = $2`,
    values: [projectAId, runId, status],
  };
}

test("AI runtime PostgreSQL URL guard allows the exact disposable loopback targets", () => {
  for (const value of [
    `postgresql://127.0.0.1:${testDatabasePort}/${testDatabaseName}`,
    `postgres://localhost:${testDatabasePort}/${testDatabaseName}`,
    `postgresql://user:pass@[::1]:${testDatabasePort}/${testDatabaseName}`,
  ]) {
    assert.equal(validateAiRuntimeTestDatabaseUrl(value), value);
  }
});

test("AI runtime PostgreSQL URL guard rejects unsafe targets without connecting", () => {
  for (const value of [
    `postgresql://db.internal:${testDatabasePort}/${testDatabaseName}`,
    `postgresql://127.0.0.1:5433/${testDatabaseName}`,
    `postgresql://127.0.0.1:55432/${testDatabaseName}`,
    `postgresql://127.0.0.1:${testDatabasePort}/other_database`,
    `postgresql://127.0.0.1:${testDatabasePort}/${testDatabaseName}?sslmode=disable`,
    `postgresql://127.0.0.1:${testDatabasePort}/${testDatabaseName}#fragment`,
    `postgresql://127.0.0.1:${testDatabasePort}/%61i_project_os_ai_runtime_test`,
    `postgresql://127.0.0.1:${testDatabasePort}/${testDatabaseName}/extra`,
    `postgresql://127.0.0.1/${testDatabaseName}`,
    `mysql://127.0.0.1:${testDatabasePort}/${testDatabaseName}`,
    "not-a-url",
  ]) {
    assert.throws(
      () => validateAiRuntimeTestDatabaseUrl(value),
      (error: unknown) =>
        error instanceof Error && error.message === "AI_RUNTIME_TEST_DATABASE_URL_INVALID",
    );
  }
});

test(
  "AI runtime PostgreSQL integration requires an explicit gate before any connection",
  { skip: !hasConfiguredTestUrl || postgresGate === "1" },
  () => {
    throw new Error("AI_RUNTIME_POSTGRES_GATE must equal 1");
  },
);

async function runEmptyDatabasePath(client: Client, url: string): Promise<void> {
  await resetPublic(client);
  await runPrismaMigrateDeploy(url);
  await assertEmptyDatabaseCatalog(client);
}

async function runV0UpgradePath(client: Client): Promise<void> {
  await resetPublic(client);
  for (const path of v0MigrationPaths) {
    await applySqlMigration(client, path);
  }
  await seedV0Rows(client);
  await assertV0RowsSurviveAiMigration(client);
  await applyAiMigrationInTransaction(client);
  await assertV0RowsSurviveAiMigration(client);
  await assertV0ItemHistoryBackfill(client);
}

async function runPolicyAndGrantMatrix(client: Client): Promise<void> {
  await insertPolicyRevision(client, revisionAId, projectAId, 1, true, true, true);
  await insertPolicyPointer(client, projectAId, revisionAId);

  await expectRejected(
    client,
    `INSERT INTO "ProjectAiPolicyOperationProfile"
       ("id", "projectId", "policyRevisionId", "operation",
        "profileFingerprint", "providerFingerprint", "modelFingerprint", "modelId",
        "processorFingerprint", "regionFingerprint", "retentionFingerprint",
        "endpointFingerprint")
     VALUES (gen_random_uuid(), $1, $2, 'projectAnalysis', $3, $3, $3,
             'synthetic-provider/model-v1', $3, $3, $3, $3)`,
    [projectAId, revisionAId, fingerprintA],
    "current operation profile append",
  );

  await safeQuery(
    client,
    `INSERT INTO "ProjectAiPolicyRevision"
       ("id", "projectId", "revision", "policyFingerprint", "outboundEnabled",
        "embeddingEnabled", "autoExtractEnabled", "sourceSummaryEnabled",
        "projectAnalysisEnabled", "generateWithContextEnabled",
        "profileFingerprint", "processorFingerprint", "regionFingerprint",
        "retentionFingerprint", "endpointFingerprint", "budgetFingerprint", "scannerFingerprint")
     VALUES ('bbbbbbb4-bbbb-4bbb-8bbb-bbbbbbbbbbb4', $1, 1, $2, true,
             false, false, false, true, false, $2, $2, $2, $2, $2, $2, $2)`,
    [projectBId, fingerprintA],
  );
  await expectRejected(
    client,
    `INSERT INTO "ProjectAiPolicy" ("projectId", "currentRevisionId", "updatedAt")
     VALUES ($1, 'bbbbbbb4-bbbb-4bbb-8bbb-bbbbbbbbbbb4', CURRENT_TIMESTAMP)`,
    [projectBId],
    "policy pointer without complete operation profiles",
  );

  await expectRejected(
    client,
    `UPDATE "ProjectAiPolicyRevision"
        SET "revision" = 9
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, revisionAId],
    "policy revision update",
  );
  await expectRejected(
    client,
    `DELETE FROM "ProjectAiPolicyRevision"
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, revisionAId],
    "policy revision direct delete",
  );
  await expectRejected(
    client,
    `DELETE FROM "ProjectAiPolicy" WHERE "projectId" = $1`,
    [projectAId],
    "policy direct delete",
  );

  await insertDraftGrant(client, grantIncompleteId);
  await expectActionRejected(
    () => issueGrant(client, grantIncompleteId),
    "incomplete grant issuance",
  );

  await insertDraftGrant(client, grantBadOperationId);
  await expectRejected(
    client,
    `INSERT INTO "ModelProcessingGrantOperation"
       ("id", "projectId", "grantId", "operation")
     VALUES ($1, $2, $3, 'embedding')`,
    [grantOperationBadId, projectAId, grantBadOperationId],
    "policy-disallowed operation scope",
  );
  await safeQuery(
    client,
    `UPDATE "ModelProcessingGrant"
        SET "modelFingerprint" = $3, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, grantBadOperationId, fingerprintB],
  );
  await expectActionRejected(
    () => insertGrantOperation(
      client,
      grantOperationBadId,
      grantBadOperationId,
      "projectAnalysis",
    ),
    "grant operation model profile mismatch",
  );

  await insertDraftGrant(client, grantAId);
  await insertGrantSource(client, grantSourceAId, grantAId);
  await insertGrantOperation(client, grantOperationAId, grantAId);
  await expectActionRejected(
    () => insertGrantOperation(
      client,
      grantOperationBadId,
      grantAId,
      "autoExtract",
    ),
    "grant second operation",
  );
  await issueGrant(client, grantAId);

  await expectActionRejected(
    () => insertGrantSource(client, grantSourceIncompleteId, grantAId, sourceAId),
    "issued grant source expansion",
  );
  await expectRejected(
    client,
    `UPDATE "ModelProcessingGrantSource"
        SET "contentBytes" = 13
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, grantSourceAId],
    "issued grant source update",
  );
  await expectRejected(
    client,
    `DELETE FROM "ModelProcessingGrantSource"
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, grantSourceAId],
    "issued grant source delete",
  );
  await expectActionRejected(
    () => insertGrantOperation(client, grantOperationBadId, grantAId, "projectAnalysis"),
    "issued grant operation expansion",
  );
  await expectRejected(
    client,
    `UPDATE "ModelProcessingGrantOperation"
        SET "operation" = 'embedding'
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, grantOperationAId],
    "issued grant operation update",
  );
  await expectRejected(
    client,
    `DELETE FROM "ModelProcessingGrantOperation"
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, grantOperationAId],
    "issued grant operation delete",
  );
  await expectRejected(
    client,
    `UPDATE "ModelProcessingGrant"
        SET "modelId" = 'synthetic-provider/model-v2'
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, grantAId],
    "issued grant model update",
  );

  await insertPolicyRevision(client, revisionA2Id, projectAId, 2, false, false);
  await safeQuery(
    client,
    `UPDATE "ProjectAiPolicy"
        SET "currentRevisionId" = $2, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "projectId" = $1`,
    [projectAId, revisionA2Id],
  );
  await expectRejected(
    client,
    `UPDATE "ProjectAiPolicy"
        SET "currentRevisionId" = $2, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "projectId" = $1`,
    [projectAId, revisionAId],
    "policy pointer reverse update",
  );

  await insertDraftGrant(client, grantAfterAdvanceId, revisionAId);
  await insertGrantSource(client, grantSourceAfterAdvanceId, grantAfterAdvanceId);
  await insertGrantOperation(client, grantOperationAfterAdvanceId, grantAfterAdvanceId);
  await expectActionRejected(
    () => issueGrant(client, grantAfterAdvanceId),
    "post-advance grant issuance",
  );
  await expectActionRejected(
    () => insertQueuedRun(client, runMainId, operationKeyValues[0]),
    "post-advance run creation",
  );
}

async function setupFreshLiveGrant(client: Client): Promise<void> {
  await runV0UpgradePath(client);
  await insertPolicyRevision(client, revisionAId, projectAId, 1, true, true);
  await insertPolicyPointer(client, projectAId, revisionAId);
  await insertDraftGrant(client, grantAId);
  await insertGrantSource(client, grantSourceAId, grantAId);
  await insertGrantOperation(client, grantOperationAId, grantAId);
  await issueGrant(client, grantAId);
}

async function setupPrepareOrGetFixture(client: Client): Promise<void> {
  await runV0UpgradePath(client);
  await safeQuery(
    client,
    `INSERT INTO "ProjectSource"
       ("id", "projectId", "kind", "externalRef", "contentText", "contentHash", "capturedAt")
     VALUES ($1, $2, 'manual', NULL, $3, $4, CURRENT_TIMESTAMP)`,
    [
      sourceA2Id,
      projectAId,
      sourceA2Content,
      sourceA2ContentHash,
    ],
  );
  await insertPolicyRevision(client, revisionAId, projectAId, 1, true, true);
  await insertPolicyPointer(client, projectAId, revisionAId);
  await insertDraftGrant(client, grantAId);
  await insertGrantSource(client, grantSourceAId, grantAId);
  await insertGrantSource(
    client,
    grantSourceA2Id,
    grantAId,
    sourceA2Id,
    projectAId,
    sourceA2ContentHash,
    Buffer.byteLength(sourceA2Content, "utf8"),
  );
  await insertGrantOperation(client, grantOperationAId, grantAId);
  await issueGrant(client, grantAId);
}

async function runPrepareOrGetConcurrency(client: Client, url: string): Promise<void> {
  await setupPrepareOrGetFixture(client);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });
  const recorder = new FakeAdmissibilityRecorder();
  const service = createAiRuntimeService({
    db: prisma,
    admissibilityGate: new FakeAdmissibilityGate({ recorder }),
  });
  const request = {
    projectId: projectAId,
    grantId: grantAId,
    operation: "projectAnalysis" as const,
    sourceIds: [sourceAId, sourceA2Id],
  };
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.prepareOrGetRun(request)),
    );
    const successful = results.filter((result) => result.kind !== "rejected");
    const rejectedSafeCodeCounts: Record<string, number> = {};
    for (const result of results) {
      if (result.kind === "rejected") {
        rejectedSafeCodeCounts[result.safeCode] =
          (rejectedSafeCodeCounts[result.safeCode] ?? 0) + 1;
      }
    }
    const orderedRejectedSafeCodeCounts = Object.fromEntries(
      Object.entries(rejectedSafeCodeCounts).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    const resultDistribution = JSON.stringify({
      created: results.filter((result) => result.kind === "created").length,
      existing: results.filter((result) => result.kind === "existing").length,
      rejected: results.filter((result) => result.kind === "rejected").length,
      rejectedSafeCodes: orderedRejectedSafeCodeCounts,
    });
    requireCondition(
      successful.length === 20,
      `AI_RUNTIME_POSTGRES_PREPARE_RESULT_DISTRIBUTION ${resultDistribution}`,
    );
    const createdCount = successful.filter((result) => result.kind === "created").length;
    const runIds = new Set(successful.map((result) => result.runId));
    const operationKeys = new Set(successful.map((result) => result.operationKey));
    requireCondition(createdCount === 1, "AI_RUNTIME_POSTGRES_PREPARE_CREATED_COUNT");
    requireCondition(runIds.size === 1, "AI_RUNTIME_POSTGRES_PREPARE_RUN_ID_MISMATCH");
    requireCondition(
      operationKeys.size === 1,
      "AI_RUNTIME_POSTGRES_PREPARE_OPERATION_KEY_MISMATCH",
    );
    requireCondition(
      successful.every(
        (result) =>
          result.status === "queued" &&
          result.safeCode === null &&
          result.inputBytes ===
            Buffer.byteLength(sourceAContent, "utf8") +
              Buffer.byteLength(sourceA2Content, "utf8") &&
          result.sourceCount === 2,
      ),
      "AI_RUNTIME_POSTGRES_PREPARE_RESULT_MISMATCH",
    );

    const expectedManifest = buildInputManifest([
      {
        sourceId: sourceAId,
        contentFingerprint: sourceAContentHash,
        contentBytes: Buffer.byteLength(sourceAContent, "utf8"),
        scannerVersion: "scanner-v1",
      },
      {
        sourceId: sourceA2Id,
        contentFingerprint: sourceA2ContentHash,
        contentBytes: Buffer.byteLength(sourceA2Content, "utf8"),
        scannerVersion: "scanner-v1",
      },
    ]);
    const expectedInputManifestFingerprint =
      buildInputManifestFingerprint(expectedManifest);
    const runId = [...runIds][0];
    const operationKey = [...operationKeys][0];
    requireCondition(runId !== undefined && operationKey !== undefined, "AI_RUNTIME_POSTGRES_PREPARE_IDS_MISSING");

    const counts = await safeQuery<{
      runs: string;
      inputs: string;
      run_created_audits: string;
      attempts: string;
    }>(
      client,
      `SELECT
         (SELECT COUNT(*)::text FROM "AiRun" WHERE "projectId" = $1) AS runs,
         (SELECT COUNT(*)::text FROM "AiRunInputSource" WHERE "projectId" = $1) AS inputs,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "eventType" = 'runCreated') AS run_created_audits,
         (SELECT COUNT(*)::text FROM "AiRunAttempt" WHERE "projectId" = $1) AS attempts`,
      [projectAId],
    );
    const countRow = counts.rows[0];
    requireCondition(
      countRow?.runs === "1" &&
        countRow.inputs === "2" &&
        countRow.run_created_audits === "1" &&
        countRow.attempts === "0",
      "AI_RUNTIME_POSTGRES_PREPARE_SIDE_EFFECT_COUNT",
    );

    const persistedRun = await safeQuery<{
      operation_key: string;
      input_manifest_fingerprint: string;
      input_bytes: number;
    }>(
      client,
      `SELECT
         "operationKey" AS operation_key,
         "inputManifestFingerprint" AS input_manifest_fingerprint,
         "inputBytes" AS input_bytes
         FROM "AiRun"
        WHERE "projectId" = $1 AND "id" = $2`,
      [projectAId, runId],
    );
    const runRow = persistedRun.rows[0];
    requireCondition(
      runRow?.operation_key === operationKey &&
        runRow.input_manifest_fingerprint === expectedInputManifestFingerprint &&
        runRow.input_bytes ===
          Buffer.byteLength(sourceAContent, "utf8") +
            Buffer.byteLength(sourceA2Content, "utf8"),
      "AI_RUNTIME_POSTGRES_PREPARE_RUN_SNAPSHOT",
    );

    const persistedInputs = await safeQuery<{
      source_id: string;
      content_fingerprint: string;
      content_bytes: number;
      scanner_version: string;
      evidence_manifest_fingerprint: string;
    }>(
      client,
      `SELECT
         "sourceId"::text AS source_id,
         "contentFingerprint" AS content_fingerprint,
         "contentBytes" AS content_bytes,
         "scannerVersion" AS scanner_version,
         "evidenceManifestFingerprint" AS evidence_manifest_fingerprint
         FROM "AiRunInputSource"
        WHERE "projectId" = $1 AND "aiRunId" = $2
        ORDER BY "sourceId" ASC`,
      [projectAId, runId],
    );
    requireCondition(
      persistedInputs.rows.length === expectedManifest.length &&
        persistedInputs.rows.every((row, index) => {
          const expected = expectedManifest[index];
          return (
            expected !== undefined &&
            row.source_id === expected.sourceId &&
            row.content_fingerprint === expected.contentFingerprint &&
            row.content_bytes === expected.contentBytes &&
            row.scanner_version === expected.scannerVersion &&
            row.evidence_manifest_fingerprint === expected.evidenceManifestFingerprint
          );
        }),
      "AI_RUNTIME_POSTGRES_PREPARE_INPUT_SNAPSHOT",
    );
    requireCondition(
      !/runtime-src-[ab]|contentText|prompt|body|apiKey|secret/i.test(
        JSON.stringify(recorder.records),
      ),
      "AI_RUNTIME_POSTGRES_PREPARE_GATE_LEAK",
    );

    const reversed = await service.prepareOrGetRun({
      ...request,
      sourceIds: [sourceA2Id, sourceAId],
    });
    requireCondition(
      reversed.kind === "existing" &&
        reversed.runId === runId &&
        reversed.operationKey === operationKey &&
        reversed.inputManifestFingerprint === expectedInputManifestFingerprint,
      "AI_RUNTIME_POSTGRES_PREPARE_REVERSE_EXISTING",
    );

    const claimRecorder = new FakeAdmissibilityRecorder();
    const completedProvider = new FakeProviderRecorder({
      kind: "completed",
      providerRequestId: "fake-request-1",
      providerResponseId: "fake-response-1",
      usage: { inputTokens: 3, outputTokens: 4, requestCount: 1 },
    });
    const claimService = createAiRuntimeService({
      db: prisma,
      admissibilityGate: new FakeAdmissibilityGate({ recorder: claimRecorder }),
      provider: completedProvider,
    });
    const claimResults = await Promise.all(
      Array.from({ length: 20 }, () =>
        claimService.claimAndDispatchRun({
          ...request,
          runId,
          operationKey,
        }),
      ),
    );
    const claimedResults = claimResults.filter((result) => result.kind === "claimed");
    const existingResults = claimResults.filter((result) => result.kind === "existing");
    const claimDistribution = claimResultHistogram(claimResults);
    requireCondition(
      claimResults.length === 20 &&
        claimedResults.length === 1 &&
        claimedResults[0]?.status === "succeeded" &&
        claimedResults[0]?.safeCode === null &&
        existingResults.length === 19 &&
        existingResults.every((result) => result.safeCode === null),
      `AI_RUNTIME_POSTGRES_CLAIM_RESULT_DISTRIBUTION ${claimDistribution}`,
    );
    requireCondition(completedProvider.count === 1, "AI_RUNTIME_POSTGRES_PROVIDER_DISPATCH_COUNT");
    const expectedInputBytes =
      Buffer.byteLength(sourceAContent, "utf8") +
      Buffer.byteLength(sourceA2Content, "utf8");
    const expectedBudget = calculateFakeBudgetMicros({
      inputBytes: expectedInputBytes,
      outputTokens: 4,
    });
    const claimedRun = await safeQuery<{
      status: string;
      request_count: number;
      input_tokens: number;
      output_tokens: number;
      budget_used_micros: number;
      budget_status: string;
      safe_error_code: string | null;
      provider_request_id: string | null;
      provider_response_id: string | null;
      http_status: number | null;
    }>(
      client,
      `SELECT "status"::text AS status,
              "requestCount" AS request_count,
              "inputTokens" AS input_tokens,
              "outputTokens" AS output_tokens,
              "budgetUsedMicros" AS budget_used_micros,
              "budgetStatus"::text AS budget_status,
              "safeErrorCode"::text AS safe_error_code,
              "providerRequestId" AS provider_request_id,
              "providerResponseId" AS provider_response_id,
              "httpStatus" AS http_status
         FROM "AiRun"
        WHERE "projectId" = $1 AND "id" = $2`,
      [projectAId, runId],
    );
    const claimedRunRow = claimedRun.rows[0];
    const claimedRunDiagnostic =
      claimedRunRow === undefined
        ? "missing"
        : JSON.stringify({
            status: claimedRunRow.status,
            requestCount: claimedRunRow.request_count,
            inputTokens: claimedRunRow.input_tokens,
            outputTokens: claimedRunRow.output_tokens,
            budgetUsedMicros: claimedRunRow.budget_used_micros,
            budgetStatus: claimedRunRow.budget_status,
            providerRequestIdPresent: claimedRunRow.provider_request_id !== null,
            providerResponseIdPresent: claimedRunRow.provider_response_id !== null,
            httpStatusPresent: claimedRunRow.http_status !== null,
            safeErrorCode: claimedRunRow.safe_error_code,
          });
    requireCondition(
      claimedRunRow?.status === "succeeded" &&
        claimedRunRow.request_count === 1 &&
        claimedRunRow.input_tokens === 3 &&
        claimedRunRow.output_tokens === 4 &&
        claimedRunRow.budget_used_micros === expectedBudget &&
        claimedRunRow.budget_used_micros <= 100000 &&
        claimedRunRow.budget_status === "allowed" &&
        claimedRunRow.safe_error_code === null &&
        claimedRunRow.provider_request_id === "fake-request-1" &&
        claimedRunRow.provider_response_id === "fake-response-1" &&
        claimedRunRow.http_status === null,
      `AI_RUNTIME_POSTGRES_CLAIM_RUN_PARITY ${claimedRunDiagnostic}`,
    );
    const claimedAttempt = await safeQuery<{
      status: string;
      attempt_number: number;
      request_count: number;
      input_tokens: number;
      output_tokens: number;
      safe_error_code: string | null;
      provider_request_id: string | null;
      provider_response_id: string | null;
      http_status: number | null;
    }>(
      client,
      `SELECT "status"::text AS status,
              "attemptNumber" AS attempt_number,
              "requestCount" AS request_count,
              "inputTokens" AS input_tokens,
              "outputTokens" AS output_tokens,
              "safeErrorCode"::text AS safe_error_code,
              "providerRequestId" AS provider_request_id,
              "providerResponseId" AS provider_response_id,
              "httpStatus" AS http_status
         FROM "AiRunAttempt"
        WHERE "projectId" = $1 AND "aiRunId" = $2`,
      [projectAId, runId],
    );
    const claimedAttemptRow = claimedAttempt.rows[0];
    requireCondition(
      claimedAttempt.rows.length === 1 &&
        claimedAttemptRow?.status === "succeeded" &&
        claimedAttemptRow.attempt_number === 1 &&
        claimedAttemptRow.request_count === 1 &&
        claimedAttemptRow.input_tokens === 3 &&
        claimedAttemptRow.output_tokens === 4 &&
        claimedAttemptRow.safe_error_code === null &&
        claimedAttemptRow.provider_request_id === "fake-request-1" &&
        claimedAttemptRow.provider_response_id === "fake-response-1" &&
        claimedAttemptRow.http_status === null,
      "AI_RUNTIME_POSTGRES_CLAIM_ATTEMPT_PARITY",
    );
    const claimAuditCounts = await safeQuery<{
      run_claimed: string;
      dispatch_sent: string;
      run_succeeded: string;
      attempt_succeeded: string;
      run_created: string;
    }>(
      client,
      `SELECT
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2 AND "eventType" = 'runClaimed') AS run_claimed,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2 AND "eventType" = 'dispatchSent') AS dispatch_sent,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2 AND "eventType" = 'runSucceeded') AS run_succeeded,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2 AND "eventType" = 'attemptSucceeded') AS attempt_succeeded,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2 AND "eventType" = 'runCreated') AS run_created`,
      [projectAId, runId],
    );
    requireCondition(
      claimAuditCounts.rows[0]?.run_claimed === "1" &&
        claimAuditCounts.rows[0].dispatch_sent === "1" &&
        claimAuditCounts.rows[0].run_succeeded === "1" &&
        claimAuditCounts.rows[0].attempt_succeeded === "1" &&
        claimAuditCounts.rows[0].run_created === "1",
      "AI_RUNTIME_POSTGRES_CLAIM_AUDIT_COUNTS",
    );
    requireCondition(
      !/runtime-src-[ab]|contentText|prompt|body|apiKey|secret/i.test(
        JSON.stringify({ gate: claimRecorder.records, provider: completedProvider.records }),
      ),
      "AI_RUNTIME_POSTGRES_CLAIM_SAFE_METADATA",
    );

    const boundaryPrepared = await claimService.prepareOrGetRun({
      ...request,
      sourceIds: [sourceA2Id],
    });
    requireCondition(
      boundaryPrepared.kind === "created" && boundaryPrepared.status === "queued",
      "AI_RUNTIME_POSTGRES_PROVIDER_ID_BOUNDARY_PREPARE",
    );
    const boundaryRunId = boundaryPrepared.runId;
    const boundaryOperationKey = boundaryPrepared.operationKey;
    const maxLengthProviderId = "x".repeat(512);
    const boundaryProvider = new FakeProviderRecorder({
      kind: "completed",
      providerRequestId: maxLengthProviderId,
      providerResponseId: maxLengthProviderId,
      usage: { inputTokens: 3, outputTokens: 4, requestCount: 1 },
    });
    const boundaryService = createAiRuntimeService({
      db: prisma,
      admissibilityGate: new FakeAdmissibilityGate(),
      provider: boundaryProvider,
    });
    const boundaryResult = await boundaryService.claimAndDispatchRun({
      ...request,
      sourceIds: [sourceA2Id],
      runId: boundaryRunId,
      operationKey: boundaryOperationKey,
    });
    requireCondition(
      boundaryResult.kind === "claimed" &&
        boundaryResult.status === "succeeded" &&
        boundaryResult.safeCode === null &&
        boundaryProvider.count === 1,
      "AI_RUNTIME_POSTGRES_PROVIDER_ID_MAX_LENGTH_ACCEPTED",
    );
    const boundaryLengths = await safeQuery<{
      run_request_length: number;
      run_response_length: number;
      attempt_request_length: number;
      attempt_response_length: number;
    }>(
      client,
      `SELECT
         char_length(r."providerRequestId") AS run_request_length,
         char_length(r."providerResponseId") AS run_response_length,
         char_length(a."providerRequestId") AS attempt_request_length,
         char_length(a."providerResponseId") AS attempt_response_length
         FROM "AiRun" r
         JOIN "AiRunAttempt" a
           ON a."projectId" = r."projectId" AND a."aiRunId" = r."id"
        WHERE r."projectId" = $1 AND r."id" = $2`,
      [projectAId, boundaryRunId],
    );
    const boundaryLengthRow = boundaryLengths.rows[0];
    requireCondition(
      boundaryLengthRow?.run_request_length === 512 &&
        boundaryLengthRow.run_response_length === 512 &&
        boundaryLengthRow.attempt_request_length === 512 &&
        boundaryLengthRow.attempt_response_length === 512,
      "AI_RUNTIME_POSTGRES_PROVIDER_ID_MAX_LENGTH_PERSISTED",
    );

    const overLengthRunId = batch2RunId(30);
    const overLengthAttemptId = batch2AttemptId(30);
    await insertQueuedRun(client, overLengthRunId, batch2OperationKey(30));
    await claimRun(client, overLengthRunId, overLengthAttemptId);
    await expectActionRejected(
      () =>
        transaction(client, [
          {
            sql: `UPDATE "AiRunAttempt"
                    SET "status" = 'succeeded',
                        "providerRequestId" = 'safe-attempt-request',
                        "completedAt" = CURRENT_TIMESTAMP
                  WHERE "projectId" = $1 AND "id" = $2 AND "aiRunId" = $3`,
            values: [projectAId, overLengthAttemptId, overLengthRunId],
          },
          {
            sql: `UPDATE "AiRun"
                    SET "status" = 'succeeded',
                        "outputBytes" = 0,
                        "inputTokens" = 0,
                        "outputTokens" = 0,
                        "requestCount" = 1,
                        "budgetUsedMicros" = 0,
                        "budgetStatus" = 'allowed',
                        "safeErrorCode" = NULL,
                        "httpStatus" = NULL,
                        "providerRequestId" = $3,
                        "providerResponseId" = NULL,
                        "completedAt" = CURRENT_TIMESTAMP
                  WHERE "projectId" = $1 AND "id" = $2`,
            values: [projectAId, overLengthRunId, "x".repeat(513)],
          },
        ]),
      "provider request id over max length",
    );
    const overLengthState = await safeQuery<{
      run_status: string;
      run_completed: boolean;
      run_provider_request_null: boolean;
      attempt_status: string;
      attempt_completed: boolean;
      attempt_provider_request_null: boolean;
    }>(
      client,
      `SELECT
         r."status"::text AS run_status,
         r."completedAt" IS NULL AS run_completed,
         r."providerRequestId" IS NULL AS run_provider_request_null,
         a."status"::text AS attempt_status,
         a."completedAt" IS NULL AS attempt_completed,
         a."providerRequestId" IS NULL AS attempt_provider_request_null
         FROM "AiRun" r
         JOIN "AiRunAttempt" a
           ON a."projectId" = r."projectId" AND a."aiRunId" = r."id"
        WHERE r."projectId" = $1 AND r."id" = $2`,
      [projectAId, overLengthRunId],
    );
    requireCondition(
      overLengthState.rows[0]?.run_status === "running" &&
        overLengthState.rows[0].run_completed &&
        overLengthState.rows[0].run_provider_request_null &&
        overLengthState.rows[0].attempt_status === "sent" &&
        overLengthState.rows[0].attempt_completed &&
        overLengthState.rows[0].attempt_provider_request_null,
      "AI_RUNTIME_POSTGRES_PROVIDER_ID_LENGTH_REJECTED_NO_SIDE_EFFECT",
    );

    const secretRunId = batch2RunId(31);
    const secretAttemptId = batch2AttemptId(31);
    await insertQueuedRun(client, secretRunId, batch2OperationKey(31));
    await claimRun(client, secretRunId, secretAttemptId);
    await expectActionRejected(
      () =>
        transaction(client, [
          {
            sql: `UPDATE "AiRun"
                    SET "status" = 'succeeded',
                        "outputBytes" = 0,
                        "inputTokens" = 0,
                        "outputTokens" = 0,
                        "requestCount" = 1,
                        "budgetUsedMicros" = 0,
                        "budgetStatus" = 'allowed',
                        "safeErrorCode" = NULL,
                        "httpStatus" = NULL,
                        "providerRequestId" = 'safe-run-request',
                        "providerResponseId" = NULL,
                        "completedAt" = CURRENT_TIMESTAMP
                  WHERE "projectId" = $1 AND "id" = $2`,
            values: [projectAId, secretRunId],
          },
          {
            sql: `UPDATE "AiRunAttempt"
                    SET "status" = 'succeeded',
                        "providerRequestId" = NULL,
                        "providerResponseId" = $3,
                        "completedAt" = CURRENT_TIMESTAMP
                  WHERE "projectId" = $1 AND "id" = $2 AND "aiRunId" = $4`,
            values: [projectAId, secretAttemptId, "secret-provider-value", secretRunId],
          },
        ]),
      "provider response id secret-like value",
    );
    const secretState = await safeQuery<{
      run_status: string;
      run_completed: boolean;
      run_provider_request_null: boolean;
      attempt_status: string;
      attempt_completed: boolean;
      attempt_provider_response_null: boolean;
    }>(
      client,
      `SELECT
         r."status"::text AS run_status,
         r."completedAt" IS NULL AS run_completed,
         r."providerRequestId" IS NULL AS run_provider_request_null,
         a."status"::text AS attempt_status,
         a."completedAt" IS NULL AS attempt_completed,
         a."providerResponseId" IS NULL AS attempt_provider_response_null
         FROM "AiRun" r
         JOIN "AiRunAttempt" a
           ON a."projectId" = r."projectId" AND a."aiRunId" = r."id"
        WHERE r."projectId" = $1 AND r."id" = $2`,
      [projectAId, secretRunId],
    );
    requireCondition(
      secretState.rows[0]?.run_status === "running" &&
        secretState.rows[0].run_completed &&
        secretState.rows[0].run_provider_request_null &&
        secretState.rows[0].attempt_status === "sent" &&
        secretState.rows[0].attempt_completed &&
        secretState.rows[0].attempt_provider_response_null,
      "AI_RUNTIME_POSTGRES_PROVIDER_ID_SECRET_REJECTED_NO_SIDE_EFFECT",
    );

    const secondPrepared = await claimService.prepareOrGetRun({
      ...request,
      sourceIds: [sourceAId],
    });
    requireCondition(
      secondPrepared.kind === "created" && secondPrepared.status === "queued",
      "AI_RUNTIME_POSTGRES_UNKNOWN_PREPARE",
    );
    const secondRunId = secondPrepared.runId;
    const secondOperationKey = secondPrepared.operationKey;
    const throwingProvider = new FakeProviderRecorder({
      mode: "throw",
      code: "AI_PROVIDER_FAILED",
    });
    const throwingDiagnostics = withStageDiagnostics(prisma);
    const throwingService = createAiRuntimeService({
      db: throwingDiagnostics.client,
      admissibilityGate: new FakeAdmissibilityGate(),
      provider: throwingProvider,
    });
    const unknownResult = await throwingService.claimAndDispatchRun({
      ...request,
      sourceIds: [sourceAId],
      runId: secondRunId,
      operationKey: secondOperationKey,
    });
    const unknownResultDiagnostic = JSON.stringify({
      kind: unknownResult.kind,
      status: unknownResult.status,
      safeCode: unknownResult.safeCode,
      providerCount: throwingProvider.count,
      stages: throwingDiagnostics.stages,
    });
    requireCondition(
      unknownResult.kind === "claimed" &&
        unknownResult.status === "unknown" &&
        unknownResult.safeCode === "AI_PROVIDER_UNKNOWN",
      `AI_RUNTIME_POSTGRES_THROW_UNKNOWN_RESULT ${unknownResultDiagnostic}`,
    );
    const existingUnknown = await throwingService.claimAndDispatchRun({
      ...request,
      sourceIds: [sourceAId],
      runId: secondRunId,
      operationKey: secondOperationKey,
    });
    const existingUnknownDiagnostic = JSON.stringify({
      kind: existingUnknown.kind,
      status: existingUnknown.status,
      safeCode: existingUnknown.safeCode,
      providerCount: throwingProvider.count,
    });
    requireCondition(
      existingUnknown.kind === "existing" &&
        existingUnknown.status === "unknown" &&
        existingUnknown.safeCode === "AI_PROVIDER_UNKNOWN" &&
        throwingProvider.count === 1,
      `AI_RUNTIME_POSTGRES_UNKNOWN_NO_REDISPATCH ${existingUnknownDiagnostic}`,
    );
    const unknownCounts = await safeQuery<{
      run_status: string;
      run_safe_code: string | null;
      attempt_status: string;
      attempt_safe_code: string | null;
      run_unknown: string;
      attempt_unknown: string;
    }>(
      client,
      `SELECT
         (SELECT "status"::text FROM "AiRun"
            WHERE "projectId" = $1 AND "id" = $2) AS run_status,
         (SELECT "safeErrorCode"::text FROM "AiRun"
            WHERE "projectId" = $1 AND "id" = $2) AS run_safe_code,
         (SELECT "status"::text FROM "AiRunAttempt"
            WHERE "projectId" = $1 AND "aiRunId" = $2) AS attempt_status,
         (SELECT "safeErrorCode"::text FROM "AiRunAttempt"
            WHERE "projectId" = $1 AND "aiRunId" = $2) AS attempt_safe_code,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2 AND "eventType" = 'runUnknown') AS run_unknown,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2 AND "eventType" = 'attemptUnknown') AS attempt_unknown`,
      [projectAId, secondRunId],
    );
    requireCondition(
      unknownCounts.rows[0]?.run_status === "unknown" &&
        unknownCounts.rows[0].run_safe_code === "AI_PROVIDER_UNKNOWN" &&
        unknownCounts.rows[0].attempt_status === "unknown" &&
        unknownCounts.rows[0].attempt_safe_code === "AI_PROVIDER_UNKNOWN" &&
        unknownCounts.rows[0].run_unknown === "1" &&
        unknownCounts.rows[0].attempt_unknown === "1",
      "AI_RUNTIME_POSTGRES_UNKNOWN_PERSISTENCE",
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function runQueuedPreflightClosureMatrix(
  client: Client,
  url: string,
): Promise<void> {
  const request = {
    projectId: projectAId,
    grantId: grantAId,
    operation: "projectAnalysis" as const,
    sourceIds: [sourceAId],
  };

  for (const liveFailure of ["revoke", "policy"] as const) {
    await setupFreshLiveGrant(client);
    if (liveFailure === "policy") {
      await insertPolicyRevision(client, revisionA2Id, projectAId, 2, true, false);
    }
    const adapter = new PrismaPg({ connectionString: url });
    const prisma = new PrismaClient({ adapter });
    try {
      const preparationService = createAiRuntimeService({
        db: prisma,
        admissibilityGate: new FakeAdmissibilityGate(),
      });
      const prepared = await preparationService.prepareOrGetRun(request);
      requireCondition(
        prepared.kind === "created" && prepared.status === "queued",
        `AI_RUNTIME_POSTGRES_CLOSURE_${liveFailure}_PREPARE`,
      );
      if (liveFailure === "revoke") {
        await safeQuery(
          client,
          `UPDATE "ModelProcessingGrant"
              SET "status" = 'revoked',
                  "revokedAt" = CURRENT_TIMESTAMP,
                  "revocationReasonCode" = 'userRequested'
            WHERE "projectId" = $1 AND "id" = $2`,
          [projectAId, grantAId],
        );
      } else {
        await safeQuery(
          client,
          `UPDATE "ProjectAiPolicy"
              SET "currentRevisionId" = $2,
                  "updatedAt" = CURRENT_TIMESTAMP
            WHERE "projectId" = $1`,
          [projectAId, revisionA2Id],
        );
      }
      const provider = new FakeProviderRecorder();
      const claimService = createAiRuntimeService({
        db: prisma,
        admissibilityGate: new FakeAdmissibilityGate(),
        provider,
      });
      const claim = () =>
        claimService.claimAndDispatchRun({
          ...request,
          runId: prepared.runId,
          operationKey: prepared.operationKey,
        });
      const results = await Promise.all([claim(), claim()]);
      const safeCode =
        liveFailure === "revoke" ? "AI_GRANT_DENIED" : "AI_POLICY_DENIED";
      requireCondition(
        results.filter(
          (result) =>
            result.kind === "rejected" && result.safeCode === safeCode,
        ).length === 1 &&
          results.filter(
            (result) =>
              result.kind === "existing" &&
              result.status === "cancelled" &&
              result.safeCode === safeCode,
          ).length === 1 &&
          provider.count === 0,
        `AI_RUNTIME_POSTGRES_CLOSURE_${liveFailure}_RESULT`,
      );
      const state = await safeQuery<{
        status: string;
        safe_code: string | null;
        budget_status: string;
        request_count: number;
        attempt_count: string;
        audit_count: string;
      }>(
        client,
        `SELECT
           r."status"::text AS status,
           r."safeErrorCode"::text AS safe_code,
           r."budgetStatus"::text AS budget_status,
           r."requestCount" AS request_count,
           (SELECT COUNT(*)::text FROM "AiRunAttempt"
              WHERE "projectId" = $1 AND "aiRunId" = $2) AS attempt_count,
           (SELECT COUNT(*)::text FROM "AiAuditEvent"
              WHERE "projectId" = $1 AND "aiRunId" = $2
                AND "eventType" = 'runCancelled') AS audit_count
         FROM "AiRun" r
        WHERE r."projectId" = $1 AND r."id" = $2`,
        [projectAId, prepared.runId],
      );
      requireCondition(
        state.rows[0]?.status === "cancelled" &&
          state.rows[0].safe_code === safeCode &&
          state.rows[0].budget_status === "pending" &&
          state.rows[0].request_count === 0 &&
          state.rows[0].attempt_count === "0" &&
          state.rows[0].audit_count === "1",
        `AI_RUNTIME_POSTGRES_CLOSURE_${liveFailure}_PERSISTENCE`,
      );
    } finally {
      await prisma.$disconnect();
    }
  }

  await setupFreshLiveGrant(client);
  const scannerAdapter = new PrismaPg({ connectionString: url });
  const scannerPrisma = new PrismaClient({ adapter: scannerAdapter });
  try {
    const preparationService = createAiRuntimeService({
      db: scannerPrisma,
      admissibilityGate: new FakeAdmissibilityGate(),
    });
    const prepared = await preparationService.prepareOrGetRun(request);
    requireCondition(
      prepared.kind === "created" && prepared.status === "queued",
      "AI_RUNTIME_POSTGRES_CLOSURE_SCANNER_PREPARE",
    );
    let gateCalls = 0;
    const blockedGate = new FakeAdmissibilityGate({ scanResult: "blocked" });
    const provider = new FakeProviderRecorder();
    const scannerService = createAiRuntimeService({
      db: scannerPrisma,
      admissibilityGate: {
        assess: (value: unknown) => {
          gateCalls += 1;
          return blockedGate.assess(value);
        },
      },
      provider,
    });
    const first = await scannerService.claimAndDispatchRun({
      ...request,
      runId: prepared.runId,
      operationKey: prepared.operationKey,
    });
    const second = await scannerService.claimAndDispatchRun({
      ...request,
      runId: prepared.runId,
      operationKey: prepared.operationKey,
    });
    requireCondition(
      first.kind === "rejected" &&
        first.safeCode === "AI_SCANNER_DENIED" &&
        second.kind === "existing" &&
        second.status === "failed" &&
        second.safeCode === "AI_SCANNER_DENIED" &&
        gateCalls === 1 &&
        provider.count === 0,
      "AI_RUNTIME_POSTGRES_CLOSURE_SCANNER_RESULT",
    );
    const state = await safeQuery<{
      status: string;
      safe_code: string | null;
      budget_status: string;
      request_count: number;
      attempts: string;
      audits: string;
    }>(
      client,
      `SELECT
         "status"::text AS status,
         "safeErrorCode"::text AS safe_code,
         "budgetStatus"::text AS budget_status,
         "requestCount" AS request_count,
         (SELECT COUNT(*)::text FROM "AiRunAttempt"
            WHERE "projectId" = $1 AND "aiRunId" = $2) AS attempts,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2
              AND "eventType" = 'runFailed') AS audits
       FROM "AiRun"
      WHERE "projectId" = $1 AND "id" = $2`,
      [projectAId, prepared.runId],
    );
    requireCondition(
      state.rows[0]?.status === "failed" &&
        state.rows[0].safe_code === "AI_SCANNER_DENIED" &&
        state.rows[0].budget_status === "pending" &&
        state.rows[0].request_count === 0 &&
        state.rows[0].attempts === "0" &&
        state.rows[0].audits === "1",
      "AI_RUNTIME_POSTGRES_CLOSURE_SCANNER_PERSISTENCE",
    );
  } finally {
    await scannerPrisma.$disconnect();
  }

  await setupOversizedLiveGrant(client);
  const budgetAdapter = new PrismaPg({ connectionString: url });
  const budgetPrisma = new PrismaClient({ adapter: budgetAdapter });
  try {
    const budgetRunId = batch3RunId(30);
    const oversizedContent = "x".repeat(FAKE_PROFILE.maxInputBytes + 1);
    const oversizedFingerprint = hashSourceContent(oversizedContent);
    const oversizedBytes = Buffer.byteLength(oversizedContent, "utf8");
    const manifest = buildInputManifest([{
      sourceId: sourceA2Id,
      contentFingerprint: oversizedFingerprint,
      contentBytes: oversizedBytes,
      scannerVersion: "scanner-v1",
    }]);
    const operationKey = operationKeyForManifest(manifest);
    await insertProfileQueuedRun(
      client,
      budgetRunId,
      operationKey,
      buildInputManifestFingerprint(manifest),
      oversizedBytes,
    );
    await insertExactRunInputSource(
      client,
      batch3InputId(30),
      budgetRunId,
      sourceA2Id,
      oversizedFingerprint,
      oversizedBytes,
      "scanner-v1",
      manifest[0]?.evidenceManifestFingerprint ?? fingerprintA,
    );
    let gateCalls = 0;
    let providerCalls = 0;
    const budgetService = createAiRuntimeService({
      db: budgetPrisma,
      admissibilityGate: {
        assess: () => {
          gateCalls += 1;
          throw new Error("pre-budget gate must not run");
        },
      },
      provider: {
        dispatch: () => {
          providerCalls += 1;
          throw new Error("pre-budget provider must not run");
        },
      },
    });
    const result = await budgetService.claimAndDispatchRun({
      projectId: projectAId,
      grantId: grantAId,
      operation: "projectAnalysis",
      sourceIds: [sourceA2Id],
      runId: budgetRunId,
      operationKey,
    });
    requireCondition(
      result.kind === "rejected" &&
        result.safeCode === "AI_BUDGET_DENIED" &&
        gateCalls === 0 &&
        providerCalls === 0,
      "AI_RUNTIME_POSTGRES_CLOSURE_BUDGET_RESULT",
    );
    const state = await safeQuery<{
      status: string;
      safe_code: string | null;
      budget_status: string;
      request_count: number;
      attempts: string;
      audits: string;
    }>(
      client,
      `SELECT
         "status"::text AS status,
         "safeErrorCode"::text AS safe_code,
         "budgetStatus"::text AS budget_status,
         "requestCount" AS request_count,
         (SELECT COUNT(*)::text FROM "AiRunAttempt"
            WHERE "projectId" = $1 AND "aiRunId" = $2) AS attempts,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2
              AND "eventType" = 'runFailed') AS audits
       FROM "AiRun"
      WHERE "projectId" = $1 AND "id" = $2`,
      [projectAId, budgetRunId],
    );
    requireCondition(
      state.rows[0]?.status === "failed" &&
        state.rows[0].safe_code === "AI_BUDGET_DENIED" &&
        state.rows[0].budget_status === "rejected" &&
        state.rows[0].request_count === 0 &&
        state.rows[0].attempts === "0" &&
        state.rows[0].audits === "1",
      "AI_RUNTIME_POSTGRES_CLOSURE_BUDGET_PERSISTENCE",
    );
  } finally {
    await budgetPrisma.$disconnect();
  }
}

async function setupOversizedLiveGrant(client: Client): Promise<void> {
  await runV0UpgradePath(client);
  const content = "x".repeat(FAKE_PROFILE.maxInputBytes + 1);
  const contentHash = hashSourceContent(content);
  await safeQuery(
    client,
    `INSERT INTO "ProjectSource"
       ("id", "projectId", "kind", "externalRef", "contentText", "contentHash", "capturedAt")
     VALUES ($1, $2, 'manual', NULL, $3, $4, CURRENT_TIMESTAMP)`,
    [sourceA2Id, projectAId, content, contentHash],
  );
  await insertPolicyRevision(client, revisionAId, projectAId, 1, true, true);
  await insertPolicyPointer(client, projectAId, revisionAId);
  await insertDraftGrant(client, grantAId);
  await insertGrantSource(
    client,
    grantSourceAId,
    grantAId,
    sourceA2Id,
    projectAId,
    contentHash,
    Buffer.byteLength(content, "utf8"),
  );
  await insertGrantOperation(client, grantOperationAId, grantAId);
  await issueGrant(client, grantAId);
}

async function runAdversarialClaimIdentityMatrix(
  client: Client,
  url: string,
): Promise<void> {
  await setupFreshLiveGrant(client);
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });
  try {
    const request = {
      projectId: projectAId,
      grantId: grantAId,
      operation: "projectAnalysis" as const,
      sourceIds: [sourceAId],
    };
    const preparationService = createAiRuntimeService({
      db: prisma,
      admissibilityGate: new FakeAdmissibilityGate(),
    });
    const prepared = await preparationService.prepareOrGetRun(request);
    requireCondition(
      prepared.kind === "created" && prepared.status === "queued",
      "AI_RUNTIME_POSTGRES_ADVERSARIAL_IDENTITY_PREPARE",
    );

    await safeQuery(
      client,
      `UPDATE "ModelProcessingGrant"
          SET "status" = 'revoked',
              "revokedAt" = CURRENT_TIMESTAMP,
              "revocationReasonCode" = 'userRequested'
        WHERE "projectId" = $1 AND "id" = $2`,
      [projectAId, grantAId],
    );

    const provider = new FakeProviderRecorder();
    const claimService = createAiRuntimeService({
      db: prisma,
      admissibilityGate: new FakeAdmissibilityGate(),
      provider,
    });
    // The preparation audit is the only run-scoped event before the invalid
    // requests. Keep its full count as the no-write baseline.
    const auditBaseline = await safeQuery<{ audit_count: string }>(
      client,
      `SELECT COUNT(*)::text AS audit_count
         FROM "AiAuditEvent"
        WHERE "projectId" = $1 AND "aiRunId" = $2`,
      [projectAId, prepared.runId],
    );
    const baselineAuditCount = auditBaseline.rows[0]?.audit_count;
    requireCondition(
      baselineAuditCount === "1",
      "AI_RUNTIME_POSTGRES_ADVERSARIAL_IDENTITY_AUDIT_BASELINE",
    );
    // The source variant is an earlier live grant/source fail-closed case;
    // grant and operation variants exercise the live-rejection identity guard.
    // None of the three requests is allowed to enter a successful closure.
    const invalidClaims = [
      {
        label: "source",
        expectedSafeCode: "AI_INVALID_OPERATION_KEY_INPUT" as const,
        request: { ...request, sourceIds: [sourceBId] },
      },
      {
        label: "grant",
        expectedSafeCode: "AI_GRANT_DENIED" as const,
        request: { ...request, grantId: grantIncompleteId },
      },
      {
        label: "operation",
        expectedSafeCode: "AI_POLICY_DENIED" as const,
        request: { ...request, operation: "embedding" as const },
      },
    ] as const;
    for (const invalidClaim of invalidClaims) {
      const result = await claimService.claimAndDispatchRun({
        ...invalidClaim.request,
        runId: prepared.runId,
        operationKey: prepared.operationKey,
      });
      requireCondition(
        result.kind === "rejected" &&
          result.safeCode === invalidClaim.expectedSafeCode,
        `AI_RUNTIME_POSTGRES_ADVERSARIAL_IDENTITY_${invalidClaim.label}_RESULT`,
      );
      const state = await safeQuery<{
        status: string;
        safe_error_code: string | null;
        budget_status: string;
        request_count: number;
        completed: boolean;
        attempts: string;
        audit_count: string;
        terminal_audits: string;
      }>(
        client,
        `SELECT
           "status"::text AS status,
           "safeErrorCode"::text AS safe_error_code,
           "budgetStatus"::text AS budget_status,
           "requestCount" AS request_count,
           "completedAt" IS NOT NULL AS completed,
           (SELECT COUNT(*)::text FROM "AiRunAttempt"
              WHERE "projectId" = $1 AND "aiRunId" = $2) AS attempts,
           (SELECT COUNT(*)::text FROM "AiAuditEvent"
              WHERE "projectId" = $1 AND "aiRunId" = $2) AS audit_count,
           (SELECT COUNT(*)::text FROM "AiAuditEvent"
              WHERE "projectId" = $1 AND "aiRunId" = $2
                AND "eventType" IN ('runCancelled', 'runFailed', 'runSucceeded', 'runUnknown'))
             AS terminal_audits
         FROM "AiRun"
        WHERE "projectId" = $1 AND "id" = $2`,
        [projectAId, prepared.runId],
      );
      requireCondition(
        state.rows[0]?.status === "queued" &&
          state.rows[0].safe_error_code === null &&
          state.rows[0].budget_status === "pending" &&
          state.rows[0].request_count === 0 &&
          !state.rows[0].completed &&
          state.rows[0].attempts === "0" &&
          state.rows[0].audit_count === baselineAuditCount &&
          state.rows[0].terminal_audits === "0" &&
          provider.count === 0,
        `AI_RUNTIME_POSTGRES_ADVERSARIAL_IDENTITY_${invalidClaim.label}_NO_SIDE_EFFECT`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function runClaimFirstAfterLiveMutation(
  client: Client,
  url: string,
): Promise<void> {
  const request = {
    projectId: projectAId,
    grantId: grantAId,
    operation: "projectAnalysis" as const,
    sourceIds: [sourceAId],
  };
  for (const mutation of ["revoke", "policy"] as const) {
    await setupFreshLiveGrant(client);
    if (mutation === "policy") {
      await insertPolicyRevision(client, revisionA2Id, projectAId, 2, true, false);
    }
    const adapter = new PrismaPg({ connectionString: url });
    const prisma = new PrismaClient({ adapter });
    try {
      const preparationService = createAiRuntimeService({
        db: prisma,
        admissibilityGate: new FakeAdmissibilityGate(),
      });
      const prepared = await preparationService.prepareOrGetRun(request);
      requireCondition(
        prepared.kind === "created" && prepared.status === "queued",
        `AI_RUNTIME_POSTGRES_CLAIM_FIRST_${mutation}_PREPARE`,
      );
      let transactionNumber = 0;
      const wrappedPrisma = new Proxy(prisma, {
        get(target, property, receiver) {
          if (property !== "$transaction") {
            return Reflect.get(target, property, receiver);
          }
          const delegate = Reflect.get(target, property, receiver);
          if (typeof delegate !== "function") {
            return delegate;
          }
          return async (...args: unknown[]) => {
            transactionNumber += 1;
            if (transactionNumber === 2) {
              if (mutation === "revoke") {
                await safeQuery(
                  client,
                  `UPDATE "ModelProcessingGrant"
                      SET "status" = 'revoked',
                          "revokedAt" = CURRENT_TIMESTAMP,
                          "revocationReasonCode" = 'userRequested'
                    WHERE "projectId" = $1 AND "id" = $2`,
                  [projectAId, grantAId],
                );
              } else {
                await safeQuery(
                  client,
                  `UPDATE "ProjectAiPolicy"
                      SET "currentRevisionId" = $2,
                          "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "projectId" = $1`,
                  [projectAId, revisionA2Id],
                );
              }
            }
            return Reflect.apply(delegate, target, args);
          };
        },
      }) as unknown as PrismaClient;
      const provider = new FakeProviderRecorder({
        kind: "completed",
        providerRequestId: "claim-first-request",
        providerResponseId: "claim-first-response",
        usage: { inputTokens: 3, outputTokens: 4, requestCount: 1 },
      });
      const service = createAiRuntimeService({
        db: wrappedPrisma,
        admissibilityGate: new FakeAdmissibilityGate(),
        provider,
      });
      const result = await service.claimAndDispatchRun({
        ...request,
        runId: prepared.runId,
        operationKey: prepared.operationKey,
      });
      requireCondition(
        result.kind === "claimed" &&
          result.status === "succeeded" &&
          result.safeCode === null &&
          provider.count === 1,
        `AI_RUNTIME_POSTGRES_CLAIM_FIRST_${mutation}_RESULT`,
      );
      const evidence = await safeQuery<{
        run_status: string;
        attempt_status: string;
        run_successes: string;
        attempt_successes: string;
        frozen_successes: string;
      }>(
        client,
        `SELECT
           (SELECT "status"::text FROM "AiRun"
              WHERE "projectId" = $1 AND "id" = $2) AS run_status,
           (SELECT "status"::text FROM "AiRunAttempt"
              WHERE "projectId" = $1 AND "aiRunId" = $2) AS attempt_status,
           (SELECT COUNT(*)::text FROM "AiAuditEvent"
              WHERE "projectId" = $1 AND "aiRunId" = $2
                AND "eventType" = 'runSucceeded') AS run_successes,
           (SELECT COUNT(*)::text FROM "AiAuditEvent"
              WHERE "projectId" = $1 AND "aiRunId" = $2
                AND "eventType" = 'attemptSucceeded') AS attempt_successes,
           (SELECT COUNT(*)::text FROM "AiAuditEvent"
              WHERE "projectId" = $1 AND "aiRunId" = $2
                AND "policyRevisionId" = $3 AND "grantId" = $4
                AND "eventType" = 'runSucceeded') AS frozen_successes`,
        [projectAId, prepared.runId, revisionAId, grantAId],
      );
      requireCondition(
        evidence.rows[0]?.run_status === "succeeded" &&
          evidence.rows[0].attempt_status === "succeeded" &&
          evidence.rows[0].run_successes === "1" &&
          evidence.rows[0].attempt_successes === "1" &&
          evidence.rows[0].frozen_successes === "1",
        `AI_RUNTIME_POSTGRES_CLAIM_FIRST_${mutation}_FROZEN_EVIDENCE`,
      );
    } finally {
      await prisma.$disconnect();
    }
  }
}

async function assertRevokedQueuedClosure(
  client: Client,
  runId: string,
  provider: FakeProviderRecorder,
  label: string,
): Promise<void> {
  const state = await safeQuery<{
    status: string;
    safe_code: string | null;
    budget_status: string;
    request_count: number;
    completed: boolean;
    attempts: string;
    run_cancelled: string;
    terminal_audits: string;
  }>(
    client,
    `SELECT
       "status"::text AS status,
       "safeErrorCode"::text AS safe_code,
       "budgetStatus"::text AS budget_status,
       "requestCount" AS request_count,
       "completedAt" IS NOT NULL AS completed,
       (SELECT COUNT(*)::text FROM "AiRunAttempt"
          WHERE "projectId" = $1 AND "aiRunId" = $2) AS attempts,
       (SELECT COUNT(*)::text FROM "AiAuditEvent"
          WHERE "projectId" = $1 AND "aiRunId" = $2
            AND "eventType" = 'runCancelled') AS run_cancelled,
       (SELECT COUNT(*)::text FROM "AiAuditEvent"
          WHERE "projectId" = $1 AND "aiRunId" = $2
            AND "eventType" IN ('runCancelled', 'runFailed', 'runSucceeded', 'runUnknown'))
         AS terminal_audits
     FROM "AiRun"
    WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, runId],
  );
  requireCondition(
    state.rows[0]?.status === "cancelled" &&
      state.rows[0].safe_code === "AI_GRANT_DENIED" &&
      state.rows[0].budget_status === "pending" &&
      state.rows[0].request_count === 0 &&
      state.rows[0].completed &&
      state.rows[0].attempts === "0" &&
      state.rows[0].run_cancelled === "1" &&
      state.rows[0].terminal_audits === "1" &&
      provider.count === 0,
    `AI_RUNTIME_POSTGRES_${label}_CLOSURE_STATE`,
  );
}

type CommitBarrier = {
  committed: Promise<void>;
  signalCommitted: () => void;
  rejectCommitted: (error: unknown) => void;
  released: Promise<void>;
  release: () => void;
};

function createCommitBarrier(): CommitBarrier {
  let signalCommitted!: () => void;
  let rejectCommitted!: (error: unknown) => void;
  const committed = new Promise<void>((resolve, reject) => {
    signalCommitted = resolve;
    rejectCommitted = reject;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    committed,
    signalCommitted,
    rejectCommitted,
    released,
    release,
  };
}

/**
 * Test-only barrier around the first Prisma transaction. The wrapped call is
 * delegated unchanged; the barrier opens only after Prisma has committed it.
 */
function withFirstTransactionCommitBarrier(
  client: PrismaClient,
  barrier: CommitBarrier,
): PrismaClient {
  let transactionNumber = 0;
  const wrapped = new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "$transaction") {
        return Reflect.get(target, property, receiver);
      }
      const transaction = Reflect.get(target, property, receiver);
      if (typeof transaction !== "function") {
        return transaction;
      }
      return (...args: unknown[]) => {
        const callback = args[0];
        transactionNumber += 1;
        if (typeof callback !== "function" || transactionNumber !== 1) {
          return Reflect.apply(transaction, target, args);
        }
        const committed = Promise.resolve(Reflect.apply(transaction, target, args));
        return committed.then(
          (value) => {
            barrier.signalCommitted();
            return barrier.released.then(() => value);
          },
          (error: unknown) => {
            barrier.rejectCommitted(error);
            throw error;
          },
        );
      };
    },
  });
  return wrapped as unknown as PrismaClient;
}

async function runTwoConnectionRevokeFirstEvidence(
  client: Client,
  url: string,
): Promise<void> {
  await setupFreshLiveGrant(client);
  const adapter = new PrismaPg({ connectionString: url });
  const servicePrisma = new PrismaClient({ adapter });
  let mutationClient: Client | null = null;
  let mutationOpen = false;
  let claimPromise: Promise<ClaimAndDispatchRunResult> | undefined;
  let provider: FakeProviderRecorder | undefined;
  try {
    const request = {
      projectId: projectAId,
      grantId: grantAId,
      operation: "projectAnalysis" as const,
      sourceIds: [sourceAId],
    };
    const preparationService = createAiRuntimeService({
      db: servicePrisma,
      admissibilityGate: new FakeAdmissibilityGate(),
    });
    const prepared = await preparationService.prepareOrGetRun(request);
    requireCondition(
      prepared.kind === "created" && prepared.status === "queued",
      "AI_RUNTIME_POSTGRES_TWO_CONNECTION_REVOKE_FIRST_PREPARE",
    );

    mutationClient = await connectDedicated(url);
    await safeQuery(mutationClient, "BEGIN");
    mutationOpen = true;
    await safeQuery(
      mutationClient,
      `SELECT "id" FROM "Project"
        WHERE "id" = $1
        FOR UPDATE`,
      [projectAId],
    );
    await safeQuery(
      mutationClient,
      `UPDATE "ModelProcessingGrant"
          SET "status" = 'revoked',
              "revokedAt" = CURRENT_TIMESTAMP,
              "revocationReasonCode" = 'userRequested'
        WHERE "projectId" = $1 AND "id" = $2`,
      [projectAId, grantAId],
    );

    const pidSignal = createBackendPidSignal();
    const serviceClient = withBackendPidSignal(servicePrisma, pidSignal);
    provider = new FakeProviderRecorder();
    const claimService = createAiRuntimeService({
      db: serviceClient,
      admissibilityGate: new FakeAdmissibilityGate(),
      provider,
    });
    claimPromise = claimService.claimAndDispatchRun({
      ...request,
      runId: prepared.runId,
      operationKey: prepared.operationKey,
    });
    const servicePid = await pidSignal.promise;
    await waitForBlockingEvidence(mutationClient, servicePid);
    await safeQuery(mutationClient, "COMMIT");
    mutationOpen = false;

    const result = await claimPromise;
    requireCondition(
      result.kind === "rejected" &&
        result.safeCode === "AI_GRANT_DENIED" &&
        provider.count === 0,
      "AI_RUNTIME_POSTGRES_TWO_CONNECTION_REVOKE_FIRST_RESULT",
    );
    await assertRevokedQueuedClosure(
      client,
      prepared.runId,
      provider,
      "TWO_CONNECTION_REVOKE_FIRST",
    );
  } finally {
    if (mutationOpen && mutationClient !== null) {
      try {
        await mutationClient.query("ROLLBACK");
      } catch {
        // Keep cleanup safe and do not expose database details.
      }
    }
    if (claimPromise !== undefined) {
      try {
        await claimPromise;
      } catch {
        // The assertion path reports a stable test error instead.
      }
    }
    await servicePrisma.$disconnect();
    if (mutationClient !== null) {
      await closeClient(mutationClient);
    }
  }
}

async function runTwoConnectionClaimFirstEvidence(
  client: Client,
  url: string,
): Promise<void> {
  await setupFreshLiveGrant(client);
  const adapter = new PrismaPg({ connectionString: url });
  const servicePrisma = new PrismaClient({ adapter });
  let mutationClient: Client | null = null;
  let claimPromise: Promise<ClaimAndDispatchRunResult> | undefined;
  let provider: FakeProviderRecorder | undefined;
  const barrier = createCommitBarrier();
  let barrierReleased = false;
  try {
    const request = {
      projectId: projectAId,
      grantId: grantAId,
      operation: "projectAnalysis" as const,
      sourceIds: [sourceAId],
    };
    const preparationService = createAiRuntimeService({
      db: servicePrisma,
      admissibilityGate: new FakeAdmissibilityGate(),
    });
    const prepared = await preparationService.prepareOrGetRun(request);
    requireCondition(
      prepared.kind === "created" && prepared.status === "queued",
      "AI_RUNTIME_POSTGRES_TWO_CONNECTION_CLAIM_FIRST_PREPARE",
    );

    mutationClient = await connectDedicated(url);
    provider = new FakeProviderRecorder({
      kind: "completed",
      providerRequestId: "two-connection-request",
      providerResponseId: "two-connection-response",
      usage: { inputTokens: 3, outputTokens: 4, requestCount: 1 },
    });
    const serviceClient = withFirstTransactionCommitBarrier(
      servicePrisma,
      barrier,
    );
    const claimService = createAiRuntimeService({
      db: serviceClient,
      admissibilityGate: new FakeAdmissibilityGate(),
      provider,
    });
    claimPromise = claimService.claimAndDispatchRun({
      ...request,
      runId: prepared.runId,
      operationKey: prepared.operationKey,
    });
    await barrier.committed;

    await safeQuery(mutationClient, "BEGIN");
    await safeQuery(
      mutationClient,
      `SELECT "id" FROM "Project"
        WHERE "id" = $1
        FOR UPDATE`,
      [projectAId],
    );
    await safeQuery(
      mutationClient,
      `UPDATE "ModelProcessingGrant"
          SET "status" = 'revoked',
              "revokedAt" = CURRENT_TIMESTAMP,
              "revocationReasonCode" = 'userRequested'
        WHERE "projectId" = $1 AND "id" = $2`,
      [projectAId, grantAId],
    );
    await safeQuery(mutationClient, "COMMIT");
    barrier.release();
    barrierReleased = true;

    const result = await claimPromise;
    requireCondition(
      result.kind === "claimed" &&
        result.status === "succeeded" &&
        result.safeCode === null &&
        provider.count === 1,
      "AI_RUNTIME_POSTGRES_TWO_CONNECTION_CLAIM_FIRST_RESULT",
    );
    const evidence = await safeQuery<{
      run_status: string;
      attempt_status: string;
      run_succeeded: string;
      attempt_succeeded: string;
      frozen_successes: string;
    }>(
      client,
      `SELECT
         (SELECT "status"::text FROM "AiRun"
            WHERE "projectId" = $1 AND "id" = $2) AS run_status,
         (SELECT "status"::text FROM "AiRunAttempt"
            WHERE "projectId" = $1 AND "aiRunId" = $2) AS attempt_status,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2
              AND "eventType" = 'runSucceeded') AS run_succeeded,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2
              AND "eventType" = 'attemptSucceeded') AS attempt_succeeded,
         (SELECT COUNT(*)::text FROM "AiAuditEvent"
            WHERE "projectId" = $1 AND "aiRunId" = $2
              AND "policyRevisionId" = $3 AND "grantId" = $4
              AND "eventType" IN ('runSucceeded', 'attemptSucceeded')) AS frozen_successes`,
      [projectAId, prepared.runId, revisionAId, grantAId],
    );
    requireCondition(
      evidence.rows[0]?.run_status === "succeeded" &&
        evidence.rows[0].attempt_status === "succeeded" &&
        evidence.rows[0].run_succeeded === "1" &&
        evidence.rows[0].attempt_succeeded === "1" &&
        evidence.rows[0].frozen_successes === "2",
      "AI_RUNTIME_POSTGRES_TWO_CONNECTION_CLAIM_FIRST_FROZEN_EVIDENCE",
    );
  } finally {
    if (!barrierReleased) {
      barrier.release();
    }
    if (claimPromise !== undefined) {
      try {
        await claimPromise;
      } catch {
        // The assertion path reports a stable test error instead.
      }
    }
    await servicePrisma.$disconnect();
    if (mutationClient !== null) {
      await closeClient(mutationClient);
    }
  }
}

async function runTwoConnectionOrderingEvidence(
  client: Client,
  url: string,
): Promise<void> {
  await runTwoConnectionRevokeFirstEvidence(client, url);
  await runTwoConnectionClaimFirstEvidence(client, url);
}

async function runRunAttemptInputMatrix(client: Client): Promise<void> {
  // P2 hard-gate boundary: operationKey/manifest membership and Attempt-to-Run
  // usage aggregation remain Phase 2B CAS-service invariants. This gate only
  // verifies the database lifecycle, provenance, and deferred state contract.
  const inputRunId = batch2RunId(1);
  const inputId = batch2InputId(1);
  await insertQueuedRun(client, inputRunId, batch2OperationKey(1));
  await insertRunInputSource(client, inputId, inputRunId);
  await expectActionRejected(
    () =>
      transaction(client, [
        {
          sql: `UPDATE "AiRunInputSource"
                  SET "contentBytes" = 13
                WHERE "projectId" = $1 AND "id" = $2`,
          values: [projectAId, inputId],
        },
      ]),
    "queued input update",
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        {
          sql: `DELETE FROM "AiRunInputSource"
                 WHERE "projectId" = $1 AND "id" = $2`,
          values: [projectAId, inputId],
        },
      ]),
    "queued input delete",
  );
  await claimRun(client, inputRunId, batch2AttemptId(1));
  await expectActionRejected(
    () =>
      transaction(client, [
        insertRunInputSourceStatement(batch2InputId(2), inputRunId),
      ]),
    "running input append",
  );

  const invalidInputCases = [
    {
      runSequence: 3,
      inputSequence: 3,
      contentFingerprint: fingerprintB,
      contentBytes: 12,
      scannerVersion: "scanner-v1",
      label: "input fingerprint",
    },
    {
      runSequence: 4,
      inputSequence: 4,
      contentFingerprint: fingerprintA,
      contentBytes: 14,
      scannerVersion: "scanner-v1",
      label: "input byte count",
    },
    {
      runSequence: 5,
      inputSequence: 5,
      contentFingerprint: fingerprintA,
      contentBytes: 12,
      scannerVersion: "scanner-v2",
      label: "input scanner version",
    },
  ] as const;
  for (const inputCase of invalidInputCases) {
    const runId = batch2RunId(inputCase.runSequence);
    await insertQueuedRun(client, runId, batch2OperationKey(inputCase.runSequence));
    await expectActionRejected(
      () =>
        transaction(client, [
          insertRunInputSourceStatement(
            batch2InputId(inputCase.inputSequence),
            runId,
            projectAId,
            grantAId,
            sourceAId,
            inputCase.contentFingerprint,
            inputCase.contentBytes,
            inputCase.scannerVersion,
          ),
        ]),
      inputCase.label,
    );
  }

  const runOnlyId = batch2RunId(6);
  await insertQueuedRun(client, runOnlyId, batch2OperationKey(6));
  await expectActionRejected(
    () => transaction(client, [claimRunStatement(runOnlyId)]),
    "run-only claim",
  );

  const attemptOnlyRunId = batch2RunId(7);
  await insertQueuedRun(client, attemptOnlyRunId, batch2OperationKey(7));
  await expectActionRejected(
    () =>
      transaction(client, [
        insertSentAttemptStatement(batch2AttemptId(7), attemptOnlyRunId),
      ]),
    "attempt-only claim",
  );

  const invalidRequestCountRunId = batch2RunId(8);
  await insertQueuedRun(client, invalidRequestCountRunId, batch2OperationKey(8));
  await expectActionRejected(
    () => transaction(client, [claimRunStatement(invalidRequestCountRunId, 2)]),
    "run request count greater than one",
  );

  const invalidAttemptRequestCountRunId = batch2RunId(9);
  const invalidAttemptRequestCountAttemptId = batch2AttemptId(9);
  await insertQueuedRun(
    client,
    invalidAttemptRequestCountRunId,
    batch2OperationKey(9),
  );
  await claimRun(
    client,
    invalidAttemptRequestCountRunId,
    invalidAttemptRequestCountAttemptId,
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        {
          sql: `UPDATE "AiRunAttempt"
                  SET "requestCount" = 2
                WHERE "projectId" = $1 AND "id" = $2`,
          values: [projectAId, invalidAttemptRequestCountAttemptId],
        },
      ]),
    "attempt request count",
  );

  const mismatchRunId = batch2RunId(10);
  const mismatchAttemptId = batch2AttemptId(10);
  await insertQueuedRun(client, mismatchRunId, batch2OperationKey(10));
  await claimRun(client, mismatchRunId, mismatchAttemptId);
  await expectActionRejected(
    () =>
      transaction(client, [
        completeAttemptStatement(mismatchAttemptId, "succeeded"),
        completeRunStatement(mismatchRunId, "failed"),
      ]),
    "terminal run and attempt status mismatch",
  );

  const orderARunId = batch2RunId(11);
  const orderAAttemptId = batch2AttemptId(11);
  await insertQueuedRun(client, orderARunId, batch2OperationKey(11));
  await claimRun(client, orderARunId, orderAAttemptId);
  await transaction(client, [
    completeAttemptStatement(orderAAttemptId, "succeeded"),
    completeRunStatement(orderARunId, "succeeded"),
  ]);

  const orderBRunId = batch2RunId(12);
  const orderBAttemptId = batch2AttemptId(12);
  await insertQueuedRun(client, orderBRunId, batch2OperationKey(12));
  await claimRun(client, orderBRunId, orderBAttemptId);
  await transaction(client, [
    completeRunStatement(orderBRunId, "succeeded"),
    completeAttemptStatement(orderBAttemptId, "succeeded"),
  ]);

  const preflightFailedRunId = batch2RunId(13);
  await insertQueuedRun(client, preflightFailedRunId, batch2OperationKey(13));
  await safeQuery(
    client,
    `UPDATE "AiRun"
        SET "status" = 'failed', "completedAt" = CURRENT_TIMESTAMP
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, preflightFailedRunId],
  );

  const preflightCancelledRunId = batch2RunId(14);
  await insertQueuedRun(client, preflightCancelledRunId, batch2OperationKey(14));
  await safeQuery(
    client,
    `UPDATE "AiRun"
        SET "status" = 'cancelled', "completedAt" = CURRENT_TIMESTAMP
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, preflightCancelledRunId],
  );

  const invalidPreflightSucceededRunId = batch2RunId(15);
  await insertQueuedRun(
    client,
    invalidPreflightSucceededRunId,
    batch2OperationKey(15),
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        {
          sql: `UPDATE "AiRun"
                  SET "status" = 'succeeded', "completedAt" = CURRENT_TIMESTAMP
                WHERE "projectId" = $1 AND "id" = $2`,
          values: [projectAId, invalidPreflightSucceededRunId],
        },
      ]),
    "queued run direct success",
  );

  const unknownRunId = batch2RunId(16);
  const unknownAttemptId = batch2AttemptId(16);
  await insertQueuedRun(client, unknownRunId, batch2OperationKey(16));
  await claimRun(client, unknownRunId, unknownAttemptId);
  await transaction(client, [
    completeAttemptStatement(unknownAttemptId, "unknown"),
    completeRunStatement(unknownRunId, "unknown"),
  ]);
  await expectActionRejected(
    () =>
      transaction(client, [
        {
          sql: `UPDATE "AiRun"
                  SET "status" = 'queued'
                WHERE "projectId" = $1 AND "id" = $2`,
          values: [projectAId, unknownRunId],
        },
      ]),
    "unknown run reset to queued",
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        {
          sql: `UPDATE "AiRun"
                  SET "status" = 'running'
                WHERE "projectId" = $1 AND "id" = $2`,
          values: [projectAId, unknownRunId],
        },
      ]),
    "unknown run redispatch",
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        insertSentAttemptStatement(batch2AttemptId(17), unknownRunId, 2),
      ]),
    "unknown attempt redispatch",
  );

  const revokedRunId = batch2RunId(17);
  await insertQueuedRun(client, revokedRunId, batch2OperationKey(17));
  await safeQuery(
    client,
    `UPDATE "ModelProcessingGrant"
        SET "status" = 'revoked',
            "revokedAt" = CURRENT_TIMESTAMP,
            "revocationReasonCode" = 'userRequested'
      WHERE "projectId" = $1 AND "id" = $2`,
    [projectAId, grantAId],
  );
  await expectActionRejected(
    () => transaction(client, [claimRunStatement(revokedRunId)]),
    "revoked grant claim",
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        insertRunInputSourceStatement(batch2InputId(17), revokedRunId),
      ]),
    "revoked grant input",
  );
}

async function runAtomicRuntimeCandidateCompletion(
  client: Client,
  prisma: PrismaClient,
): Promise<void> {
  const revisionId = "18181818-1818-4818-8818-181818181818";
  const operationProfileId = "19191919-1919-4919-8919-191919191919";
  const policyFingerprint = "c".repeat(64);
  const budgetFingerprint = "d".repeat(64);
  await safeQuery(
    client,
    `INSERT INTO "ProjectAiPolicyRevision"
       ("id", "projectId", "revision", "policyFingerprint", "outboundEnabled",
        "embeddingEnabled", "autoExtractEnabled", "sourceSummaryEnabled",
        "projectAnalysisEnabled", "generateWithContextEnabled",
        "profileFingerprint", "processorFingerprint", "regionFingerprint",
        "retentionFingerprint", "endpointFingerprint", "budgetFingerprint",
        "scannerFingerprint")
     VALUES ($1, $2, 3, $3, true, false, true, false, false, false,
             $4, $5, $6, $7, $8, $9, $10)`,
    [
      revisionId,
      projectAId,
      policyFingerprint,
      OPENAI_AUTO_EXTRACT_PROFILE_FINGERPRINT,
      OPENAI_AUTO_EXTRACT_PROCESSOR_FINGERPRINT,
      OPENAI_PROCESSOR_REGION_FINGERPRINT,
      OPENAI_RESPONSES_RETENTION_FINGERPRINT,
      OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
      budgetFingerprint,
      LOCAL_SOURCE_SCANNER_FINGERPRINT,
    ],
  );
  await safeQuery(
    client,
    `INSERT INTO "ProjectAiPolicyOperationProfile"
       ("id", "projectId", "policyRevisionId", "operation",
        "profileFingerprint", "providerFingerprint", "modelFingerprint", "modelId",
        "processorFingerprint", "regionFingerprint", "retentionFingerprint",
        "endpointFingerprint")
     VALUES ($1, $2, $3, 'autoExtract', $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      operationProfileId,
      projectAId,
      revisionId,
      OPENAI_AUTO_EXTRACT_PROFILE_FINGERPRINT,
      OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
      OPENAI_AUTO_EXTRACT_MODEL_FINGERPRINT,
      OPENAI_AUTO_EXTRACT_MODEL_ID,
      OPENAI_AUTO_EXTRACT_PROCESSOR_FINGERPRINT,
      OPENAI_PROCESSOR_REGION_FINGERPRINT,
      OPENAI_RESPONSES_RETENTION_FINGERPRINT,
      OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
    ],
  );
  await safeQuery(
    client,
    `UPDATE "ProjectAiPolicy"
        SET "currentRevisionId" = $2, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "projectId" = $1`,
    [projectAId, revisionId],
  );

  const insertExactGrant = async (
    grantId: string,
    grantSourceId: string,
    grantOperationId: string,
    grantFingerprint: string,
  ): Promise<void> => {
    await safeQuery(
      client,
      `INSERT INTO "ModelProcessingGrant"
         ("id", "projectId", "sourceKind", "status", "policyRevisionId",
          "profileFingerprint", "providerFingerprint", "modelFingerprint", "modelId",
          "processorFingerprint", "regionFingerprint", "retentionFingerprint",
          "endpointFingerprint", "grantFingerprint", "effectivePolicyVersion",
          "budgetFingerprint", "scannerFingerprint", "scannerVersion", "budgetProfile",
          "issuedBy", "purposeCode", "updatedAt")
       VALUES ($1, $2, 'manual_text', 'draft', $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, 3, $13, $14, $15, 'standard',
               'runtime-gate-test', 'atomic-candidate-completion', CURRENT_TIMESTAMP)`,
      [
        grantId,
        projectAId,
        revisionId,
        OPENAI_AUTO_EXTRACT_PROFILE_FINGERPRINT,
        OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
        OPENAI_AUTO_EXTRACT_MODEL_FINGERPRINT,
        OPENAI_AUTO_EXTRACT_MODEL_ID,
        OPENAI_AUTO_EXTRACT_PROCESSOR_FINGERPRINT,
        OPENAI_PROCESSOR_REGION_FINGERPRINT,
        OPENAI_RESPONSES_RETENTION_FINGERPRINT,
        OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
        grantFingerprint,
        budgetFingerprint,
        LOCAL_SOURCE_SCANNER_FINGERPRINT,
        LOCAL_SOURCE_SCANNER_VERSION,
      ],
    );
    await insertGrantSource(client, grantSourceId, grantId);
    await insertGrantOperation(
      client,
      grantOperationId,
      grantId,
      "autoExtract",
    );
    await issueGrant(client, grantId);
  };

  const candidateService = createAiCandidateService({ db: prisma });
  const admissibilityGate = {
    assess: (value: unknown) => {
      const input = value as {
        projectId: string;
        runId: string;
        operationKey: string;
        inputManifest: ReturnType<typeof buildInputManifest>;
        inputManifestFingerprint: string;
      };
      return {
        admissible: true as const,
        projectId: input.projectId,
        runId: input.runId,
        operationKey: input.operationKey,
        inputManifestFingerprint: input.inputManifestFingerprint,
        inputBytes: sumInputBytes(input.inputManifest),
        sourceCount: input.inputManifest.length,
        scannerVersion: LOCAL_SOURCE_SCANNER_VERSION,
        safeScanResult: "passed" as const,
        safeCode: null,
      };
    },
  };

  const successGrantId = "20202020-2020-4020-8020-202020202020";
  await insertExactGrant(
    successGrantId,
    "21212120-2121-4121-8121-212121212120",
    "22222220-2222-4222-8222-222222222220",
    "e".repeat(64),
  );
  const providerResponseId = "resp_atomic_candidate_completion_1";
  const candidates = [{
    itemType: "progress" as const,
    statement: "Atomic candidate publication succeeded.",
    statementFingerprint: buildOpenAiCandidateStatementFingerprint(
      "Atomic candidate publication succeeded.",
    ),
    sourceId: sourceAId,
    sourceExcerpt: sourceAContent,
    sourceExcerptFingerprint: buildOpenAiCandidateExcerptFingerprint(sourceAContent),
    sourceStart: 0,
    sourceEnd: Buffer.byteLength(sourceAContent, "utf8"),
  }];
  const verifiedResponse = Object.freeze({
    contractVersion: OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION,
    providerResponseId,
    modelId: OPENAI_AUTO_EXTRACT_MODEL_ID,
    usage: Object.freeze({ inputTokens: 10, outputTokens: 5, requestCount: 1 }),
    candidates: Object.freeze(candidates),
    candidateSetFingerprint: buildOpenAiCandidateSetFingerprint(candidates),
  });
  const outputBytes = Buffer.byteLength(JSON.stringify(verifiedResponse), "utf8");
  const successService = createAiRuntimeService({
    db: prisma,
    admissibilityGate,
    provider: {
      dispatch: async () => ({
        classification: {
          runStatus: "succeeded" as const,
          attemptStatus: "succeeded" as const,
          safeCode: null,
          httpStatus: 200,
          automaticRetry: false as const,
          providerRequestId: "req_atomic_candidate_completion_1",
          providerResponseId,
          usage: { inputTokens: 10, outputTokens: 5, requestCount: 1 as const },
        },
        completionPayload: verifiedResponse,
        outputBytes,
      }),
    },
    completionHandler: {
      complete: async (tx, value) => {
        requireCondition(
          value.operation === "autoExtract",
          "AI_RUNTIME_POSTGRES_COMPLETION_OPERATION_MISMATCH",
        );
        await candidateService.persistVerifiedCandidatesInTransaction(tx, {
          projectId: value.projectId,
          aiRunId: value.runId,
          verifiedResponse: value.completionPayload,
        });
      },
    },
  });
  const success = await successService.execute({
    projectId: projectAId,
    grantId: successGrantId,
    operation: "autoExtract",
    sourceIds: [sourceAId],
  });
  if (!(success.kind === "claimed" && success.status === "succeeded")) {
    throw new Error(
      `AI_RUNTIME_POSTGRES_ATOMIC_COMPLETION_FAILED:${JSON.stringify(success)}`,
    );
  }
  if (success.kind !== "claimed" || success.runId === undefined) {
    throw new Error("AI_RUNTIME_POSTGRES_ATOMIC_COMPLETION_RUN_MISSING");
  }
  const committed = await safeQuery<{
    run_status: string;
    output_bytes: number;
    attempt_status: string;
    batches: string;
    claims: string;
    items: string;
    terminal_audits: string;
  }>(
    client,
    `SELECT r."status"::text AS run_status,
            r."outputBytes" AS output_bytes,
            (SELECT a."status"::text FROM "AiRunAttempt" a
              WHERE a."projectId" = r."projectId" AND a."aiRunId" = r."id") AS attempt_status,
            (SELECT count(*)::text FROM "AiCandidateBatch" b
              WHERE b."projectId" = r."projectId" AND b."aiRunId" = r."id") AS batches,
            (SELECT count(*)::text FROM "AiCandidateClaim" c
              WHERE c."projectId" = r."projectId" AND c."aiRunId" = r."id") AS claims,
            (SELECT count(*)::text FROM "ProjectItem" i
              WHERE i."projectId" = r."projectId"
                AND i."metadata"->>'aiRunId' = r."id"::text) AS items,
            (SELECT count(*)::text FROM "AiAuditEvent" e
              WHERE e."projectId" = r."projectId" AND e."aiRunId" = r."id"
                AND e."eventType" IN ('runSucceeded', 'attemptSucceeded')) AS terminal_audits
       FROM "AiRun" r
      WHERE r."projectId" = $1 AND r."id" = $2`,
    [projectAId, success.runId],
  );
  const committedRow = committed.rows[0];
  requireCondition(
    committedRow?.run_status === "succeeded" &&
      committedRow.output_bytes === outputBytes &&
      committedRow.attempt_status === "succeeded" &&
      committedRow.batches === "1" &&
      committedRow.claims === "1" &&
      committedRow.items === "1" &&
      committedRow.terminal_audits === "2",
    "AI_RUNTIME_POSTGRES_ATOMIC_COMPLETION_STATE_MISMATCH",
  );

  const rollbackGrantId = "23232320-2323-4323-8323-232323232320";
  await insertExactGrant(
    rollbackGrantId,
    "24242420-2424-4424-8424-242424242420",
    "25252520-2525-4525-8525-252525252520",
    "f".repeat(64),
  );
  const rollbackService = createAiRuntimeService({
    db: prisma,
    admissibilityGate,
    provider: {
      dispatch: async () => ({
        classification: {
          runStatus: "succeeded" as const,
          attemptStatus: "succeeded" as const,
          safeCode: null,
          httpStatus: 200,
          automaticRetry: false as const,
          providerRequestId: "req_atomic_candidate_rollback_1",
          providerResponseId: "resp_atomic_candidate_rollback_1",
          usage: { inputTokens: 10, outputTokens: 5, requestCount: 1 as const },
        },
        completionPayload: verifiedResponse,
        outputBytes,
      }),
    },
    completionHandler: {
      complete: async () => {
        throw new Error("EXPECTED_ATOMIC_COMPLETION_ROLLBACK");
      },
    },
    transactionRetryLimit: 1,
  });
  const rolledBack = await rollbackService.execute({
    projectId: projectAId,
    grantId: rollbackGrantId,
    operation: "autoExtract",
    sourceIds: [sourceAId],
  });
  requireCondition(
    rolledBack.kind === "claimed" &&
      rolledBack.status === "running" &&
      rolledBack.safeCode === "AI_PROVIDER_UNKNOWN",
    "AI_RUNTIME_POSTGRES_ATOMIC_ROLLBACK_RESULT_MISMATCH",
  );
  if (rolledBack.kind !== "claimed" || rolledBack.runId === undefined) {
    throw new Error("AI_RUNTIME_POSTGRES_ATOMIC_ROLLBACK_RUN_MISSING");
  }
  const rollback = await safeQuery<{
    run_status: string;
    output_bytes: number;
    provider_response_id: string | null;
    attempt_status: string;
    batches: string;
    terminal_audits: string;
  }>(
    client,
    `SELECT r."status"::text AS run_status,
            r."outputBytes" AS output_bytes,
            r."providerResponseId" AS provider_response_id,
            (SELECT a."status"::text FROM "AiRunAttempt" a
              WHERE a."projectId" = r."projectId" AND a."aiRunId" = r."id") AS attempt_status,
            (SELECT count(*)::text FROM "AiCandidateBatch" b
              WHERE b."projectId" = r."projectId" AND b."aiRunId" = r."id") AS batches,
            (SELECT count(*)::text FROM "AiAuditEvent" e
              WHERE e."projectId" = r."projectId" AND e."aiRunId" = r."id"
                AND e."eventType" IN ('runSucceeded', 'attemptSucceeded')) AS terminal_audits
       FROM "AiRun" r
      WHERE r."projectId" = $1 AND r."id" = $2`,
    [projectAId, rolledBack.runId],
  );
  const rollbackRow = rollback.rows[0];
  requireCondition(
    rollbackRow?.run_status === "running" &&
      rollbackRow.output_bytes === 0 &&
      rollbackRow.provider_response_id === null &&
      rollbackRow.attempt_status === "sent" &&
      rollbackRow.batches === "0" &&
      rollbackRow.terminal_audits === "0",
    "AI_RUNTIME_POSTGRES_ATOMIC_ROLLBACK_STATE_MISMATCH",
  );
}

async function runCandidateMemoryMatrix(client: Client, url: string): Promise<void> {
  await setupFreshLiveGrant(client);
  await insertPolicyRevision(
    client,
    revisionA2Id,
    projectAId,
    2,
    true,
    true,
    true,
  );
  await safeQuery(
    client,
    `UPDATE "ProjectAiPolicy"
        SET "currentRevisionId" = $2, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "projectId" = $1`,
    [projectAId, revisionA2Id],
  );

  const candidateGrantId = "12121212-1212-4212-8212-121212121212";
  const candidateGrantSourceId = "13131313-1313-4313-8313-131313131313";
  const candidateGrantOperationId = "14141414-1414-4414-8414-141414141414";
  const candidateRunId = "15151515-1515-4515-8515-151515151515";
  const candidateInputId = "16161616-1616-4616-8616-161616161616";
  const candidateAttemptId = "17171717-1717-4717-8717-171717171717";
  const providerResponseId = "resp_candidate_postgres_1";

  await insertDraftGrant(client, candidateGrantId, revisionA2Id, 2);
  await insertGrantSource(
    client,
    candidateGrantSourceId,
    candidateGrantId,
  );
  await insertGrantOperation(
    client,
    candidateGrantOperationId,
    candidateGrantId,
    "autoExtract",
  );
  await issueGrant(client, candidateGrantId);

  await safeQuery(
    client,
    `INSERT INTO "AiRun"
       ("id", "projectId", "grantId", "policyRevisionId", "operation",
        "operationKey", "operationKeySchemaVersion", "inputManifestFingerprint",
        "promptFingerprint", "promptVersion", "providerFingerprint", "modelId",
        "modelFingerprint", "profileFingerprint", "grantFingerprint",
        "effectivePolicyVersion", "processorFingerprint", "processorEndpointFingerprint",
        "processorRegionFingerprint", "processorRetentionFingerprint", "noRagSnapshotMarker",
        "inputBytes", "outputBytes", "maxInputTokens", "maxOutputTokens", "maxRequests",
        "maxBudgetMicros", "inputTokens", "outputTokens", "requestCount", "budgetUsedMicros",
        "pricingSnapshotId", "budgetStatus", "status")
     VALUES ($1, $2, $3, $4, 'autoExtract', $5, 'ai-operation-key:v1', $6,
             $7, 'candidate-prompt-v1', $7, 'synthetic-provider/model-v1',
             $7, $7, $7, 2, $7, $7, $7, $7, 'no-rag-snapshot:v1',
             $8, 0, 100, 100, 1, 100000, 0, 0, 0, 0,
             'candidate-pricing-v1', 'pending', 'queued')`,
    [
      candidateRunId,
      projectAId,
      candidateGrantId,
      revisionA2Id,
      "f".repeat(64),
      sourceAContentHash,
      fingerprintA,
      Buffer.byteLength(sourceAContent, "utf8"),
    ],
  );
  await insertRunInputSource(
    client,
    candidateInputId,
    candidateRunId,
    projectAId,
    candidateGrantId,
  );
  await claimRun(client, candidateRunId, candidateAttemptId);
  await transaction(client, [
    {
      sql: `UPDATE "AiRunAttempt"
               SET "status" = 'succeeded',
                   "inputTokens" = 10,
                   "outputTokens" = 5,
                   "providerResponseId" = $3,
                   "httpStatus" = 200,
                   "completedAt" = CURRENT_TIMESTAMP
             WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, candidateAttemptId, providerResponseId],
    },
    {
      sql: `UPDATE "AiRun"
               SET "status" = 'succeeded',
                   "outputBytes" = 256,
                   "inputTokens" = 10,
                   "outputTokens" = 5,
                   "budgetUsedMicros" = 1,
                   "budgetStatus" = 'allowed',
                   "providerResponseId" = $3,
                   "httpStatus" = 200,
                   "completedAt" = CURRENT_TIMESTAMP
             WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, candidateRunId, providerResponseId],
    },
  ]);

  const candidates = [
    {
      itemType: "decision",
      statement: "Candidate decision.",
      statementFingerprint: buildOpenAiCandidateStatementFingerprint(
        "Candidate decision.",
      ),
      sourceId: sourceAId,
      sourceExcerpt: sourceAContent,
      sourceExcerptFingerprint: buildOpenAiCandidateExcerptFingerprint(
        sourceAContent,
      ),
      sourceStart: 0,
      sourceEnd: Buffer.byteLength(sourceAContent, "utf8"),
    },
    {
      itemType: "risk",
      statement: "Candidate risk.",
      statementFingerprint: buildOpenAiCandidateStatementFingerprint(
        "Candidate risk.",
      ),
      sourceId: sourceAId,
      sourceExcerpt: "runtime",
      sourceExcerptFingerprint: buildOpenAiCandidateExcerptFingerprint("runtime"),
      sourceStart: 0,
      sourceEnd: Buffer.byteLength("runtime", "utf8"),
    },
  ] as const;
  const verifiedResponse = {
    contractVersion: OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION,
    providerResponseId,
    modelId: "synthetic-provider/model-v1",
    usage: { inputTokens: 10, outputTokens: 5, requestCount: 1 },
    candidates,
    candidateSetFingerprint: buildOpenAiCandidateSetFingerprint(candidates),
  };

  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });
  const service = createAiCandidateService({ db: prisma });
  try {
    const first = await service.persistVerifiedCandidates({
      projectId: projectAId,
      aiRunId: candidateRunId,
      verifiedResponse,
    });
    const replay = await service.persistVerifiedCandidates({
      projectId: projectAId,
      aiRunId: candidateRunId,
      verifiedResponse,
    });
    requireCondition(
      first.id === replay.id &&
        first.candidateCount === 2 &&
        first.claims.length === 2 &&
        first.claims.every(
          (claim) =>
            claim.reviewStatus === "candidate" &&
            claim.projectItem.reviewStatus === "candidate" &&
            claim.projectItem.content === claim.statement,
        ),
      "AI_CANDIDATE_POSTGRES_ATOMIC_IDEMPOTENCY_FAILED",
    );

    const decision = first.claims.find(
      (claim) => claim.statement === "Candidate decision.",
    );
    const risk = first.claims.find(
      (claim) => claim.statement === "Candidate risk.",
    );
    requireCondition(
      decision !== undefined && risk !== undefined,
      "AI_CANDIDATE_POSTGRES_CLAIMS_MISSING",
    );
    const publishedCandidates = await safeQuery<{
      project_item_id: string;
      revisions: string;
      initial_action: string;
      evidences: string;
    }>(
      client,
      `SELECT c."projectItemId"::text AS project_item_id,
              count(r."id")::text AS revisions,
              min(r."action"::text) AS initial_action,
              (SELECT count(*)::text FROM "ProjectItemEvidence" AS e
                WHERE e."projectId" = c."projectId"
                  AND e."projectItemId" = c."projectItemId") AS evidences
         FROM "AiCandidateClaim" AS c
         JOIN "ProjectItemRevision" AS r
           ON r."projectId" = c."projectId"
          AND r."projectItemId" = c."projectItemId"
        WHERE c."projectId" = $1 AND c."batchId" = $2
        GROUP BY c."projectId", c."projectItemId"
        ORDER BY c."projectItemId"`,
      [projectAId, first.id],
    );
    requireCondition(
      publishedCandidates.rows.length === 2 &&
        publishedCandidates.rows.every(
          (row) =>
            row.project_item_id.length > 0 &&
            row.revisions === "1" &&
            row.initial_action === "ai_created" &&
            row.evidences === "1",
        ),
      "AI_CANDIDATE_POSTGRES_VISIBLE_PUBLICATION_MISMATCH",
    );
    const accepted = await service.acceptCandidate({
      projectId: projectAId,
      candidateId: decision.id,
      reviewedBy: "local-user",
      item: {
        type: ProjectItemType.decision,
        title: "Accepted model candidate",
        content: decision.statement,
        occurredAt: null,
      },
    });
    const dismissed = await service.dismissCandidate({
      projectId: projectAId,
      candidateId: risk.id,
      reviewedBy: "local-user",
    });
    requireCondition(
      accepted.reviewStatus === "accepted" &&
        accepted.projectItem.reviewStatus === "confirmed" &&
        accepted.projectItem.sourceId === sourceAId &&
        accepted.projectItem.sourceExcerpt === sourceAContent &&
        dismissed.reviewStatus === "dismissed" &&
        dismissed.projectItem.reviewStatus === "dismissed" &&
        dismissed.projectItemId === risk.projectItemId,
      "AI_CANDIDATE_POSTGRES_REVIEW_STATE_MISMATCH",
    );

    const acceptedHistory = await safeQuery<{
      actions: string[];
      evidences: string;
      revision_links: string;
    }>(
      client,
      `SELECT
         array_agg(r."action"::text ORDER BY r."revisionNumber") AS actions,
         (SELECT COUNT(*)::text FROM "ProjectItemEvidence" e
           WHERE e."projectId" = $1 AND e."projectItemId" = $2) AS evidences,
         (SELECT COUNT(*)::text FROM "ProjectItemRevisionEvidence" re
           WHERE re."projectId" = $1 AND re."projectItemId" = $2) AS revision_links
       FROM "ProjectItemRevision" r
       WHERE r."projectId" = $1 AND r."projectItemId" = $2`,
      [projectAId, accepted.projectItemId],
    );
    requireCondition(
      JSON.stringify(acceptedHistory.rows[0]?.actions) ===
        JSON.stringify(["ai_created", "confirmed"]) &&
        acceptedHistory.rows[0]?.evidences === "1" &&
        acceptedHistory.rows[0]?.revision_links === "2",
      "AI_CANDIDATE_POSTGRES_ITEM_HISTORY_MISMATCH",
    );

    const replayAfterReview = await service.persistVerifiedCandidates({
      projectId: projectAId,
      aiRunId: candidateRunId,
      verifiedResponse,
    });
    requireCondition(
      replayAfterReview.id === first.id &&
        replayAfterReview.claims.some((claim) => claim.reviewStatus === "accepted") &&
        replayAfterReview.claims.some((claim) => claim.reviewStatus === "dismissed"),
      "AI_CANDIDATE_POSTGRES_REPLAY_AFTER_REVIEW_FAILED",
    );
    await expectActionRejected(
      async () => {
        await service.acceptCandidate({
          projectId: projectAId,
          candidateId: decision.id,
          reviewedBy: "local-user",
          item: {
            type: ProjectItemType.decision,
            title: "Duplicate review",
            content: decision.statement,
          },
        });
      },
      "candidate duplicate review",
    );
    try {
      await service.dismissCandidate({
        projectId: projectAId,
        candidateId: decision.id,
        reviewedBy: "local-user",
      });
      throw new Error("AI_CANDIDATE_POSTGRES_TERMINAL_REVIEW_ACCEPTED");
    } catch (error) {
      requireCondition(
        error instanceof AiCandidateError &&
          error.code === "AI_CANDIDATE_ALREADY_REVIEWED",
        "AI_CANDIDATE_POSTGRES_TERMINAL_REVIEW_ERROR_MISMATCH",
      );
    }

    await expectActionRejected(
      () =>
        transaction(client, [
          {
            sql: `UPDATE "AiCandidateClaim"
                    SET "statement" = 'forged'
                  WHERE "projectId" = $1 AND "id" = $2`,
            values: [projectAId, decision.id],
          },
        ]),
      "candidate evidence update",
    );
    await expectActionRejected(
      () =>
        transaction(client, [
          {
            sql: `DELETE FROM "AiCandidateClaim"
                  WHERE "projectId" = $1 AND "id" = $2`,
            values: [projectAId, risk.id],
          },
        ]),
      "candidate direct delete",
    );
    await expectActionRejected(
      () =>
        transaction(client, [
          {
            sql: `UPDATE "AiCandidateBatch"
                    SET "candidateCount" = 1
                  WHERE "projectId" = $1 AND "id" = $2`,
            values: [projectAId, first.id],
          },
        ]),
      "candidate batch mutation",
    );
    await expectActionRejected(
      () =>
        transaction(client, [
          {
            sql: `UPDATE "ProjectItem"
                    SET "sourceExcerpt" = 'runtime'
                  WHERE "projectId" = $1 AND "id" = $2`,
            values: [projectAId, accepted.projectItemId],
          },
        ]),
      "accepted candidate provenance mutation",
    );
    await expectActionRejected(
      () =>
        transaction(client, [
          {
            sql: `DELETE FROM "ProjectItem"
                  WHERE "projectId" = $1 AND "id" = $2`,
            values: [projectAId, accepted.projectItemId],
          },
        ]),
      "accepted candidate item delete",
    );
    await runAtomicRuntimeCandidateCompletion(client, prisma);
  } finally {
    await prisma.$disconnect();
  }

  await transaction(client, [
    {
      sql: `DELETE FROM "Project" WHERE "id" = $1`,
      values: [projectAId],
    },
  ]);
  const cascade = await safeQuery<{
    batches: string;
    claims: string;
    items: string;
  }>(
    client,
    `SELECT
       (SELECT COUNT(*)::text FROM "AiCandidateBatch" WHERE "projectId" = $1) AS batches,
       (SELECT COUNT(*)::text FROM "AiCandidateClaim" WHERE "projectId" = $1) AS claims,
       (SELECT COUNT(*)::text FROM "ProjectItem" WHERE "projectId" = $1) AS items`,
    [projectAId],
  );
  requireCondition(
    cascade.rows[0]?.batches === "0" &&
      cascade.rows[0].claims === "0" &&
      cascade.rows[0].items === "0",
    "AI_CANDIDATE_POSTGRES_PROJECT_CASCADE_MISMATCH",
  );
}

async function runCandidatePublicationUpgradePath(client: Client): Promise<void> {
  await resetPublic(client);
  for (const path of v0MigrationPaths) {
    await applySqlMigration(client, path);
  }
  await seedV0Rows(client);
  await applyAiMigrationsBeforeCandidatePublication(client);

  await insertPolicyRevision(
    client,
    revisionAId,
    projectAId,
    1,
    true,
    false,
    true,
    false,
  );
  await insertPolicyPointer(client, projectAId, revisionAId);
  await insertDraftGrant(client, grantAId);
  await insertGrantSource(client, grantSourceAId, grantAId);
  await insertGrantOperation(client, grantOperationAId, grantAId, "autoExtract");
  await issueGrant(client, grantAId);

  const runId = "21212121-2121-4121-8121-212121212121";
  const inputId = "22222221-2222-4222-8222-222222222221";
  const attemptId = "23232323-2323-4323-8323-232323232323";
  const batchId = "24242424-2424-4424-8424-242424242424";
  const pendingClaimId = "25252525-2525-4525-8525-252525252525";
  const dismissedClaimId = "26262626-2626-4626-8626-262626262626";
  const acceptedClaimId = "27272727-2727-4727-8727-272727272727";
  const acceptedItemId = "28282828-2828-4828-8828-282828282828";
  const acceptedEvidenceId = "29292929-2929-4929-8929-292929292929";
  const acceptedRevisionId = "30303030-3030-4030-8030-303030303030";
  const providerResponseId = "resp_candidate_upgrade_1";

  await safeQuery(
    client,
    `INSERT INTO "AiRun"
       ("id", "projectId", "grantId", "policyRevisionId", "operation",
        "operationKey", "operationKeySchemaVersion", "inputManifestFingerprint",
        "promptFingerprint", "promptVersion", "providerFingerprint", "modelId",
        "modelFingerprint", "profileFingerprint", "grantFingerprint",
        "effectivePolicyVersion", "processorFingerprint", "processorEndpointFingerprint",
        "processorRegionFingerprint", "processorRetentionFingerprint", "noRagSnapshotMarker",
        "inputBytes", "outputBytes", "maxInputTokens", "maxOutputTokens", "maxRequests",
        "maxBudgetMicros", "inputTokens", "outputTokens", "requestCount", "budgetUsedMicros",
        "pricingSnapshotId", "budgetStatus", "status")
     VALUES ($1, $2, $3, $4, 'autoExtract', $5, 'ai-operation-key:v1', $6,
             $7, 'candidate-upgrade-prompt-v1', $7, 'synthetic-provider/model-v1',
             $7, $7, $7, 1, $7, $7, $7, $7, 'no-rag-snapshot:v1',
             $8, 0, 100, 100, 1, 100000, 0, 0, 0, 0,
             'candidate-upgrade-pricing-v1', 'pending', 'queued')`,
    [
      runId,
      projectAId,
      grantAId,
      revisionAId,
      "d".repeat(64),
      sourceAContentHash,
      fingerprintA,
      Buffer.byteLength(sourceAContent, "utf8"),
    ],
  );
  await insertRunInputSource(client, inputId, runId);
  await claimRun(client, runId, attemptId);
  await transaction(client, [
    {
      sql: `UPDATE "AiRunAttempt"
               SET "status" = 'succeeded', "inputTokens" = 10,
                   "outputTokens" = 5, "providerResponseId" = $3,
                   "httpStatus" = 200, "completedAt" = CURRENT_TIMESTAMP
             WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, attemptId, providerResponseId],
    },
    {
      sql: `UPDATE "AiRun"
               SET "status" = 'succeeded', "outputBytes" = 256,
                   "inputTokens" = 10, "outputTokens" = 5,
                   "budgetUsedMicros" = 1, "budgetStatus" = 'allowed',
                   "providerResponseId" = $3, "httpStatus" = 200,
                   "completedAt" = CURRENT_TIMESTAMP
             WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, runId, providerResponseId],
    },
  ]);

  await transaction(client, [
    {
      sql: `INSERT INTO "ProjectItem"
              ("id", "projectId", "type", "reviewStatus", "sourceId", "title",
               "content", "sourceExcerpt", "confirmedAt", "metadata",
               "createdAt", "updatedAt")
            VALUES ($1, $2, 'decision', 'confirmed', $3,
                    'Accepted legacy candidate', 'Accepted legacy candidate', $4,
                    CURRENT_TIMESTAMP,
                    jsonb_build_object('origin', 'ai_candidate'),
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      values: [acceptedItemId, projectAId, sourceAId, sourceAContent],
    },
    {
      sql: `INSERT INTO "ProjectItemEvidence"
              ("id", "projectId", "projectItemId", "role", "evidenceState",
               "originScope", "projectSourceId", "sourceExcerpt",
               "sourceExcerptFingerprint", "rangeUnit", "rangeStart", "rangeEnd",
               "isActive")
            VALUES ($1, $2, $3, 'primary', 'active', 'project', $4, $5,
                    encode(sha256(convert_to($5, 'UTF8')), 'hex'),
                    'utf8_byte', 0, $6, true)`,
      values: [
        acceptedEvidenceId,
        projectAId,
        acceptedItemId,
        sourceAId,
        sourceAContent,
        Buffer.byteLength(sourceAContent, "utf8"),
      ],
    },
    {
      sql: `INSERT INTO "ProjectItemRevision"
              ("id", "projectId", "projectItemId", "revisionNumber", "action",
               "actorId", "itemType", "reviewStatus", "title", "content",
               "sourceId", "sourceExcerpt", "confirmedAt", "metadata",
               "evidenceManifestFingerprint", "integrityState")
            VALUES ($1, $2, $3, 1, 'legacy_import', 'system:migration',
                    'decision', 'confirmed', 'Accepted legacy candidate',
                    'Accepted legacy candidate', $4::uuid, $5, CURRENT_TIMESTAMP,
                    jsonb_build_object('origin', 'ai_candidate'),
                    encode(sha256(convert_to(
                      $4::uuid::text || ':' || encode(sha256(convert_to($5, 'UTF8')), 'hex')
                      || ':0:' || $6::text,
                      'UTF8'
                    )), 'hex'), 'active')`,
      values: [
        acceptedRevisionId,
        projectAId,
        acceptedItemId,
        sourceAId,
        sourceAContent,
        Buffer.byteLength(sourceAContent, "utf8"),
      ],
    },
    {
      sql: `INSERT INTO "ProjectItemRevisionEvidence"
              ("id", "projectId", "projectItemId", "revisionId", "evidenceId", "role")
            VALUES (gen_random_uuid(), $1, $2, $3, $4, 'primary')`,
      values: [
        projectAId,
        acceptedItemId,
        acceptedRevisionId,
        acceptedEvidenceId,
      ],
    },
    {
      sql: `INSERT INTO "AiCandidateBatch"
              ("id", "projectId", "aiRunId", "candidateSetFingerprint", "candidateCount")
            VALUES ($1, $2, $3, $4, 3)`,
      values: [batchId, projectAId, runId, fingerprintA],
    },
    {
      sql: `INSERT INTO "AiCandidateClaim"
              ("id", "projectId", "batchId", "aiRunId", "sourceId",
               "statement", "statementFingerprint", "sourceExcerpt",
               "sourceExcerptFingerprint", "sourceStart", "sourceEnd")
            VALUES ($1, $2, $3, $4, $5, 'Pending legacy candidate', $6,
                    $7, $8, 0, $9)`,
      values: [
        pendingClaimId,
        projectAId,
        batchId,
        runId,
        sourceAId,
        fingerprintA,
        sourceAContent,
        fingerprintA,
        Buffer.byteLength(sourceAContent, "utf8"),
      ],
    },
    {
      sql: `INSERT INTO "AiCandidateClaim"
              ("id", "projectId", "batchId", "aiRunId", "sourceId",
               "statement", "statementFingerprint", "sourceExcerpt",
               "sourceExcerptFingerprint", "sourceStart", "sourceEnd")
            VALUES ($1, $2, $3, $4, $5, 'Accepted legacy candidate', $6,
                    $7, $8, 0, $9)`,
      values: [
        acceptedClaimId,
        projectAId,
        batchId,
        runId,
        sourceAId,
        "c".repeat(64),
        sourceAContent,
        "c".repeat(64),
        Buffer.byteLength(sourceAContent, "utf8"),
      ],
    },
    {
      sql: `INSERT INTO "AiCandidateClaim"
              ("id", "projectId", "batchId", "aiRunId", "sourceId",
               "statement", "statementFingerprint", "sourceExcerpt",
               "sourceExcerptFingerprint", "sourceStart", "sourceEnd")
            VALUES ($1, $2, $3, $4, $5, 'Dismissed legacy candidate', $6,
                    'runtime', $7, 0, $8)`,
      values: [
        dismissedClaimId,
        projectAId,
        batchId,
        runId,
        sourceAId,
        fingerprintB,
        fingerprintB,
        Buffer.byteLength("runtime", "utf8"),
      ],
    },
    {
      sql: `UPDATE "AiCandidateClaim"
               SET "reviewStatus" = 'dismissed',
                   "reviewedAt" = CURRENT_TIMESTAMP,
                   "reviewedBy" = 'upgrade-reviewer'
             WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, dismissedClaimId],
    },
    {
      sql: `UPDATE "AiCandidateClaim"
               SET "reviewStatus" = 'accepted',
                   "reviewedAt" = CURRENT_TIMESTAMP,
                   "reviewedBy" = 'upgrade-reviewer',
                   "acceptedItemId" = $3
             WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, acceptedClaimId, acceptedItemId],
    },
  ]);

  await applySqlMigration(client, candidateItemPublicationMigrationPath);
  const rows = await safeQuery<{
    id: string;
    claim_status: string;
    item_type: string;
    item_status: string;
    project_item_id: string;
    actions: string[];
    evidence_count: string;
  }>(
    client,
    `SELECT c."id"::text AS id,
            c."reviewStatus"::text AS claim_status,
            c."itemType"::text AS item_type,
            i."reviewStatus"::text AS item_status,
            c."projectItemId"::text AS project_item_id,
            array_agg(r."action"::text ORDER BY r."revisionNumber") AS actions,
            (SELECT count(*)::text FROM "ProjectItemEvidence" AS e
              WHERE e."projectId" = c."projectId"
                AND e."projectItemId" = c."projectItemId") AS evidence_count
       FROM "AiCandidateClaim" AS c
       JOIN "ProjectItem" AS i
         ON i."projectId" = c."projectId" AND i."id" = c."projectItemId"
       JOIN "ProjectItemRevision" AS r
         ON r."projectId" = c."projectId"
        AND r."projectItemId" = c."projectItemId"
      WHERE c."projectId" = $1 AND c."id" = ANY($2::uuid[])
      GROUP BY c."id", c."reviewStatus", c."itemType", i."reviewStatus",
               c."projectItemId", c."projectId"
      ORDER BY c."id"`,
    [projectAId, [pendingClaimId, dismissedClaimId, acceptedClaimId]],
  );
  const pending = rows.rows.find((row) => row.id === pendingClaimId);
  const dismissed = rows.rows.find((row) => row.id === dismissedClaimId);
  const accepted = rows.rows.find((row) => row.id === acceptedClaimId);
  requireCondition(
    pending?.claim_status === "candidate" &&
      pending.item_type === "progress" &&
      pending.item_status === "candidate" &&
      pending.project_item_id.length > 0 &&
      pending.evidence_count === "1" &&
      JSON.stringify(pending.actions) === JSON.stringify(["ai_created"]) &&
      dismissed?.claim_status === "dismissed" &&
      dismissed.item_type === "progress" &&
      dismissed.item_status === "dismissed" &&
      dismissed.project_item_id.length > 0 &&
      dismissed.evidence_count === "1" &&
      JSON.stringify(dismissed.actions) ===
        JSON.stringify(["ai_created", "dismissed"]) &&
      accepted?.claim_status === "accepted" &&
      accepted.item_type === "decision" &&
      accepted.item_status === "confirmed" &&
      accepted.project_item_id === acceptedItemId &&
      accepted.evidence_count === "1" &&
      JSON.stringify(accepted.actions) ===
        JSON.stringify(["ai_created", "confirmed"]),
    "AI_CANDIDATE_POSTGRES_PUBLICATION_UPGRADE_MISMATCH",
  );

  await applySqlMigration(client, operationProfileMigrationPath);
  const profile = await safeQuery<{
    operation: string;
    profile_fingerprint: string;
    provider_fingerprint: string;
    model_id: string;
  }>(
    client,
    `SELECT "operation"::text AS operation,
            "profileFingerprint" AS profile_fingerprint,
            "providerFingerprint" AS provider_fingerprint,
            "modelId" AS model_id
       FROM "ProjectAiPolicyOperationProfile"
      WHERE "projectId" = $1 AND "policyRevisionId" = $2`,
    [projectAId, revisionAId],
  );
  requireCondition(
    profile.rows.length === 1 &&
      profile.rows[0]?.operation === "autoExtract" &&
      profile.rows[0].profile_fingerprint === fingerprintA &&
      profile.rows[0].provider_fingerprint === fingerprintA &&
      profile.rows[0].model_id === "synthetic-provider/model-v1",
    "AI_RUNTIME_POSTGRES_OPERATION_PROFILE_BACKFILL_MISMATCH",
  );
}

async function assertProjectRootCascade(client: Client): Promise<void> {
  const result = await safeQuery<{
    project_a: string;
    source_a: string;
    item_a: string;
    policy_revisions_a: string;
    operation_profiles_a: string;
    policy_a: string;
    grants_a: string;
    grant_sources_a: string;
    grant_operations_a: string;
    runs_a: string;
    attempts_a: string;
    inputs_a: string;
    audits_a: string;
    candidate_batches_a: string;
    candidate_claims_a: string;
    project_b: string;
    source_b: string;
  }>(
    client,
    `SELECT
       (SELECT COUNT(*)::text FROM "Project" WHERE "id" = $1) AS project_a,
       (SELECT COUNT(*)::text FROM "ProjectSource" WHERE "projectId" = $1) AS source_a,
       (SELECT COUNT(*)::text FROM "ProjectItem" WHERE "projectId" = $1) AS item_a,
       (SELECT COUNT(*)::text FROM "ProjectAiPolicyRevision" WHERE "projectId" = $1) AS policy_revisions_a,
       (SELECT COUNT(*)::text FROM "ProjectAiPolicyOperationProfile" WHERE "projectId" = $1) AS operation_profiles_a,
       (SELECT COUNT(*)::text FROM "ProjectAiPolicy" WHERE "projectId" = $1) AS policy_a,
       (SELECT COUNT(*)::text FROM "ModelProcessingGrant" WHERE "projectId" = $1) AS grants_a,
       (SELECT COUNT(*)::text FROM "ModelProcessingGrantSource" WHERE "projectId" = $1) AS grant_sources_a,
       (SELECT COUNT(*)::text FROM "ModelProcessingGrantOperation" WHERE "projectId" = $1) AS grant_operations_a,
       (SELECT COUNT(*)::text FROM "AiRun" WHERE "projectId" = $1) AS runs_a,
       (SELECT COUNT(*)::text FROM "AiRunAttempt" WHERE "projectId" = $1) AS attempts_a,
       (SELECT COUNT(*)::text FROM "AiRunInputSource" WHERE "projectId" = $1) AS inputs_a,
       (SELECT COUNT(*)::text FROM "AiAuditEvent" WHERE "projectId" = $1) AS audits_a,
       (SELECT COUNT(*)::text FROM "AiCandidateBatch" WHERE "projectId" = $1) AS candidate_batches_a,
       (SELECT COUNT(*)::text FROM "AiCandidateClaim" WHERE "projectId" = $1) AS candidate_claims_a,
       (SELECT COUNT(*)::text FROM "Project" WHERE "id" = $2) AS project_b,
       (SELECT COUNT(*)::text FROM "ProjectSource" WHERE "projectId" = $2) AS source_b`,
    [projectAId, projectBId],
  );
  const counts = result.rows[0];
  requireCondition(
    counts !== undefined &&
      counts.project_a === "0" &&
      counts.source_a === "0" &&
      counts.item_a === "0" &&
      counts.policy_revisions_a === "0" &&
      counts.operation_profiles_a === "0" &&
      counts.policy_a === "0" &&
      counts.grants_a === "0" &&
      counts.grant_sources_a === "0" &&
      counts.grant_operations_a === "0" &&
      counts.runs_a === "0" &&
      counts.attempts_a === "0" &&
      counts.inputs_a === "0" &&
      counts.audits_a === "0" &&
      counts.candidate_batches_a === "0" &&
      counts.candidate_claims_a === "0" &&
      counts.project_b === "1" &&
      counts.source_b === "1",
    "AI_RUNTIME_POSTGRES_PROJECT_ROOT_CASCADE_MISMATCH",
  );
}

async function runCrossProjectAuditDeleteCascadeMatrix(client: Client): Promise<void> {
  // Batch 3 keeps operationKey/manifest child-set and Attempt/Run usage
  // aggregation explicitly service-only for the Phase 2B CAS gate.
  await setupFreshLiveGrant(client);
  await insertPolicyRevision(client, revisionA2Id, projectAId, 2, true, true);

  const secondaryGrantId = batch3GrantId(2);
  await insertDraftGrant(client, secondaryGrantId);
  await insertGrantSource(client, batch3GrantSourceId(2), secondaryGrantId);
  await insertGrantOperation(client, batch3GrantOperationId(2), secondaryGrantId);
  await issueGrant(client, secondaryGrantId);

  const crossSourceGrantId = batch3GrantId(1);
  await insertDraftGrant(client, crossSourceGrantId);
  await expectActionRejected(
    () =>
      transaction(client, [
        insertGrantSourceStatement(
          batch3GrantSourceId(1),
          crossSourceGrantId,
          sourceBId,
          projectAId,
        ),
      ]),
    "cross-project grant source",
  );

  const primaryRunId = batch3RunId(1);
  const primaryAttemptId = batch3AttemptId(1);
  const primaryInputId = batch3InputId(1);
  await insertQueuedRun(client, primaryRunId, batch3OperationKey(1));
  await insertRunInputSource(client, primaryInputId, primaryRunId);
  await claimRun(client, primaryRunId, primaryAttemptId);

  const secondaryRunId = batch3RunId(2);
  const secondaryAttemptId = batch3AttemptId(2);
  await insertQueuedRun(client, secondaryRunId, batch3OperationKey(2));
  await claimRun(client, secondaryRunId, secondaryAttemptId);

  await expectActionRejected(
    () =>
      transaction(client, [
        insertQueuedRunStatement(
          batch3RunId(3),
          batch3OperationKey(3),
          grantAId,
          revisionAId,
          projectBId,
        ),
      ]),
    "cross-project run",
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        insertSentAttemptStatement(
          batch3AttemptId(3),
          primaryRunId,
          1,
          projectBId,
        ),
      ]),
    "cross-project attempt",
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        insertRunInputSourceStatement(
          batch3InputId(2),
          primaryRunId,
          projectBId,
          grantAId,
          sourceAId,
        ),
      ]),
    "cross-project input source",
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        insertAuditEventStatement(
          batch3AuditId(5),
          projectBId,
          "dispatchSent",
          revisionAId,
          grantAId,
          primaryRunId,
          primaryAttemptId,
        ),
      ]),
    "cross-project audit provenance",
  );

  await insertAuditEvent(
    client,
    batch3AuditId(1),
    projectAId,
    "policyCreated",
    revisionAId,
  );
  await insertAuditEvent(
    client,
    batch3AuditId(2),
    projectAId,
    "grantIssued",
    revisionAId,
    grantAId,
  );
  await insertAuditEvent(
    client,
    batch3AuditId(3),
    projectAId,
    "runClaimed",
    revisionAId,
    grantAId,
    primaryRunId,
  );
  await insertAuditEvent(
    client,
    batch3AuditId(4),
    projectAId,
    "dispatchSent",
    revisionAId,
    grantAId,
    primaryRunId,
    primaryAttemptId,
  );

  const invalidAuditSubjects = [
    insertAuditEventStatement(
      batch3AuditId(6),
      projectAId,
      "policyCreated",
      revisionAId,
      grantAId,
    ),
    insertAuditEventStatement(
      batch3AuditId(7),
      projectAId,
      "grantIssued",
      revisionAId,
    ),
    insertAuditEventStatement(
      batch3AuditId(8),
      projectAId,
      "runClaimed",
      revisionAId,
      grantAId,
    ),
    insertAuditEventStatement(
      batch3AuditId(9),
      projectAId,
      "dispatchSent",
      revisionAId,
      grantAId,
      primaryRunId,
    ),
  ] as const;
  for (const [index, statement] of invalidAuditSubjects.entries()) {
    await expectActionRejected(
      () => transaction(client, [statement]),
      `audit subject shape ${index}`,
    );
  }

  await expectActionRejected(
    () =>
      transaction(client, [
        insertAuditEventStatement(
          batch3AuditId(10),
          projectAId,
          "grantIssued",
          revisionA2Id,
          grantAId,
        ),
      ]),
    "audit policy revision and grant mismatch",
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        insertAuditEventStatement(
          batch3AuditId(11),
          projectAId,
          "runClaimed",
          revisionAId,
          secondaryGrantId,
          primaryRunId,
        ),
      ]),
    "audit run and grant mismatch",
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        insertAuditEventStatement(
          batch3AuditId(12),
          projectAId,
          "dispatchSent",
          revisionAId,
          grantAId,
          secondaryRunId,
          primaryAttemptId,
        ),
      ]),
    "audit attempt and run mismatch",
  );

  await expectActionRejected(
    () =>
      transaction(client, [
        {
          sql: `UPDATE "AiAuditEvent"
                  SET "fingerprintCount" = 1
                WHERE "projectId" = $1 AND "id" = $2`,
          values: [projectAId, batch3AuditId(4)],
        },
      ]),
    "audit update",
  );
  await expectActionRejected(
    () =>
      transaction(client, [
        {
          sql: `DELETE FROM "AiAuditEvent"
                WHERE "projectId" = $1 AND "id" = $2`,
          values: [projectAId, batch3AuditId(4)],
        },
      ]),
    "audit delete",
  );

  const directDeleteCases = [
    {
      sql: `DELETE FROM "ProjectAiPolicy" WHERE "projectId" = $1`,
      values: [projectAId],
      label: "policy direct delete",
    },
    {
      sql: `DELETE FROM "ProjectAiPolicyRevision"
              WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, revisionA2Id],
      label: "policy revision direct delete",
    },
    {
      sql: `DELETE FROM "ModelProcessingGrant"
              WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, secondaryGrantId],
      label: "grant direct delete",
    },
    {
      sql: `DELETE FROM "AiRun"
              WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, primaryRunId],
      label: "run direct delete",
    },
    {
      sql: `DELETE FROM "AiRunAttempt"
              WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, primaryAttemptId],
      label: "attempt direct delete",
    },
    {
      sql: `DELETE FROM "AiRunInputSource"
              WHERE "projectId" = $1 AND "id" = $2`,
      values: [projectAId, primaryInputId],
      label: "input direct delete",
    },
  ] as const;
  for (const deleteCase of directDeleteCases) {
    await expectActionRejected(
      () => transaction(client, [{ sql: deleteCase.sql, values: deleteCase.values }]),
      deleteCase.label,
    );
  }
  await expectActionRejected(
    () =>
      transaction(client, [
        {
          sql: `DELETE FROM "ProjectSource"
                  WHERE "projectId" = $1 AND "id" = $2`,
          values: [projectAId, sourceAId],
        },
      ]),
    "source direct delete while referenced",
  );

  const rootQueuedRunId = batch3RunId(20);
  await insertQueuedRun(client, rootQueuedRunId, batch3OperationKey(20));
  await transaction(client, [
    {
      sql: `DELETE FROM "Project" WHERE "id" = $1`,
      values: [projectAId],
    },
  ]);
  await assertProjectRootCascade(client);
}

test(
  "AI runtime PostgreSQL migration and policy gate is opt-in and serial",
  { skip: !shouldRunPostgresGate ? "AI_RUNTIME_TEST_DATABASE_URL and explicit gate are required" : false },
  async () => {
    const client = await connectDedicated(testDatabaseUrl);
    try {
      await runEmptyDatabasePath(client, testDatabaseUrl as string);
      await runV0UpgradePath(client);
      await runPolicyAndGrantMatrix(client);
      await runPrepareOrGetConcurrency(client, testDatabaseUrl as string);
      await runQueuedPreflightClosureMatrix(client, testDatabaseUrl as string);
      await runClaimFirstAfterLiveMutation(client, testDatabaseUrl as string);
      await runAdversarialClaimIdentityMatrix(client, testDatabaseUrl as string);
      await runTwoConnectionOrderingEvidence(client, testDatabaseUrl as string);
      await setupFreshLiveGrant(client);
      await runRunAttemptInputMatrix(client);
      await runCandidateMemoryMatrix(client, testDatabaseUrl as string);
      await runCrossProjectAuditDeleteCascadeMatrix(client);
      await runCandidatePublicationUpgradePath(client);
    } finally {
      try {
        await resetPublic(client);
      } finally {
        await closeClient(client);
      }
    }
  },
);
