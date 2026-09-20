import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const activationService = readFileSync("src/lib/account-entitlement-activation-service.ts", "utf8");
const backfillService = readFileSync("src/lib/account-entitlement-backfill-service.ts", "utf8");
const backfillRoute = readFileSync("src/app/api/admin/credits/backfill/route.ts", "utf8");
const migration = readFileSync("prisma/migrations/20260910040000_add_account_entitlement_activation/migration.sql", "utf8");
const auth = readFileSync("src/lib/auth.ts", "utf8");
const github = readFileSync("src/lib/github-oauth.ts", "utf8");
const oidc = readFileSync("src/lib/oidc.ts", "utf8");
const workspaces = readFileSync("src/lib/workspaces.ts", "utf8");

test("ENT-009 keeps one immutable activation source and versioned signup identity", () => {
  assert.match(activationService, /ACCOUNT_ENTITLEMENT_LIFECYCLE_KEY = "initial_account_v1"/u);
  for (const source of [
    "bootstrap",
    "localProvisioning",
    "githubRegistration",
    "oidcRegistration",
    "oidcInvitationRegistration",
    "historicalBackfill",
  ]) {
    assert.match(activationService, new RegExp(`"${source}"`, "u"));
  }
  assert.match(activationService, /activateAccountEntitlements\(/u);
  assert.match(activationService, /grant:signup:\$\{context\.userId\}:\$\{activePolicy\.offerVersion\}/u);
  assert.match(activationService, /set_config\('app\.account_entitlement_activation_context'/u);
  assert.match(activationService, /set_config\('app\.account_entitlement_activation_transaction_id'/u);
  assert.match(activationService, /accountEntitlementActivation\.findUnique/u);
  assert.match(activationService, /existing !== null\) return existing/u);

  assert.doesNotMatch(auth, /issueVerifiedSignupGrant\(/u);
  assert.doesNotMatch(github, /issueVerifiedSignupGrant\(/u);
  assert.doesNotMatch(oidc, /issueVerifiedSignupGrant\(/u);
  assert.doesNotMatch(workspaces, /issueVerifiedSignupGrant\(/u);
  const adminBootstrap = auth.slice(
    auth.indexOf("export async function initializeAdmin"),
    auth.indexOf("export async function loginAdmin"),
  );
  assert.match(adminBootstrap, /data: \{ username, role: "admin", \.\.\.password \}/u);
  assert.doesNotMatch(adminBootstrap, /activateAccountEntitlements|source:/u);
  assert.doesNotMatch(auth, /initializeFirstOwner|initial-owner-bootstrap|localProvisioning/u);
  assert.match(github, /source: "githubRegistration"/u);
  assert.match(oidc, /source: invitation === null \? "oidcRegistration" : "oidcInvitationRegistration"/u);
  assert.match(workspaces, /source: "localProvisioning"/u);
});

test("ENT-009 backfill remains a strict, frozen preview-to-execute API", () => {
  assert.match(backfillRoute, /assertSameOrigin\(request\)/u);
  assert.match(backfillRoute, /readRequestBody\(/u);
  assert.match(backfillRoute, /no-store/u);
  assert.match(backfillRoute, /\.strict\(\)/u);
  assert.match(backfillRoute, /impactFingerprint: z\.string\(\)\.regex\(\/\^\[0-9a-f\]\{64\}\$\/u\)/u);
  assert.doesNotMatch(backfillRoute, /offerVersion|eligibilityKey|amount|validForDays/u);
  assert.match(backfillService, /run\.impactFingerprint !== input\.impactFingerprint/u);
  assert.match(backfillService, /run\.status === "executing"/u);
  assert.match(backfillService, /processBackfillItemInTransaction/u);
  assert.match(backfillService, /completeBackfillInTransaction/u);
  assert.match(backfillService, /function nextTransitionAt\(now: Date, previous: Date\): Date/u);
  assert.match(backfillService, /const confirmationAt = nextTransitionAt\(now, run\.transitionAt\)/u);
  assert.match(backfillService, /const completionAt = nextTransitionAt\(now, run\.transitionAt\)/u);
  assert.match(backfillService, /db\.\$transaction\(async \(tx\) =>/u);
  assert.match(backfillService, /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/u);
  assert.match(backfillService, /mintHistoricalBackfillGrantInTransaction/u);
  assert.doesNotMatch(activationService, /grantHistoricalBackfillForNoActiveOffer/u);
  assert.doesNotMatch(backfillService, /grantHistoricalBackfillForNoActiveOffer/u);
  assert.match(backfillService, /runId: run\.id/u);
  assert.match(backfillService, /item\.runId !== run\.id/u);
  assert.match(backfillService, /item\.activationId === null/u);
  assert.match(backfillService, /run\.eligibleMissingCount > 0 && run\.activePolicyFingerprint === null/u);
  assert.match(backfillService, /run\.actorAccountAccessVersion !== current\.accountAccessVersion/u);
  assert.match(backfillService, /normalizeBackfillActor/u);
  assert.match(backfillService, /export type AccountEntitlementBackfillClock = \(\) => Date/u);
  assert.match(backfillService, /function normalizeBackfillClock\(now: AccountEntitlementBackfillNow \| undefined\): AccountEntitlementBackfillClock/u);
  assert.match(backfillService, /if \(now === undefined\) return \(\) => new Date\(\)/u);
  assert.match(backfillService, /claimBackfillInTransaction\(tx, normalizedActor, parsed, clock\)/u);
  assert.match(backfillService, /processBackfillItemInTransaction\(tx, normalizedActor, parsed, clock\)/u);
  assert.match(backfillService, /completeBackfillInTransaction\(tx, normalizedActor, parsed, clock\)/u);
  assert.match(backfillService, /claimBackfillInTransaction\(db, actor, input, clock\)/u);
  assert.match(backfillService, /processBackfillItemInTransaction\(db, actor, input, clock\)/u);
  assert.match(backfillService, /completeBackfillInTransaction\(db, actor, input, clock\)/u);
  assert.match(backfillService, /await lockActorsAccess\(db, \[actor\.id\]\);\s+await lockBackfillDomain\(db\);\s+const now = clock\(\);/u);
  assert.match(backfillService, /async function completeBackfillInTransaction[\s\S]*?if \(run\.expiresAt <= now\) return publicRun\(await markRun\(db, run, current\.id, "expired", "expired", now\)\)/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION "account_entitlement_backfill_expiry_guard"/u);
  assert.match(migration, /OLD\."status" = 'previewed' AND NEW\."status" = 'executing'[\s\S]*?clock_timestamp\(\) AT TIME ZONE 'UTC'/u);
  assert.match(migration, /OLD\."status" = 'executing' AND NEW\."status" = 'completed'[\s\S]*?clock_timestamp\(\) AT TIME ZONE 'UTC'/u);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "AccountEntitlementBackfillRun_expiry_guard"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "AccountEntitlementBackfillItem_expiry_guard"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(migration, /\(clock_timestamp\(\) AT TIME ZONE 'UTC'\)::timestamp\(3\) < run\."expiresAt"/u);
  assert.match(backfillService, /requireAccountAccessVersion/u);
  assert.match(backfillService, /assertAccountAccessForActor/u);
  assert.match(backfillService, /ACCOUNT_ENTITLEMENT_BACKFILL_EPOCH_STALE/u);
  assert.match(backfillService, /ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT/u);
  assert.match(backfillService, /run\.status === "completed" && run\.requestKey === input\.requestKey[\s\S]*run\.reason !== input\.reason/u);
  assert.match(backfillService, /findFirst\(\{[\s\S]*actorId: current\.id, requestKey: input\.requestKey/u);
  assert.match(backfillService, /isUniqueConflict/u);
  assert.match(backfillService, /markExecutingRunStaleAfterEpochDrift/u);
  assert.match(backfillService, /ACCOUNT_ENTITLEMENT_BACKFILL_MAX_CANDIDATES \+ 1/u);
  assert.match(backfillService, /createHmac\("sha256"/u);
});

test("ENT-009 migration preserves legacy rows and protects new versioned grant facts", () => {
  assert.match(migration, /ACCOUNT_ENTITLEMENT_LEGACY_RECONCILIATION_REQUIRED/u);
  assert.match(migration, /DROP INDEX "PlatformTokenGrant_userId_kind_key"/u);
  assert.match(migration, /PlatformTokenGrant_userId_offerVersion_signup_key[\s\S]*WHERE "kind" = 'signup'/u);
  assert.match(migration, /AccountEntitlementActivation_userId_lifecycleKey_key/u);
  assert.match(migration, /AccountEntitlementActivation_grantId_key/u);
  assert.match(migration, /AccountEntitlementActivationAudit_activationId_key/u);
  assert.match(migration, /actorAccountAccessVersion/u);
  assert.match(migration, /account entitlement activation grant ledger mismatch/u);
  assert.match(migration, /account entitlement activation grant time mismatch/u);
  assert.match(migration, /account entitlement activation user epoch mismatch/u);
  assert.match(migration, /AccountEntitlementActivation_mutation_guard/u);
  assert.match(migration, /AccountEntitlementActivationAudit_append_only_guard/u);
  assert.match(migration, /AccountEntitlementActivation_audit_link_guard/u);
  assert.match(migration, /PlatformTokenLedgerEntry_signup_grant_key/u);
  assert.match(migration, /AccountEntitlementSignupGrant_insert_link_guard/u);
  assert.match(migration, /AccountEntitlementSignupLedger_insert_link_guard/u);
  assert.match(migration, /canonical activation or backfill closure/u);
  assert.match(migration, /WHEN activation_row\."decision" = 'already_issued' THEN 'linked'/u);
  assert.match(migration, /WHEN NEW\."decision" = 'already_issued' THEN 'linked'/u);
  assert.doesNotMatch(migration, /WHEN (?:activation_row|NEW)\."grantId" IS NULL THEN 'created'/u);
  assert.match(migration, /AccountEntitlementSignupLedger_append_only_guard/u);
  assert.match(migration, /TG_OP = 'UPDATE' AND NEW\."entryKind" = 'grant' AND NEW\."reasonCode" = 'AI_SIGNUP_GRANT'/u);
  assert.match(migration, /AccountEntitlementBackfillRun_mutation_guard/u);
  assert.match(migration, /AccountEntitlementBackfillRun_audit_link_guard/u);
  assert.match(migration, /AccountEntitlementBackfillItem_mutation_guard/u);
  assert.match(migration, /NEW\."classification" = 'already_issued'[\s\S]*activation_row\."decision" = 'no_active_offer'[\s\S]*activation_row\."status" IS DISTINCT FROM 'no_active_offer'[\s\S]*activation_row\."accountAccessVersion" IS DISTINCT FROM NEW\."accountAccessVersion"[\s\S]*NEW\."existingGrantId" IS NULL[\s\S]*NEW\."status" IS DISTINCT FROM 'skipped'[\s\S]*NEW\."resultGrantId" IS NOT NULL[\s\S]*NEW\."skipCode" IS DISTINCT FROM 'ACCOUNT_STATE_CHANGED'/u);
  assert.match(migration, /activation_row\."decision" NOT IN \('granted', 'already_issued', 'no_active_offer'\)/u);
  assert.doesNotMatch(migration, /INSERT INTO "PlatformTokenGrant"/u);
  assert.doesNotMatch(migration, /INSERT INTO "PlatformTokenLedgerEntry"/u);
});
