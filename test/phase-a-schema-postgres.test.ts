import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { grantWorkspaceMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.PHASE_A_SCHEMA_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_phase_a_schema_test";
const compatibilityMigrationName = "20260903010000_add_user_system_role_compatibility";
const providerScopeMigrationName = "20260903020000_add_user_ai_provider_scope";
const platformPolicyMigrationName = "20260903030000_add_platform_policies_and_connection_ownership";
const defaultAppUserRoleMigrationName = "20260904010000_default_new_app_users_to_user";
const defaultWorkspaceId = "00000000-0000-4000-8000-000000000001";

function errorText(error: unknown): string {
  const seen = new Set<object>();
  const chunks: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5) return;
    if (value === null || value === undefined) return;
    if (typeof value !== "object") {
      chunks.push(String(value));
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) chunks.push(value.name, value.message);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === "stack") continue;
      try {
        visit((value as Record<string, unknown>)[key], depth + 1);
      } catch {
        // Error inspection is best-effort; the assertion still checks all text collected.
      }
    }
  };
  visit(error, 0);
  return chunks.join(" ");
}

function matchesPostgresConstraint(error: unknown, code: string, constraint: string): boolean {
  const text = errorText(error);
  return text.includes(code) && text.includes(constraint);
}

async function assertPostgresConstraint(
  action: () => Promise<unknown>,
  code: string,
  constraint: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => matchesPostgresConstraint(error, code, constraint));
}

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("PHASE_A_SCHEMA_TEST_DATABASE_URL_REQUIRED");
  }

  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("PHASE_A_SCHEMA_TEST_DATABASE_URL_INVALID");
  }

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
    throw new Error("PHASE_A_SCHEMA_TEST_DATABASE_URL_INVALID");
  }
}

