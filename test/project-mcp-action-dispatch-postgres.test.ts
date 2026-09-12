import "dotenv/config";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import test from "node:test";
import { createCredential, rotateCredential } from "../src/lib/credential-vault";
import { getDb } from "../src/lib/db";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import { resolveSecureEndpointFingerprint } from "../src/lib/web-sources";
import { McpCapabilityError } from "../src/lib/mcp/errors";
import { discoverMcpConnectionTools, updateMcpConnection } from "../src/lib/mcp/service";
import { createMcpControlPlaneAttestation } from "../src/lib/mcp-attestation-control-plane-service";
import {
  confirmProjectMcpConnectionDelegationOwner,
  confirmProjectMcpConnectionDelegationProject,
  proposeProjectMcpConnectionDelegation,
  revokeProjectMcpConnectionDelegation,
} from "../src/lib/project-mcp-connection-delegation-service";
import {
  createProjectMcpToolGrantV2,
  ProjectMcpToolGrantServiceError,
  revokeProjectMcpToolGrantV2,
} from "../src/lib/project-mcp-tool-grant-service";
import { decideProjectMcpAction, proposeProjectMcpAction } from "../src/lib/project-mcp-action-service";
import { sanitizeMcpToolResult } from "../src/lib/mcp/schema";
import { deleteArchivedProject } from "../src/lib/project-lifecycle";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  ActionEngineError,
  cancelProjectAction,
  decideProjectAction,
  getProjectActionCenter,
  runProjectActionWorkerCycle,
} from "../src/lib/action-engine";
import { ActionResultIntakeError, importProjectActionResult } from "../src/lib/action-result-intake";
import {
  dispatchProjectMcpAction,
  reconcileStaleProjectMcpActionDispatchReservations,
} from "../src/lib/project-mcp-action-dispatch-service";

const shouldRun = process.env.PROJECT_MCP_ACTION_DISPATCH_POSTGRES_GATE === "1";
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";
const fingerprint = (letter: string) => letter.repeat(64);

type ServerMode = "success" | "large" | "sensitive" | "rpcError" | "reset" | "hold";

function timeZoneDatabase(timeZone: string): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") throw new Error("DATABASE_URL is required");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, options: `-c TimeZone=${timeZone}` }) });
}

function shortReservationDatabase(db: PrismaClient, reservationMs: number, readyDelayMs: number): PrismaClient {
  type AttemptCreateInput = Readonly<{ data: Record<string, unknown> & { reservationExpiresAt: Date } }>;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return async (operation: unknown, options?: unknown) => {
        const invoke = target.$transaction.bind(target) as unknown as (
          callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          transactionOptions?: unknown,
        ) => Promise<unknown>;
        const result = await invoke(async (tx) => {
          const proxied = new Proxy(tx, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty !== "projectMcpActionDispatchAttempt") return Reflect.get(txTarget, txProperty, txReceiver);
              const delegate = txTarget.projectMcpActionDispatchAttempt;
              return new Proxy(delegate, {
                get(delegateTarget, delegateProperty, delegateReceiver) {
                  if (delegateProperty !== "create") return Reflect.get(delegateTarget, delegateProperty, delegateReceiver);
                  const create = Reflect.get(delegateTarget, delegateProperty, delegateReceiver) as unknown as (input: AttemptCreateInput) => Promise<unknown>;
                  return (input: AttemptCreateInput) => create.call(delegateTarget, {
                    ...input,
                    data: { ...input.data, reservationExpiresAt: new Date(Date.now() + reservationMs) },
                  });
                },
              });
            },
          }) as Prisma.TransactionClient;
          return (operation as (transaction: Prisma.TransactionClient) => Promise<unknown>)(proxied);
        }, options);
        if (typeof result === "object" && result !== null && "kind" in result && result.kind === "ready") await delay(readyDelayMs);
        return result;
      };
    },
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitFor<T>(read: () => Promise<T | null>, predicate: (value: T) => boolean): Promise<T> {
  for (let index = 0; index < 100; index += 1) {
    const value = await read();
    if (value !== null && predicate(value)) return value;
    await delay(10);
  }
  throw new Error("PROJECT_MCP_ACTION_DISPATCH_GATE_WAIT_TIMEOUT");
}

function isDispatchBoundaryUpdate(query: unknown): boolean {
  if (typeof query !== "object" || query === null || !("strings" in query)) return false;
  const strings = (query as { strings?: unknown }).strings;
  if (!Array.isArray(strings) || !strings.every((part) => typeof part === "string")) return false;
  const sql = strings.join("");
  return sql.includes('UPDATE "ProjectMcpActionDispatchAttempt" AS attempt')
    && sql.includes('SET "boundaryReachedAt"');
}

