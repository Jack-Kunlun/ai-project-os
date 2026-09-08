import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { mapApiError } from "../src/lib/api-errors";
import { createProjectMcpToolGrantV2, ProjectMcpToolGrantServiceError, listProjectMcpToolGrantsV2 } from "../src/lib/project-mcp-tool-grant-service";
import { sanitizeMcpAttestationJson } from "../src/lib/mcp-attestation-control-plane-service";

const projectId = "00000000-0000-4000-8000-000000000001";
const grantId = "00000000-0000-4000-8000-000000000002";

test("V2 project MCP grant routes use strict, no-store control-plane boundaries", async () => {
  const [collection, legacy, revocation, service] = await Promise.all([
    readFile("src/app/api/projects/[projectId]/mcp-tool-grants/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/mcp-tool-grants/[grantId]/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/mcp-tool-grants/[grantId]/revocation/route.ts", "utf8"),
    readFile("src/lib/project-mcp-tool-grant-service.ts", "utf8"),
  ]);
  assert.match(collection, /listProjectMcpToolGrantsV2/u);
  assert.match(collection, /createProjectMcpToolGrantV2/u);
  assert.match(collection, /assertSameOrigin\(request\)/u);
  assert.match(collection, /created \? 201 : 200/u);
  assert.match(collection, /cache-control.*no-store/u);
  assert.match(revocation, /revokeProjectMcpToolGrantV2/u);
  assert.match(revocation, /assertSameOrigin\(request\)/u);
  assert.doesNotMatch(revocation, /assertProjectActive/u);
  assert.match(legacy, /MCP_LEGACY_PROJECT_RUNTIME_FROZEN/u);
  assert.match(legacy, /idSchema\.parse\(params\.projectId\)/u);
  assert.match(legacy, /idSchema\.parse\(params\.grantId\)/u);
  assert.doesNotMatch(legacy, /readJsonBody|revokeProjectMcpToolGrant|assertProjectActive/u);
  assert.match(service, /expectedDelegationVersion: VERSION/u);
  assert.match(service, /expectedAttestationVersion: z\.literal\(1\)/u);
  assert.match(service, /acknowledgeReadOnly: z\.literal\(true\)/u);
  assert.match(service, /\.strict\(\)/u);
  assert.match(service, /TransactionIsolationLevel\.Serializable/u);
  assert.match(service, /32010000/u);
  assert.match(service, /32010002/u);
  assert.match(service, /32010003/u);
  assert.match(service, /32010007/u);
  assert.doesNotMatch(service, /callMcpTool|readCredentialSecret|executeMcpActionSnapshot/u);
  const projection = service.slice(service.indexOf("function projectGrant"), service.indexOf("type FullDelegation"));
  assert.doesNotMatch(projection, /fingerprint|connectionId|audit|ledger|transaction|membership|terminalReason/u);
});

test("V2 candidate slots include active legacy grants while keeping legacy rows out of projection", async () => {
  const service = await readFile("src/lib/project-mcp-tool-grant-service.ts", "utf8");
  const listBody = service.slice(service.indexOf("export async function listProjectMcpToolGrantsV2"), service.indexOf("export async function createProjectMcpToolGrantV2"));
  const activeSlotsQuery = listBody.slice(listBody.indexOf("const activeSlots"), listBody.indexOf("const activeSlotKeys"));
  assert.match(activeSlotsQuery, /where: \{ projectId, status: "active" \}/u);
  assert.doesNotMatch(activeSlotsQuery, /controlPlaneVersion/u);
  const projectedRowsQuery = listBody.slice(listBody.indexOf("const rows"), listBody.indexOf("if \(project\.archivedAt"));
  assert.match(projectedRowsQuery, /controlPlaneVersion: 2/u);
});

