import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ENT-005 keeps policy authority in the service and exposes only current admin controls", async () => {
  const service = await readFile("src/lib/platform-grant-offer-policy-service.ts", "utf8");
  const entitlements = await readFile("src/lib/ai-entitlements.ts", "utf8");
  const github = await readFile("src/lib/github-oauth.ts", "utf8");
  const oidc = await readFile("src/lib/oidc.ts", "utf8");
  const auth = await readFile("src/lib/auth.ts", "utf8");
  const page = await readFile("src/app/admin/models/platform-grant-offer-policy-client.tsx", "utf8");
  const migration = await readFile("prisma/migrations/20260910030000_add_platform_grant_offer_policy_governance/migration.sql", "utf8");

  assert.match(service, /Serializable/u);
  assert.match(service, /pg_advisory_xact_lock/u);
  assert.match(service, /PLATFORM_GRANT_OFFER_ELIGIBILITY_KEY/u);
  assert.match(service, /status: "draft"/u);
  assert.match(entitlements, /issueVerifiedSignupGrantFromActivePolicy/u);
  assert.match(entitlements, /AI_SIGNUP_ELIGIBILITY_REQUIRED/u);
  assert.match(github, /eligibilitySource: "verifiedGithub"/u);
  assert.match(oidc, /eligibilitySource: "verifiedOidc"/u);
  assert.match(auth, /createBootstrapSignupOfferPolicy/u);
  assert.match(page, /只影响之后符合条件的新注册，不补发、不修改历史/u);
  assert.match(page, /api\/admin\/credits\/policies/u);
  assert.match(page, /lifecycle/u);
  assert.match(migration, /PlatformGrantOfferPolicyAudit/u);
  assert.match(migration, /PlatformGrantOfferPolicy_delete_guard/u);
  assert.doesNotMatch(migration, /INSERT INTO "PlatformGrantOfferPolicy"/u);
});