test(
  "single-use MCP dispatch is linearized, bounded, and retains scalar evidence",
  { skip: !shouldRun ? "PROJECT_MCP_ACTION_DISPATCH_POSTGRES_GATE=1 is required" : false },
  async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-mcp-dispatch-key-"));
    const previousMasterKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
    const db = getDb();
    const positiveTimeZoneDb = timeZoneDatabase("Asia/Shanghai");
    const negativeTimeZoneDb = timeZoneDatabase("America/Los_Angeles");
    const positiveTimeZone = await positiveTimeZoneDb.$queryRaw<Array<{ timeZone: string }>>(Prisma.sql`SELECT current_setting('TimeZone') AS "timeZone"`);
    const negativeTimeZone = await negativeTimeZoneDb.$queryRaw<Array<{ timeZone: string }>>(Prisma.sql`SELECT current_setting('TimeZone') AS "timeZone"`);
    assert.equal(positiveTimeZone[0]?.timeZone, "Asia/Shanghai");
    assert.equal(negativeTimeZone[0]?.timeZone, "America/Los_Angeles");
    const quarantineCoverage = await db.$queryRaw<Array<{ consumerCount: number; guardedCount: number }>>(Prisma.sql`
      WITH consumers AS (
        SELECT DISTINCT conrelid
        FROM pg_constraint
        WHERE contype = 'f' AND confrelid = '"ProjectSource"'::regclass
      ), guarded AS (
        SELECT DISTINCT tgrelid
        FROM pg_trigger
        WHERE NOT tgisinternal
          AND (
            pg_get_triggerdef(oid) LIKE '%legacy_mcp_source_reference_guard%'
            OR pg_get_triggerdef(oid) LIKE '%project_action_result_import_guard%'
          )
      )
      SELECT count(*)::int AS "consumerCount",
             count(*) FILTER (WHERE guarded.tgrelid IS NOT NULL)::int AS "guardedCount"
      FROM consumers LEFT JOIN guarded ON guarded.tgrelid = consumers.conrelid
    `);
    assert.ok((quarantineCoverage[0]?.consumerCount ?? 0) >= 19);
    assert.equal(quarantineCoverage[0]?.guardedCount, quarantineCoverage[0]?.consumerCount);
    const indirectMaterialGuards = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(DISTINCT tgrelid)::int AS count
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid IN (
          '"RepositoryMaterialGenerationEntry"'::regclass,
          '"RepositoryMaterialIndexInput"'::regclass
        )
        AND pg_get_triggerdef(oid) LIKE '%legacy_mcp_source_reference_guard%'
    `);
    assert.equal(indirectMaterialGuards[0]?.count, 2);
    const utcFunctionCount = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS count
      FROM pg_proc
      WHERE proname IN (
        'ai_run_lifecycle_guard',
        'ai_input_source_lifecycle_guard',
        'repository_code_index_generation_guard',
        'repository_code_index_pointer_guard',
        'repository_material_index_guard',
        'repository_material_index_pointer_guard'
      )
        AND position('CURRENT_TIMESTAMP' IN pg_get_functiondef(oid)) = 0
        AND position('AT TIME ZONE ''UTC''' IN pg_get_functiondef(oid)) > 0
    `);
    assert.equal(utcFunctionCount[0]?.count, 6);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const ownerId = randomUUID();
    const approvingOwnerId = randomUUID();
    const lifecycleAdminId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const legacyActionId = randomUUID();
    const legacyWaitingActionId = randomUUID();
    const legacyQueuedActionId = randomUUID();
    const legacyRunningActionId = randomUUID();
    const connectionId = randomUUID();
    const definitionId = randomUUID();
    const bearerConnectionId = randomUUID();
    const bearerDefinitionId = randomUUID();
    const definitionFingerprint = fingerprint("a");
    let actor: { readonly id: string; readonly role: "admin"; readonly accountAccessVersion: number } = { id: ownerId, role: "admin", accountAccessVersion: 1 };
    let dispatchActor: { readonly id: string; readonly role: "user"; readonly accountAccessVersion: number } = { id: approvingOwnerId, role: "user", accountAccessVersion: 1 };
    let activeBearerToken = `dispatch-gate-token-${suffix}`;
    const sensitiveResponseText = [
      "Authorization=Bearer persisted-bearer-marker; Authorization: Basic persisted-basic-marker; access_token: Bearer persisted-access-marker; Authorization: Bearer \"persisted-quoted-marker with space\"; Bearer \"persisted-standalone-marker nested\"; token: \"persisted-token-marker with space\"",
      "Authorization: Bearer\r\n persisted-folded-marker",
      "Authorization: Bearer \"" + "\\" + "\rpersisted-continuation-cr-marker",
      "Authorization: Bearer \"persisted-unclosed-authorization-marker with space",
      "Authorization: Basic 'persisted-unclosed-basic-marker with space",
      "access_token=\"persisted-unclosed-token-marker with space",
      "Authorization: Bearer \"persisted-dangling-double-marker" + "\\",
      "Authorization: Basic 'persisted-dangling-single-marker" + "\\",
      "access_token=\"persisted-dangling-access-marker" + "\\",
      "Authorization: Bearer \"persisted-barecr-marker\rnext-safe",
      "Authorization: Bearer \"persisted-dangling-barecr-marker" + "\\\rnext-safe",
      String.raw`{\"Authorization\":\"persisted-escaped-json-marker\"}`,
      String.raw`access_token\": \"persisted-escaped-access-marker\"`,
      String.raw`Authorization: Bearer \"persisted-escaped-open-marker\"`,
      String.raw`{\\"Authorization\\":\\"persisted-escaped-double-json-marker\\"}`,
      String.raw`Authorization: Bearer \\"persisted-escaped-double-open-marker\\"`,
      String.raw`{\u0022Authorization\u0022:\u0022persisted-unicode-quote-marker\u0022}`,
      String.raw`{\u0041uthorization\u0022:\u0022persisted-unicode-key-marker\u0022}`,
      String.raw`{\u0022access\u005ftoken\u0022:\u0022Bearer persisted-unicode-access-marker\u0022}`,
      "Auth<!--x-->orization: persisted-html-comment-marker",
      "Auth<b>x</b>orization: persisted-html-element-marker",
      "Au<span><i>x</i></span>thorization: persisted-html-nested-marker",
    ].join("\n");
    const serverState = {
      mode: "success" as ServerMode,
      postCount: 0,
      discoveryCount: 0,
      requestIds: [] as string[],
      releaseHold: null as (() => void) | null,
      hold: null as Promise<void> | null,
    };
    const server = createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", async () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method?: string };
        const authorization = request.headers.authorization;
        if (authorization !== undefined && authorization !== `Bearer ${activeBearerToken}`) {
          response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32001, message: "invalid bearer" } }));
          return;
        }
        if (parsed.method === "tools/call") {
          serverState.postCount += 1;
          serverState.requestIds.push(parsed.id);
        }
        if (parsed.method === "tools/list") {
          serverState.discoveryCount += 1;
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            result: {
              resultType: "complete",
              tools: [{
                name: "project.bearer.lookup",
                title: "Bearer lookup",
                description: "Epoch rotation lookup",
                inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
                outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: true },
                annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
              }],
            },
          }));
          return;
        }
        if (serverState.mode === "hold" && serverState.hold !== null) await serverState.hold;
        if (serverState.mode === "reset") {
          response.destroy();
          return;
        }
        const body = serverState.mode === "rpcError"
          ? { jsonrpc: "2.0", id: parsed.id, error: { code: -32001, message: "explicit remote rejection" } }
          : serverState.mode === "large"
            ? { jsonrpc: "2.0", id: parsed.id, result: { resultType: "complete", content: [{ type: "text", text: "x".repeat(60_000) }], structuredContent: { ok: true } } }
            : serverState.mode === "sensitive"
              ? {
                jsonrpc: "2.0",
                id: parsed.id,
                result: {
                  resultType: "complete",
                  content: [{ type: "text", text: sensitiveResponseText }],
                  structuredContent: {
                    ok: true,
                    access_token: "persisted-structured-marker",
                    [String.raw`\u{0041}uthorization`]: "persisted-obfuscated-braced-marker",
                    [String.raw`\x41uthorization`]: "persisted-obfuscated-hex-marker",
                    "&#65;uthorization": "persisted-obfuscated-entity-marker",
                    "A\u200duthorization": "persisted-obfuscated-joiner-marker",
                    "Auth\u200borization": "persisted-obfuscated-zero-width-marker",
                    "%41uthorization": "persisted-obfuscated-percent-marker",
                    "%u0041ccess_key": "persisted-obfuscated-percent-unicode-marker",
                    "%U0041pi_key": "persisted-obfuscated-percent-upper-unicode-marker",
                    "%u{0052}efresh_key": "persisted-obfuscated-percent-braced-marker",
                    "％u0041ccess_key": "persisted-obfuscated-fullwidth-percent-marker",
                    "＼u0041ccess_key": "persisted-obfuscated-fullwidth-backslash-marker",
                    "＆#65;ccess_key": "persisted-obfuscated-fullwidth-ampersand-marker",
                    "﹪u0041ccess_key": "persisted-obfuscated-small-percent-marker",
                    "﹨u0041ccess_key": "persisted-obfuscated-small-backslash-marker",
                    "﹠#65;ccess_key": "persisted-obfuscated-small-ampersand-marker",
                    "Auth<!--x-->orization": "persisted-obfuscated-html-comment-marker",
                    "Auth<b>x</b>orization": "persisted-obfuscated-html-element-marker",
                    "Au<span><i>x</i></span>thorization": "persisted-obfuscated-html-nested-marker",
                    ["__proto__"]: { marker: "persisted-prototype-marker" },
                  },
                },
              }
              : { jsonrpc: "2.0", id: parsed.id, result: { resultType: "complete", content: [{ type: "text", text: "safe lookup" }], structuredContent: { ok: true } } };
        await delay(25);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
    });

    const createApprovedAction = async (query: string) => {
      const proposal = await proposeProjectMcpAction(projectId, {
        clientRequestId: randomUUID(),
        grantId,
        expectedGrantVersion: 1,
        arguments: { query },
      }, actor, db);
      const actionId = proposal.action.id as string;
      const actionRevision = proposal.action.actionRevision as string;
      const approved = await decideProjectMcpAction(projectId, actionId, {
        decision: "approved",
        expectedStateVersion: 1,
        expectedActionRevision: actionRevision,
        acknowledgeSingleUse: true,
      }, dispatchActor, db);
      assert.equal(approved.created, true);
      return { actionId, actionRevision };
    };

    const mutateAccountAccess = async (
      targetUserId: string,
      adminUserId: string,
      action: "disable" | "restore",
      reason: string,
      requestKey: string,
    ) => {
      const admin = await db.appUser.findUniqueOrThrow({ where: { id: adminUserId }, select: { accountAccessVersion: true } });
      const target = await db.appUser.findUniqueOrThrow({ where: { id: targetUserId }, select: { accountAccessVersion: true } });
      const preview = await previewAccountAccess({
        adminUserId,
        adminAccountAccessVersion: admin.accountAccessVersion,
        userId: targetUserId,
        action,
        reason,
        expectedVersion: target.accountAccessVersion,
      }, db);
      assert.equal(preview.canExecute, true);
      return executeAccountAccess({
        adminUserId,
        adminAccountAccessVersion: admin.accountAccessVersion,
        userId: targetUserId,
        action,
        reason,
        expectedVersion: preview.current.accountAccessVersion,
        expectedImpactFingerprint: preview.impactFingerprint,
        requestKey,
        requestFingerprint: preview.requestFingerprint,
        previewId: preview.previewId,
        previewIssuedAt: preview.previewIssuedAt,
        previewExpiresAt: preview.previewExpiresAt,
        confirmation: true,
        confirmationUsername: preview.user.username,
      }, db);
    };

    const mutateApprovingOwnerAccess = async (
      action: "disable" | "restore",
      reason: string,
      requestKey: string,
    ) => mutateAccountAccess(approvingOwnerId, ownerId, action, reason, requestKey);

    const mutateConnectionOwnerAccess = async (
      action: "disable" | "restore",
      reason: string,
      requestKey: string,
    ) => mutateAccountAccess(ownerId, lifecycleAdminId, action, reason, requestKey);

    let grantId = "";
    let delegationId = "";
    let delegationVersion = 0;
    let projectCascadeActionId = "";
    let retainedAttemptCount = 0;
    let retainedRuntimeCount = 0;
    let inFlight: Promise<unknown> | null = null;
    try {
      const port = await listen(server);
      const endpoint = `http://127.0.0.1:${port}/mcp`;
      const resolved = await resolveSecureEndpointFingerprint({ url: endpoint, allowPrivateNetwork: true });
      await db.appUser.createMany({ data: [
        { id: ownerId, username: `dispatch_owner_${suffix}`, role: "admin" },
        { id: approvingOwnerId, username: `dispatch_approver_${suffix}`, role: "user" },
        { id: lifecycleAdminId, username: `dispatch_lifecycle_admin_${suffix}`, role: "admin" },
      ] });
      await db.$transaction(async (tx) => {
        const project = await tx.workspace.create({ data: { id: workspaceId, name: `dispatch gate ${suffix}`, slug: `dispatch-gate-${suffix}`, createdById: ownerId, projects: { create: { id: projectId, name: `dispatch project ${suffix}`, slug: `dispatch-project-${suffix}` } } }, select: { id: true } });
        assert.equal(project.id, workspaceId);
        await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "dispatch_gate_workspace_owner" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: approvingOwnerId, role: "owner", actorId: ownerId, reason: "dispatch_gate_workspace_approver" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "dispatch_gate_project_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: approvingOwnerId, role: "owner", actorId: ownerId, reason: "dispatch_gate_project_approver" });
      });
      await assert.rejects(
        () => db.projectSource.create({
          data: {
            projectId,
            kind: "mcp",
            externalRef: "legacy://mcp/forbidden",
            contentText: "legacy result container",
            contentHash: fingerprint("9"),
          },
        }),
        /LEGACY_MCP_SOURCE_CREATION_FROZEN/u,
      );
      // Model a historical successful row that predates the database freeze.
      // Replica mode is limited to fixture creation; every production read and
      // intake assertion below runs with normal triggers and access checks.
      const legacyInputFingerprint = fingerprint("d");
      const legacyResultFingerprint = fingerprint("e");
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectAction" (
            "id", "projectId", "capability", "riskLevel", "status", "input",
            "inputFingerprint", "policyModeSnapshot", "idempotencyKey", "requestedById",
            "approvalExpiresAt", "result", "completedAt", "updatedAt"
          )
          VALUES (
            ${legacyActionId}::uuid, ${projectId}::uuid,
            'project.mcp.read-tool.invoke', 'high'::"ProjectActionRiskLevel", 'succeeded'::"ProjectActionStatus",
            ${JSON.stringify({ secret: "legacy-sensitive-input-marker" })}::jsonb,
            ${legacyInputFingerprint}, 'approval_required'::"ProjectActionPolicyMode", ${fingerprint("f")}, ${ownerId}::uuid,
            NULL,
            ${JSON.stringify({ text: "legacy-sensitive-result-marker", resultFingerprint: legacyResultFingerprint })}::jsonb,
            (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
            (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
          ), (
            ${legacyWaitingActionId}::uuid, ${projectId}::uuid,
            'project.mcp.read-tool.invoke', 'high'::"ProjectActionRiskLevel", 'waiting_approval'::"ProjectActionStatus",
            ${JSON.stringify({ secret: "legacy-waiting-input-marker" })}::jsonb,
            ${legacyInputFingerprint}, 'approval_required'::"ProjectActionPolicyMode", ${fingerprint("1")}, ${ownerId}::uuid,
            (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 hour',
            ${JSON.stringify({ text: "legacy-waiting-result-marker" })}::jsonb,
            NULL,
            (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
          ), (
            ${legacyQueuedActionId}::uuid, ${projectId}::uuid,
            'project.mcp.read-tool.invoke', 'high'::"ProjectActionRiskLevel", 'queued'::"ProjectActionStatus",
            ${JSON.stringify({ secret: "legacy-queued-input-marker" })}::jsonb,
            ${legacyInputFingerprint}, 'approval_required'::"ProjectActionPolicyMode", ${fingerprint("2")}, ${ownerId}::uuid,
            (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) + interval '1 hour',
            ${JSON.stringify({ text: "legacy-queued-result-marker" })}::jsonb,
            NULL,
            (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
          )
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectAction" (
            "id", "projectId", "capability", "riskLevel", "status", "input",
            "inputFingerprint", "policyModeSnapshot", "idempotencyKey", "requestedById",
            "workerId", "leaseExpiresAt", "attemptCount", "result", "startedAt", "updatedAt"
          )
          VALUES (
            ${legacyRunningActionId}::uuid, ${projectId}::uuid,
            'project.mcp.read-tool.invoke', 'high'::"ProjectActionRiskLevel", 'running'::"ProjectActionStatus",
            ${JSON.stringify({ secret: "legacy-running-input-marker" })}::jsonb,
            ${legacyInputFingerprint}, 'approval_required'::"ProjectActionPolicyMode", ${fingerprint("3")}, ${ownerId}::uuid,
            ${`legacy-worker:${suffix}`},
            (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 hour',
            1,
            ${JSON.stringify({ text: "legacy-running-result-marker" })}::jsonb,
            (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '2 hours',
            (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '2 hours'
          )
        `);
      });
      const legacyNonterminalActionIds = [legacyWaitingActionId, legacyQueuedActionId, legacyRunningActionId];
      const legacyWorkerStateBefore = await db.projectAction.findMany({
        where: { id: { in: legacyNonterminalActionIds } },
        orderBy: { id: "asc" },
        select: { id: true, status: true, attemptCount: true, updatedAt: true },
      });
      const legacyWorkerAuditCountBefore = await db.projectActionAudit.count({ where: { actionId: { in: legacyNonterminalActionIds } } });
      assert.deepEqual(
        await runProjectActionWorkerCycle({ workerId: `dispatch-gate:${suffix}`, maximumActions: 1 }, db),
        { recoveredLeases: 0, expiredApprovals: 0, claimed: 0, succeeded: 0, failed: 0 },
      );
      assert.deepEqual(
        await db.projectAction.findMany({
          where: { id: { in: legacyNonterminalActionIds } },
          orderBy: { id: "asc" },
          select: { id: true, status: true, attemptCount: true, updatedAt: true },
        }),
        legacyWorkerStateBefore,
      );
      assert.equal(
        await db.projectActionAudit.count({ where: { actionId: { in: legacyNonterminalActionIds } } }),
        legacyWorkerAuditCountBefore,
      );
      await db.$transaction(async (tx) => {
        const remediated = await tx.$executeRaw(Prisma.sql`
          UPDATE "ProjectAction"
          SET "status" = 'failed'::"ProjectActionStatus",
              "failureCode" = 'ACTION_CAPABILITY_RETIRED',
              "leaseExpiresAt" = NULL,
              "completedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3),
              "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
          WHERE "id" = ${legacyRunningActionId}::uuid
            AND "status" = 'running'::"ProjectActionStatus"
        `);
        assert.equal(remediated, 1);
        await tx.projectActionAudit.create({ data: {
          projectId,
          actionId: legacyRunningActionId,
          event: "failed",
          details: { failureCode: "ACTION_CAPABILITY_RETIRED", reason: "CONTROLLED_TEST_REMEDIATION" },
        } });
      });
      const legacyCenter = await getProjectActionCenter(projectId, actor, {
        page: 1,
        pageSize: 20,
        capability: "project.mcp.read-tool.invoke",
      }, db);
      for (const actionId of [legacyActionId, legacyWaitingActionId, legacyQueuedActionId, legacyRunningActionId]) {
        const legacyProjection = legacyCenter.actions.find((entry) => entry.id === actionId);
        assert.ok(legacyProjection);
        assert.deepEqual(legacyProjection.input, {});
        assert.equal(legacyProjection.result, null);
        assert.equal(legacyProjection.resultImport, null);
      }
      assert.deepEqual(legacyCenter.importableActions, []);
      assert.equal(legacyCenter.canImportResults, false);
      const legacyWaiting = await db.projectAction.findUniqueOrThrow({ where: { id: legacyWaitingActionId }, select: { updatedAt: true } });
      await assert.rejects(
        () => decideProjectAction(projectId, legacyWaitingActionId, {
          decision: "rejected",
          expectedUpdatedAt: legacyWaiting.updatedAt.toISOString(),
          expectedFingerprint: legacyInputFingerprint,
        }, actor, db),
        (error: unknown) => error instanceof ActionEngineError && error.code === "ACTION_POLICY_DENIED",
      );
      const cancelledWaitingLegacy = await cancelProjectAction(projectId, legacyWaitingActionId, {
        expectedUpdatedAt: legacyWaiting.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(cancelledWaitingLegacy.status, "cancelled");
      assert.deepEqual(cancelledWaitingLegacy.input, {});
      assert.equal(cancelledWaitingLegacy.result, null);
      assert.equal(cancelledWaitingLegacy.resultImport, null);
      const legacyQueued = await db.projectAction.findUniqueOrThrow({ where: { id: legacyQueuedActionId }, select: { updatedAt: true } });
      const cancelledLegacy = await cancelProjectAction(projectId, legacyQueuedActionId, {
        expectedUpdatedAt: legacyQueued.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(cancelledLegacy.status, "cancelled");
      assert.deepEqual(cancelledLegacy.input, {});
      assert.equal(cancelledLegacy.result, null);
      assert.equal(cancelledLegacy.resultImport, null);
      await assert.rejects(
        () => importProjectActionResult(projectId, legacyActionId, {
          expectedUpdatedAt: new Date().toISOString(),
          expectedInputFingerprint: legacyInputFingerprint,
          expectedResultFingerprint: legacyResultFingerprint,
        }, actor, db),
        (error: unknown) => error instanceof ActionResultIntakeError
          && error.code === "ACTION_RESULT_INTAKE_NOT_IMPORTABLE",
      );
      await db.mcpConnection.create({ data: {
        id: connectionId,
        name: `dispatch connection ${suffix}`,
        endpointUrl: resolved.url,
        authKind: "none",
        credentialId: null,
        allowPrivateNetwork: true,
        resolvedAddressFingerprint: resolved.fingerprint,
        protocolVersion: "2026-07-28",
        catalogFingerprint: fingerprint("c"),
        credentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
        configurationRevision: 1,
        status: "verified",
        createdById: ownerId,
        ownerUserId: ownerId,
        ownerAccountAccessVersion: 1,
        ownershipState: "confirmed",
      } });
      await db.mcpToolDefinition.create({ data: {
        id: definitionId,
        connectionId,
        name: "project.lookup",
        title: "Lookup",
        description: "Safe lookup",
        inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" }, access_token: { type: "string" } }, required: ["ok"], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false },
        remoteReadOnlyHint: true,
        definitionFingerprint,
        current: true,
      } });
      const attestation = await createMcpControlPlaneAttestation(actor, {
        toolDefinitionId: definitionId,
        expectedConnectionConfigurationRevision: 1,
        expectedDefinitionFingerprint: definitionFingerprint,
        expectedNetworkFingerprint: resolved.fingerprint,
        expectedCredentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
        conclusion: "read_only_verified",
        riskLevel: "low",
        evidenceNote: "manual_read_only_review",
      }, db);
      // A positive-offset session must not advance UTC civil time and reject a
      // live one-hour delegation or the grant created from it.
      const draft = await proposeProjectMcpConnectionDelegation(projectId, { mcpConnectionId: connectionId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, actor, positiveTimeZoneDb);
      if (!("id" in draft)) throw new Error("PROJECT_MCP_ACTION_DISPATCH_GATE_DELEGATION_CREATE_FAILED");
      await confirmProjectMcpConnectionDelegationOwner(projectId, draft.id, { expectedVersion: 1, acknowledgeCredentialUse: true }, actor, positiveTimeZoneDb);
      const active = await confirmProjectMcpConnectionDelegationProject(projectId, draft.id, { expectedVersion: 2, acknowledgeProjectScope: true, acknowledgeDataEgress: true }, actor, positiveTimeZoneDb);
      if (!("id" in active)) throw new Error("PROJECT_MCP_ACTION_DISPATCH_GATE_DELEGATION_ACTIVATE_FAILED");
      const delegation = await db.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: active.id }, select: { id: true, version: true, proposedAt: true, expiresAt: true } });
      delegationId = delegation.id;
      delegationVersion = delegation.version;
      const grant = await createProjectMcpToolGrantV2(projectId, {
        delegationId,
        toolDefinitionId: definitionId,
        attestationId: attestation.id,
        expectedDelegationVersion: delegationVersion,
        expectedAttestationVersion: 1,
        acknowledgeReadOnly: true,
      }, actor, positiveTimeZoneDb);
      grantId = grant.grant.id as string;

      // A separate bearer-backed tuple is reserved for credential-rotation
      // testing so its deliberate drift cannot weaken the primary fixture.
      const bearerCredential = await createCredential("mcp", activeBearerToken, db);
      const bearerCredentialSnapshot = await db.externalCredential.findUniqueOrThrow({
        where: { id: bearerCredential.id },
        select: { secretFingerprint: true },
      });
      const bearerDefinitionFingerprint = fingerprint("b");
      await db.mcpConnection.create({ data: {
        id: bearerConnectionId,
        name: `dispatch bearer connection ${suffix}`,
        endpointUrl: resolved.url,
        authKind: "bearer",
        credentialId: bearerCredential.id,
        allowPrivateNetwork: true,
        resolvedAddressFingerprint: resolved.fingerprint,
        protocolVersion: "2026-07-28",
        catalogFingerprint: fingerprint("3"),
        credentialFingerprint: bearerCredentialSnapshot.secretFingerprint,
        configurationRevision: 1,
        status: "verified",
        createdById: ownerId,
        ownerUserId: ownerId,
        ownerAccountAccessVersion: 1,
        ownershipState: "confirmed",
      } });
      await db.mcpToolDefinition.create({ data: {
        id: bearerDefinitionId,
        connectionId: bearerConnectionId,
        name: "project.bearer.lookup",
        title: "Bearer lookup",
        description: "Credential rotation boundary fixture",
        inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: true },
        annotations: { readOnlyHint: true, destructiveHint: false },
        remoteReadOnlyHint: true,
        definitionFingerprint: bearerDefinitionFingerprint,
        current: true,
      } });
      const bearerAttestation = await createMcpControlPlaneAttestation(actor, {
        toolDefinitionId: bearerDefinitionId,
        expectedConnectionConfigurationRevision: 1,
        expectedDefinitionFingerprint: bearerDefinitionFingerprint,
        expectedNetworkFingerprint: resolved.fingerprint,
        expectedCredentialFingerprint: bearerCredentialSnapshot.secretFingerprint,
        conclusion: "read_only_verified",
        riskLevel: "low",
        evidenceNote: "manual_read_only_review",
      }, db);
      const bearerDraft = await proposeProjectMcpConnectionDelegation(projectId, {
        mcpConnectionId: bearerConnectionId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }, actor, db);
      if (!("id" in bearerDraft)) throw new Error("PROJECT_MCP_ACTION_DISPATCH_GATE_BEARER_DELEGATION_CREATE_FAILED");
      await confirmProjectMcpConnectionDelegationOwner(projectId, bearerDraft.id, {
        expectedVersion: 1,
        acknowledgeCredentialUse: true,
      }, actor, db);
      const activeBearerDelegation = await confirmProjectMcpConnectionDelegationProject(projectId, bearerDraft.id, {
        expectedVersion: 2,
        acknowledgeProjectScope: true,
        acknowledgeDataEgress: true,
      }, actor, db);
      if (!("id" in activeBearerDelegation)) throw new Error("PROJECT_MCP_ACTION_DISPATCH_GATE_BEARER_DELEGATION_ACTIVATE_FAILED");
      const bearerDelegation = await db.projectMcpConnectionDelegation.findUniqueOrThrow({
        where: { id: activeBearerDelegation.id },
        select: { id: true, version: true },
      });
      const bearerGrant = await createProjectMcpToolGrantV2(projectId, {
        delegationId: bearerDelegation.id,
        toolDefinitionId: bearerDefinitionId,
        attestationId: bearerAttestation.id,
        expectedDelegationVersion: bearerDelegation.version,
        expectedAttestationVersion: 1,
        acknowledgeReadOnly: true,
      }, actor, db);
      const bearerGrantId = bearerGrant.grant.id as string;

      // One reservation/request ID survives 20 concurrent API calls.
      const concurrent = await createApprovedAction("concurrent");
      serverState.mode = "success";
      const concurrentResults = await Promise.allSettled(Array.from({ length: 20 }, () => dispatchProjectMcpAction(projectId, concurrent.actionId, {
        expectedStateVersion: 2,
        expectedActionRevision: concurrent.actionRevision,
        acknowledgeSingleUse: true,
      }, dispatchActor, db)));
      assert.ok(concurrentResults.some((entry) => entry.status === "fulfilled"));
      assert.equal(serverState.postCount, 1);
      assert.equal(new Set(serverState.requestIds).size, 1);
      assert.equal(await db.projectMcpActionDispatchAttempt.count({ where: { actionId: concurrent.actionId } }), 1);
      assert.equal(await db.projectMcpActionRuntimeLedger.count({ where: { actionId: concurrent.actionId } }), 2);
      const concurrentAction = await db.projectMcpAction.findUniqueOrThrow({ where: { id: concurrent.actionId }, select: { status: true, stateVersion: true, actionFingerprint: true, transitionAt: true, transitionTransactionId: true, lastActorId: true, lastActorProjectMembershipId: true, lastActorMembershipCreatedAt: true } });
      assert.equal(concurrentAction.status, "succeeded");
      const concurrentAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { actionId: concurrent.actionId } });
      const concurrentRuntime = await db.projectMcpActionRuntimeLedger.findMany({ where: { actionId: concurrent.actionId }, orderBy: { stateVersion: "asc" } });
      assert.equal(concurrentAttempt.actorKind, "owner");
      assert.equal(concurrentAttempt.actorId, concurrentAction.lastActorId);
      assert.equal(concurrentAttempt.actorProjectMembershipId, concurrentAction.lastActorProjectMembershipId);
      assert.equal(concurrentAttempt.actorMembershipCreatedAt.getTime(), concurrentAction.lastActorMembershipCreatedAt.getTime());
      assert.equal(concurrentRuntime[0]?.event, "reserved");
      assert.equal(concurrentRuntime[0]?.statusBefore, "approved");
      assert.equal(concurrentRuntime[0]?.statusAfter, "dispatchReserved");
      assert.equal(concurrentRuntime[0]?.actorKind, "owner");
      assert.equal(concurrentRuntime[0]?.transactionId, concurrentAttempt.reservationTransactionId);
      assert.equal(concurrentRuntime[0]?.transitionAt.getTime(), concurrentAttempt.reservedAt.getTime());
      assert.equal(concurrentRuntime[1]?.transactionId, concurrentAction.transitionTransactionId);
      assert.equal(concurrentRuntime[1]?.transitionAt.getTime(), concurrentAction.transitionAt.getTime());
      const result = await db.projectMcpActionDispatchResult.findUniqueOrThrow({ where: { actionId: concurrent.actionId } });
      const digest = await db.$queryRaw<Array<{ fingerprint: string; bytes: number; nodes: number; depth: number }>>(Prisma.sql`
        SELECT encode(digest(convert_to("sanitizedPayload"::text, 'UTF8'), 'sha256'), 'hex') AS "fingerprint",
               octet_length(convert_to("sanitizedPayload"::text, 'UTF8')) AS "bytes",
               "resultNodes" AS "nodes", "resultDepth" AS "depth"
        FROM "ProjectMcpActionDispatchResult" WHERE "actionId" = ${concurrent.actionId}::uuid
      `);
      assert.equal(result.resultFingerprint, digest[0]?.fingerprint);
      assert.equal(result.resultBytes, digest[0]?.bytes);
      assert.equal(result.resultNodes, digest[0]?.nodes);
      assert.equal(result.resultDepth, digest[0]?.depth);
      assert.equal(concurrentAttempt.resultFingerprint, result.resultFingerprint);
      assert.equal(concurrentAttempt.resultBytes, result.resultBytes);
      assert.equal(concurrentAttempt.resultNodes, result.resultNodes);
      assert.equal(concurrentAttempt.resultDepth, result.resultDepth);
      assert.equal(concurrentRuntime[1]?.resultFingerprint, result.resultFingerprint);
      assert.equal(concurrentRuntime[1]?.resultBytes, result.resultBytes);
      assert.equal(concurrentRuntime[1]?.resultNodes, result.resultNodes);
      assert.equal(concurrentRuntime[1]?.resultDepth, result.resultDepth);
      assert.equal(await db.projectMcpActionDecision.count({ where: { actionId: concurrent.actionId, decision: "approved" } }), 1);
      assert.equal(await db.projectMcpActionLedger.count({ where: { actionId: concurrent.actionId, stateVersion: 2, event: "approved" } }), 1);
      assert.equal((await db.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`SELECT "project_mcp_action_evidence_valid"(source) AS "valid" FROM "ProjectMcpAction" AS source WHERE source."id" = ${concurrent.actionId}::uuid`))[0]?.valid, true);

      const replayPostCount = serverState.postCount;
      await dispatchProjectMcpAction(projectId, concurrent.actionId, { expectedStateVersion: 2, expectedActionRevision: concurrent.actionRevision, acknowledgeSingleUse: true }, dispatchActor, db);
      assert.equal(serverState.postCount, replayPostCount);

      // Client-side wrapper metrics must match the database JSONB walk exactly,
      // including null children and the 256-node acceptance boundary.
      for (const structuredContent of [
        null,
        {},
        { ok: true },
        [null, true],
        Array.from({ length: 252 }, () => null),
        JSON.parse('{"__proto__":{"safe":"persisted-prototype-metric-marker"}}'),
      ]) {
        const sanitized = sanitizeMcpToolResult({ text: null, structuredContent, omittedContentCount: 0 });
        const metrics = await db.$queryRaw<Array<{ nodes: number; depth: number }>>(Prisma.sql`
          SELECT "project_mcp_action_result_nodes"(${JSON.stringify(sanitized.payload)}::jsonb) AS "nodes",
                 "project_mcp_action_result_depth"(${JSON.stringify(sanitized.payload)}::jsonb) AS "depth"
        `);
        assert.equal(sanitized.resultNodes, metrics[0]?.nodes);
        assert.equal(sanitized.resultDepth, metrics[0]?.depth);
      }
      assert.throws(
        () => sanitizeMcpToolResult({ text: null, structuredContent: Array.from({ length: 253 }, () => null), omittedContentCount: 0 }),
        /MCP_RESPONSE_TOO_LARGE/u,
      );

      // A positive session offset must not make a live delegation appear
      // expired in the approval trigger or the final pre-egress boundary.
      serverState.mode = "success";
      const positiveTimeZone = await createApprovedAction("positive-time-zone");
      const positiveTimeZonePosts = serverState.postCount;
      await dispatchProjectMcpAction(projectId, positiveTimeZone.actionId, { expectedStateVersion: 2, expectedActionRevision: positiveTimeZone.actionRevision, acknowledgeSingleUse: true }, dispatchActor, positiveTimeZoneDb);
      assert.equal(serverState.postCount, positiveTimeZonePosts + 1);
      assert.equal((await db.projectMcpAction.findUniqueOrThrow({ where: { id: positiveTimeZone.actionId }, select: { status: true } })).status, "succeeded");

      // A negative session offset must not extend a reservation beyond its UTC
      // expiry. The test-only DB wrapper shortens the normal reservation and
      // pauses after phase-B, before the real boundary callback.
      const negativeTimeZone = await createApprovedAction("negative-time-zone-expiry");
      const shortExpiryDb = shortReservationDatabase(negativeTimeZoneDb, 250, 350);
      const negativeTimeZonePosts = serverState.postCount;
      await dispatchProjectMcpAction(projectId, negativeTimeZone.actionId, { expectedStateVersion: 2, expectedActionRevision: negativeTimeZone.actionRevision, acknowledgeSingleUse: true }, dispatchActor, shortExpiryDb);
      assert.equal(serverState.postCount, negativeTimeZonePosts);
      const negativeTimeZoneAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { actionId: negativeTimeZone.actionId } });
      assert.equal(negativeTimeZoneAttempt.boundaryReachedAt, null);
      assert.equal(negativeTimeZoneAttempt.status, "unknown");
      assert.equal(negativeTimeZoneAttempt.safeErrorCode, "MCP_DISPATCH_RESERVATION_STALE");

      // The compact client boundary remains persistable after JSONB
      // canonicalization; database metrics are derived from the stored value.
      serverState.mode = "large";
      const large = await createApprovedAction("large-result");
      await dispatchProjectMcpAction(projectId, large.actionId, { expectedStateVersion: 2, expectedActionRevision: large.actionRevision, acknowledgeSingleUse: true }, dispatchActor, db);
      const largeResult = await db.projectMcpActionDispatchResult.findUniqueOrThrow({ where: { actionId: large.actionId } });
      assert.ok(largeResult.resultBytes <= 64 * 1024);
      assert.ok(largeResult.resultBytes > 50 * 1024);
      assert.ok(largeResult.resultNodes >= 4);
      assert.ok(largeResult.resultDepth >= 2);
      assert.equal((await db.projectMcpAction.findUniqueOrThrow({ where: { id: large.actionId }, select: { status: true } })).status, "succeeded");

      // Credential-like result text and structured keys are removed before any
      // result, attempt, or runtime row is persisted.
      serverState.mode = "sensitive";
      const sensitive = await createApprovedAction("sensitive-result");
      await dispatchProjectMcpAction(projectId, sensitive.actionId, { expectedStateVersion: 2, expectedActionRevision: sensitive.actionRevision, acknowledgeSingleUse: true }, dispatchActor, db);
      const retainedMarkers = await db.$queryRaw<Array<{ resultLeak: boolean; attemptLeak: boolean; runtimeLeak: boolean }>>(Prisma.sql`
        SELECT
          EXISTS (
            SELECT 1 FROM "ProjectMcpActionDispatchResult"
            WHERE "actionId" = ${sensitive.actionId}::uuid
              AND "sanitizedPayload"::text ~ 'persisted-(bearer|basic|access|structured|obfuscated|quoted|standalone|token|unclosed|dangling|barecr|escaped|unicode|continuation|folded|html|prototype)-'
          ) AS "resultLeak",
          EXISTS (
            SELECT 1 FROM "ProjectMcpActionDispatchAttempt"
            WHERE "actionId" = ${sensitive.actionId}::uuid
              AND to_jsonb("ProjectMcpActionDispatchAttempt")::text ~ 'persisted-(bearer|basic|access|structured|obfuscated|quoted|standalone|token|unclosed|dangling|barecr|escaped|unicode|continuation|folded|html|prototype)-'
          ) AS "attemptLeak",
          EXISTS (
            SELECT 1 FROM "ProjectMcpActionRuntimeLedger"
            WHERE "actionId" = ${sensitive.actionId}::uuid
              AND to_jsonb("ProjectMcpActionRuntimeLedger")::text ~ 'persisted-(bearer|basic|access|structured|obfuscated|quoted|standalone|token|unclosed|dangling|barecr|escaped|unicode|continuation|folded|html|prototype)-'
          ) AS "runtimeLeak"
      `);
      assert.deepEqual(retainedMarkers[0], { resultLeak: false, attemptLeak: false, runtimeLeak: false });

      // Matching remote failure is terminal failed; replay remains local.
      serverState.mode = "rpcError";
      const failed = await createApprovedAction("matching-rpc-error");
      await dispatchProjectMcpAction(projectId, failed.actionId, { expectedStateVersion: 2, expectedActionRevision: failed.actionRevision, acknowledgeSingleUse: true }, dispatchActor, db);
      const failedAction = await db.projectMcpAction.findUniqueOrThrow({ where: { id: failed.actionId }, select: { status: true } });
      assert.equal(failedAction.status, "failed");
      assert.equal(await db.projectMcpActionDispatchAttempt.count({ where: { actionId: failed.actionId } }), 1);
      assert.equal(await db.projectMcpActionRuntimeLedger.count({ where: { actionId: failed.actionId } }), 2);
      const failedPostCount = serverState.postCount;
      await dispatchProjectMcpAction(projectId, failed.actionId, { expectedStateVersion: 2, expectedActionRevision: failed.actionRevision, acknowledgeSingleUse: true }, dispatchActor, db);
      assert.equal(serverState.postCount, failedPostCount);

      // Reset after the request boundary is unknown and never retried.
      serverState.mode = "reset";
      const unknown = await createApprovedAction("connection-reset");
      await dispatchProjectMcpAction(projectId, unknown.actionId, { expectedStateVersion: 2, expectedActionRevision: unknown.actionRevision, acknowledgeSingleUse: true }, dispatchActor, db);
      assert.equal((await db.projectMcpAction.findUniqueOrThrow({ where: { id: unknown.actionId }, select: { status: true } })).status, "unknown");
      assert.equal(await db.projectMcpActionDispatchAttempt.count({ where: { actionId: unknown.actionId } }), 1);

      // An atomic DB-clock boundary predicate that returns no row is stale,
      // not an ordinary client failure, and therefore sends no request.
      serverState.mode = "success";
      const boundaryStale = await createApprovedAction("boundary-stale");
      const boundaryDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return async (operation: unknown, options?: unknown) => {
            const invoke = target.$transaction.bind(target) as unknown as (
              callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
              transactionOptions?: unknown,
            ) => Promise<unknown>;
            return invoke(async (tx) => {
              const boundaryTx = new Proxy(tx, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
                  return async (query: unknown, ...values: unknown[]) => {
                    if (isDispatchBoundaryUpdate(query)) return [];
                    const queryRaw = txTarget.$queryRaw.bind(txTarget) as unknown as (
                      sql: unknown,
                      ...parameters: unknown[]
                    ) => Promise<unknown>;
                    return queryRaw(query, ...values);
                  };
                },
              }) as Prisma.TransactionClient;
              return (operation as (transaction: Prisma.TransactionClient) => Promise<unknown>)(boundaryTx);
            }, options);
          };
        },
      }) as typeof db;
      const boundaryPosts = serverState.postCount;
      await dispatchProjectMcpAction(projectId, boundaryStale.actionId, { expectedStateVersion: 2, expectedActionRevision: boundaryStale.actionRevision, acknowledgeSingleUse: true }, dispatchActor, boundaryDb);
      assert.equal(serverState.postCount, boundaryPosts);
      const boundaryStaleAction = await db.projectMcpAction.findUniqueOrThrow({ where: { id: boundaryStale.actionId }, select: { status: true } });
      assert.equal(boundaryStaleAction.status, "unknown");
      const boundaryStaleAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { actionId: boundaryStale.actionId } });
      assert.equal(boundaryStaleAttempt.status, "unknown");
      assert.equal(boundaryStaleAttempt.safeErrorCode, "MCP_DISPATCH_RESERVATION_STALE");

      // A source change between reservation and phase B revalidation is
      // invalidated before the client boundary, with zero external POSTs.
      serverState.mode = "success";
      const phaseB = await createApprovedAction("phase-b-network-drift");
      const preReservationDrift = await createApprovedAction("phase-a-grant-drift");
      const boundaryOwnerDrift = await createApprovedAction("boundary-owner-drift");
      const boundaryConnectionDrift = await createApprovedAction("boundary-connection-drift");

      // Disable the dispatching Owner only after phase-B commits. The final
      // boundary must revalidate the current actor epoch and send no POST.
      let disabledAfterPhaseB = false;
      const boundaryOwnerDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return async (operation: unknown, options?: unknown) => {
            const invoke = target.$transaction.bind(target) as unknown as (
              callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
              transactionOptions?: unknown,
            ) => Promise<unknown>;
            const result = await invoke(operation as (tx: Prisma.TransactionClient) => Promise<unknown>, options);
            if (!disabledAfterPhaseB && typeof result === "object" && result !== null && "kind" in result && result.kind === "ready") {
              await mutateApprovingOwnerAccess("disable", "dispatch boundary account disable", randomUUID());
              disabledAfterPhaseB = true;
            }
            return result;
          };
        },
      }) as typeof db;
      const boundaryOwnerPosts = serverState.postCount;
      try {
        await dispatchProjectMcpAction(projectId, boundaryOwnerDrift.actionId, { expectedStateVersion: 2, expectedActionRevision: boundaryOwnerDrift.actionRevision, acknowledgeSingleUse: true }, dispatchActor, boundaryOwnerDb);
      } finally {
        const account = await db.appUser.findUniqueOrThrow({ where: { id: approvingOwnerId }, select: { disabledAt: true } });
        if (account.disabledAt !== null) {
          const restoredApprovingOwner = await mutateApprovingOwnerAccess("restore", "dispatch boundary account restore", randomUUID());
          dispatchActor = { ...dispatchActor, accountAccessVersion: restoredApprovingOwner.accountAccessVersion };
        }
      }
      assert.equal(disabledAfterPhaseB, true);
      assert.equal(serverState.postCount, boundaryOwnerPosts);
      const boundaryOwnerAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { actionId: boundaryOwnerDrift.actionId } });
      assert.equal(boundaryOwnerAttempt.status, "unknown");
      assert.equal(boundaryOwnerAttempt.boundaryReachedAt, null);
      assert.equal(boundaryOwnerAttempt.safeErrorCode, "MCP_DISPATCH_RESERVATION_STALE");
      const boundaryOwnerTerminal = await db.projectMcpAction.findUniqueOrThrow({ where: { id: boundaryOwnerDrift.actionId }, select: { status: true, stateVersion: true } });
      const boundaryOwnerReplayPosts = serverState.postCount;
      const boundaryOwnerReplay = await dispatchProjectMcpAction(
        projectId,
        boundaryOwnerDrift.actionId,
        { expectedStateVersion: boundaryOwnerTerminal.stateVersion, expectedActionRevision: boundaryOwnerDrift.actionRevision, acknowledgeSingleUse: true },
        dispatchActor,
        db,
      );
      assert.equal(boundaryOwnerReplay.status, "unknown");
      assert.equal(serverState.postCount, boundaryOwnerReplayPosts);

      // Rotate a real bearer credential after phase-B has returned ready and
      // immediately before the boundary transaction. The final fence must
      // reject it before any secret read or external POST.
      const bearerProposal = await proposeProjectMcpAction(projectId, {
        clientRequestId: randomUUID(),
        grantId: bearerGrantId,
        expectedGrantVersion: 1,
        arguments: { query: "credential-boundary-drift" },
      }, actor, db);
      const bearerActionId = bearerProposal.action.id as string;
      const bearerActionRevision = bearerProposal.action.actionRevision as string;
      await decideProjectMcpAction(projectId, bearerActionId, {
        decision: "approved",
        expectedStateVersion: 1,
        expectedActionRevision: bearerActionRevision,
        acknowledgeSingleUse: true,
      }, dispatchActor, db);
      let bearerPhaseBReady = false;
      let bearerRotatedBeforeBoundary = false;
      let bearerSecretReadCount = 0;
      const trackCredentialReads = <T extends object>(delegate: T): T => new Proxy(delegate, {
        get(target, property, receiver) {
          if (property !== "findUnique") return Reflect.get(target, property, receiver);
          const findUnique = Reflect.get(target, property, receiver) as (...args: never[]) => Promise<unknown>;
          return (...args: never[]) => {
            bearerSecretReadCount += 1;
            return findUnique.apply(target, args);
          };
        },
      });
      const boundaryCredentialDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "externalCredential") return trackCredentialReads(target.externalCredential);
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return async (operation: unknown, options?: unknown) => {
            if (bearerPhaseBReady && !bearerRotatedBeforeBoundary) {
              await target.$transaction(async (tx) => {
                await rotateCredential(bearerCredential.id, "mcp", `dispatch-gate-rotated-${suffix}`, tx);
                const rotated = await tx.externalCredential.findUniqueOrThrow({
                  where: { id: bearerCredential.id },
                  select: { secretFingerprint: true },
                });
                await tx.mcpConnection.update({
                  where: { id: bearerConnectionId },
                  data: { credentialFingerprint: rotated.secretFingerprint },
                });
              });
              activeBearerToken = `dispatch-gate-rotated-${suffix}`;
              bearerRotatedBeforeBoundary = true;
            }
            const invoke = target.$transaction.bind(target) as unknown as (
              callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
              transactionOptions?: unknown,
            ) => Promise<unknown>;
            const result = await invoke(async (tx) => {
              const trackedTx = new Proxy(tx, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty === "externalCredential") return trackCredentialReads(txTarget.externalCredential);
                  return Reflect.get(txTarget, txProperty, txReceiver);
                },
              }) as Prisma.TransactionClient;
              return (operation as (transaction: Prisma.TransactionClient) => Promise<unknown>)(trackedTx);
            }, options);
            if (typeof result === "object" && result !== null && "kind" in result && result.kind === "ready") {
              bearerPhaseBReady = true;
            }
            return result;
          };
        },
      }) as typeof db;
      const bearerBoundaryPosts = serverState.postCount;
      await dispatchProjectMcpAction(projectId, bearerActionId, {
        expectedStateVersion: 2,
        expectedActionRevision: bearerActionRevision,
        acknowledgeSingleUse: true,
      }, dispatchActor, boundaryCredentialDb);
      assert.equal(bearerPhaseBReady, true);
      assert.equal(bearerRotatedBeforeBoundary, true);
      assert.equal(bearerSecretReadCount, 0);
      assert.equal(serverState.postCount, bearerBoundaryPosts);
      const bearerAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { actionId: bearerActionId } });
      assert.equal(bearerAttempt.status, "unknown");
      assert.equal(bearerAttempt.boundaryReachedAt, null);
      assert.equal(bearerAttempt.safeErrorCode, "MCP_DISPATCH_RESERVATION_STALE");
      assert.equal((await db.mcpConnection.findUniqueOrThrow({ where: { id: bearerConnectionId }, select: { configurationRevision: true } })).configurationRevision, 2);
      await revokeProjectMcpToolGrantV2(projectId, bearerGrantId, { expectedGrantVersion: 1 }, actor, db);
      await revokeProjectMcpConnectionDelegation(projectId, bearerDelegation.id, {
        expectedVersion: bearerDelegation.version,
        reason: "credential boundary gate cleanup",
      }, actor, db);

      // Create all remaining approved actions while the source tuple is still
      // valid. The later phase-B drift intentionally changes the connection
      // revision, so no new proposal may be attempted after that point.
      serverState.mode = "hold";
      serverState.hold = new Promise<void>((resolve) => { serverState.releaseHold = resolve; });
      const reserved = await createApprovedAction("archive-block");
      const heldPostCount = serverState.postCount;
      const heldRequestCount = serverState.requestIds.length;
      const heldDispatch = dispatchProjectMcpAction(projectId, reserved.actionId, { expectedStateVersion: 2, expectedActionRevision: reserved.actionRevision, acknowledgeSingleUse: true }, dispatchActor, db);
      inFlight = heldDispatch;
      void heldDispatch.catch(() => undefined);
      const heldRequestId = await waitFor(
        async () => serverState.requestIds.length > heldRequestCount
          ? serverState.requestIds[heldRequestCount] ?? null
          : null,
        () => true,
      );
      const heldAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { actionId: reserved.actionId } });
      const heldAction = await db.projectMcpAction.findUniqueOrThrow({ where: { id: reserved.actionId }, select: { status: true } });
      assert.equal(heldAction.status, "dispatchReserved");
      assert.equal(heldAttempt.status, "reserved");
      assert.ok(heldAttempt.boundaryReachedAt !== null);
      assert.notEqual(heldAttempt.boundaryReachedAt?.getTime(), 0);
      assert.equal(heldRequestId, heldAttempt.rpcRequestId);
      assert.equal(serverState.postCount, heldPostCount + 1);
      assert.equal(serverState.requestIds.length, heldRequestCount + 1);
      assert.equal(await reconcileStaleProjectMcpActionDispatchReservations(positiveTimeZoneDb), 0);
      for (const mutate of [
        () => db.$executeRaw(Prisma.sql`UPDATE "ProjectMcpActionDispatchAttempt" SET "safeErrorCode" = 'forged' WHERE "id" = ${heldAttempt.id}::uuid`),
        () => db.$executeRaw(Prisma.sql`UPDATE "ProjectMcpActionDispatchAttempt" SET "httpStatus" = 599 WHERE "id" = ${heldAttempt.id}::uuid`),
        () => db.$executeRaw(Prisma.sql`UPDATE "ProjectMcpActionDispatchAttempt" SET "completedAt" = CURRENT_TIMESTAMP WHERE "id" = ${heldAttempt.id}::uuid`),
        () => db.$executeRaw(Prisma.sql`UPDATE "ProjectMcpActionDispatchAttempt" SET "resultFingerprint" = repeat('a', 64) WHERE "id" = ${heldAttempt.id}::uuid`),
        () => db.$executeRaw(Prisma.sql`UPDATE "ProjectMcpActionDispatchAttempt" SET "resultBytes" = 1 WHERE "id" = ${heldAttempt.id}::uuid`),
        () => db.$executeRaw(Prisma.sql`UPDATE "ProjectMcpActionDispatchAttempt" SET "resultNodes" = 1 WHERE "id" = ${heldAttempt.id}::uuid`),
        () => db.$executeRaw(Prisma.sql`UPDATE "ProjectMcpActionDispatchAttempt" SET "resultDepth" = 1 WHERE "id" = ${heldAttempt.id}::uuid`),
      ]) {
        await assert.rejects(mutate, /PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_STATE_INVALID/u);
      }
      await assert.rejects(() => db.$executeRaw(Prisma.sql`
        UPDATE "ProjectMcpActionDispatchAttempt" SET "boundaryReachedAt" = NULL WHERE "id" = ${heldAttempt.id}::uuid
      `), /PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_IMMUTABLE/u);
      await assert.rejects(() => db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } }), /PROJECT_MCP_ACTION_PENDING_ARCHIVE_FORBIDDEN/u);
      await assert.rejects(() => db.project.delete({ where: { id: projectId } }), /PROJECT_MCP_ACTION_PENDING/u);
      serverState.releaseHold?.();
      serverState.releaseHold = null;
      await heldDispatch;
      inFlight = null;
      assert.equal(serverState.postCount, heldPostCount + 1);
      projectCascadeActionId = reserved.actionId;
      serverState.mode = "success";
      const staleProposal = await createApprovedAction("stale-recovery");
      const staleAttemptId = randomUUID();
      const staleRpcId = randomUUID();
      // Build the stale reservation while the grant/source tuple is valid.
      // The worker must later close it without re-running Owner admission.
      await db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ProjectMcpAction"
          SET "status" = 'dispatch_reserved'::"ProjectMcpActionStatus", "stateVersion" = 3
          WHERE "id" = ${staleProposal.actionId}::uuid AND "projectId" = ${projectId}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectMcpActionDispatchAttempt" (
            "id", "projectId", "actionId", "actorKind", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt", "rpcRequestId", "reservationTokenHash", "status",
            "actionFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "connectionConfigurationRevision", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "reservationTransactionId", "reservationExpiresAt", "reservedAt", "createdAt"
          )
          SELECT ${staleAttemptId}::uuid, source."projectId", source."id", 'owner'::"ProjectMcpActionRuntimeActorKind", source."lastActorId", source."lastActorProjectMembershipId", source."lastActorMembershipCreatedAt", ${staleRpcId}::uuid, repeat('f', 64), 'reserved'::"ProjectMcpActionDispatchAttemptStatus",
            source."actionFingerprint", source."definitionFingerprint", source."networkFingerprint", source."credentialFingerprint", source."connectionConfigurationRevision", source."connectionOwnerId", source."connectionOwnerAccountAccessVersion", source."transitionTransactionId", source."transitionAt" + interval '200 milliseconds', source."transitionAt", source."transitionAt"
          FROM "ProjectMcpAction" AS source WHERE source."id" = ${staleProposal.actionId}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectMcpActionRuntimeLedger" (
            "id", "projectId", "actionId", "attemptId", "rpcRequestId", "actorKind", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt", "event", "statusBefore", "statusAfter", "stateVersion",
            "actionFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "connectionConfigurationRevision", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "transactionId", "transitionAt", "createdAt"
          )
          SELECT gen_random_uuid(), source."projectId", source."id", ${staleAttemptId}::uuid, ${staleRpcId}::uuid, 'system_recovery'::"ProjectMcpActionRuntimeActorKind", source."lastActorId", source."lastActorProjectMembershipId", source."lastActorMembershipCreatedAt", 'reserved'::"ProjectMcpActionRuntimeLedgerEvent", 'approved'::"ProjectMcpActionStatus", 'dispatch_reserved'::"ProjectMcpActionStatus", 3,
            source."actionFingerprint", source."definitionFingerprint", source."networkFingerprint", source."credentialFingerprint", source."connectionConfigurationRevision", source."connectionOwnerId", source."connectionOwnerAccountAccessVersion", 0, TIMESTAMP 'epoch', TIMESTAMP 'epoch'
          FROM "ProjectMcpAction" AS source WHERE source."id" = ${staleProposal.actionId}::uuid
        `);
      });
      await assert.rejects(
        () => db.$transaction(async (tx) => {
          await tx.projectMcpAction.update({
            where: { id: staleProposal.actionId },
            data: { status: "succeeded", stateVersion: { increment: 1 } },
          });
          await tx.projectMcpActionDispatchAttempt.update({
            where: { id: staleAttemptId },
            data: { status: "succeeded", safeErrorCode: null, completedAt: new Date(0) },
          });
        }),
        /PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_STATE_INVALID/u,
      );
      let phaseATransactions = 0;
      const phaseBDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return async (operation: unknown, options?: unknown) => {
            phaseATransactions += 1;
            const invoke = target.$transaction.bind(target) as unknown as (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, transactionOptions?: unknown) => Promise<unknown>;
            const result = await invoke(operation as (tx: Prisma.TransactionClient) => Promise<unknown>, options);
            if (phaseATransactions === 1 && typeof result === "object" && result !== null && "kind" in result && result.kind === "reserved") {
              await target.mcpToolDefinition.update({ where: { id: definitionId }, data: { current: false, supersededAt: new Date() } });
            }
            return result;
          };
        },
      }) as typeof db;
      const postBeforePhaseB = serverState.postCount;
      try {
        await dispatchProjectMcpAction(projectId, phaseB.actionId, { expectedStateVersion: 2, expectedActionRevision: phaseB.actionRevision, acknowledgeSingleUse: true }, dispatchActor, phaseBDb);
      } finally {
        await db.mcpToolDefinition.update({ where: { id: definitionId }, data: { current: true, supersededAt: null } });
      }
      assert.equal(serverState.postCount, postBeforePhaseB);
      assert.equal((await db.projectMcpAction.findUniqueOrThrow({ where: { id: phaseB.actionId }, select: { status: true } })).status, "invalidated");
      assert.equal(await db.projectMcpActionDispatchAttempt.count({ where: { actionId: phaseB.actionId } }), 1);

      // Direct result deletion is rejected, while terminal action deletion
      // removes the payload and retains scalar attempt/runtime evidence.
      await assert.rejects(() => db.projectMcpActionDispatchResult.delete({ where: { actionId: concurrent.actionId } }), /PROJECT_MCP_ACTION_DISPATCH_RESULT_IMMUTABLE/u);
      const evidenceBeforeActionDelete = await db.projectMcpActionRuntimeLedger.count({ where: { actionId: concurrent.actionId } });
      await db.projectMcpAction.delete({ where: { id: concurrent.actionId } });
      assert.equal(await db.projectMcpActionDispatchResult.count({ where: { actionId: concurrent.actionId } }), 0);
      assert.equal(await db.projectMcpActionRuntimeLedger.count({ where: { actionId: concurrent.actionId } }), evidenceBeforeActionDelete);

      // The restricted recovery path does not consult the Owner and preserves
      // the original owner epoch as subject evidence.
      await mutateApprovingOwnerAccess("disable", "dispatch stale recovery account disable", randomUUID());
      await delay(250);
      const stalePosts = serverState.postCount;
      assert.equal(await reconcileStaleProjectMcpActionDispatchReservations(negativeTimeZoneDb), 1);
      assert.equal(serverState.postCount, stalePosts);
      const staleAction = await db.projectMcpAction.findUniqueOrThrow({ where: { id: staleProposal.actionId }, select: { status: true, stateVersion: true, lastActorId: true, lastActorProjectMembershipId: true, lastActorMembershipCreatedAt: true } });
      const staleAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { id: staleAttemptId } });
      const staleRuntime = await db.projectMcpActionRuntimeLedger.findMany({ where: { actionId: staleProposal.actionId }, orderBy: { stateVersion: "asc" } });
      assert.equal(staleAction.status, "unknown");
      assert.equal(staleAction.stateVersion, 4);
      assert.equal(staleAttempt.status, "unknown");
      assert.equal(staleAttempt.actorKind, "owner");
      assert.equal(staleRuntime[0]?.actorKind, "owner");
      assert.equal(staleRuntime[1]?.actorKind, "systemRecovery");
      assert.equal(staleRuntime[1]?.safeErrorCode, "MCP_DISPATCH_RESERVATION_STALE");
      assert.equal(staleRuntime[1]?.actorId, staleAction.lastActorId);
      assert.equal(staleRuntime[1]?.actorProjectMembershipId, staleAction.lastActorProjectMembershipId);
      assert.equal(staleRuntime[1]?.actorMembershipCreatedAt.getTime(), staleAction.lastActorMembershipCreatedAt.getTime());
      const recoverySetting = await db.$queryRaw<Array<{ value: string | null }>>(Prisma.sql`SELECT current_setting('ai_project_os.mcp_dispatch_recovery', true) AS "value"`);
      assert.equal(recoverySetting[0]?.value ?? null, null);
      const restoredAfterStaleRecovery = await mutateApprovingOwnerAccess("restore", "dispatch stale recovery account restore", randomUUID());
      dispatchActor = { ...dispatchActor, accountAccessVersion: restoredAfterStaleRecovery.accountAccessVersion };
      const staleReplayPosts = serverState.postCount;
      const staleReplay = await dispatchProjectMcpAction(
        projectId,
        staleProposal.actionId,
        { expectedStateVersion: staleAction.stateVersion, expectedActionRevision: staleProposal.actionRevision, acknowledgeSingleUse: true },
        dispatchActor,
        db,
      );
      assert.equal(staleReplay.status, "unknown");
      assert.equal(serverState.postCount, staleReplayPosts);

      // Raw SQL cannot forge a second attempt or append inconsistent runtime evidence.
      const retainedAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { actionId: projectCascadeActionId } });
      await assert.rejects(() => db.projectMcpActionDispatchAttempt.update({ where: { id: retainedAttempt.id }, data: { actorKind: "systemRecovery" } }), /PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_IMMUTABLE/u);
      await assert.rejects(() => db.$executeRaw(Prisma.sql`
        INSERT INTO "ProjectMcpActionDispatchAttempt" ("id", "projectId", "actionId", "actorKind", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt", "rpcRequestId", "reservationTokenHash", "status", "actionFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "connectionConfigurationRevision", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "reservationTransactionId", "reservationExpiresAt", "reservedAt", "createdAt")
        SELECT gen_random_uuid(), "projectId", "actionId", 'owner'::"ProjectMcpActionRuntimeActorKind", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt", gen_random_uuid(), "reservationTokenHash", 'reserved'::"ProjectMcpActionDispatchAttemptStatus", "actionFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "connectionConfigurationRevision", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "reservationTransactionId", "reservationExpiresAt", "reservedAt", "createdAt"
        FROM "ProjectMcpActionDispatchAttempt" WHERE "actionId" = ${projectCascadeActionId}::uuid
      `), /PROJECT_MCP_ACTION_DISPATCH_ATTEMPT_(INVALID|STATE_INVALID)/u);
      const terminalRuntime = await db.projectMcpActionRuntimeLedger.findFirstOrThrow({ where: { actionId: projectCascadeActionId, stateVersion: 4 } });
      const terminalRuntimeStatusBefore = terminalRuntime.statusBefore === "dispatchReserved" ? "dispatch_reserved" : terminalRuntime.statusBefore;
      const terminalRuntimeStatusAfter = terminalRuntime.statusAfter === "dispatchReserved" ? "dispatch_reserved" : terminalRuntime.statusAfter;
      await assert.rejects(() => db.$executeRaw(Prisma.sql`
        INSERT INTO "ProjectMcpActionRuntimeLedger" ("id", "projectId", "actionId", "attemptId", "rpcRequestId", "actorKind", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt", "event", "statusBefore", "statusAfter", "stateVersion", "actionFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "connectionConfigurationRevision", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "transactionId", "transitionAt", "createdAt")
        VALUES (gen_random_uuid(), ${terminalRuntime.projectId}::uuid, ${terminalRuntime.actionId}::uuid, ${terminalRuntime.attemptId}::uuid, ${terminalRuntime.rpcRequestId}::uuid, 'system_recovery'::"ProjectMcpActionRuntimeActorKind", ${terminalRuntime.actorId}::uuid, ${terminalRuntime.actorProjectMembershipId}::uuid, ${terminalRuntime.actorMembershipCreatedAt}, ${terminalRuntime.event}::"ProjectMcpActionRuntimeLedgerEvent", ${terminalRuntimeStatusBefore}::"ProjectMcpActionStatus", ${terminalRuntimeStatusAfter}::"ProjectMcpActionStatus", 99, ${terminalRuntime.actionFingerprint}, ${terminalRuntime.definitionFingerprint}, ${terminalRuntime.networkFingerprint}, ${terminalRuntime.credentialFingerprint}, ${terminalRuntime.connectionConfigurationRevision}, ${terminalRuntime.connectionOwnerId}::uuid, ${terminalRuntime.connectionOwnerAccountAccessVersion}, ${terminalRuntime.transactionId}, ${terminalRuntime.transitionAt}, ${terminalRuntime.createdAt})
      `), /PROJECT_MCP_ACTION_RUNTIME_LEDGER_INVALID/u);

      // A historical live row whose UTC expiry is already past must remain
      // ineligible in a negative-offset session. The service and the database
      // V2 tuple predicate must both fail closed for the same reason.
      const expiredDelegationAt = new Date(Math.max(delegation.proposedAt.getTime() + 1, Date.now() - 1_000));
      assert.ok(expiredDelegationAt < new Date());
      const setDelegationExpiryFixture = async (expiresAt: Date) => {
        await negativeTimeZoneDb.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
          await tx.$executeRaw(Prisma.sql`
            UPDATE "ProjectMcpConnectionDelegation"
            SET "expiresAt" = ${expiresAt}
            WHERE "id" = ${delegationId}::uuid
          `);
        });
      };
      await setDelegationExpiryFixture(expiredDelegationAt);
      try {
        const tupleValidity = await negativeTimeZoneDb.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
          SELECT "project_mcp_tool_grant_v2_tuple_valid"(grant_row) AS "valid"
          FROM "ProjectMcpToolGrant" AS grant_row
          WHERE grant_row."id" = ${grantId}::uuid
        `);
        assert.equal(tupleValidity[0]?.valid, false);
        await assert.rejects(
          () => createProjectMcpToolGrantV2(projectId, {
            delegationId,
            toolDefinitionId: definitionId,
            attestationId: attestation.id,
            expectedDelegationVersion: delegationVersion,
            expectedAttestationVersion: 1,
            acknowledgeReadOnly: true,
          }, actor, negativeTimeZoneDb),
          (error: unknown) => error instanceof ProjectMcpToolGrantServiceError && error.code === "PROJECT_MCP_TOOL_GRANT_STALE",
        );
      } finally {
        await setDelegationExpiryFixture(delegation.expiresAt);
      }

      // Disable the source connection only after phase-B returns ready. The
      // final pre-egress boundary must observe the drift and send no POST.
      let connectionDisabledAfterPhaseB = false;
      const boundaryConnectionDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return async (operation: unknown, options?: unknown) => {
            const invoke = target.$transaction.bind(target) as unknown as (
              callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
              transactionOptions?: unknown,
            ) => Promise<unknown>;
            const result = await invoke(operation as (tx: Prisma.TransactionClient) => Promise<unknown>, options);
            if (!connectionDisabledAfterPhaseB && typeof result === "object" && result !== null && "kind" in result && result.kind === "ready") {
              await target.mcpConnection.update({ where: { id: connectionId }, data: { status: "disabled", disabledAt: new Date() } });
              connectionDisabledAfterPhaseB = true;
            }
            return result;
          };
        },
      }) as typeof db;
      const boundaryConnectionPosts = serverState.postCount;
      await dispatchProjectMcpAction(projectId, boundaryConnectionDrift.actionId, { expectedStateVersion: 2, expectedActionRevision: boundaryConnectionDrift.actionRevision, acknowledgeSingleUse: true }, dispatchActor, boundaryConnectionDb);
      assert.equal(connectionDisabledAfterPhaseB, true);
      assert.equal(serverState.postCount, boundaryConnectionPosts);
      const boundaryConnectionAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { actionId: boundaryConnectionDrift.actionId } });
      assert.equal(boundaryConnectionAttempt.status, "unknown");
      assert.equal(boundaryConnectionAttempt.boundaryReachedAt, null);
      assert.equal(boundaryConnectionAttempt.safeErrorCode, "MCP_DISPATCH_RESERVATION_STALE");

      await revokeProjectMcpToolGrantV2(projectId, grantId, { expectedGrantVersion: 1 }, actor, db);
      const driftPostCount = serverState.postCount;
      await dispatchProjectMcpAction(projectId, preReservationDrift.actionId, { expectedStateVersion: 2, expectedActionRevision: preReservationDrift.actionRevision, acknowledgeSingleUse: true }, dispatchActor, db);
      assert.equal(serverState.postCount, driftPostCount);
      assert.equal((await db.projectMcpAction.findUniqueOrThrow({ where: { id: preReservationDrift.actionId }, select: { status: true, stateVersion: true } })).status, "invalidated");
      assert.equal(await db.projectMcpActionDispatchAttempt.count({ where: { actionId: preReservationDrift.actionId } }), 0);

      // A connection owner's account epoch is part of every personal MCP
      // capability chain.  Maintenance operations keep the root epoch, while
      // an explicit bearer-token rotation rebinds it to the current epoch.
      const assertMcpError = (code: string) => (error: unknown) => error instanceof McpCapabilityError && error.code === code;
      const createEpochProject = async (epochProjectId: string, label: string) => {
        await db.project.create({
          data: {
            id: epochProjectId,
            workspaceId,
            name: `dispatch epoch ${label} ${suffix}`,
            slug: `dispatch-epoch-${label}-${suffix}-${epochProjectId.slice(0, 6)}`,
          },
        });
        await db.$transaction(async (tx) => {
          await grantProjectMembership(tx, { projectId: epochProjectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: `dispatch_epoch_${label}_owner` });
          await grantProjectMembership(tx, { projectId: epochProjectId, workspaceId, userId: approvingOwnerId, role: "owner", actorId: ownerId, reason: `dispatch_epoch_${label}_approver` });
        });
      };
      const createEpochChain = async (epochProjectId: string, root: {
        configurationRevision: number;
        resolvedAddressFingerprint: string;
        credentialFingerprint: string;
        ownerAccountAccessVersion: number;
      }, definition: { id: string; name: string; definitionFingerprint: string }) => {
        const attestation = await createMcpControlPlaneAttestation(actor, {
          toolDefinitionId: definition.id,
          expectedConnectionConfigurationRevision: root.configurationRevision,
          expectedDefinitionFingerprint: definition.definitionFingerprint,
          expectedNetworkFingerprint: root.resolvedAddressFingerprint,
          expectedCredentialFingerprint: root.credentialFingerprint,
          conclusion: "read_only_verified",
          riskLevel: "low",
          evidenceNote: "manual_read_only_review",
        }, db);
        const draft = await proposeProjectMcpConnectionDelegation(epochProjectId, {
          mcpConnectionId: bearerConnectionId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }, actor, db);
        if (!("id" in draft)) throw new Error("PROJECT_MCP_ACTION_DISPATCH_GATE_EPOCH_DELEGATION_CREATE_FAILED");
        await confirmProjectMcpConnectionDelegationOwner(epochProjectId, draft.id, {
          expectedVersion: 1,
          acknowledgeCredentialUse: true,
        }, actor, db);
        const active = await confirmProjectMcpConnectionDelegationProject(epochProjectId, draft.id, {
          expectedVersion: 2,
          acknowledgeProjectScope: true,
          acknowledgeDataEgress: true,
        }, actor, db);
        if (!("id" in active)) throw new Error("PROJECT_MCP_ACTION_DISPATCH_GATE_EPOCH_DELEGATION_ACTIVATE_FAILED");
        const delegation = await db.projectMcpConnectionDelegation.findUniqueOrThrow({
          where: { id: active.id },
          select: {
            id: true,
            version: true,
            connectionOwnerId: true,
            connectionOwnerAccountAccessVersion: true,
          },
        });
        const grant = await createProjectMcpToolGrantV2(epochProjectId, {
          delegationId: delegation.id,
          toolDefinitionId: definition.id,
          attestationId: attestation.id,
          expectedDelegationVersion: delegation.version,
          expectedAttestationVersion: 1,
          acknowledgeReadOnly: true,
        }, actor, db);
        const actionProposal = await proposeProjectMcpAction(epochProjectId, {
          clientRequestId: randomUUID(),
          grantId: grant.grant.id,
          expectedGrantVersion: 1,
          arguments: { query: "epoch-chain" },
        }, actor, db);
        const actionId = actionProposal.action.id as string;
        const actionRevision = actionProposal.action.actionRevision as string;
        const approval = await decideProjectMcpAction(epochProjectId, actionId, {
          decision: "approved",
          expectedStateVersion: 1,
          expectedActionRevision: actionRevision,
          acknowledgeSingleUse: true,
        }, dispatchActor, db);
        assert.equal(approval.created, true);
        const action = await db.projectMcpAction.findUniqueOrThrow({
          where: { id: actionId },
          select: {
            id: true,
            connectionOwnerId: true,
            connectionOwnerAccountAccessVersion: true,
            delegationId: true,
            grantId: true,
            attestationId: true,
            toolDefinitionId: true,
            connectionId: true,
            actionFingerprint: true,
            stateVersion: true,
            status: true,
          },
        });
        assert.equal(action.connectionOwnerId, ownerId);
        assert.equal(action.connectionOwnerAccountAccessVersion, root.ownerAccountAccessVersion);
        assert.equal(delegation.connectionOwnerId, ownerId);
        assert.equal(delegation.connectionOwnerAccountAccessVersion, root.ownerAccountAccessVersion);
        return { attestation, delegation, grantId: grant.grant.id as string, actionId, actionRevision, action };
      };

      const initialBearerRoot = await db.mcpConnection.findUniqueOrThrow({
        where: { id: bearerConnectionId },
        select: {
          ownerUserId: true,
          ownerAccountAccessVersion: true,
          configurationRevision: true,
          resolvedAddressFingerprint: true,
          credentialFingerprint: true,
          updatedAt: true,
          status: true,
        },
      });
      const initialOwnerEpoch = await db.appUser.findUniqueOrThrow({ where: { id: ownerId }, select: { accountAccessVersion: true, disabledAt: true } });
      assert.equal(initialOwnerEpoch.disabledAt, null);
      assert.equal(initialBearerRoot.ownerUserId, ownerId);
      assert.equal(initialBearerRoot.ownerAccountAccessVersion, initialOwnerEpoch.accountAccessVersion);
      const frozenRootEpoch = initialBearerRoot.ownerAccountAccessVersion;
      assert.ok(frozenRootEpoch !== null);

      const renamedRoot = await updateMcpConnection(bearerConnectionId, {
        name: `dispatch bearer epoch maintenance ${suffix}`,
        expectedUpdatedAt: initialBearerRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(renamedRoot.ownerAccountAccessVersion, frozenRootEpoch);
      const networkTestedRoot = await updateMcpConnection(bearerConnectionId, {
        trustCurrentNetwork: true,
        expectedUpdatedAt: renamedRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(networkTestedRoot.ownerAccountAccessVersion, frozenRootEpoch);
      const disabledRoot = await updateMcpConnection(bearerConnectionId, {
        enabled: false,
        expectedUpdatedAt: networkTestedRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(disabledRoot.ownerAccountAccessVersion, frozenRootEpoch);
      const enabledRoot = await updateMcpConnection(bearerConnectionId, {
        enabled: true,
        expectedUpdatedAt: disabledRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(enabledRoot.ownerAccountAccessVersion, frozenRootEpoch);
      const discoveredBeforeRotation = await discoverMcpConnectionTools(bearerConnectionId, {
        expectedUpdatedAt: enabledRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(discoveredBeforeRotation.discoveredCount, 1);
      assert.equal(discoveredBeforeRotation.connection.ownerAccountAccessVersion, frozenRootEpoch);
      const bearerRoot = await db.mcpConnection.findUniqueOrThrow({
        where: { id: bearerConnectionId },
        select: {
          ownerUserId: true,
          ownerAccountAccessVersion: true,
          configurationRevision: true,
          resolvedAddressFingerprint: true,
          credentialFingerprint: true,
          updatedAt: true,
          status: true,
        },
      });
      assert.equal(bearerRoot.ownerAccountAccessVersion, frozenRootEpoch);
      assert.equal(bearerRoot.status, "verified");
      assert.ok(bearerRoot.resolvedAddressFingerprint !== null);
      assert.ok(bearerRoot.credentialFingerprint !== null);
      const oldDefinition = await db.mcpToolDefinition.findFirstOrThrow({
        where: { connectionId: bearerConnectionId, current: true },
        select: { id: true, name: true, definitionFingerprint: true, remoteReadOnlyHint: true },
      });
      assert.equal(oldDefinition.remoteReadOnlyHint, true);
      const oldEpochProjectId = randomUUID();
      await createEpochProject(oldEpochProjectId, "old");
      const oldEpochChain = await createEpochChain(oldEpochProjectId, {
        configurationRevision: bearerRoot.configurationRevision,
        resolvedAddressFingerprint: bearerRoot.resolvedAddressFingerprint,
        credentialFingerprint: bearerRoot.credentialFingerprint,
        ownerAccountAccessVersion: frozenRootEpoch,
      }, oldDefinition);
      const oldChainRows = await Promise.all([
        db.mcpConnection.findUniqueOrThrow({ where: { id: bearerConnectionId }, select: { ownerAccountAccessVersion: true } }),
        db.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: oldEpochChain.delegation.id }, select: { connectionOwnerId: true, connectionOwnerAccountAccessVersion: true } }),
        db.mcpToolAttestation.findUniqueOrThrow({ where: { id: oldEpochChain.attestation.id }, select: { connectionOwnerAccountAccessVersion: true } }),
        db.projectMcpToolGrant.findUniqueOrThrow({ where: { id: oldEpochChain.grantId }, select: { connectionOwnerAccountAccessVersion: true } }),
        db.projectMcpAction.findUniqueOrThrow({ where: { id: oldEpochChain.actionId }, select: { connectionOwnerId: true, connectionOwnerAccountAccessVersion: true, status: true, stateVersion: true } }),
      ]);
      assert.equal(oldChainRows[0].ownerAccountAccessVersion, frozenRootEpoch);
      assert.equal(oldChainRows[1].connectionOwnerId, ownerId);
      assert.equal(oldChainRows[1].connectionOwnerAccountAccessVersion, frozenRootEpoch);
      assert.equal(oldChainRows[2].connectionOwnerAccountAccessVersion, frozenRootEpoch);
      assert.equal(oldChainRows[3].connectionOwnerAccountAccessVersion, frozenRootEpoch);
      assert.equal(oldChainRows[4].connectionOwnerId, ownerId);
      assert.equal(oldChainRows[4].connectionOwnerAccountAccessVersion, frozenRootEpoch);
      assert.equal(oldChainRows[4].status, "approved");
      assert.equal(oldChainRows[4].stateVersion, 2);
      const oldChainEvidence = await Promise.all([
        db.projectMcpConnectionDelegationAudit.findMany({ where: { delegationId: oldEpochChain.delegation.id }, select: { connectionOwnerAccountAccessVersion: true } }),
        db.mcpToolAttestationAudit.findMany({ where: { attestationId: oldEpochChain.attestation.id }, select: { connectionOwnerAccountAccessVersion: true } }),
        db.projectMcpToolGrantLedger.findMany({ where: { grantId: oldEpochChain.grantId }, select: { connectionOwnerId: true, connectionOwnerAccountAccessVersion: true } }),
        db.projectMcpToolGrantAudit.findMany({ where: { grantId: oldEpochChain.grantId }, select: { connectionOwnerAccountAccessVersion: true } }),
        db.projectMcpActionLedger.findMany({ where: { actionId: oldEpochChain.actionId }, select: { connectionOwnerId: true, connectionOwnerAccountAccessVersion: true } }),
      ]);
      for (const evidenceRows of oldChainEvidence) {
        assert.ok(evidenceRows.length > 0);
        for (const evidence of evidenceRows) {
          assert.equal(evidence.connectionOwnerAccountAccessVersion, frozenRootEpoch);
          if ("connectionOwnerId" in evidence) assert.equal(evidence.connectionOwnerId, ownerId);
        }
      }

      const disabledOwner = await mutateConnectionOwnerAccess("disable", "dispatch epoch invalidation disable", randomUUID());
      assert.equal(disabledOwner.accountAccessVersion, frozenRootEpoch + 1);
      const restoredOwner = await mutateConnectionOwnerAccess("restore", "dispatch epoch invalidation restore", randomUUID());
      assert.equal(restoredOwner.accountAccessVersion, frozenRootEpoch + 2);
      actor = { ...actor, accountAccessVersion: restoredOwner.accountAccessVersion };
      const restoredOwnerRow = await db.appUser.findUniqueOrThrow({ where: { id: ownerId }, select: { disabledAt: true, accountAccessVersion: true } });
      assert.equal(restoredOwnerRow.disabledAt, null);
      assert.equal(restoredOwnerRow.accountAccessVersion, frozenRootEpoch + 2);
      const postRestoreChainRows = await Promise.all([
        db.mcpConnection.findUniqueOrThrow({ where: { id: bearerConnectionId }, select: { ownerAccountAccessVersion: true } }),
        db.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: oldEpochChain.delegation.id }, select: { connectionOwnerId: true, connectionOwnerAccountAccessVersion: true } }),
        db.mcpToolAttestation.findUniqueOrThrow({ where: { id: oldEpochChain.attestation.id }, select: { connectionOwnerAccountAccessVersion: true } }),
        db.projectMcpToolGrant.findUniqueOrThrow({ where: { id: oldEpochChain.grantId }, select: { connectionOwnerAccountAccessVersion: true } }),
        db.projectMcpAction.findUniqueOrThrow({ where: { id: oldEpochChain.actionId }, select: { connectionOwnerId: true, connectionOwnerAccountAccessVersion: true, status: true, stateVersion: true } }),
      ]);
      for (const row of postRestoreChainRows) {
        if ("connectionOwnerAccountAccessVersion" in row) assert.equal(row.connectionOwnerAccountAccessVersion, frozenRootEpoch);
        if ("ownerAccountAccessVersion" in row) assert.equal(row.ownerAccountAccessVersion, frozenRootEpoch);
      }
      const staleDiscoveryCount = serverState.discoveryCount;
      await assert.rejects(
        () => discoverMcpConnectionTools(bearerConnectionId, { expectedUpdatedAt: bearerRoot.updatedAt.toISOString() }, actor, db),
        assertMcpError("MCP_CONNECTION_NOT_VERIFIED"),
      );
      assert.equal(serverState.discoveryCount, staleDiscoveryCount);
      await assert.rejects(
        () => updateMcpConnection(bearerConnectionId, { name: `dispatch stale rename ${suffix}`, expectedUpdatedAt: bearerRoot.updatedAt.toISOString() }, actor, db),
        assertMcpError("MCP_CONNECTION_NOT_VERIFIED"),
      );
      await assert.rejects(
        () => createMcpControlPlaneAttestation(actor, {
          toolDefinitionId: oldDefinition.id,
          expectedConnectionConfigurationRevision: bearerRoot.configurationRevision,
          expectedDefinitionFingerprint: oldDefinition.definitionFingerprint,
          expectedNetworkFingerprint: bearerRoot.resolvedAddressFingerprint,
          expectedCredentialFingerprint: bearerRoot.credentialFingerprint,
          conclusion: "read_only_verified",
          riskLevel: "low",
          evidenceNote: "manual_read_only_review",
        }, db),
        assertMcpError("MCP_CONNECTION_NOT_VERIFIED"),
      );
      await assert.rejects(
        () => proposeProjectMcpConnectionDelegation(oldEpochProjectId, {
          mcpConnectionId: bearerConnectionId,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }, actor, db),
        /PROJECT_MCP_CONNECTION_DELEGATION_CONNECTION_UNAVAILABLE/u,
      );
      await assert.rejects(
        () => createProjectMcpToolGrantV2(oldEpochProjectId, {
          delegationId: oldEpochChain.delegation.id,
          toolDefinitionId: oldDefinition.id,
          attestationId: oldEpochChain.attestation.id,
          expectedDelegationVersion: oldEpochChain.delegation.version,
          expectedAttestationVersion: 1,
          acknowledgeReadOnly: true,
        }, actor, db),
        /PROJECT_MCP_TOOL_GRANT_STALE/u,
      );
      await assert.rejects(
        () => proposeProjectMcpAction(oldEpochProjectId, {
          clientRequestId: randomUUID(),
          grantId: oldEpochChain.grantId,
          expectedGrantVersion: 1,
          arguments: { query: "stale-epoch" },
        }, actor, db),
        /PROJECT_MCP_ACTION_STALE/u,
      );
      const oldReplayPosts = serverState.postCount;
      const oldReplay = await dispatchProjectMcpAction(oldEpochProjectId, oldEpochChain.actionId, {
        expectedStateVersion: 2,
        expectedActionRevision: oldEpochChain.actionRevision,
        acknowledgeSingleUse: true,
      }, dispatchActor, db);
      assert.equal(serverState.postCount, oldReplayPosts);
      assert.equal(oldReplay.status, "invalidated");
      const invalidatedOldAction = await db.projectMcpAction.findUniqueOrThrow({ where: { id: oldEpochChain.actionId }, select: { status: true, stateVersion: true, connectionOwnerAccountAccessVersion: true } });
      assert.equal(invalidatedOldAction.status, "invalidated");
      assert.equal(invalidatedOldAction.stateVersion, 3);
      assert.equal(invalidatedOldAction.connectionOwnerAccountAccessVersion, frozenRootEpoch);
      const oldRuntimeRows = await db.projectMcpActionRuntimeLedger.findMany({ where: { actionId: oldEpochChain.actionId }, select: { connectionOwnerId: true, connectionOwnerAccountAccessVersion: true } });
      assert.equal(oldRuntimeRows.length, 1);
      assert.equal(oldRuntimeRows[0]?.connectionOwnerId, ownerId);
      assert.equal(oldRuntimeRows[0]?.connectionOwnerAccountAccessVersion, frozenRootEpoch);

      // Only the explicit credential/token rotation may rebind the root to
      // the restored account epoch.  Re-discovery then establishes a new
      // definition snapshot for the new credential fingerprint.
      const rotatedBearerToken = `dispatch-gate-epoch-rotated-${suffix}`;
      activeBearerToken = rotatedBearerToken;
      const rotatedRoot = await updateMcpConnection(bearerConnectionId, {
        bearerToken: rotatedBearerToken,
        expectedUpdatedAt: bearerRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(rotatedRoot.ownerAccountAccessVersion, restoredOwner.accountAccessVersion);
      assert.notEqual(rotatedRoot.ownerAccountAccessVersion, frozenRootEpoch);
      const discoveredAfterRotation = await discoverMcpConnectionTools(bearerConnectionId, {
        expectedUpdatedAt: rotatedRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(discoveredAfterRotation.discoveredCount, 1);
      assert.equal(discoveredAfterRotation.connection.ownerAccountAccessVersion, restoredOwner.accountAccessVersion);
      const postRotationRenamedRoot = await updateMcpConnection(bearerConnectionId, {
        name: `dispatch bearer epoch rebound ${suffix}`,
        expectedUpdatedAt: discoveredAfterRotation.connection.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(postRotationRenamedRoot.ownerAccountAccessVersion, restoredOwner.accountAccessVersion);
      const postRotationNetworkTestedRoot = await updateMcpConnection(bearerConnectionId, {
        trustCurrentNetwork: true,
        expectedUpdatedAt: postRotationRenamedRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(postRotationNetworkTestedRoot.ownerAccountAccessVersion, restoredOwner.accountAccessVersion);
      const postRotationDisabledRoot = await updateMcpConnection(bearerConnectionId, {
        enabled: false,
        expectedUpdatedAt: postRotationNetworkTestedRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(postRotationDisabledRoot.ownerAccountAccessVersion, restoredOwner.accountAccessVersion);
      const postRotationEnabledRoot = await updateMcpConnection(bearerConnectionId, {
        enabled: true,
        expectedUpdatedAt: postRotationDisabledRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(postRotationEnabledRoot.ownerAccountAccessVersion, restoredOwner.accountAccessVersion);
      const reboundDiscovery = await discoverMcpConnectionTools(bearerConnectionId, {
        expectedUpdatedAt: postRotationEnabledRoot.updatedAt.toISOString(),
      }, actor, db);
      assert.equal(reboundDiscovery.discoveredCount, 1);
      assert.equal(reboundDiscovery.connection.ownerAccountAccessVersion, restoredOwner.accountAccessVersion);
      const reboundRoot = await db.mcpConnection.findUniqueOrThrow({
        where: { id: bearerConnectionId },
        select: {
          ownerUserId: true,
          ownerAccountAccessVersion: true,
          configurationRevision: true,
          resolvedAddressFingerprint: true,
          credentialFingerprint: true,
          updatedAt: true,
          status: true,
        },
      });
      assert.equal(reboundRoot.ownerUserId, ownerId);
      assert.equal(reboundRoot.ownerAccountAccessVersion, restoredOwner.accountAccessVersion);
      assert.equal(reboundRoot.status, "verified");
      const reboundDefinition = await db.mcpToolDefinition.findFirstOrThrow({
        where: { connectionId: bearerConnectionId, current: true },
        select: { id: true, name: true, definitionFingerprint: true, remoteReadOnlyHint: true },
      });
      assert.equal(reboundDefinition.remoteReadOnlyHint, true);
      const newEpochProjectId = randomUUID();
      await createEpochProject(newEpochProjectId, "new");
      const newEpochChain = await createEpochChain(newEpochProjectId, {
        configurationRevision: reboundRoot.configurationRevision,
        resolvedAddressFingerprint: reboundRoot.resolvedAddressFingerprint!,
        credentialFingerprint: reboundRoot.credentialFingerprint!,
        ownerAccountAccessVersion: restoredOwner.accountAccessVersion,
      }, reboundDefinition);
      assert.equal(newEpochChain.action.status, "approved");
      assert.equal(newEpochChain.action.stateVersion, 2);

      // Database-owned guards reject forged root, delegation, and action
      // epochs. A delegation-only update is rejected by its existing shape
      // guard before the deferred epoch guard can observe the drift.
      await assert.rejects(() => db.$executeRaw(Prisma.sql`
        UPDATE "McpConnection"
        SET "ownerAccountAccessVersion" = ${restoredOwner.accountAccessVersion + 1}
        WHERE "id" = ${bearerConnectionId}::uuid
      `), /PERSONAL_MCP_ACCOUNT_EPOCH_/u);
      await assert.rejects(() => db.$executeRaw(Prisma.sql`
        UPDATE "ProjectMcpConnectionDelegation"
        SET "connectionOwnerAccountAccessVersion" = ${restoredOwner.accountAccessVersion + 1}
        WHERE "id" = ${newEpochChain.delegation.id}::uuid
      `), /(?:PERSONAL_MCP_ACCOUNT_EPOCH_|PROJECT_MCP_CONNECTION_DELEGATION_VERSION_INVALID)/u);
      await assert.rejects(() => db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ProjectMcpAction"
          SET "status" = 'cancelled'::"ProjectMcpActionStatus",
              "stateVersion" = 3,
              "approvedAt" = TIMESTAMP '2001-01-01 00:00:00',
              "approvalExpiresAt" = TIMESTAMP '2001-01-01 00:15:00',
              "rejectedAt" = TIMESTAMP '2001-01-01 00:30:00',
              "cancelledAt" = TIMESTAMP '2001-01-01 00:45:00',
              "connectionOwnerAccountAccessVersion" = ${restoredOwner.accountAccessVersion + 1}
          WHERE "id" = ${newEpochChain.actionId}::uuid
            AND "projectId" = ${newEpochProjectId}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectMcpActionLedger" (
            "id", "projectId", "actionId", "clientRequestId", "grantId", "delegationId", "toolDefinitionId", "attestationId", "connectionId", "connectionOwnerId", "toolName",
            "event", "statusBefore", "statusAfter", "stateVersion", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt",
            "grantVersion", "delegationVersion", "attestationVersion", "delegationFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
            "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "canonicalArgumentsHash", "actionFingerprint", "transactionId", "transitionAt", "createdAt"
          )
          SELECT gen_random_uuid(), source."projectId", source."id", source."clientRequestId", source."grantId", source."delegationId", source."toolDefinitionId", source."attestationId", source."connectionId", source."connectionOwnerId", source."toolName",
            'cancelled'::"ProjectMcpActionLedgerEvent", 'approved'::"ProjectMcpActionStatus", source."status", source."stateVersion", source."lastActorId", source."lastActorProjectMembershipId", source."lastActorMembershipCreatedAt",
            source."grantVersion", source."delegationVersion", source."attestationVersion", source."delegationFingerprint", source."definitionFingerprint", source."networkFingerprint", source."credentialFingerprint",
            source."connectionConfigurationRevision", source."connectionOwnerAccountAccessVersion", source."canonicalArgumentsHash", source."actionFingerprint", 0, TIMESTAMP 'epoch', TIMESTAMP 'epoch'
          FROM "ProjectMcpAction" AS source
          WHERE source."id" = ${newEpochChain.actionId}::uuid AND source."projectId" = ${newEpochProjectId}::uuid
        `);
      }), /PERSONAL_MCP_ACCOUNT_EPOCH_/u);
      const newDispatchPosts = serverState.postCount;
      const newDispatch = await dispatchProjectMcpAction(newEpochProjectId, newEpochChain.actionId, {
        expectedStateVersion: 2,
        expectedActionRevision: newEpochChain.actionRevision,
        acknowledgeSingleUse: true,
      }, dispatchActor, db);
      assert.equal(newDispatch.status, "succeeded");
      assert.equal(serverState.postCount, newDispatchPosts + 1);
      const newDispatchAction = await db.projectMcpAction.findUniqueOrThrow({ where: { id: newEpochChain.actionId }, select: { connectionOwnerAccountAccessVersion: true, status: true, stateVersion: true } });
      assert.equal(newDispatchAction.connectionOwnerAccountAccessVersion, restoredOwner.accountAccessVersion);
      assert.equal(newDispatchAction.status, "succeeded");
      assert.equal(newDispatchAction.stateVersion, 4);
      const newDispatchAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { actionId: newEpochChain.actionId }, select: { connectionOwnerId: true, connectionOwnerAccountAccessVersion: true } });
      assert.equal(newDispatchAttempt.connectionOwnerId, ownerId);
      assert.equal(newDispatchAttempt.connectionOwnerAccountAccessVersion, restoredOwner.accountAccessVersion);
      const newRuntimeRows = await db.projectMcpActionRuntimeLedger.findMany({ where: { actionId: newEpochChain.actionId }, select: { connectionOwnerId: true, connectionOwnerAccountAccessVersion: true } });
      assert.equal(newRuntimeRows.length, 2);
      for (const runtime of newRuntimeRows) {
        assert.equal(runtime.connectionOwnerId, ownerId);
        assert.equal(runtime.connectionOwnerAccountAccessVersion, restoredOwner.accountAccessVersion);
      }

      // When the boundary transaction commits first, the owner mutation is
      // intentionally linearized after that commit and the already-authorized
      // request may write exactly one body.  The subsequent restore advances
      // the epoch again; no old root is implicitly revived by that restore.
      const boundaryFirstProjectId = randomUUID();
      await createEpochProject(boundaryFirstProjectId, "boundary-first");
      const boundaryFirstChain = await createEpochChain(boundaryFirstProjectId, {
        configurationRevision: reboundRoot.configurationRevision,
        resolvedAddressFingerprint: reboundRoot.resolvedAddressFingerprint!,
        credentialFingerprint: reboundRoot.credentialFingerprint!,
        ownerAccountAccessVersion: restoredOwner.accountAccessVersion,
      }, reboundDefinition);
      let boundaryFirstCommitted = false;
      const boundaryFirstDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return async (operation: unknown, options?: unknown) => {
            const invoke = target.$transaction.bind(target) as unknown as (
              callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
              transactionOptions?: unknown,
            ) => Promise<unknown>;
            let boundaryUpdated = false;
            const result = await invoke(async (tx) => {
              const proxied = new Proxy(tx, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty !== "$queryRaw") return Reflect.get(txTarget, txProperty, txReceiver);
                  const queryRaw = txTarget.$queryRaw.bind(txTarget) as unknown as (query: unknown, ...values: unknown[]) => Promise<unknown>;
                  return async (query: unknown, ...values: unknown[]) => {
                    const rows = await queryRaw(query, ...values);
                    if (isDispatchBoundaryUpdate(query) && Array.isArray(rows) && rows.length === 1) boundaryUpdated = true;
                    return rows;
                  };
                },
              }) as Prisma.TransactionClient;
              return (operation as (transaction: Prisma.TransactionClient) => Promise<unknown>)(proxied);
            }, options);
            if (boundaryUpdated && !boundaryFirstCommitted) {
              await mutateConnectionOwnerAccess("disable", "dispatch epoch boundary-first disable", randomUUID());
              boundaryFirstCommitted = true;
            }
            return result;
          };
        },
      }) as typeof db;
      const boundaryFirstPosts = serverState.postCount;
      const boundaryFirstDispatch = await dispatchProjectMcpAction(boundaryFirstProjectId, boundaryFirstChain.actionId, {
        expectedStateVersion: 2,
        expectedActionRevision: boundaryFirstChain.actionRevision,
        acknowledgeSingleUse: true,
      }, dispatchActor, boundaryFirstDb);
      assert.equal(boundaryFirstCommitted, true);
      assert.equal(boundaryFirstDispatch.status, "succeeded");
      assert.equal(serverState.postCount, boundaryFirstPosts + 1);
      const boundaryFirstAttempt = await db.projectMcpActionDispatchAttempt.findUniqueOrThrow({ where: { actionId: boundaryFirstChain.actionId } });
      assert.ok(boundaryFirstAttempt.boundaryReachedAt !== null);
      assert.equal(boundaryFirstAttempt.status, "succeeded");
      assert.equal(boundaryFirstAttempt.connectionOwnerId, ownerId);
      assert.equal(boundaryFirstAttempt.connectionOwnerAccountAccessVersion, restoredOwner.accountAccessVersion);
      const restoredAfterBoundaryFirst = await mutateConnectionOwnerAccess("restore", "dispatch epoch boundary-first restore", randomUUID());
      assert.equal(restoredAfterBoundaryFirst.accountAccessVersion, restoredOwner.accountAccessVersion + 2);
      actor = { ...actor, accountAccessVersion: restoredAfterBoundaryFirst.accountAccessVersion };
      assert.equal((await db.appUser.findUniqueOrThrow({ where: { id: ownerId }, select: { disabledAt: true, accountAccessVersion: true } })).disabledAt, null);

      retainedAttemptCount = await db.projectMcpActionDispatchAttempt.count({ where: { projectId } });
      retainedRuntimeCount = await db.projectMcpActionRuntimeLedger.count({ where: { projectId } });
      await revokeProjectMcpConnectionDelegation(projectId, delegationId, { expectedVersion: delegationVersion, reason: "dispatch gate cleanup" }, actor, db);
      const archived = await db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      const projectName = (await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } })).name;
      await deleteArchivedProject({ projectId, actor, confirmationName: projectName, expectedUpdatedAt: archived.updatedAt }, db);
      assert.equal(await db.projectMcpAction.count({ where: { projectId } }), 0);
      assert.equal(await db.projectMcpActionDispatchResult.count({ where: { projectId } }), 0);
      assert.equal(await db.projectMcpActionDispatchAttempt.count({ where: { projectId } }), retainedAttemptCount);
      assert.equal(await db.projectMcpActionRuntimeLedger.count({ where: { projectId } }), retainedRuntimeCount);
    } finally {
      serverState.releaseHold?.();
      await inFlight?.catch(() => undefined);
      await close(server).catch(() => undefined);
      await positiveTimeZoneDb.$disconnect();
      await negativeTimeZoneDb.$disconnect();
      await db.$disconnect();
      if (previousMasterKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousMasterKeyPath;
      await rm(keyDirectory, { recursive: true, force: true });
    }
  },
);
