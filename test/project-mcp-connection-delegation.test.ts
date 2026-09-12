import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { POSTGRES_GATES } from "../scripts/postgres-gate-contract";
import {
  ProjectMcpConnectionDelegationServiceError,
  proposeProjectMcpConnectionDelegation,
} from "../src/lib/project-mcp-connection-delegation-service";

const readSource = (path: string): string => readFileSync(path, "utf8");
const service = readSource("src/lib/project-mcp-connection-delegation-service.ts");
const accessControl = readSource("src/lib/access-control.ts");
const mcpService = readSource("src/lib/mcp/service.ts");
const mcpErrors = readSource("src/lib/mcp/errors.ts");
const apiErrors = readSource("src/lib/api-errors.ts");

const projectRouteFiles = [
  "src/app/api/projects/[projectId]/mcp-connection-delegations/route.ts",
  "src/app/api/projects/[projectId]/mcp-connection-delegations/[delegationId]/route.ts",
  "src/app/api/projects/[projectId]/mcp-connection-delegations/[delegationId]/owner-confirmation/route.ts",
  "src/app/api/projects/[projectId]/mcp-connection-delegations/[delegationId]/project-confirmation/route.ts",
  "src/app/api/projects/[projectId]/mcp-connection-delegations/[delegationId]/rejection/route.ts",
  "src/app/api/projects/[projectId]/mcp-connection-delegations/[delegationId]/revocation/route.ts",
];

test("MCP connection delegation service validates strict proposal input before database access", async () => {
  const actor = { id: "11111111-1111-4111-8111-111111111111", role: "user" as const };
  await assert.rejects(
    () => proposeProjectMcpConnectionDelegation(
      "22222222-2222-4222-8222-222222222222",
      { mcpConnectionId: "33333333-3333-4333-8333-333333333333", expiresAt: "not-utc" },
      actor,
      {} as never,
    ),
    (error: unknown) => error instanceof ProjectMcpConnectionDelegationServiceError
      && error.code === "PROJECT_MCP_CONNECTION_DELEGATION_INVALID_INPUT",
  );
});

test("MCP delegation lifecycle keeps direct membership, frozen epochs, CAS and expiry commit ordering explicit", () => {
  assert.match(service, /currentDirectEditorOrOwner/u);
  assert.match(service, /currentDirectProjectOwner/u);
  assert.match(service, /frozenOwnerMembership/u);
  assert.match(service, /ownerProjectMembershipId/u);
  assert.match(service, /ownerMembershipCreatedAt/u);
  assert.match(service, /expectedVersion/u);
  assert.match(service, /updateMany\(/u);
  assert.match(service, /status: "draft"/u);
  assert.match(service, /status: "ownerConfirmed"/u);
  assert.match(service, /status: "active"/u);
  assert.match(service, /status: "expired"/u);
  assert.match(service, /const expired = await expireIfNeeded/u);
  assert.ok(service.indexOf("await activeActor(tx, actor)") < service.indexOf("const expired = await expireIfNeeded"));
  assert.match(service, /admitWebAiProjectAccess\(tx, \{ actor, projectId, required: "view", allowArchived: true \}\)/u);
  assert.match(service, /if \(typeof result === "object"[\s\S]*PROJECT_MCP_CONNECTION_DELEGATION_EXPIRED/u);
  assert.match(service, /const now = await databaseNow\(db\)/u);
  assert.doesNotMatch(service, /await db\.projectMcpConnectionDelegation\.delete/u);
  assert.doesNotMatch(service, /readCredentialSecret|discoverMcpTools|callMcpTool|grantProjectMcpTool|attestMcpToolDefinition|buildMcpActionSnapshot/u);
});

test("MCP projections and owner discovery remain secret-free while retaining due physical-live records", async () => {
  const projection = service.slice(service.indexOf("function delegationView"), service.indexOf("function canonicalFingerprint"));
  assert.doesNotMatch(projection, /endpointUrl|authKind|credential|Fingerprint|membershipId|Membership|auditId|username|catalog|tool/u);
  assert.match(projection, /ownerVisible/u);
  assert.match(projection, /connection: ownerVisible \? \{ id: row\.mcpConnection\.id, name: row\.mcpConnection\.name \} : null/u);
  const meRoute = readSource("src/app/api/me/mcp-delegations/route.ts");
  assert.match(meRoute, /listConnectionOwnerProjectMcpConnectionDelegations/u);
  assert.match(service, /status: \{ in: \["draft", "ownerConfirmed", "active", "rejected", "revoked", "expired"\] \}/u);
  assert.doesNotMatch(service.slice(service.indexOf("export async function listConnectionOwnerProjectMcpConnectionDelegations"), service.indexOf("export async function proposeProjectMcpConnectionDelegation")), /\.filter\(\(row\) => row\.expiresAt/u);
  assert.match(service, /terminalOwnerSafe = ownerActor[\s\S]*row\.status !== "expired"/u);
});

test("MCP delegation APIs use session, same-origin writes, no-store and exact terminal bypass", async () => {
  assert.match(accessControl, /MCP_DELEGATION_TERMINAL_PATH_PATTERN/u);
  assert.match(accessControl, /rawPath === path/u);
  assert.match(accessControl, /request\.method\.toUpperCase\(\) === "POST"/u);
  assert.match(accessControl, /MCP_DELEGATION_TERMINAL_PATH_PATTERN\.test\(path\)/u);
  for (const file of projectRouteFiles) {
    const source = readSource(file);
    assert.match(source, /requireApiSession/u, file);
    assert.match(source, /cache-control.*no-store|noStore/u, file);
    if (file.endsWith("/route.ts") && !file.endsWith("mcp-connection-delegations/[delegationId]/route.ts")) {
      assert.match(source, /assertSameOrigin/u, file);
    }
  }
  const meRoute = readSource("src/app/api/me/mcp-delegations/route.ts");
  assert.match(meRoute, /requireApiSession/u);
  assert.match(meRoute, /cache-control.*no-store|noStore/u);
});

test("MCP connection mutation lock and live-delete error remain stable while runtime stays frozen", () => {
  assert.match(mcpService, /32010000/u);
  assert.match(mcpService, /discoverMcpConnectionTools[\s\S]*pg_advisory_xact_lock\(hashtextextended\(\$\{connectionId\}::text, 32010000\)/u);
  assert.match(mcpService, /MCP_CONNECTION_LIVE_DELEGATION_DELETE_FORBIDDEN/u);
  assert.match(mcpErrors, /MCP_CONNECTION_LIVE_DELEGATION_DELETE_FORBIDDEN/u);
  assert.match(apiErrors, /MCP_CONNECTION_LIVE_DELEGATION_DELETE_FORBIDDEN: \[409/u);
  assert.match(mcpService, /function projectMcpDelegationEnabled\(\): boolean \{\s+return false;/u);
  assert.deepEqual(POSTGRES_GATES.find((gate) => gate.id === "project-mcp-delegation"), {
    id: "project-mcp-delegation",
    file: "test/project-mcp-delegation-postgres.test.ts",
    database: "ai_project_os_project_mcp_delegation_test",
    gateEnv: "PROJECT_MCP_DELEGATION_POSTGRES_GATE",
    setup: "migrate",
  });
});
