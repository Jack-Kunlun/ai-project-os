import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ProviderBillingError, readProviderBalance } from "../src/lib/provider-billing";

const projectId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";

function billingDb(kind: "deepseek" | "qwen" = "deepseek") {
  return {
    projectAiRoute: {
      findFirst: async () => ({
        providerConnection: {
          id: connectionId,
          name: kind === "deepseek" ? "DeepSeek" : "Qwen",
          kind,
          status: "verified",
          credentialId: "33333333-3333-4333-8333-333333333333",
        },
      }),
    },
  };
}

test("DeepSeek balance lookup uses the canonical endpoint and returns only verified balance fields", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(input.toString(), "https://api.deepseek.com/user/balance");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-secret");
    return Response.json({
      is_available: true,
      balance_infos: [{
        currency: "CNY",
        total_balance: "12.34",
        granted_balance: "2.34",
        topped_up_balance: "10.00",
      }],
    });
  };

  const result = await readProviderBalance(projectId, connectionId, billingDb() as never, {
    fetchImpl,
    readSecret: async () => "test-secret",
    now: () => new Date("2026-09-02T03:04:05.000Z"),
  });

  assert.deepEqual(result, {
    providerConnectionId: connectionId,
    providerName: "DeepSeek",
    providerKind: "deepseek",
    isAvailable: true,
    balances: [{ currency: "CNY", total: "12.34", granted: "2.34", toppedUp: "10.00" }],
    fetchedAt: "2026-09-02T03:04:05.000Z",
  });
  assert.equal("credentialId" in result, false);
});

test("balance lookup rejects unsupported providers before reading a credential", async () => {
  let secretRead = false;
  await assert.rejects(
    () => readProviderBalance(projectId, connectionId, billingDb("qwen") as never, {
      readSecret: async () => {
        secretRead = true;
        return "unused";
      },
    }),
    (error: unknown) => error instanceof ProviderBillingError && error.code === "PROVIDER_BILLING_UNSUPPORTED",
  );
  assert.equal(secretRead, false);
});

test("balance lookup rejects oversized provider responses", async () => {
  const fetchImpl: typeof fetch = async () => new Response("{}", {
    headers: { "content-length": String(64 * 1024 + 1) },
  });
  await assert.rejects(
    () => readProviderBalance(projectId, connectionId, billingDb() as never, {
      fetchImpl,
      readSecret: async () => "test-secret",
    }),
    (error: unknown) => error instanceof ProviderBillingError && error.code === "PROVIDER_BILLING_INVALID_RESPONSE",
  );
});

test("provider balance API is owner-only, same-origin, strict, and no-store", async () => {
  const route = await readFile("src/app/api/projects/[projectId]/governance/provider-balance/route.ts", "utf8");
  assert.match(route, /export async function POST/u);
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /assertProjectAccess\(user, projectId, "owner"\)/u);
  assert.match(route, /bodySchema = z\.object\(\{ providerConnectionId: z\.string\(\)\.uuid\(\) \}\)\.strict\(\)/u);
  assert.match(route, /cache-control": "no-store"/u);
  assert.doesNotMatch(route, /export async function (GET|PUT|PATCH|DELETE)/u);
});
