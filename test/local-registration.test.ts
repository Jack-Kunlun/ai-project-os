import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api-errors";
import { AuthError } from "@/lib/auth";
import { localRegistrationUsernameFingerprint } from "@/lib/local-registration-abuse-budget";
import { assertLocalRegistrationOrigin } from "@/lib/local-registration-config";
import { normalizeLocalRegistrationUsername, registerLocalAccount } from "@/lib/local-registration-service";
import { POST as registerPost } from "@/app/api/auth/register/route";

test("local registration stores a canonical lowercase username", () => {
  assert.equal(normalizeLocalRegistrationUsername("Project.Owner_7"), "project.owner_7");
});

test("local registration rejects usernames outside the documented ASCII policy", () => {
  for (const username of ["ab", " leading", "bad name", "ünicode", ".leading", "a".repeat(65)]) {
    assert.throws(() => normalizeLocalRegistrationUsername(username), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "LOCAL_REGISTRATION_INVALID_INPUT");
      return true;
    });
  }
});

test("registration abuse budget fingerprints normalized usernames without storing them", () => {
  const first = localRegistrationUsernameFingerprint("alice_123");
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(localRegistrationUsernameFingerprint("alice_123"), first);
  assert.notEqual(localRegistrationUsernameFingerprint("alice_124"), first);
  assert.notEqual(first, "alice_123");
});

test("local registration consumes durable admission before password hashing or database writes", async () => {
  let admissionCalled = false;
  await assert.rejects(
    registerLocalAccount(
      { username: "BudgetDenied", password: "StrongPassword_2026" },
      async (username) => {
        admissionCalled = true;
        assert.equal(username, "budgetdenied");
        throw new ApiError(429, "LOCAL_REGISTRATION_RATE_LIMITED", "请稍后重试");
      },
      // The guard rejects first, so the service must not acquire a database.
      {} as never,
    ),
    (error: unknown) => error instanceof ApiError && error.code === "LOCAL_REGISTRATION_RATE_LIMITED",
  );
  assert.equal(admissionCalled, true);
});

test("local registration rejects weak passwords before opening a database transaction", async () => {
  let admissionCalled = false;
  await assert.rejects(
    registerLocalAccount({ username: "weakpassword", password: "short12" }, async () => { admissionCalled = true; }, {} as never),
    (error: unknown) => error instanceof AuthError && error.code === "AUTH_INVALID_INPUT",
  );
  assert.equal(admissionCalled, false);
});

test("registration API rejects missing and cross-origin Origin headers before database access", async () => {
  const body = JSON.stringify({ username: "csrf_user", password: "StrongPassword_2026", remember: true });
  for (const origin of [null, "https://attacker.invalid", "http://app.example"]) {
    const headers = new Headers({ host: "app.example", "content-type": "application/json" });
    if (origin !== null) headers.set("origin", origin);
    const response = await registerPost(new Request("https://app.example/api/auth/register", {
      method: "POST",
      headers,
      body,
    }));
    assert.equal(response.status, 403);
    const payload = await response.json() as { error?: { code?: string } };
    assert.equal(payload.error?.code, "AUTH_CSRF_REJECTED");
  }
});

test("registration API stays closed unless explicitly enabled", async () => {
  const previous = process.env.LOCAL_REGISTRATION_ENABLED;
  process.env.LOCAL_REGISTRATION_ENABLED = "false";
  try {
    const response = await registerPost(new Request("https://app.example/api/auth/register", {
      method: "POST",
      headers: { host: "app.example", origin: "https://app.example", "content-type": "application/json" },
      body: JSON.stringify({ username: "closed_signup", password: "StrongPassword_2026" }),
    }));
    assert.equal(response.status, 503);
    const payload = await response.json() as { error?: { code?: string } };
    assert.equal(payload.error?.code, "LOCAL_REGISTRATION_DISABLED");
  } finally {
    if (previous === undefined) delete process.env.LOCAL_REGISTRATION_ENABLED;
    else process.env.LOCAL_REGISTRATION_ENABLED = previous;
  }
});

test("registration checks the configured public origin, including its scheme", () => {
  const previous = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
  process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = "https://app.example";
  try {
    const request = (origin: string) => new Request("http://127.0.0.1:3000/api/auth/register", {
      method: "POST",
      headers: { origin },
    });
    assert.doesNotThrow(() => assertLocalRegistrationOrigin(request("https://app.example")));
    for (const origin of ["http://app.example", "https://attacker.invalid"]) {
      assert.throws(() => assertLocalRegistrationOrigin(request(origin)),
        (error: unknown) => error instanceof ApiError && error.code === "AUTH_CSRF_REJECTED");
    }
  } finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
    else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = previous;
  }
});

test("registration reports an invalid configured public origin as a service error", () => {
  const previous = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
  try {
    for (const invalid of ["https://app.example/path", "ftp://app.example", "not-a-url"]) {
      process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = invalid;
      assert.throws(() => assertLocalRegistrationOrigin(new Request("https://app.example/api/auth/register", {
        headers: { origin: "https://app.example" },
      })), (error: unknown) => error instanceof ApiError
        && error.status === 503
        && error.code === "LOCAL_REGISTRATION_CONFIG_INVALID");
    }
  } finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
    else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = previous;
  }
});
