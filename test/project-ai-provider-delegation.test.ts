import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { POSTGRES_GATES } from "../scripts/postgres-gate-contract";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync(
  "prisma/migrations/20260904090000_add_project_ai_provider_delegations/migration.sql",
  "utf8",
);
const safetySwitchMigration = readFileSync(
  "prisma/migrations/20260904100000_allow_delegation_owner_safety_switch/migration.sql",
  "utf8",
);
const personalMemoryInvalidationMigration = readFileSync(
  "prisma/migrations/20260904120000_harden_personal_memory_runtime_invalidation/migration.sql",
  "utf8",
);

test("personal project model delegation has an independent schema surface", () => {
  assert.match(schema, /enum ProjectAiProviderDelegationStatus/u);
  assert.match(schema, /enum ProjectAiProviderDelegationActorKind/u);
  assert.match(schema, /enum ProjectAiEffectiveRouteSelectionSource/u);
  assert.match(schema, /model ProjectAiProviderDelegation \{/u);
  assert.match(schema, /model ProjectAiEffectiveRouteSelection \{/u);
  assert.match(schema, /model ProjectAiProviderDelegationAudit \{/u);
  assert.match(schema, /ownerProjectMembershipId\s+String\s+@db\.Uuid/u);
  assert.match(schema, /connectionOwnerSubscriptionId\s+String\s+@db\.Uuid/u);
  assert.match(schema, /projectConfirmedProjectMembershipId\s+String\?\s+@db\.Uuid/u);
  assert.match(schema, /selectedByProjectMembershipId\s+String\s+@db\.Uuid/u);
  assert.match(schema, /terminalActorKind\s+ProjectAiProviderDelegationActorKind\?/u);
  assert.match(schema, /delegationFingerprint\s+String\s+@db\.Char\(64\)/u);
  assert.match(schema, /effectiveRouteSelections\s+ProjectAiEffectiveRouteSelection\[\]/u);
  assert.match(schema, /aiProviderDelegations\s+ProjectAiProviderDelegation\[\]/u);
  assert.match(schema, /aiEffectiveRouteSelections\s+ProjectAiEffectiveRouteSelection\[\]/u);
});

test("delegation migration is additive and leaves legacy routes untouched", () => {
  assert.match(migration, /CREATE TABLE "ProjectAiProviderDelegation"/u);
  assert.match(migration, /CREATE TABLE "ProjectAiEffectiveRouteSelection"/u);
  assert.match(migration, /CREATE TABLE "ProjectAiProviderDelegationAudit"/u);
  assert.match(migration, /ProjectAiProviderDelegation_live_project_operation_key/u);
  assert.match(migration, /WHERE "status" IN \('draft', 'owner_confirmed', 'active'\)/u);
  assert.match(migration, /ON DELETE CASCADE ON UPDATE CASCADE/u);
  assert.match(migration, /ON DELETE NO ACTION ON UPDATE CASCADE/u);
  assert.match(migration, /PROJECT_AI_PROVIDER_DELEGATION_ACTIVE_PROVIDER_INVALID/u);
  assert.match(migration, /PROJECT_AI_PROVIDER_DELEGATION_LIVE_PROVIDER_INVALID/u);
  assert.match(migration, /PROJECT_AI_PROVIDER_DELEGATION_ACTIVE_OWNER_INVALID/u);
  assert.match(migration, /PROJECT_AI_PROVIDER_DELEGATION_LIVE_OWNER_INVALID/u);
  assert.match(migration, /PROJECT_AI_PROVIDER_DELEGATION_LIVE_EXPIRED/u);
  assert.match(migration, /PROJECT_AI_PROVIDER_DELEGATION_PROPOSER_INVALID/u);
  assert.match(migration, /PROJECT_AI_PROVIDER_DELEGATION_CONFIRMATION_IMMUTABLE/u);
  assert.match(migration, /ProjectAiEffectiveRouteSelection_delete_guard/u);
  assert.match(migration, /provider\."protocol" = 'chat_completions'/u);
  assert.match(migration, /provider\."kind" <> 'deepseek'/u);
  assert.match(migration, /project_row\."archivedAt" IS NULL/u);
  assert.match(migration, /PROJECT_AI_PROVIDER_DELEGATION_AUDIT_REQUIRED/u);
  assert.match(migration, /PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_AUDIT_REQUIRED/u);
  assert.match(migration, /PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_DELEGATION_INVALID/u);
  assert.match(migration, /system_expiry/u);
  assert.match(migration, /clock_timestamp\(\)/u);
  assert.match(migration, /PAD_A_actor_kind_check/u);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+"ProjectAiProviderDelegation"[\s\S]*SELECT/u);
});

test("delegation shape guards own selection event time and clear non-terminal actors", () => {
  const selectionShapeGuard = migration.match(
    /CREATE OR REPLACE FUNCTION "project_ai_effective_route_selection_shape_guard"\(\)[\s\S]*?\$\$;/u,
  )?.[0];
  assert.ok(selectionShapeGuard);
  assert.match(selectionShapeGuard, /NEW\."createdAt" := clock_timestamp\(\)/u);
  assert.match(selectionShapeGuard, /NEW\."updatedAt" := NEW\."createdAt"/u);
  assert.match(selectionShapeGuard, /ELSE[\s\S]*?NEW\."updatedAt" := clock_timestamp\(\)/u);

  const statusBranches = [
    ["draft", "owner_confirmed"],
    ["owner_confirmed", "active"],
    ["active", "rejected"],
  ] as const;
  for (const [status, nextStatus] of statusBranches) {
    const branch = migration.match(
      new RegExp(
        `(?:IF|ELSIF) NEW\\."status" = '${status}' THEN[\\s\\S]*?(?=\\n  ELSIF NEW\\."status" = '${nextStatus}' THEN)`,
        "u",
      ),
    )?.[0];
    assert.ok(branch, `${status} shape branch must be present`);
    assert.match(branch, /NEW\."terminalActorKind" IS NOT NULL/u);
  }
});

test("delegation serialization locks are statement-scoped and fail fast", () => {
  const globalLockTriggerNames = [
    "PAD_delegation_global_lock",
    "PAERS_global_lock",
    "PAD_provider_global_lock",
    "PAD_credential_global_lock",
    "PAD_subscription_global_lock",
    "PAD_membership_global_lock",
    "PAD_user_global_lock",
    "PAD_project_global_lock",
  ];
  for (const triggerName of globalLockTriggerNames) {
    const trigger = migration.match(
      new RegExp(`CREATE TRIGGER "${triggerName}"[\\s\\S]*?FOR EACH (ROW|STATEMENT) EXECUTE FUNCTION`, "u"),
    );
    assert.equal(trigger?.[1], "STATEMENT", `${triggerName} must acquire its lock before target rows`);
  }
  const lockFunction = migration.match(
    /CREATE OR REPLACE FUNCTION "project_ai_provider_delegation_global_lock"\(\)[\s\S]*?\$\$;/u,
  )?.[0];
  assert.ok(lockFunction);
  assert.match(lockFunction, /pg_try_advisory_xact_lock\(/u);
  assert.match(lockFunction, /PROJECT_AI_PROVIDER_DELEGATION_LOCK_BUSY/u);
  assert.match(lockFunction, /ERRCODE = 'serialization_failure'/u);
  assert.match(lockFunction, /RETURN NULL;/u);
  assert.doesNotMatch(lockFunction, /\b(?:NEW|OLD)\b/u);
  assert.doesNotMatch(migration, /pg_advisory_xact_lock\(/u);
});

test("delegation gate is registered as a disposable migrated PostgreSQL gate", () => {
  const gate = POSTGRES_GATES.find((candidate) => candidate.id === "project-ai-provider-delegation");
  assert.deepEqual(gate, {
    id: "project-ai-provider-delegation",
    file: "test/project-ai-provider-delegation-postgres.test.ts",
    database: "ai_project_os_project_ai_provider_delegation_test",
    gateEnv: "PROJECT_AI_PROVIDER_DELEGATION_POSTGRES_GATE",
    seedAdmin: true,
    setup: "migrate",
  });
});

test("owner safety switch is a narrow audited forward migration", () => {
  assert.match(safetySwitchMigration, /CREATE OR REPLACE FUNCTION "project_ai_effective_route_selection_integrity_guard"/u);
  assert.match(safetySwitchMigration, /OLD\."source" = 'personal_delegation'/u);
  assert.match(safetySwitchMigration, /OLD\."delegationId" IS NOT NULL/u);
  assert.match(safetySwitchMigration, /NEW\."source" = 'platform_default'/u);
  assert.match(safetySwitchMigration, /NEW\."delegationId" IS NULL/u);
  assert.match(safetySwitchMigration, /delegation_owner_revocation_explicit_platform_switch/u);
  assert.match(safetySwitchMigration, /delegation\."status" = 'revoked'/u);
  assert.match(safetySwitchMigration, /selection_audit\."transactionId" = txid_current\(\)/u);
  assert.match(safetySwitchMigration, /delegation_audit\."transactionId" = txid_current\(\)/u);
  assert.match(safetySwitchMigration, /PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_OWNER_INVALID/u);
  assert.doesNotMatch(safetySwitchMigration, /CREATE TABLE/u);
});

test("latest selection guard preserves the owner switch while adding archive handling", () => {
  const selectionGuard = personalMemoryInvalidationMigration.match(
    /CREATE OR REPLACE FUNCTION "project_ai_effective_route_selection_integrity_guard"\(\)[\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(selectionGuard);
  assert.match(selectionGuard, /owner_switch_valid boolean := FALSE/u);
  assert.match(selectionGuard, /OLD\."source" = 'personal_delegation'/u);
  assert.match(selectionGuard, /NEW\."source" = 'platform_default'/u);
  assert.match(selectionGuard, /delegation\."status" = 'revoked'/u);
  assert.match(selectionGuard, /delegation_owner_revocation_explicit_platform_switch/u);
  assert.match(selectionGuard, /selection_audit\."transactionId" = txid_current\(\)/u);
  assert.match(selectionGuard, /delegation_audit\."transactionId" = txid_current\(\)/u);
  assert.match(selectionGuard, /project_row\."archivedAt" IS NULL/u);
  assert.match(selectionGuard, /ProjectLifecycleRevision/u);
  assert.match(selectionGuard, /IF NOT owner_valid AND NOT owner_switch_valid THEN/u);
  assert.match(selectionGuard, /NEW\."source" = 'platform_default'[\s\S]*?currentArchivedAt/u);
});
