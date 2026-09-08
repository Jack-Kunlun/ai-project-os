import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  activatePlatformDefaultAiRoute,
  createPlatformDefaultAiRoute,
  getPlatformDefaultAiRouteReadiness,
  retirePlatformDefaultAiRoute,
  PlatformDefaultAiRouteError,
  validatePlatformDefaultAiRoute,
} from "../src/lib/platform-default-ai-routes";
import {
  deleteProviderConnection,
  confirmPlatformProviderOwnership,
  ProviderServiceError,
  updateProviderConnection,
} from "../src/lib/ai-providers";
import { getDb } from "../src/lib/db";

const shouldRun = process.env.PLATFORM_DEFAULT_AI_ROUTES_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_platform_default_routes_test";
const m59MigrationName = "20260904020000_add_platform_default_route_control_plane";
const m60MigrationName = "20260904030000_add_ai_provider_ownership_audit";

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("PLATFORM_DEFAULT_AI_ROUTES_TEST_DATABASE_URL_REQUIRED");
  }
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("PLATFORM_DEFAULT_AI_ROUTES_TEST_DATABASE_URL_INVALID");
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
    throw new Error("PLATFORM_DEFAULT_AI_ROUTES_TEST_DATABASE_URL_INVALID");
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  return String(error);
}

