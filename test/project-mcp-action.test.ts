import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapApiError } from "../src/lib/api-errors";
import { isProjectMcpActionApiEnabled, projectMcpActionApiUnavailable } from "../src/lib/project-mcp-action-api-gate";
import { ProjectMcpActionServiceError } from "../src/lib/project-mcp-action-service";

test("project MCP action routes require the explicit deployment gate", async () => {
  const [collection, detail, decision, cancel, service, migration, compose, environmentExample] = await Promise.all([
    readFile("src/app/api/projects/[projectId]/mcp-actions/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/mcp-actions/[actionId]/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/mcp-actions/[actionId]/decision/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/mcp-actions/[actionId]/cancel/route.ts", "utf8"),
    readFile("src/lib/project-mcp-action-service.ts", "utf8"),
    readFile("prisma/migrations/20260904210000_add_project_mcp_action_approval_control_plane/migration.sql", "utf8"),
    readFile("compose.yaml", "utf8"),
    readFile(".env.example", "utf8"),
  ]);
  for (const route of [collection, detail, decision, cancel]) {
    assert.match(route, /projectMcpActionApiUnavailable/u);
    assert.match(route, /isProjectMcpActionApiEnabled/u);
    assert.match(route, /requireApiSession/u);
  }
  assert.match(compose, /AI_PROJECT_OS_MCP_ACTIONS_ENABLED: "\$\{AI_PROJECT_OS_MCP_ACTIONS_ENABLED:-false\}"/u);
  assert.match(environmentExample, /^AI_PROJECT_OS_MCP_ACTIONS_ENABLED=false$/mu);
  const unavailable = projectMcpActionApiUnavailable();
  assert.equal(unavailable.status, 404);
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.deepEqual(await unavailable.json(), {
    error: {
      code: "PROJECT_MCP_ACTION_API_UNAVAILABLE",
      message: "项目 MCP 调用尚未开放",
    },
  });
  assert.match(service, /current direct project Owner|ownerAdmission|role: "owner"/u);
  assert.match(service, /TransactionIsolationLevel\.Serializable/u);
  assert.match(service, /32020002/u);
  assert.match(service, /32020007/u);
  assert.match(service, /canonicalMcpToolArguments/u);
  assert.match(service, /acknowledgeSingleUse: z\.literal\(true\)/u);
  assert.match(service, /expectedActionRevision: HASH/u);
  assert.match(service, /actionRevisionFromFingerprint/u);
  assert.match(service, /32010000/u);
  assert.match(service, /32010002/u);
  assert.match(service, /32010003/u);
  assert.doesNotMatch(service, /fetch\(|http:|https:|McpClient|credential-vault|worker|executeMcpActionSnapshot|buildMcpActionSnapshot/u);
  assert.doesNotMatch(service, /endpointUrl|ciphertext|nonce|authTag|readCredentialSecret/u);
  const projection = service.slice(service.indexOf("function projectAction"), service.indexOf("async function loadAction"));
  assert.match(projection, /actionRevision/u);
  assert.doesNotMatch(projection, /actionFingerprint\s*:/u);
  assert.doesNotMatch(projection, /canonicalArgumentsHash|connectionId|credential|ledger|audit|transactionId|membership/u);
  assert.match(migration, /ProjectMcpActionLedger/u);
  assert.match(migration, /ProjectMcpActionDecision_evidence_guard/u);
  assert.match(migration, /project_mcp_action_source_tuple_valid/u);
  assert.match(migration, /project_mcp_action_snapshot_fingerprint/u);
  assert.match(migration, /PROJECT_MCP_ACTION_EVIDENCE_REQUIRED/u);
  assert.match(migration, /PROJECT_MCP_ACTION_RELATED_EVIDENCE_REQUIRED/u);
  assert.match(migration, /PROJECT_MCP_ACTION_PENDING_ARCHIVE_FORBIDDEN/u);
  assert.match(migration, /INTERVAL '15 minutes'/u);
  const fingerprintFunction = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION "project_mcp_action_snapshot_fingerprint"'), migration.indexOf('CREATE OR REPLACE FUNCTION "project_mcp_action_source_tuple_valid"'));
  assert.doesNotMatch(fingerprintFunction, /lastActor/u);
  assert.match(fingerprintFunction, /project_mcp_action_timestamp_token/u);
  assert.match(migration, /"status" = 'cancelled' AND "stateVersion" = 2/u);
  assert.match(migration, /NEW\."approvedAt" := OLD\."approvedAt"/u);
  assert.match(migration, /NEW\."transitionAt" := action_row\."transitionAt"/u);
  assert.doesNotMatch(migration, /ProjectMcpActionDecision_action_fkey/u);
});

test("project MCP action errors have stable API mappings", () => {
  const mapped = mapApiError(new ProjectMcpActionServiceError("PROJECT_MCP_ACTION_STALE"));
  assert.equal(mapped.status, 409);
  assert.equal(mapped.body.error.code, "PROJECT_MCP_ACTION_STALE");
});

test("all public MCP action routes fail closed when the deployment gate is off", async () => {
  const [collection, detail, decision, cancel, dispatch, resultImport] = await Promise.all([
    import("../src/app/api/projects/[projectId]/mcp-actions/route"),
    import("../src/app/api/projects/[projectId]/mcp-actions/[actionId]/route"),
    import("../src/app/api/projects/[projectId]/mcp-actions/[actionId]/decision/route"),
    import("../src/app/api/projects/[projectId]/mcp-actions/[actionId]/cancel/route"),
    import("../src/app/api/projects/[projectId]/mcp-actions/[actionId]/dispatch/route"),
    import("../src/app/api/projects/[projectId]/mcp-actions/[actionId]/import/route"),
  ]);
  const prior = process.env.AI_PROJECT_OS_MCP_ACTIONS_ENABLED;
  delete process.env.AI_PROJECT_OS_MCP_ACTIONS_ENABLED;
  try {
    const request = new Request("http://localhost/api/projects/00000000-0000-0000-0000-000000000001/mcp-actions", { method: "POST" });
    const projectContext = { params: Promise.resolve({ projectId: "00000000-0000-0000-0000-000000000001" }) };
    const actionContext = { params: Promise.resolve({ projectId: "00000000-0000-0000-0000-000000000001", actionId: "00000000-0000-0000-0000-000000000002" }) };
    for (const response of await Promise.all([
      collection.GET(request, projectContext), collection.POST(request, projectContext),
      detail.GET(request, actionContext), decision.POST(request, actionContext),
      cancel.POST(request, actionContext), dispatch.POST(request, actionContext), resultImport.POST(request, actionContext),
    ])) {
      assert.equal(response.status, 404);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "PROJECT_MCP_ACTION_API_UNAVAILABLE");
    }
  } finally {
    if (prior === undefined) delete process.env.AI_PROJECT_OS_MCP_ACTIONS_ENABLED;
    else process.env.AI_PROJECT_OS_MCP_ACTIONS_ENABLED = prior;
  }
});