test("V2 create admits the target Owner before reading caller-supplied resource ids", async () => {
  const service = await readFile("src/lib/project-mcp-tool-grant-service.ts", "utf8");
  const createBody = service.slice(service.indexOf("export async function createProjectMcpToolGrantV2"), service.indexOf("export async function revokeProjectMcpToolGrantV2"));
  const preflightIndex = createBody.indexOf("const preflight = await withSerializableRetry");
  const mutationIndex = createBody.indexOf("return withSerializableRetry", preflightIndex + 1);
  assert.ok(preflightIndex >= 0 && mutationIndex > preflightIndex);
  const beforePreflight = createBody.slice(0, preflightIndex);
  assert.doesNotMatch(beforePreflight, /findUnique\(|findFirst\(|lockConnection|lockTuple|lockGrantSlot|lockGrantRow/u);
  const preflight = createBody.slice(preflightIndex, mutationIndex);
  assert.match(preflight, /await lockAdmission\(tx, projectId, \[actorId\]\)/u);
  assert.match(preflight, /await requireActorAndProject\(tx, projectId, actorId, false, actor\.accountAccessVersion\)/u);
  assert.match(preflight, /where: \{ id: parsed\.data\.delegationId, projectId, status: "active" \}/u);
  assert.match(preflight, /connectionId: delegation\.mcpConnectionId/u);
  assert.match(preflight, /controlPlaneVersion: 2,[\s\S]*connectionId: delegation\.mcpConnectionId/u);
  const mutation = createBody.slice(mutationIndex);
  assert.match(mutation, /preflight\.connectionOwnerId[\s\S]*preflight\.projectConfirmedById[\s\S]*preflight\.attestationVerifierId/u);
  assert.match(mutation, /preflight\.connectionId[\s\S]*preflight\.toolDefinitionId/u);
  assert.match(mutation, /where: \{ id: preflight\.delegationId, projectId, status: "active" \}/u);
  assert.match(mutation, /where: \{ id: preflight\.toolDefinitionId, connectionId: liveSeed\.mcpConnectionId \}/u);
  assert.match(mutation, /controlPlaneVersion: 2,[\s\S]*connectionId: liveSeed\.mcpConnectionId/u);
});

test("V2 create rejects a non-owner before touching external resource repositories", async () => {
  const calls: string[] = [];
  const actorId = "00000000-0000-4000-8000-000000000003";
  const workspaceId = "00000000-0000-4000-8000-000000000004";
  const membershipId = "00000000-0000-4000-8000-000000000005";
  const db = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({
      $executeRaw: async () => 0,
      project: { findUnique: async () => ({ id: projectId, workspaceId, archivedAt: null }) },
      appUser: { findUnique: async () => ({ id: actorId, disabledAt: null, accountAccessVersion: 1 }) },
      projectMembership: { findFirst: async () => ({ id: membershipId, userId: actorId, role: "editor", createdAt: new Date("2026-01-01T00:00:00.000Z") }) },
      projectMcpConnectionDelegation: { findFirst: async () => { calls.push("delegation"); return null; } },
      mcpToolDefinition: { findFirst: async () => { calls.push("definition"); return null; } },
      mcpToolAttestation: { findFirst: async () => { calls.push("attestation"); return null; } },
    }),
  } as unknown as PrismaClient;
  await assert.rejects(
    () => createProjectMcpToolGrantV2(projectId, {
      delegationId: grantId,
      toolDefinitionId: "00000000-0000-4000-8000-000000000006",
      attestationId: "00000000-0000-4000-8000-000000000007",
      expectedDelegationVersion: 1,
      expectedAttestationVersion: 1,
      acknowledgeReadOnly: true,
    }, { id: actorId, role: "member", accountAccessVersion: 1 }, db),
    (error: unknown) => error instanceof ProjectMcpToolGrantServiceError && error.code === "PROJECT_MCP_TOOL_GRANT_PROJECT_OWNER_REQUIRED",
  );
  assert.deepEqual(calls, []);
});

test("V2 revoke admits the target project before scoped grant lookup and resource locks", async () => {
  const service = await readFile("src/lib/project-mcp-tool-grant-service.ts", "utf8");
  const revokeBody = service.slice(service.indexOf("export async function revokeProjectMcpToolGrantV2"));
  assert.doesNotMatch(revokeBody.slice(0, revokeBody.indexOf("return withSerializableRetry")), /findUnique\(|findFirst\(/u);
  const transactionBody = revokeBody.slice(revokeBody.indexOf("return withSerializableRetry"));
  const admissionIndex = transactionBody.indexOf("await lockAdmission(tx, projectId, [actorId]);");
  const ownerAdmissionIndex = transactionBody.indexOf("await requireActorAndProject(tx, projectId, actorId, true, actor.accountAccessVersion);");
  const scopedLookupIndex = transactionBody.indexOf("where: { id: grantId, projectId, controlPlaneVersion: 2 }");
  const resourceLockIndex = transactionBody.indexOf("scopedSeed.connectionId, scopedSeed.toolDefinitionId");
  assert.ok(admissionIndex >= 0 && ownerAdmissionIndex > admissionIndex);
  assert.ok(scopedLookupIndex > ownerAdmissionIndex);
  assert.ok(resourceLockIndex > scopedLookupIndex);
  assert.match(service, /WHERE "id".*AND "projectId".*AND "controlPlaneVersion" = 2 FOR UPDATE/u);
});

test("V2 project MCP grant projection sanitizes hostile tool metadata", () => {
  const input = JSON.parse(JSON.stringify({
    type: "object",
    properties: {
      safe: { type: "string", description: "safe" },
      "https://private.example.invalid/mcp": { type: "string" },
      __proto__: { leaked: true },
      constructor: { leaked: true },
      token: { default: "secret" },
    },
  }));
  Object.defineProperty(input.properties, "__proto__", { value: { leaked: true }, enumerable: true });
  const output = sanitizeMcpAttestationJson(input);
  const serialized = JSON.stringify(output);
  assert.match(serialized, /safe/u);
  assert.doesNotMatch(serialized, /private\.example|leaked|secret|token/u);
  assert.equal(Object.getPrototypeOf(output), null);
  const properties = (output as { properties: Record<string, unknown> }).properties;
  assert.equal(Object.getPrototypeOf(properties), null);
  assert.equal("__proto__" in properties, false);
  assert.equal("https://private.example.invalid/mcp" in properties, false);
});

test("V2 project MCP grant list admits only a current direct project Owner", async () => {
  const noDb = {
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({ project: { findUnique: async () => null } }),
  } as unknown as PrismaClient;
  await assert.rejects(
    () => listProjectMcpToolGrantsV2(projectId, { id: grantId, role: "admin" }, noDb),
    (error: unknown) => error instanceof ProjectMcpToolGrantServiceError && error.code === "PROJECT_MCP_TOOL_GRANT_FORBIDDEN",
  );
});

test("V2 project MCP grant errors have stable API mappings", () => {
  const mapped = mapApiError(new ProjectMcpToolGrantServiceError("PROJECT_MCP_TOOL_GRANT_STALE"));
  assert.equal(mapped.status, 409);
  assert.equal(mapped.body.error.code, "PROJECT_MCP_TOOL_GRANT_STALE");
});