test(
  "platform default route control plane applies the full migration and preserves lifecycle fences",
  { skip: !shouldRun ? "PLATFORM_DEFAULT_AI_ROUTES_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    const providerId = randomUUID();
    const credentialId = randomUUID();
    const legacyProviderId = randomUUID();
    const legacyCredentialId = randomUUID();
    const configRaceProviderId = randomUUID();
    const configRaceCredentialId = randomUUID();
    const disableRaceProviderId = randomUUID();
    const disableRaceCredentialId = randomUUID();

    try {
      const migrations = await db.$queryRaw<Array<{ migration_name: string }>>`
        SELECT "migration_name"
        FROM "_prisma_migrations"
        WHERE "finished_at" IS NOT NULL
        ORDER BY "started_at"
      `;
      assert.equal(migrations.findIndex((migration) => migration.migration_name === m59MigrationName), 58);
      assert.equal(migrations.findIndex((migration) => migration.migration_name === m60MigrationName), 59);
      assert.ok(migrations.length >= 60);

      const auditActions = await db.$queryRaw<Array<{ value: string }>>`
        SELECT value::text
        FROM unnest(enum_range(NULL::"PlatformDefaultAiRouteAuditAction")) AS value
      `;
      assert.deepEqual(auditActions.map((row) => row.value), ["draft_created", "draft_updated", "validated", "activated", "retired"]);

      const configurationDefault = await db.$queryRaw<Array<{ column_default: string | null }>>`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'AiProviderConnection'
          AND column_name = 'configurationVersion'
      `;
      assert.equal(configurationDefault.length, 1);
      assert.match(configurationDefault[0]?.column_default ?? "", /1/u);

      const routeColumns = await db.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'PlatformDefaultAiRoute'
          AND column_name IN ('validatedProviderConfigurationVersion', 'validatedAt')
        ORDER BY column_name
      `;
      assert.deepEqual(routeColumns, [
        { column_name: "validatedAt", is_nullable: "YES" },
        { column_name: "validatedProviderConfigurationVersion", is_nullable: "YES" },
      ]);

      const triggerRows = await db.$queryRaw<Array<{ tgname: string }>>`
        SELECT tgname
        FROM pg_trigger
        WHERE tgrelid = 'public."PlatformDefaultAiRouteAudit"'::regclass
          AND tgname = 'PlatformDefaultAiRouteAudit_immutable_guard'
          AND NOT tgisinternal
      `;
      assert.deepEqual(triggerRows, [{ tgname: "PlatformDefaultAiRouteAudit_immutable_guard" }]);
      const ownershipTriggerRows = await db.$queryRaw<Array<{ tgname: string }>>`
        SELECT tgname
        FROM pg_trigger
        WHERE tgrelid = 'public."AiProviderOwnershipAudit"'::regclass
          AND tgname = 'AiProviderOwnershipAudit_immutable_guard'
          AND NOT tgisinternal
      `;
      assert.deepEqual(ownershipTriggerRows, [{ tgname: "AiProviderOwnershipAudit_immutable_guard" }]);

      await db.appUser.create({ data: { id: adminId, username: `platform-route-admin-${suffix}`, role: "admin" } });
      await db.externalCredential.create({
        data: {
          id: credentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([1]),
          nonce: Buffer.from([2]),
          authTag: Buffer.from([3]),
          maskedSuffix: "gate",
          secretFingerprint: "b".repeat(64),
        },
      });
      const provider = await db.aiProviderConnection.create({
        data: {
          id: providerId,
          name: `Platform route provider ${suffix}`,
          kind: "openai",
          scope: "platform",
          ownershipState: "confirmed",
          baseUrl: "https://api.openai.com/v1",
          credentialId,
          defaultGenerationModelId: "gpt-4.1-mini",
          defaultVisionModelId: "gpt-4.1-mini",
          defaultEmbeddingModelId: "text-embedding-3-small",
          embeddingDimensions: 1536,
          status: "verified",
          lastTestedAt: new Date(),
        },
      });
      assert.equal(provider.configurationVersion, 1);

      await db.externalCredential.create({
        data: {
          id: legacyCredentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([4]),
          nonce: Buffer.from([5]),
          authTag: Buffer.from([6]),
          maskedSuffix: "legacy",
          secretFingerprint: "c".repeat(64),
        },
      });
      const legacyProvider = await db.aiProviderConnection.create({
        data: {
          id: legacyProviderId,
          name: `Legacy platform provider ${suffix}`,
          kind: "openai",
          scope: "platform",
          ownershipState: "legacyPending",
          baseUrl: "https://api.openai.com/v1",
          credentialId: legacyCredentialId,
          defaultGenerationModelId: "gpt-4.1-mini",
          status: "configured",
        },
      });
      const concurrentConfirmations = await Promise.all([
        confirmPlatformProviderOwnership(
          legacyProvider.id,
          { confirmationName: legacyProvider.name, reason: "历史平台托管归属已核对 A" },
          { id: adminId, role: "admin" },
          db,
        ),
        confirmPlatformProviderOwnership(
          legacyProvider.id,
          { confirmationName: legacyProvider.name, reason: "历史平台托管归属已核对 B" },
          { id: adminId, role: "admin" },
          db,
        ),
      ]);
      const [firstConfirmation, secondConfirmation] = concurrentConfirmations;
      assert.ok(firstConfirmation);
      assert.ok(secondConfirmation);
      assert.deepEqual([firstConfirmation.ownershipState, secondConfirmation.ownershipState], ["confirmed", "confirmed"]);
      const ownershipAudit = await db.aiProviderOwnershipAudit.findMany({
        where: { providerConnectionId: legacyProvider.id },
      });
      assert.equal(ownershipAudit.length, 1);
      assert.deepEqual(ownershipAudit[0], {
        id: ownershipAudit[0]?.id,
        providerConnectionId: legacyProvider.id,
        actorId: adminId,
        action: "legacyOwnershipConfirmed",
        reason: ownershipAudit[0]?.reason,
        oldScope: "platform",
        newScope: "platform",
        oldOwnershipState: "legacyPending",
        newOwnershipState: "confirmed",
        oldWorkspacePresent: false,
        newWorkspacePresent: false,
        oldOwnerPresent: false,
        newOwnerPresent: false,
        createdAt: ownershipAudit[0]?.createdAt,
      });
      assert.ok(["历史平台托管归属已核对 A", "历史平台托管归属已核对 B"].includes(ownershipAudit[0]?.reason ?? ""));
      await confirmPlatformProviderOwnership(
        legacyProvider.id,
        { confirmationName: legacyProvider.name, reason: "重复确认保持幂等" },
        { id: adminId, role: "admin" },
        db,
      );
      assert.equal(await db.aiProviderOwnershipAudit.count({ where: { providerConnectionId: legacyProvider.id } }), 1);

      await db.externalCredential.create({
        data: {
          id: configRaceCredentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([7]),
          nonce: Buffer.from([8]),
          authTag: Buffer.from([9]),
          maskedSuffix: "config-race",
          secretFingerprint: "d".repeat(64),
        },
      });
      const configRaceProvider = await db.aiProviderConnection.create({
        data: {
          id: configRaceProviderId,
          name: `Configuration race provider ${suffix}`,
          kind: "openai",
          scope: "platform",
          ownershipState: "confirmed",
          baseUrl: "https://api.openai.com/v1",
          credentialId: configRaceCredentialId,
          defaultGenerationModelId: "gpt-4.1-mini",
          status: "verified",
          lastTestedAt: new Date(),
        },
      });
      await db.externalCredential.create({
        data: {
          id: disableRaceCredentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([10]),
          nonce: Buffer.from([11]),
          authTag: Buffer.from([12]),
          maskedSuffix: "disable-race",
          secretFingerprint: "e".repeat(64),
        },
      });
      const disableRaceProvider = await db.aiProviderConnection.create({
        data: {
          id: disableRaceProviderId,
          name: `Disable race provider ${suffix}`,
          kind: "openai",
          scope: "platform",
          ownershipState: "confirmed",
          baseUrl: "https://api.openai.com/v1",
          credentialId: disableRaceCredentialId,
          defaultGenerationModelId: "gpt-4.1-mini",
          status: "verified",
          lastTestedAt: new Date(),
        },
      });

      const configurationRaceDraft = await createPlatformDefaultAiRoute({
        operation: "autoExtract",
        providerConnectionId: configRaceProvider.id,
        modelId: "gpt-4.1-mini",
        maxOutputTokens: 2048,
      }, { id: adminId, role: "admin" }, db);
      const configurationRaceVerified = await validatePlatformDefaultAiRoute(
        configurationRaceDraft.id,
        { id: adminId, role: "admin" },
        db,
        configurationRaceDraft.updatedAt,
      );
      const configurationRaceResults = await Promise.allSettled([
        activatePlatformDefaultAiRoute(
          configurationRaceVerified.id,
          { id: adminId, role: "admin" },
          db,
          configurationRaceVerified.updatedAt,
        ),
        updateProviderConnection(configRaceProvider.id, { generationModelId: "gpt-4.1" }, { id: adminId, role: "admin" }, db),
      ]);
      const configurationActivation = configurationRaceResults[0];
      const configurationUpdate = configurationRaceResults[1];
      assert.equal(configurationUpdate?.status, "fulfilled");
      const configurationRaceRoute = await db.platformDefaultAiRoute.findUniqueOrThrow({ where: { id: configurationRaceDraft.id } });
      const configurationRaceProviderAfter = await db.aiProviderConnection.findUniqueOrThrow({ where: { id: configRaceProvider.id } });
      if (configurationActivation?.status === "fulfilled") {
        assert.equal(configurationRaceRoute.status, "active");
        const configurationReadiness = await getPlatformDefaultAiRouteReadiness({ id: adminId, role: "admin" }, db);
        assert.equal(configurationReadiness.operations.autoExtract.code, "configuration-changed");
        assert.equal(configurationRaceProviderAfter.status, "configured");
      } else {
        assert.ok(configurationActivation?.status === "rejected");
        assert.ok(configurationActivation.reason instanceof PlatformDefaultAiRouteError);
        assert.ok([
          "PLATFORM_AI_ROUTE_CONFLICT",
          "PLATFORM_AI_ROUTE_NOT_VALIDATED",
          "PLATFORM_AI_ROUTE_CONFIGURATION_CHANGED",
        ].includes(configurationActivation.reason.code));
        assert.equal(configurationRaceRoute.status, "verified");
        assert.equal(configurationRaceProviderAfter.status, "configured");
        assert.equal(await db.platformDefaultAiRouteAudit.count({ where: { routeId: configurationRaceDraft.id, action: "activated" } }), 0);
      }
      const configurationRaceRouteForCleanup = await db.platformDefaultAiRoute.findUniqueOrThrow({ where: { id: configurationRaceDraft.id } });
      await retirePlatformDefaultAiRoute(
        configurationRaceRouteForCleanup.id,
        { id: adminId, role: "admin" },
        "并发配置变更测试清理",
        db,
        configurationRaceRouteForCleanup.updatedAt,
      );

      const disableRaceDraft = await createPlatformDefaultAiRoute({
        operation: "generateWithContext",
        providerConnectionId: disableRaceProvider.id,
        modelId: "gpt-4.1-mini",
        maxOutputTokens: 2048,
      }, { id: adminId, role: "admin" }, db);
      const disableRaceVerified = await validatePlatformDefaultAiRoute(
        disableRaceDraft.id,
        { id: adminId, role: "admin" },
        db,
        disableRaceDraft.updatedAt,
      );
      const disableRaceResults = await Promise.allSettled([
        activatePlatformDefaultAiRoute(
          disableRaceVerified.id,
          { id: adminId, role: "admin" },
          db,
          disableRaceVerified.updatedAt,
        ),
        updateProviderConnection(disableRaceProvider.id, { enabled: false }, { id: adminId, role: "admin" }, db),
      ]);
      const disableActivation = disableRaceResults[0];
      const disableUpdate = disableRaceResults[1];
      const disableRaceRoute = await db.platformDefaultAiRoute.findUniqueOrThrow({ where: { id: disableRaceDraft.id } });
      const disableRaceProviderAfter = await db.aiProviderConnection.findUniqueOrThrow({ where: { id: disableRaceProvider.id } });
      if (disableActivation?.status === "fulfilled") {
        assert.equal(disableUpdate?.status, "rejected");
        assert.equal((disableUpdate?.reason as ProviderServiceError).code, "AI_PROVIDER_IN_USE");
        assert.equal(disableRaceRoute.status, "active");
        assert.equal(disableRaceProviderAfter.status, "verified");
      } else {
        assert.equal(disableUpdate?.status, "fulfilled");
        assert.ok(disableActivation?.status === "rejected");
        assert.ok(disableActivation.reason instanceof PlatformDefaultAiRouteError);
        // Disabling increments the provider configuration version first, so
        // activation's version fence runs before its provider-status check.
        assert.equal((disableActivation.reason as PlatformDefaultAiRouteError).code, "PLATFORM_AI_ROUTE_CONFIGURATION_CHANGED");
        assert.equal(disableRaceRoute.status, "verified");
        assert.equal(disableRaceProviderAfter.status, "disabled");
        assert.equal(await db.platformDefaultAiRouteAudit.count({ where: { routeId: disableRaceDraft.id, action: "activated" } }), 0);
      }
      const disableRaceRouteForCleanup = await db.platformDefaultAiRoute.findUniqueOrThrow({ where: { id: disableRaceDraft.id } });
      await retirePlatformDefaultAiRoute(
        disableRaceRouteForCleanup.id,
        { id: adminId, role: "admin" },
        "并发停用测试清理",
        db,
        disableRaceRouteForCleanup.updatedAt,
      );

      const concurrentDrafts = await Promise.all([
        createPlatformDefaultAiRoute({
          operation: "sourceSummary",
          providerConnectionId: provider.id,
          modelId: "gpt-4.1-mini",
          maxOutputTokens: 2048,
        }, { id: adminId, role: "admin" }, db),
        createPlatformDefaultAiRoute({
          operation: "sourceSummary",
          providerConnectionId: provider.id,
          modelId: "gpt-4.1-mini",
          maxOutputTokens: 2048,
        }, { id: adminId, role: "admin" }, db),
      ]);
      assert.deepEqual(concurrentDrafts.map((route) => route.version).sort((left, right) => left - right), [1, 2]);

      const first = await createPlatformDefaultAiRoute({
        operation: "projectAnalysis",
        providerConnectionId: provider.id,
        modelId: "gpt-4.1-mini",
        maxOutputTokens: 2048,
      }, { id: adminId, role: "admin" }, db);
      assert.equal(first.version, 1);
      const verifiedFirst = await validatePlatformDefaultAiRoute(first.id, { id: adminId, role: "admin" }, db, first.updatedAt);
      await activatePlatformDefaultAiRoute(verifiedFirst.id, { id: adminId, role: "admin" }, db, verifiedFirst.updatedAt);

      const second = await createPlatformDefaultAiRoute({
        operation: "projectAnalysis",
        providerConnectionId: provider.id,
        modelId: "gpt-4.1-mini",
        maxOutputTokens: 2048,
      }, { id: adminId, role: "admin" }, db);
      assert.equal(second.version, 2);
      const verifiedSecond = await validatePlatformDefaultAiRoute(second.id, { id: adminId, role: "admin" }, db, second.updatedAt);
      const activeSecond = await activatePlatformDefaultAiRoute(verifiedSecond.id, { id: adminId, role: "admin" }, db, verifiedSecond.updatedAt);
      assert.equal(activeSecond.status, "active");
      assert.equal(await db.platformDefaultAiRoute.count({ where: { operation: "projectAnalysis", status: "active" } }), 1);
      assert.equal(await db.platformDefaultAiRoute.count({ where: { id: first.id, status: "retired" } }), 1);

      const ready = await getPlatformDefaultAiRouteReadiness({ id: adminId, role: "admin" }, db);
      assert.equal(ready.operations.projectAnalysis.code, "ready");
      assert.equal(ready.operations.projectAnalysis.activeRouteVersion, 2);
      assert.equal(ready.runtimeConnected, true);

      const audit = await db.platformDefaultAiRouteAudit.findFirstOrThrow({ where: { routeId: first.id }, orderBy: { createdAt: "asc" } });
      await assert.rejects(
        () => db.platformDefaultAiRouteAudit.update({ where: { id: audit.id }, data: { reason: "tampered" } }),
        (error: unknown) => errorText(error).includes("platform default AI route audit is immutable"),
      );
      await assert.rejects(
        () => db.platformDefaultAiRouteAudit.delete({ where: { id: audit.id } }),
        (error: unknown) => errorText(error).includes("platform default AI route audit is immutable"),
      );
      const ownershipAuditForGuard = await db.aiProviderOwnershipAudit.findFirstOrThrow({
        where: { providerConnectionId: legacyProvider.id },
      });
      await assert.rejects(
        () => db.aiProviderOwnershipAudit.update({ where: { id: ownershipAuditForGuard.id }, data: { reason: "tampered" } }),
        (error: unknown) => errorText(error).includes("AI provider ownership audit is immutable"),
      );
      await assert.rejects(
        () => db.aiProviderOwnershipAudit.delete({ where: { id: ownershipAuditForGuard.id } }),
        (error: unknown) => errorText(error).includes("AI provider ownership audit is immutable"),
      );

      const renamed = await updateProviderConnection(provider.id, { name: `Renamed platform route provider ${suffix}` }, { id: adminId, role: "admin" }, db);
      assert.equal(renamed.configurationVersion, 1);
      const changed = await updateProviderConnection(provider.id, { generationModelId: "gpt-4.1-nano" }, { id: adminId, role: "admin" }, db);
      assert.equal(changed.configurationVersion, 2);
      assert.equal(changed.status, "configured");
      const stale = await getPlatformDefaultAiRouteReadiness({ id: adminId, role: "admin" }, db);
      assert.equal(stale.operations.projectAnalysis.code, "configuration-changed");

      await assert.rejects(
        () => updateProviderConnection(provider.id, { enabled: false }, { id: adminId, role: "admin" }, db),
        (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_IN_USE",
      );
      await retirePlatformDefaultAiRoute(activeSecond.id, { id: adminId, role: "admin" }, "retire before disable", db, activeSecond.updatedAt);
      const disabled = await updateProviderConnection(provider.id, { enabled: false }, { id: adminId, role: "admin" }, db);
      assert.equal(disabled.status, "disabled");
      assert.equal(disabled.configurationVersion, 3);
      await assert.rejects(
        () => deleteProviderConnection(provider.id, { confirmationName: disabled.name }, { id: adminId, role: "admin" }, db),
        (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_IN_USE",
      );
      const disabledReadiness = await getPlatformDefaultAiRouteReadiness({ id: adminId, role: "admin" }, db);
      assert.equal(disabledReadiness.operations.projectAnalysis.code, "missing");
    } finally {
      await db.$disconnect();
    }
  },
);