test("production explicitly enables the project MCP action API gate", async () => {
  const { GET } = await import("../src/app/api/projects/[projectId]/mcp-actions/route");
  const mutableEnv = process.env as Record<string, string | undefined>;
  const prior = {
    nodeEnv: mutableEnv.NODE_ENV,
    actionGate: mutableEnv.AI_PROJECT_OS_MCP_ACTIONS_ENABLED,
    databaseUrl: mutableEnv.DATABASE_URL,
  };
  mutableEnv.NODE_ENV = "production";
  mutableEnv.AI_PROJECT_OS_MCP_ACTIONS_ENABLED = "true";
  mutableEnv.DATABASE_URL = "postgresql://ai_project_os_runtime:test-only@127.0.0.1:5432/ai_project_os";
  try {
    assert.equal(isProjectMcpActionApiEnabled(), true);
    const response = await GET(
      new Request("https://ai-project-os.com/api/projects/00000000-0000-0000-0000-000000000001/mcp-actions"),
      { params: Promise.resolve({ projectId: "00000000-0000-0000-0000-000000000001" }) },
    );
    assert.equal(response.status, 401, "the request passed the feature gate and reached authentication");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json() as { error: { code: string } }).error.code, "AUTH_REQUIRED");
  } finally {
    if (prior.nodeEnv === undefined) delete mutableEnv.NODE_ENV;
    else mutableEnv.NODE_ENV = prior.nodeEnv;
    if (prior.actionGate === undefined) delete mutableEnv.AI_PROJECT_OS_MCP_ACTIONS_ENABLED;
    else mutableEnv.AI_PROJECT_OS_MCP_ACTIONS_ENABLED = prior.actionGate;
    if (prior.databaseUrl === undefined) delete mutableEnv.DATABASE_URL;
    else mutableEnv.DATABASE_URL = prior.databaseUrl;
  }
});
