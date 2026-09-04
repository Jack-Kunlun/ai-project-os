import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "pg";
import { INVENTORY_TABLES, parseOwnershipInventoryDatabaseUrl } from "../scripts/0.2x-migration-inventory-contract";
import { main, runOwnershipInventory } from "../scripts/0.2x-migration-inventory";

const shouldRun = process.env.OWNERSHIP_INVENTORY_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_ownership_inventory_test";
const readerRole = "ai_project_os_inventory_reader";
const execFile = promisify(execFileCallback);

function adminDatabaseUrl(): string {
  const value = process.env.OWNERSHIP_INVENTORY_TEST_DATABASE_URL;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("OWNERSHIP_INVENTORY_TEST_DATABASE_URL_REQUIRED");
  }
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error("OWNERSHIP_INVENTORY_TEST_DATABASE_URL_INVALID");
  }
  parsed.searchParams.set("sslmode", "disable");
  return parsed.toString();
}

function adminDatabaseConfig() {
  const config = parseOwnershipInventoryDatabaseUrl(adminDatabaseUrl());
  return { ...config, options: "-c default_transaction_read_only=off" };
}

function readerDatabaseConfig(adminConfig: ReturnType<typeof adminDatabaseConfig>, password: string) {
  return { ...adminConfig, user: readerRole, password, options: "-c default_transaction_read_only=on" };
}