test(
  "full migration chain preserves both additive enum contracts",
  { skip: !shouldRun ? "PHASE_A_SCHEMA_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const userIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const suffix = randomUUID().slice(0, 8);
    const createdMembershipSubscriptionIds: string[] = [];
    const createdInvitationIds: string[] = [];
    const createdGitConnectionIds: string[] = [];
    const createdMcpConnectionIds: string[] = [];
    const createdProviderIds: string[] = [];
    const createdCredentialIds: string[] = [];
    const createdPolicyIds: string[] = [];
    const createdRouteIds: string[] = [];

    try {
      const migrations = await db.$queryRaw<Array<{ migration_name: string }>>`
        SELECT "migration_name"
        FROM "_prisma_migrations"
        WHERE "finished_at" IS NOT NULL
        ORDER BY "started_at"
      `;
      assert.equal(migrations.findIndex((migration) => migration.migration_name === compatibilityMigrationName), 54);
      assert.equal(migrations.findIndex((migration) => migration.migration_name === providerScopeMigrationName), 55);
      assert.equal(migrations.findIndex((migration) => migration.migration_name === platformPolicyMigrationName), 56);
      assert.equal(migrations.findIndex((migration) => migration.migration_name === defaultAppUserRoleMigrationName), 57);

      const enumValues = await db.$queryRaw<Array<{ value: string }>>`
        SELECT value::text
        FROM unnest(enum_range(NULL::"AppUserRole")) AS value
      `;
      assert.deepEqual(enumValues.map((row) => row.value), ["admin", "member", "user"]);

      const providerScopeValues = await db.$queryRaw<Array<{ value: string }>>`
        SELECT value::text
        FROM unnest(enum_range(NULL::"AiProviderScope")) AS value
      `;
      assert.deepEqual(providerScopeValues.map((row) => row.value), ["platform", "workspace", "user"]);

      const ownershipValues = await db.$queryRaw<Array<{ value: string }>>`
        SELECT value::text
        FROM unnest(enum_range(NULL::"ResourceOwnershipState")) AS value
      `;
      assert.deepEqual(ownershipValues.map((row) => row.value), ["legacy_pending", "ambiguous", "confirmed"]);

      const offerPolicyStatusValues = await db.$queryRaw<Array<{ value: string }>>`
        SELECT value::text
        FROM unnest(enum_range(NULL::"PlatformGrantOfferPolicyStatus")) AS value
      `;
      assert.deepEqual(offerPolicyStatusValues.map((row) => row.value), ["draft", "active", "retired"]);

      const defaultRouteStatusValues = await db.$queryRaw<Array<{ value: string }>>`
        SELECT value::text
        FROM unnest(enum_range(NULL::"PlatformDefaultAiRouteStatus")) AS value
      `;
      assert.deepEqual(defaultRouteStatusValues.map((row) => row.value), ["draft", "verified", "active", "retired"]);

      const defaultScopeRows = await db.$queryRaw<Array<{ column_default: string | null }>>`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'AiProviderConnection'
          AND column_name = 'scope'
      `;
      assert.equal(defaultScopeRows.length, 1);
      assert.match(defaultScopeRows[0]?.column_default ?? "", /'platform'::"AiProviderScope"/u);

      const scopeConstraintRows = await db.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public."AiProviderConnection"'::regclass
          AND conname = 'AiProviderConnection_scope_check'
      `;
      assert.equal(scopeConstraintRows.length, 1);
      assert.match(scopeConstraintRows[0]!.definition, /'platform'/u);
      assert.match(scopeConstraintRows[0]!.definition, /'workspace'/u);
      assert.match(scopeConstraintRows[0]!.definition, /'user'/u);
      assert.match(scopeConstraintRows[0]!.definition, /'legacy_pending'/u);
      assert.match(scopeConstraintRows[0]!.definition, /'ambiguous'/u);
      assert.match(scopeConstraintRows[0]!.definition, /'confirmed'/u);

      const ownershipDefaults = await db.$queryRaw<Array<{ table_name: string; column_default: string | null }>>`
        SELECT table_name, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'ownershipState'
          AND table_name IN ('GitConnection', 'McpConnection', 'AiProviderConnection')
        ORDER BY table_name
      `;
      assert.deepEqual(
        ownershipDefaults.map((row) => [row.table_name, row.column_default]),
        [
          ["AiProviderConnection", `'legacy_pending'::\"ResourceOwnershipState\"`],
          ["GitConnection", `'legacy_pending'::\"ResourceOwnershipState\"`],
          ["McpConnection", `'legacy_pending'::\"ResourceOwnershipState\"`],
        ],
      );

      const appUserRoleDefault = await db.$queryRaw<Array<{ column_default: string | null }>>`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'AppUser'
          AND column_name = 'role'
      `;
      assert.deepEqual(appUserRoleDefault, [{ column_default: `'user'::"AppUserRole"` }]);

      const invitationUpdatedAtDefault = await db.$queryRaw<Array<{ column_default: string | null }>>`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'WorkspaceInvitation'
          AND column_name = 'updatedAt'
      `;
      assert.deepEqual(invitationUpdatedAtDefault, [{ column_default: null }]);

      const invalidProviderId = randomUUID();
      const invalidProviderCredentialId = randomUUID();
      try {
        await db.externalCredential.create({
          data: {
            id: invalidProviderCredentialId,
            kind: "aiProvider",
            ciphertext: Buffer.from([1]),
            nonce: Buffer.from([2]),
            authTag: Buffer.from([3]),
            maskedSuffix: "gate",
            secretFingerprint: "a".repeat(64),
          },
        });
        await assert.rejects(
          () => db.$executeRaw`
            INSERT INTO "AiProviderConnection"
              ("id", "name", "kind", "scope", "protocol", "baseUrl", "credentialId", "status", "createdAt", "updatedAt")
            VALUES
              (${invalidProviderId}, ${`phase-a-invalid-user-${suffix}`}, 'openai'::"AiProviderKind", 'user'::"AiProviderScope", 'chat_completions'::"AiProviderProtocol", 'https://api.openai.com/v1', ${invalidProviderCredentialId}, 'configured'::"AiProviderConnectionStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `,
          (error: unknown) => String(error).includes("AiProviderConnection_scope_check"),
        );
      } finally {
        await db.aiProviderConnection.deleteMany({ where: { id: invalidProviderId } });
        await db.externalCredential.deleteMany({ where: { id: invalidProviderCredentialId } });
      }

      const roleRows = [
        { id: userIds[0]!, username: `phase-a-admin-${suffix}`, role: "admin" as const },
        { id: userIds[1]!, username: `phase-a-legacy-member-${suffix}`, role: "member" as const },
        { id: userIds[2]!, username: `phase-a-user-${suffix}`, role: "user" as const },
      ];
      for (const roleRow of roleRows) await db.appUser.create({ data: roleRow });
      const defaultUser = await db.appUser.create({
        data: { id: userIds[3]!, username: `phase-a-default-${suffix}` },
      });
      assert.equal(defaultUser.role, "user");

      const persisted = await db.appUser.findMany({
        where: { id: { in: userIds } },
        select: { id: true, role: true },
      });
      const persistedRoles = new Map(persisted.map((row) => [row.id, row.role]));
      for (const roleRow of roleRows) assert.equal(persistedRoles.get(roleRow.id), roleRow.role);
      assert.equal(persistedRoles.get(defaultUser.id), "user");

      const adminId = userIds[0]!;
      const ownerId = userIds[1]!;
      const userId = userIds[2]!;
      const defaultUserId = userIds[3]!;
      const now = new Date("2026-09-03T00:00:00.000Z");

      await db.$transaction(async (tx) => {
        await grantWorkspaceMembership(tx, {
          workspaceId: defaultWorkspaceId,
          userId: ownerId,
          role: "owner",
          actorId: adminId,
          reason: "phase_a_schema_gate_workspace_owner",
        });
      });

      const legacyGit = await db.gitConnection.create({
        data: {
          id: randomUUID(),
          name: `phase-a-git-legacy-${suffix}`,
          providerKind: "github",
          transport: "https",
          baseUrl: "https://github.com",
          authKind: "none",
          createdById: adminId,
        },
      });
      createdGitConnectionIds.push(legacyGit.id);
      assert.equal(legacyGit.ownerUserId, null);
      assert.equal(legacyGit.ownershipState, "legacyPending");

      const confirmedGit = await db.gitConnection.create({
        data: {
          id: randomUUID(),
          name: `phase-a-git-confirmed-${suffix}`,
          providerKind: "github",
          transport: "https",
          baseUrl: "https://github.com",
          authKind: "none",
          createdById: adminId,
          ownerUserId: ownerId,
          ownershipState: "confirmed",
        },
      });
      createdGitConnectionIds.push(confirmedGit.id);
      assert.equal(confirmedGit.ownerUserId, ownerId);
      assert.equal(confirmedGit.ownershipState, "confirmed");

      await assertPostgresConstraint(
        () => db.gitConnection.create({
          data: {
            id: randomUUID(),
            name: `phase-a-git-confirmed-no-owner-${suffix}`,
            providerKind: "github",
            transport: "https",
            baseUrl: "https://github.com",
            authKind: "none",
            createdById: adminId,
            ownershipState: "confirmed",
          },
        }),
        "23514",
        "GitConnection_ownership_check",
      );
      await assertPostgresConstraint(
        () => db.gitConnection.create({
          data: {
            id: randomUUID(),
            name: `phase-a-git-pending-owner-${suffix}`,
            providerKind: "github",
            transport: "https",
            baseUrl: "https://github.com",
            authKind: "none",
            createdById: adminId,
            ownerUserId: ownerId,
            ownershipState: "legacyPending",
          },
        }),
        "23514",
        "GitConnection_ownership_check",
      );

      const legacyMcp = await db.mcpConnection.create({
        data: {
          id: randomUUID(),
          name: `phase-a-mcp-legacy-${suffix}`,
          endpointUrl: "https://mcp.example.test",
          authKind: "none",
          createdById: adminId,
        },
      });
      createdMcpConnectionIds.push(legacyMcp.id);
      assert.equal(legacyMcp.ownerUserId, null);
      assert.equal(legacyMcp.ownershipState, "legacyPending");

      const confirmedMcp = await db.mcpConnection.create({
        data: {
          id: randomUUID(),
          name: `phase-a-mcp-confirmed-${suffix}`,
          endpointUrl: "https://mcp.example.test",
          authKind: "none",
          createdById: adminId,
          ownerUserId: ownerId,
          ownershipState: "confirmed",
        },
      });
      createdMcpConnectionIds.push(confirmedMcp.id);
      assert.equal(confirmedMcp.ownerUserId, ownerId);
      assert.equal(confirmedMcp.ownershipState, "confirmed");

      await assertPostgresConstraint(
        () => db.mcpConnection.create({
          data: {
            id: randomUUID(),
            name: `phase-a-mcp-confirmed-no-owner-${suffix}`,
            endpointUrl: "https://mcp.example.test",
            authKind: "none",
            createdById: adminId,
            ownershipState: "confirmed",
          },
        }),
        "23514",
        "McpConnection_ownership_check",
      );
      await assertPostgresConstraint(
        () => db.mcpConnection.create({
          data: {
            id: randomUUID(),
            name: `phase-a-mcp-pending-owner-${suffix}`,
            endpointUrl: "https://mcp.example.test",
            authKind: "none",
            createdById: adminId,
            ownerUserId: ownerId,
            ownershipState: "legacyPending",
          },
        }),
        "23514",
        "McpConnection_ownership_check",
      );

      async function createProviderCredential(): Promise<string> {
        const credentialId = randomUUID();
        await db.externalCredential.create({
          data: {
            id: credentialId,
            kind: "aiProvider",
            ciphertext: Buffer.from([1]),
            nonce: Buffer.from([2]),
            authTag: Buffer.from([3]),
            maskedSuffix: "gate",
            secretFingerprint: randomUUID().replaceAll("-", "").padEnd(64, "a"),
          },
        });
        createdCredentialIds.push(credentialId);
        return credentialId;
      }

      const platformProvider = await db.aiProviderConnection.create({
        data: {
          id: randomUUID(),
          name: `phase-a-provider-platform-${suffix}`,
          kind: "openai",
          scope: "platform",
          baseUrl: "https://api.openai.com/v1",
          credentialId: await createProviderCredential(),
          status: "configured",
        },
      });
      createdProviderIds.push(platformProvider.id);
      assert.equal(platformProvider.ownershipState, "legacyPending");
      assert.equal(platformProvider.workspaceId, null);
      assert.equal(platformProvider.ownerUserId, null);

      const workspaceProvider = await db.aiProviderConnection.create({
        data: {
          id: randomUUID(),
          name: `phase-a-provider-workspace-${suffix}`,
          kind: "deepseek",
          scope: "workspace",
          workspaceId: defaultWorkspaceId,
          ownerUserId: ownerId,
          baseUrl: "https://api.deepseek.com/v1",
          credentialId: await createProviderCredential(),
          status: "configured",
        },
      });
      createdProviderIds.push(workspaceProvider.id);
      assert.equal(workspaceProvider.ownershipState, "legacyPending");

      const userProvider = await db.aiProviderConnection.create({
        data: {
          id: randomUUID(),
          name: `phase-a-provider-user-${suffix}`,
          kind: "qwen",
          scope: "user",
          ownerUserId: userId,
          ownershipState: "confirmed",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          credentialId: await createProviderCredential(),
          status: "configured",
        },
      });
      createdProviderIds.push(userProvider.id);
      assert.equal(userProvider.ownershipState, "confirmed");

      const invalidProviderCases = [
        {
          label: "platform-workspace",
          scope: "platform" as const,
          workspaceId: defaultWorkspaceId,
          ownerUserId: null,
          ownershipState: "legacyPending" as const,
        },
        {
          label: "workspace-owner",
          scope: "workspace" as const,
          workspaceId: defaultWorkspaceId,
          ownerUserId: null,
          ownershipState: "legacyPending" as const,
        },
        {
          label: "user-state",
          scope: "user" as const,
          workspaceId: null,
          ownerUserId: userId,
          ownershipState: "legacyPending" as const,
        },
        {
          label: "user-workspace",
          scope: "user" as const,
          workspaceId: defaultWorkspaceId,
          ownerUserId: userId,
          ownershipState: "confirmed" as const,
        },
      ];
      for (const invalidCase of invalidProviderCases) {
        await assertPostgresConstraint(
          async () => db.aiProviderConnection.create({
            data: {
              id: randomUUID(),
              name: `phase-a-provider-invalid-${invalidCase.label}-${suffix}`,
              kind: "openai",
              scope: invalidCase.scope,
              workspaceId: invalidCase.workspaceId,
              ownerUserId: invalidCase.ownerUserId,
              ownershipState: invalidCase.ownershipState,
              baseUrl: "https://api.openai.com/v1",
              credentialId: await createProviderCredential(),
              status: "configured",
            },
          }),
          "23514",
          "AiProviderConnection_scope_check",
        );
      }

      await db.appUser.update({ where: { id: userId }, data: { disabledAt: now } });
      const legacyDisabledUser = await db.appUser.findUniqueOrThrow({
        where: { id: userId },
        select: { disabledAt: true, disabledReason: true, disabledById: true },
      });
      assert.equal(legacyDisabledUser.disabledAt?.toISOString(), now.toISOString());
      assert.equal(legacyDisabledUser.disabledReason, null);
      assert.equal(legacyDisabledUser.disabledById, null);
      await assertPostgresConstraint(
        () => db.appUser.update({ where: { id: userId }, data: { disabledAt: null, disabledReason: "missing disabled timestamp" } }),
        "23514",
        "AppUser_disabled_metadata_check",
      );
      await db.appUser.update({
        where: { id: userId },
        data: { disabledAt: now, disabledReason: "phase-a audit", disabledById: adminId },
      });
      const auditedDisabledUser = await db.appUser.findUniqueOrThrow({
        where: { id: userId },
        select: { disabledReason: true, disabledById: true },
      });
      assert.equal(auditedDisabledUser.disabledReason, "phase-a audit");
      assert.equal(auditedDisabledUser.disabledById, adminId);
      await db.appUser.update({
        where: { id: userId },
        data: { disabledAt: null, disabledReason: null, disabledById: null },
      });

      const subscription = await db.membershipSubscription.create({
        data: {
          id: randomUUID(),
          userId: defaultUserId,
          status: "active",
          startsAt: new Date("2026-09-01T00:00:00.000Z"),
          expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        },
      });
      createdMembershipSubscriptionIds.push(subscription.id);
      await assertPostgresConstraint(
        () => db.membershipSubscription.update({ where: { id: subscription.id }, data: { revocationReason: "active cannot carry a reason" } }),
        "23514",
        "MembershipSubscription_revocation_check",
      );
      await db.membershipSubscription.update({
        where: { id: subscription.id },
        data: { status: "revoked", revokedAt: now, revokedById: adminId, revocationReason: "phase-a revoke" },
      });
      const auditedSubscription = await db.membershipSubscription.findUniqueOrThrow({
        where: { id: subscription.id },
        select: { status: true, revokedAt: true, revocationReason: true },
      });
      assert.equal(auditedSubscription.status, "revoked");
      assert.equal(auditedSubscription.revokedAt?.toISOString(), now.toISOString());
      assert.equal(auditedSubscription.revocationReason, "phase-a revoke");
      await db.membershipSubscription.update({ where: { id: subscription.id }, data: { revocationReason: null } });

      const invitation = await db.workspaceInvitation.create({
        data: {
          id: randomUUID(),
          workspaceId: defaultWorkspaceId,
         email: `phase-a-${suffix}@example.com`,
         tokenHash: `${"a".repeat(63)}${suffix.slice(0, 1)}`,
          requestKey: `phase-a-request-${suffix}`,
          requestFingerprint: "1".repeat(64),
         workspaceRole: "member",
          invitedById: adminId,
          expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        },
      });
      createdInvitationIds.push(invitation.id);
      assert.ok(invitation.updatedAt instanceof Date);
      await db.workspaceInvitation.update({
        where: { id: invitation.id },
        data: {
          revokedAt: now,
          revokedById: ownerId,
          revocationReason: "phase-a revoke",
          revocationRequestKey: `phase-a-revoke-${suffix}`,
          revocationRequestFingerprint: "2".repeat(64),
          revocationImpactFingerprint: "3".repeat(64),
          version: invitation.version + 1,
        },
      });
      const auditedInvitation = await db.workspaceInvitation.findUniqueOrThrow({
        where: { id: invitation.id },
        select: { revokedAt: true, revokedById: true, revocationReason: true, updatedAt: true },
      });
      assert.equal(auditedInvitation.revokedAt?.toISOString(), now.toISOString());
      assert.equal(auditedInvitation.revokedById, ownerId);
      assert.equal(auditedInvitation.revocationReason, "phase-a revoke");
      assert.ok(auditedInvitation.updatedAt instanceof Date);
      await assertPostgresConstraint(
        () => db.workspaceInvitation.update({ where: { id: invitation.id }, data: { revokedAt: null, revocationReason: "missing revoked timestamp" } }),
        "23514",
        "WorkspaceInvitation_revocation_check",
      );

      assert.equal(await db.platformGrantOfferPolicy.count(), 0);
      assert.equal(await db.platformDefaultAiRoute.count(), 0);

      const activePolicy = await db.platformGrantOfferPolicy.create({
        data: {
          id: randomUUID(),
          offerVersion: `phase-a-offer-${suffix}-1`,
          status: "active",
          amount: 500_000,
          validForDays: 30,
          eligibilityKey: "signup",
          createdById: adminId,
          updatedById: adminId,
        },
      });
      createdPolicyIds.push(activePolicy.id);
      await assertPostgresConstraint(
        () => db.platformGrantOfferPolicy.create({
          data: {
            id: randomUUID(),
            offerVersion: `phase-a-offer-${suffix}-2`,
            status: "active",
            amount: 1,
            validForDays: 1,
            eligibilityKey: "signup",
            createdById: adminId,
            updatedById: adminId,
          },
        }),
        "23505",
        "PlatformGrantOfferPolicy_active_key",
      );
      await assertPostgresConstraint(
        () => db.platformGrantOfferPolicy.update({ where: { id: activePolicy.id }, data: { amount: 0 } }),
        "23514",
        "PlatformGrantOfferPolicy_amount_check",
      );
      await assertPostgresConstraint(
        () => db.platformGrantOfferPolicy.update({ where: { id: activePolicy.id }, data: { validForDays: 0 } }),
        "23514",
        "PlatformGrantOfferPolicy_amount_check",
      );

      const activeRoute = await db.platformDefaultAiRoute.create({
        data: {
          id: randomUUID(),
          operation: "projectAnalysis",
          version: 1,
          status: "active",
          providerConnectionId: platformProvider.id,
          modelId: "platform-analysis-v1",
          maxOutputTokens: 2048,
          createdById: adminId,
          updatedById: adminId,
        },
      });
      createdRouteIds.push(activeRoute.id);
      await assertPostgresConstraint(
        () => db.platformDefaultAiRoute.create({
          data: {
            id: randomUUID(),
            operation: "projectAnalysis",
            version: 2,
            status: "active",
            providerConnectionId: platformProvider.id,
            modelId: "platform-analysis-v2",
            maxOutputTokens: 2048,
            createdById: adminId,
            updatedById: adminId,
          },
        }),
        "23505",
        "PlatformDefaultAiRoute_operation_active_key",
      );
      await assertPostgresConstraint(
        () => db.platformDefaultAiRoute.update({ where: { id: activeRoute.id }, data: { version: 0 } }),
        "23514",
        "PlatformDefaultAiRoute_version_check",
      );
      await assertPostgresConstraint(
        () => db.platformDefaultAiRoute.update({ where: { id: activeRoute.id }, data: { quotaMultiplierBps: 0 } }),
        "23514",
        "PlatformDefaultAiRoute_quota_multiplier_check",
      );
      await assertPostgresConstraint(
        () => db.platformDefaultAiRoute.update({ where: { id: activeRoute.id }, data: { embeddingDimensions: 1 } }),
        "23514",
        "PlatformDefaultAiRoute_operation_payload_check",
      );
      await assertPostgresConstraint(
        () => db.platformDefaultAiRoute.update({ where: { id: activeRoute.id }, data: { maxOutputTokens: null } }),
        "23514",
        "PlatformDefaultAiRoute_operation_payload_check",
      );

      const embeddingRoute = await db.platformDefaultAiRoute.create({
        data: {
          id: randomUUID(),
          operation: "embedding",
          version: 1,
          status: "draft",
          providerConnectionId: platformProvider.id,
          modelId: "platform-embedding-v1",
          embeddingDimensions: 1536,
          maxOutputTokens: null,
          createdById: adminId,
          updatedById: adminId,
        },
      });
      createdRouteIds.push(embeddingRoute.id);
      await assertPostgresConstraint(
        () => db.platformDefaultAiRoute.update({ where: { id: embeddingRoute.id }, data: { embeddingDimensions: 0 } }),
        "23514",
        "PlatformDefaultAiRoute_operation_payload_check",
      );
      await assertPostgresConstraint(
        () => db.platformDefaultAiRoute.update({ where: { id: embeddingRoute.id }, data: { maxOutputTokens: 1 } }),
        "23514",
        "PlatformDefaultAiRoute_operation_payload_check",
      );
    } finally {
      try {
        await db.platformDefaultAiRoute.deleteMany({ where: { id: { in: createdRouteIds } } });
        await db.platformGrantOfferPolicy.deleteMany({ where: { id: { in: createdPolicyIds } } });
        await db.aiProviderConnection.deleteMany({ where: { id: { in: createdProviderIds } } });
        await db.gitConnection.deleteMany({ where: { id: { in: createdGitConnectionIds } } });
        await db.mcpConnection.deleteMany({ where: { id: { in: createdMcpConnectionIds } } });
        await db.workspaceInvitation.deleteMany({ where: { id: { in: createdInvitationIds } } });
        await db.membershipSubscription.deleteMany({ where: { id: { in: createdMembershipSubscriptionIds } } });
        await db.externalCredential.deleteMany({ where: { id: { in: createdCredentialIds } } });
        await db.appUser.deleteMany({ where: { id: { in: userIds } } });
      } finally {
        await db.$disconnect();
      }
    }
  },
);
