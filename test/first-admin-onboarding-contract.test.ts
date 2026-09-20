import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("v0.5 removes the default-workspace Owner bootstrap runtime", async () => {
  const [auth, setup, apiErrors] = await Promise.all([
    readFile("src/lib/auth.ts", "utf8"),
    readFile("src/app/setup/setup-form.tsx", "utf8"),
    readFile("src/lib/api-errors.ts", "utf8"),
  ]);

  assert.match(auth, /export async function initializeAdmin/u);
  assert.doesNotMatch(auth, /initializeFirstOwner|requireFirstAdminOnboardingPage|first-admin-onboarding-service/u);
  assert.doesNotMatch(apiErrors, /FirstAdminOnboardingError|FIRST_ADMIN_ONBOARDING_/u);
  assert.match(setup, /router\.replace\("\/admin"\)/u);

  for (const path of [
    "src/lib/first-admin-onboarding-service.ts",
    "src/app/api/admin/onboarding/complete/route.ts",
    "src/app/onboarding/page.tsx",
    "src/app/onboarding/first-admin-onboarding-client.tsx",
  ]) {
    assert.equal(await fileExists(path), false, `${path} must not be part of the runtime`);
  }
});