function readerDatabaseUrl(password: string): string {
  const parsed = new URL(adminDatabaseUrl());
  parsed.username = readerRole;
  parsed.password = password;
  return parsed.toString();
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function removeReaderRole(admin: Client): Promise<void> {
  await admin.query(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE usename = '${readerRole}' AND pid <> pg_backend_pid()
  `);
  const existing = await admin.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [readerRole]);
  if (existing.rows[0]?.exists === true) {
    try {
      await admin.query(`DROP OWNED BY "${readerRole}"`);
    } finally {
      await admin.query(`DROP ROLE IF EXISTS "${readerRole}"`);
    }
  }
}

async function assertReadOnlyWriteRejected(client: Client): Promise<void> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const setting = await client.query<{ transaction_read_only: string }>("SELECT current_setting('transaction_read_only') AS transaction_read_only");
    assert.equal(setting.rows[0]?.transaction_read_only, "on");
    await assert.rejects(
      () => client.query("INSERT INTO \"GitConnection\" (\"id\") VALUES ('00000000-0000-4000-8000-000000000099')"),
      (error: unknown) => errorCode(error) === "25006" || errorCode(error) === "42501",
    );
  } finally {
    await client.query("ROLLBACK");
  }

  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await assert.rejects(
      () => client.query("CREATE TABLE \"inventory_ddl_probe\" (\"id\" integer)"),
      (error: unknown) => errorCode(error) === "25006" || errorCode(error) === "42501",
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function assertInventoryPreflightFailure(config: ReturnType<typeof readerDatabaseConfig>): Promise<void> {
  const reader = new Client(config);
  await reader.connect();
  try {
    await assert.rejects(
      () => runOwnershipInventory(readerAdapter(reader)),
      /OWNERSHIP_INVENTORY_PREFLIGHT_FAILED/,
    );
  } finally {
    await reader.end();
  }
}

test(
  "restricted ownership inventory produces only the approved aggregate report",
  { skip: !shouldRun ? "OWNERSHIP_INVENTORY_POSTGRES_GATE=1 is required" : false },
  async () => {
    const adminConfig = adminDatabaseConfig();
    const admin = new Client(adminConfig);
    const password = `InventoryReader_${randomUUID().replaceAll("-", "")}`;
    const readerConfig = readerDatabaseConfig(adminConfig, password);
    const suffix = randomUUID().slice(0, 8);
    const userOwnerId = randomUUID();
    const userAdminId = randomUUID();
    const userMemberId = randomUUID();
    const userViewerId = randomUUID();
    const userProviderId = randomUUID();
    const userDisabledId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const activeOfferPolicyId = randomUUID();
    const gitLegacyId = randomUUID();
    const gitConfirmedId = randomUUID();
    const gitAmbiguousId = randomUUID();
    const gitRepositoryId = randomUUID();
    const gitConfirmedRepositoryId = randomUUID();
    const gitLinkId = randomUUID();
    const gitConfirmedLinkId = randomUUID();
    const mcpLegacyId = randomUUID();
    const mcpConfirmedId = randomUUID();
    const mcpAmbiguousId = randomUUID();
    const mcpDefinitionId = randomUUID();
    const mcpConfirmedDefinitionId = randomUUID();
    const mcpGrantId = randomUUID();
    const mcpConfirmedGrantId = randomUUID();
    const platformProviderId = randomUUID();
    const workspaceOwnerProviderId = randomUUID();
    const workspaceAdminProviderId = randomUUID();
    const workspaceMemberProviderId = randomUUID();
    const workspaceViewerProviderId = randomUUID();
    const userProviderConnectionId = randomUUID();
    const routeProviderCredentialId = randomUUID();
    const workspaceOwnerCredentialId = randomUUID();
    const workspaceAdminCredentialId = randomUUID();
    const workspaceMemberCredentialId = randomUUID();
    const workspaceViewerCredentialId = randomUUID();
    const userProviderCredentialId = randomUUID();
    const tokenGrantId = randomUUID();
    const expiredGrantId = randomUUID();
    const revokedGrantId = randomUUID();
    const reservationId = randomUUID();
    const auditId = randomUUID();
    const personalWebGrantId = randomUUID();
    const personalJobId = randomUUID();
    const automationRuleId = randomUUID();
    const activeGenerationId = randomUUID();
    const activeDefaultRouteId = randomUUID();
    const draftEmbeddingRouteId = randomUUID();
    const draftGenerationRouteId = randomUUID();
    let roleCreated = false;

    await admin.connect();
    try {
      await removeReaderRole(admin);
      await admin.query(`CREATE ROLE "${readerRole}" LOGIN PASSWORD '${password}'`);
      roleCreated = true;
      await admin.query(`ALTER ROLE "${readerRole}" SET default_transaction_read_only = 'on'`);
      await admin.query(`REVOKE TEMPORARY, CREATE ON DATABASE "${testDatabaseName}" FROM PUBLIC`);
      await admin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      await admin.query(`REVOKE SELECT ON TABLE "ExternalCredential" FROM PUBLIC`);
      for (const table of INVENTORY_TABLES) {
        await admin.query(`REVOKE ALL PRIVILEGES ON TABLE "${table}" FROM PUBLIC`);
      }
      await admin.query(`GRANT CONNECT ON DATABASE "${testDatabaseName}" TO "${readerRole}"`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO "${readerRole}"`);
      for (const table of INVENTORY_TABLES) {
        await admin.query(`GRANT SELECT ON TABLE "${table}" TO "${readerRole}"`);
      }

      await admin.query("BEGIN");
      await admin.query(`
        INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES
          ($1, $2, 'member', CURRENT_TIMESTAMP),
          ($3, $4, 'admin', CURRENT_TIMESTAMP),
          ($5, $6, 'member', CURRENT_TIMESTAMP),
          ($7, $8, 'user', CURRENT_TIMESTAMP),
          ($9, $10, 'user', CURRENT_TIMESTAMP),
          ($11, $12, 'user', CURRENT_TIMESTAMP)
      `, [
        userOwnerId, `inventory_owner_${suffix}`,
        userAdminId, `inventory_admin_${suffix}`,
        userMemberId, `inventory_member_${suffix}`,
        userViewerId, `inventory_viewer_${suffix}`,
        userProviderId, `inventory_provider_${suffix}`,
        userDisabledId, `inventory_disabled_${suffix}`,
      ]);
      await admin.query(`
        UPDATE "AppUser"
           SET "disabledAt" = CURRENT_TIMESTAMP,
               "disabledReason" = 'inventory test account disabled'
         WHERE "id" = $1
      `, [userDisabledId]);
      await admin.query(`
        INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt")
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [workspaceId, `Inventory ${suffix}`, `inventory-${suffix}`, userOwnerId]);
      await admin.query(`
        INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "updatedAt") VALUES
          (gen_random_uuid(), $1, $2, 'owner', CURRENT_TIMESTAMP),
          (gen_random_uuid(), $1, $3, 'admin', CURRENT_TIMESTAMP),
          (gen_random_uuid(), $1, $4, 'member', CURRENT_TIMESTAMP),
          (gen_random_uuid(), $1, $5, 'viewer', CURRENT_TIMESTAMP)
      `, [workspaceId, userOwnerId, userAdminId, userMemberId, userViewerId]);
      await admin.query(`
        INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt")
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [projectId, workspaceId, `Inventory project ${suffix}`, `inventory-project-${suffix}`]);
      await admin.query(`
        INSERT INTO "PlatformGrantOfferPolicy"
          ("id", "offerVersion", "status", "amount", "validForDays", "eligibilityKey", "createdById", "updatedById", "updatedAt")
        VALUES ($1, $2, 'active', 100, 30, 'inventory-test', $3, $3, CURRENT_TIMESTAMP)
      `, [activeOfferPolicyId, `inventory-offer-${suffix}`, userAdminId]);

      await admin.query(`
        INSERT INTO "GitConnection"
          ("id", "name", "providerKind", "transport", "baseUrl", "authKind", "status", "createdById", "ownerUserId", "ownershipState", "updatedAt")
        VALUES
          ($1, $2, 'generic', 'https', $3, 'none', 'configured', $4, NULL, 'legacy_pending', CURRENT_TIMESTAMP),
          ($5, $6, 'generic', 'https', $3, 'none', 'verified', $7, $7, 'confirmed', CURRENT_TIMESTAMP),
          ($8, $9, 'generic', 'https', $3, 'none', 'configured', $4, NULL, 'ambiguous', CURRENT_TIMESTAMP)
      `, [
        gitLegacyId, `inventory_git_legacy_${suffix}`, `https://sentinel.invalid/${suffix}`, userProviderId,
        gitConfirmedId, `inventory_git_confirmed_${suffix}`,
        userOwnerId, gitAmbiguousId, `inventory_git_ambiguous_${suffix}`,
      ]);
      await admin.query(`
        INSERT INTO "GitRepository"
          ("id", "gitConnectionId", "repositoryPath", "displayName", "defaultBranch", "updatedAt")
        VALUES ($1, $2, $3, $4, 'main', CURRENT_TIMESTAMP),
               ($5, $6, $7, $8, 'main', CURRENT_TIMESTAMP)
      `, [
        gitRepositoryId, gitLegacyId, `sentinel/${suffix}`, `Sentinel repository ${suffix}`,
        gitConfirmedRepositoryId, gitConfirmedId, `confirmed/${suffix}`, `Confirmed repository ${suffix}`,
      ]);
      await admin.query(`
        INSERT INTO "ProjectGitRepositoryLink"
          ("id", "projectId", "gitRepositoryId", "role", "trackedRef", "createdById", "updatedAt")
        VALUES ($1, $2, $3, 'primary', 'main', $4, CURRENT_TIMESTAMP),
               ($5, $2, $6, 'application', 'main', $7, CURRENT_TIMESTAMP)
      `, [gitLinkId, projectId, gitRepositoryId, userOwnerId, gitConfirmedLinkId, gitConfirmedRepositoryId, userAdminId]);

      await admin.query(`
        INSERT INTO "McpConnection"
          ("id", "name", "endpointUrl", "authKind", "status", "createdById", "ownerUserId", "ownershipState", "updatedAt")
        VALUES
          ($1, $2, $3, 'none', 'configured', $4, NULL, 'legacy_pending', CURRENT_TIMESTAMP),
          ($5, $6, $3, 'none', 'verified', $7, $7, 'confirmed', CURRENT_TIMESTAMP),
          ($8, $9, $3, 'none', 'configured', $4, NULL, 'ambiguous', CURRENT_TIMESTAMP)
      `, [
        mcpLegacyId, `inventory_mcp_legacy_${suffix}`, `https://sentinel-mcp.invalid/${suffix}`, userProviderId,
        mcpConfirmedId, `inventory_mcp_confirmed_${suffix}`,
        userOwnerId, mcpAmbiguousId, `inventory_mcp_ambiguous_${suffix}`,
      ]);
      await admin.query(`
        INSERT INTO "McpToolDefinition"
          ("id", "connectionId", "name", "inputSchema", "readOnlyEligible", "definitionFingerprint")
        VALUES ($1, $2, 'sentinel_tool', '{}'::jsonb, true, repeat('a', 64)),
               ($3, $4, 'sentinel_tool', '{}'::jsonb, true, repeat('c', 64))
      `, [mcpDefinitionId, mcpLegacyId, mcpConfirmedDefinitionId, mcpConfirmedId]);
      await admin.query(`
        INSERT INTO "ProjectMcpToolGrant"
          ("id", "projectId", "connectionId", "toolName", "toolDefinitionId", "status", "managedById", "acknowledgedAt", "updatedAt")
        VALUES ($1, $2, $3, 'sentinel_tool', $4, 'active', $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
               ($6, $2, $7, 'sentinel_tool', $8, 'active', $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [mcpGrantId, projectId, mcpLegacyId, mcpDefinitionId, userOwnerId, mcpConfirmedGrantId, mcpConfirmedId, mcpConfirmedDefinitionId, userAdminId]);

      const credentialIds = [
        routeProviderCredentialId, workspaceOwnerCredentialId, workspaceAdminCredentialId,
        workspaceMemberCredentialId, workspaceViewerCredentialId, userProviderCredentialId,
      ];
      await admin.query(`
        INSERT INTO "ExternalCredential"
          ("id", "kind", "ciphertext", "nonce", "authTag", "maskedSuffix", "secretFingerprint", "updatedAt")
        SELECT value, 'ai_provider', decode('00', 'hex'), decode('01', 'hex'), decode('02', 'hex'), 'sentinel', repeat('b', 64), CURRENT_TIMESTAMP
        FROM unnest($1::uuid[]) AS ids(value)
      `, [credentialIds]);
      await admin.query(`
        INSERT INTO "AiProviderConnection"
          ("id", "name", "kind", "scope", "workspaceId", "ownerUserId", "ownershipState", "baseUrl", "credentialId", "status", "updatedAt")
        VALUES
          ($1, $2, 'deepseek', 'platform', NULL, NULL, 'legacy_pending', 'https://sentinel-provider.invalid', $3, 'verified', CURRENT_TIMESTAMP),
          ($4, $5, 'deepseek', 'workspace', $6, $7, 'legacy_pending', 'https://sentinel-provider.invalid', $8, 'verified', CURRENT_TIMESTAMP),
          ($9, $10, 'deepseek', 'workspace', $6, $11, 'legacy_pending', 'https://sentinel-provider.invalid', $12, 'verified', CURRENT_TIMESTAMP),
          ($13, $14, 'deepseek', 'workspace', $6, $15, 'ambiguous', 'https://sentinel-provider.invalid', $16, 'verified', CURRENT_TIMESTAMP),
          ($17, $18, 'deepseek', 'workspace', $6, $19, 'ambiguous', 'https://sentinel-provider.invalid', $20, 'verified', CURRENT_TIMESTAMP),
          ($21, $22, 'deepseek', 'user', NULL, $23, 'confirmed', 'https://sentinel-provider.invalid', $24, 'verified', CURRENT_TIMESTAMP)
      `, [
        platformProviderId, `inventory_provider_platform_${suffix}`, routeProviderCredentialId,
        workspaceOwnerProviderId, `inventory_provider_owner_${suffix}`, workspaceId, userOwnerId, workspaceOwnerCredentialId,
        workspaceAdminProviderId, `inventory_provider_admin_${suffix}`, userAdminId, workspaceAdminCredentialId,
        workspaceMemberProviderId, `inventory_provider_member_${suffix}`, userMemberId, workspaceMemberCredentialId,
        workspaceViewerProviderId, `inventory_provider_viewer_${suffix}`, userViewerId, workspaceViewerCredentialId,
        userProviderConnectionId, `inventory_provider_user_${suffix}`, userProviderId, userProviderCredentialId,
      ]);
      await admin.query(`
        UPDATE "AiProviderConnection"
           SET "defaultGenerationModelId" = 'generation-default',
               "defaultEmbeddingModelId" = 'embedding-default',
               "defaultVisionModelId" = 'vision-default',
               "embeddingDimensions" = 1536
         WHERE "id" = $1
      `, [platformProviderId]);
      await admin.query(`
        INSERT INTO "ProjectAiRoute" ("projectId", "operation", "providerConnectionId", "modelId", "maxOutputTokens", "updatedAt")
        VALUES ($1, 'projectAnalysis', $2, 'generation-default', 1024, CURRENT_TIMESTAMP),
               ($1, 'sourceSummary', $3, 'personal-model', 1024, CURRENT_TIMESTAMP)
      `, [projectId, platformProviderId, userProviderConnectionId]);
      await admin.query(`
        INSERT INTO "WebAiGrant"
          ("id", "projectId", "operation", "scopeKind", "scopeIds", "manifestFingerprint", "providerConnectionId", "modelId", "consentVersion", "issuedById", "billingMode", "billingUserId", "expiresAt")
        VALUES ($1, $2, 'sourceSummary', 'query', '{}'::jsonb, repeat('d', 64), $3, 'personal-model', 'inventory-consent', $4, 'byok', $4, CURRENT_TIMESTAMP + INTERVAL '1 day')
      `, [personalWebGrantId, projectId, userProviderConnectionId, userProviderId]);
      await admin.query(`
        INSERT INTO "BackgroundJob"
          ("id", "projectId", "kind", "status", "idempotencyKey", "requestedById", "webAiGrantId", "createdAt")
        VALUES ($1, $2, 'project_agent', 'waitingConsent', repeat('e', 64), $3, $4, CURRENT_TIMESTAMP)
      `, [personalJobId, projectId, userProviderId, personalWebGrantId]);
      await admin.query(`
        INSERT INTO "AutomationRule"
          ("id", "projectId", "name", "kind", "status", "intervalMinutes", "config", "nextRunAt", "createdById", "updatedAt")
        VALUES ($1, $2, 'inventory-personal-automation', 'memory_index', 'active', 60, '{}'::jsonb, CURRENT_TIMESTAMP + INTERVAL '1 hour', $3, CURRENT_TIMESTAMP)
      `, [automationRuleId, projectId, userProviderId]);
      await admin.query(`
        INSERT INTO "PlatformDefaultAiRoute"
          ("id", "operation", "version", "status", "providerConnectionId", "modelId", "embeddingDimensions", "maxOutputTokens", "createdById", "updatedById", "updatedAt")
        VALUES
          ($1, 'embedding', 1, 'active', $4, 'embedding-default', 1536, NULL, $5, $5, CURRENT_TIMESTAMP),
          ($2, 'embedding', 2, 'draft', $4, 'embedding-default', 1536, NULL, $5, $5, CURRENT_TIMESTAMP),
          ($3, 'projectAnalysis', 1, 'draft', $4, 'generation-default', NULL, 1024, $5, $5, CURRENT_TIMESTAMP)
      `, [activeDefaultRouteId, draftEmbeddingRouteId, draftGenerationRouteId, platformProviderId, userAdminId]);
      await admin.query(`
        INSERT INTO "MemoryIndexGeneration"
          ("id", "projectId", "providerConnectionId", "modelId", "dimensions", "inputManifestFingerprint", "status", "recordCount")
        VALUES ($1, $2, $3, 'embedding-default', 1536, repeat('f', 64), 'complete', 0)
      `, [activeGenerationId, projectId, platformProviderId]);
      await admin.query(`
        INSERT INTO "MemoryIndexPointer" ("projectId", "indexGenerationId")
        VALUES ($1, $2)
      `, [projectId, activeGenerationId]);

      const grantRows = [
        [tokenGrantId, userOwnerId, 100, 80, "2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z", null],
        [expiredGrantId, userAdminId, 100, 20, "2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z", null],
        [revokedGrantId, userMemberId, 100, 50, "2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
      ];
      for (const [id, userId, amount, remainingTokens, issuedAt, expiresAt, revokedAt] of grantRows) {
        await admin.query(`
          INSERT INTO "PlatformTokenGrant"
            ("id", "userId", "kind", "amount", "remainingTokens", "offerVersion", "issuedAt", "expiresAt", "revokedAt", "createdAt", "updatedAt")
          VALUES ($1, $2, 'signup', $3, $4, 'inventory-sentinel', $5, $6, $7, $5, $5)
        `, [id, userId, amount, remainingTokens, issuedAt, expiresAt, revokedAt]);
      }
      await admin.query(`
        INSERT INTO "PlatformTokenReservation"
          ("id", "userId", "grantId", "providerConnectionId", "callKey", "operation", "modelId", "status", "reservedTokens", "expiresAt")
        VALUES ($1, $2, $3, $4, 'inventory-sentinel-call', 'projectAnalysis', 'sentinel-model', 'reserved', 1, CURRENT_TIMESTAMP + INTERVAL '1 day')
      `, [reservationId, userOwnerId, tokenGrantId, platformProviderId]);
      await admin.query(`
        INSERT INTO "ProviderCallAudit"
          ("id", "providerConnectionId", "operation", "modelId", "billingUserId", "callKey", "reservationId", "status")
        VALUES ($1, $2, 'projectAnalysis', 'sentinel-model', $3, 'inventory-sentinel-call', $4, 'succeeded')
      `, [auditId, platformProviderId, userOwnerId, reservationId]);
      await admin.query("COMMIT");

      await admin.query(`GRANT SELECT ON TABLE "ExternalCredential" TO "${readerRole}"`);
      try {
        await assertInventoryPreflightFailure(readerConfig);
      } finally {
        await admin.query(`REVOKE SELECT ON TABLE "ExternalCredential" FROM "${readerRole}"`);
      }

      await admin.query(`ALTER ROLE "${readerRole}" REPLICATION`);
      try {
        await assertInventoryPreflightFailure(readerConfig);
      } finally {
        await admin.query(`ALTER ROLE "${readerRole}" NOREPLICATION`);
      }

      await admin.query(`ALTER ROLE "${readerRole}" RESET default_transaction_read_only`);
      try {
        await assertInventoryPreflightFailure(readerConfig);
      } finally {
        await admin.query(`ALTER ROLE "${readerRole}" SET default_transaction_read_only = 'on'`);
      }

      await admin.query(`ALTER DATABASE "${testDatabaseName}" SET default_transaction_read_only = 'on'`);
      try {
        await assertInventoryPreflightFailure(readerConfig);
      } finally {
        await admin.query(`ALTER DATABASE "${testDatabaseName}" RESET default_transaction_read_only`);
      }

      await admin.query(`ALTER ROLE "${readerRole}" IN DATABASE "${testDatabaseName}" SET default_transaction_read_only = 'on'`);
      try {
        await assertInventoryPreflightFailure(readerConfig);
      } finally {
        await admin.query(`ALTER ROLE "${readerRole}" IN DATABASE "${testDatabaseName}" RESET default_transaction_read_only`);
      }

      const reader = new Client(readerConfig);
      await reader.connect();
      try {
        const report = await runOwnershipInventory(readerAdapter(reader));
        assert.deepEqual(report.resources.accounts, {
          total: 6,
          systemRole: { admin: 1, legacyMember: 2, user: 3, invalid: 0 },
          accountState: { enabled: 5, disabled: 1 },
          grantCoverage: {
            activeOfferPolicies: 1,
            enabledWithoutAnyGrant: 2,
            enabledWithoutSignupGrant: 2,
            enabledWithoutAvailableGrant: 4,
            eligibleWithoutGrantKnown: 0,
            eligibilityNotEvaluable: 2,
          },
        });
        assert.deepEqual(report.resources.git, {
          total: 3,
          ownership: { confirmed: 1, legacyPending: 1, ambiguous: 1, invalid: 0 },
          createdByCandidateOnly: 2,
          references: { repositories: 2, projectRepositoryLinks: 2, activeProjectRepositoryLinks: 2 },
          referencesWithDifferentActor: 2,
          activeReferencesWithDifferentActor: 2,
          connectionsWithDifferentReferenceActor: 2,
          connectionsWithCreatorOutsideProjectAccess: 1,
          activeConnectionsWithCreatorOutsideProjectAccess: 1,
          ownerCandidateExactNameConflictGroups: 0,
          connectionsInOwnerCandidateExactNameConflicts: 0,
          personalReferences: {
            directReferences: 1,
            activeDirectReferences: 1,
            distinctProjects: 1,
            potentialNonTerminalJobsInReferencedProjects: 1,
            potentialActiveAutomationsInReferencedProjects: 1,
            automationDirectBinding: "not_evaluable_without_typed_delegation",
          },
        });
        assert.deepEqual(report.resources.mcp, {
          total: 3,
          ownership: { confirmed: 1, legacyPending: 1, ambiguous: 1, invalid: 0 },
          createdByCandidateOnly: 2,
          references: { toolDefinitions: 2, currentToolDefinitions: 2, projectToolGrants: 2, activeProjectToolGrants: 2 },
          referencesWithDifferentActor: 2,
          activeReferencesWithDifferentActor: 2,
          connectionsWithDifferentReferenceActor: 2,
          connectionsWithCreatorOutsideProjectAccess: 1,
          activeConnectionsWithCreatorOutsideProjectAccess: 1,
          ownerCandidateExactNameConflictGroups: 0,
          connectionsInOwnerCandidateExactNameConflicts: 0,
          personalReferences: {
            directReferences: 1,
            activeDirectReferences: 1,
            distinctProjects: 1,
            potentialNonTerminalJobsInReferencedProjects: 1,
            potentialActiveAutomationsInReferencedProjects: 1,
            automationDirectBinding: "not_evaluable_without_typed_delegation",
          },
        });
        assert.deepEqual(report.resources.aiProvider, {
          total: 6,
          scope: { platform: 1, workspace: 4, user: 1 },
          ownership: { confirmed: 1, legacyPending: 3, ambiguous: 2, invalid: 0 },
          workspaceOwnerMembership: { owner: 1, admin: 1, member: 1, viewer: 1, missing: 0, notEvaluable: 2 },
          references: {
            projectAiRoutes: 2,
            routeRevisionsOld: 0,
            routeRevisionsNew: 0,
            webAiGrants: 1,
            openWebAiGrants: 1,
            platformTokenReservations: 1,
            openTokenReservations: 1,
            providerCallAudits: 1,
            memoryIndexGenerations: 1,
            derivedAiArtifacts: 0,
            platformDefaultRoutes: 3,
          },
          consistency: {
            structurallyValid: 6,
            structurallyInvalid: 0,
            workspaceWithMembership: 4,
            workspaceWithoutMembership: 0,
            workspaceNotEvaluable: 2,
          },
          personalReferences: {
            directProjectRoutes: 1,
            distinctProjects: 1,
            openWebAiGrants: 1,
            directNonTerminalJobs: 1,
            potentialActiveAutomationsInReferencedProjects: 1,
            automationDirectBinding: "not_evaluable_without_typed_delegation",
          },
        });
        assert.deepEqual(report.resources.githubConnectionLegacy, {
          projectScopedTotal: 0,
          configured: 0,
          verified: 0,
          disabled: 0,
          accessUnknown: 0,
          invalidStatus: 0,
          credentialAttached: 0,
          projectRepositoryLinks: 0,
          githubSyncEntries: 0,
        });
        assert.deepEqual(report.resources.platformTokenGrants, { total: 3, available: 1, expired: 1, revoked: 1 });
        assert.deepEqual(report.resources.platformDefaultRoutes, {
          total: 3,
          status: { draft: 2, verified: 0, active: 1, retired: 0, invalid: 0 },
          candidate: { total: 2, usable: 2, unusable: 0 },
          active: { total: 1, usable: 1, unusable: 0 },
          providerCapabilities: { generation: 1, vision: 1, embedding: 1 },
        });
        assert.deepEqual(report.resources.activeVectorIndex, {
          total: 1,
          matchesActiveDefaultEmbeddingRoute: 1,
          differsFromActiveDefaultEmbeddingRoute: 0,
          noActiveDefaultEmbeddingRoute: 0,
          matchesDraftOrVerifiedCandidateTuple: 1,
        });
        assert.equal(report.snapshot.readOnly, true);
        assert.equal(report.snapshot.isolation, "repeatable_read");
        assert.equal(report.snapshot.migrations.m300, "applied");
        assert.ok(report.snapshot.appliedMigrationCount >= 57);
        const publicReport = JSON.stringify(report);
        for (const sentinel of [
          suffix, "sentinel.invalid", "sentinel-mcp.invalid", "sentinel-provider.invalid", "sentinel-model", "inventory_owner_",
          workspaceId, projectId, platformProviderId, "inventory-sentinel-call",
        ]) {
          assert.equal(publicReport.includes(sentinel), false, `report leaked sentinel ${sentinel}`);
        }
      } finally {
        try {
          await assertReadOnlyWriteRejected(reader);
        } finally {
          await reader.end();
        }
      }

      const output: string[] = [];
      const originalLog = console.log;
      console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
      try {
        const exitCode = await main([], {
          OWNERSHIP_INVENTORY_DATABASE_URL: readerDatabaseUrl(password),
          PGHOST: "malicious.invalid",
          PGUSER: "malicious-user",
          PGPORT: "1",
          PGPASSWORD: "malicious-password",
          PGOPTIONS: "-c default_transaction_read_only=off",
          PGSSLMODE: "require",
          PGREPLICATION: "database",
          PGCLIENT_ENCODING: "SQL_ASCII",
          PGAPPNAME: "malicious-app",
          PGCONNECT_TIMEOUT: "1",
          PGBINARY: "",
        });
        assert.equal(exitCode, 0);
      } finally {
        console.log = originalLog;
      }
      assert.equal(output.length, 1);
      const mainReport = JSON.parse(output[0] ?? "{}") as {
        ok: boolean;
        kind: string;
        snapshot: { readOnly: boolean; isolation: string };
        resources: { accounts: { total: number } };
      };
      assert.equal(mainReport.ok, true);
      assert.equal(mainReport.kind, "ownership-migration-inventory");
      assert.equal(mainReport.snapshot.readOnly, true);
      assert.equal(mainReport.snapshot.isolation, "repeatable_read");
      assert.equal(mainReport.resources.accounts.total, 6);
      const mainPublicReport = JSON.stringify(mainReport);
      for (const sentinel of [suffix, "sentinel.invalid", workspaceId, projectId, platformProviderId, "malicious-password"]) {
        assert.equal(mainPublicReport.includes(sentinel), false, `main report leaked sentinel ${sentinel}`);
      }

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        OWNERSHIP_INVENTORY_DATABASE_URL: readerDatabaseUrl(password),
        PGHOST: "malicious.invalid",
        PGPORT: "1",
        PGUSER: "malicious-user",
        PGDATABASE: "malicious-database",
        PGPASSWORD: "malicious-password",
        PGOPTIONS: "-c default_transaction_read_only=off",
        PGSSLMODE: "require",
        PGREPLICATION: "database",
        PGCLIENT_ENCODING: "SQL_ASCII",
        PGAPPNAME: "malicious-app",
        PGCONNECT_TIMEOUT: "1",
        PGBINARY: "",
      };
      delete childEnv.NODE_PG_FORCE_NATIVE;
      const childResult = await execFile(
        process.execPath,
        ["--import", "tsx", resolve(process.cwd(), "scripts/0.2x-migration-inventory.ts")],
        {
          cwd: process.cwd(),
          env: childEnv,
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 1_024 * 1_024,
        },
      );
      assert.equal(childResult.stderr, "");
      const childLines = childResult.stdout.trim().split(/\r?\n/u);
      assert.equal(childLines.length, 1);
      const childReport = JSON.parse(childLines[0] ?? "{}") as {
        ok: boolean;
        kind: string;
        snapshot: { readOnly: boolean; isolation: string };
        resources: { accounts: { total: number } };
      };
      assert.equal(childReport.ok, true);
      assert.equal(childReport.kind, "ownership-migration-inventory");
      assert.equal(childReport.snapshot.readOnly, true);
      assert.equal(childReport.snapshot.isolation, "repeatable_read");
      assert.equal(childReport.resources.accounts.total, 6);
      const childPublicReport = JSON.stringify(childReport);
      for (const sentinel of [suffix, "sentinel.invalid", workspaceId, projectId, platformProviderId, "malicious-password", "malicious-database"]) {
        assert.equal(childPublicReport.includes(sentinel), false, `child report leaked sentinel ${sentinel}`);
      }

      let unsafeBinaryError: unknown;
      try {
        await execFile(
          process.execPath,
          ["--import", "tsx", resolve(process.cwd(), "scripts/0.2x-migration-inventory.ts")],
          {
            cwd: process.cwd(),
            env: { ...childEnv, PGBINARY: "true" },
            encoding: "utf8",
            timeout: 20_000,
            maxBuffer: 1_024 * 1_024,
          },
        );
      } catch (error) {
        unsafeBinaryError = error;
      }
      assert.ok(unsafeBinaryError !== undefined);
      const unsafeBinaryResult = unsafeBinaryError as { code?: unknown; stdout?: unknown; stderr?: unknown };
      assert.equal(unsafeBinaryResult.code, 1);
      assert.equal(String(unsafeBinaryResult.stderr ?? ""), "");
      assert.deepEqual(JSON.parse(String(unsafeBinaryResult.stdout ?? "").trim()), {
        ok: false,
        error: { code: "OWNERSHIP_INVENTORY_DATABASE_URL_INVALID" },
      });
    } catch (error) {
      try {
        await admin.query("ROLLBACK");
      } catch {
        // The database runner removes the disposable database after the gate.
      }
      throw error;
    } finally {
      if (roleCreated) {
        await removeReaderRole(admin);
      }
      await admin.end();
    }
  },
);

function readerAdapter(client: Client) {
  return {
    query: async <Row = unknown>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as readonly Row[] };
    },
  };
}
