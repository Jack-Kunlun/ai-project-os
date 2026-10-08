import assert from "node:assert/strict";
import test from "node:test";
import { POST as recovery } from "@/app/api/auth/recovery/route";
import { POST as phone } from "@/app/api/auth/phone/route";

test("recovery and phone mutation reject foreign/missing origins before authentication or SMS", async () => {
  for (const route of [recovery, phone]) {
    for (const origin of [undefined, "https://attacker.invalid", "http://account.example.com"]) {
      const headers: Record<string, string> = { host: "account.example.com", "content-type": "application/json" };
      if (origin) headers.origin = origin;
      const response = await route(new Request("https://account.example.com/api/auth/recovery", { method: "POST", headers, body: "{}" }));
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal((await response.json()).error.code, "AUTH_CSRF_REJECTED");
    }
  }
});

test("recovery rejects oversized or invalid proof input without resetting a password", async () => {
  const previous = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
  process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = "https://account.example.com";
  try {
    for (const body of [" ".repeat(2049), JSON.stringify({ phone: "13800138000", challengeId: "invalid", code: "123456", newPassword: "NewPassword2026" }), JSON.stringify({ phone: "13800138000", challengeId: "62ea96d1-e37f-4e46-a6a0-ec6d19e5500d", code: "123456", newPassword: "NewPassword2026", userId: "another-user" })]) {
      const response = await recovery(new Request("https://account.example.com/api/auth/recovery", { method: "POST", headers: { host: "account.example.com", origin: "https://account.example.com", "content-type": "application/json" }, body }));
      assert.ok(response.status >= 400 && response.status < 500);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  } finally {
    if (previous === undefined) delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
    else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = previous;
  }
});
