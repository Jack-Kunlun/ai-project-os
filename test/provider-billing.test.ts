import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ProviderBillingError, readProviderBalance, type ProviderBillingErrorCode } from "../src/lib/provider-billing";

const projectId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "66666666-6666-4666-8666-666666666666";
const otherOwnerUserId = "77777777-7777-4777-8777-777777777777";

type BillingProviderKind = "deepseek" | "qwen";
type BillingProviderScope = "platform" | "user";
type BillingProviderStatus = "verified" | "configured" | "error" | "disabled";

type BillingProvider = {
  id: string;
  name: string;
  kind: BillingProviderKind;
  scope: BillingProviderScope;
  ownerUserId: string | null;
  status: BillingProviderStatus;
  disabledAt: Date | null;
  credentialId: string;
};

function billingDb(
  kind: BillingProviderKind = "deepseek",
  overrides: Partial<BillingProvider> = {},
  onFindFirst?: (args: unknown) => void,
) {
  const provider: BillingProvider = {
    id: connectionId,
    name: kind === "deepseek" ? "DeepSeek" : "Qwen",
    kind,
    scope: "platform",
    ownerUserId: null,
    status: "verified",
    disabledAt: null,
    credentialId: "33333333-3333-4333-8333-333333333333",
    ...overrides,
  };
  return {
    project: {
      findUnique: async () => ({ id: projectId }),
    },
    platformDefaultAiRoute: {
      findFirst: async (args: unknown) => {
        onFindFirst?.(args);
        return { id: "platform-route-id" };
      },
    },
    aiProviderConnection: {
      findUnique: async (args: unknown) => {
        onFindFirst?.(args);
        return provider;
      },
    },
  };
}

async function assertRejectedBeforeDispatch(db: unknown, expectedCode: ProviderBillingErrorCode): Promise<void> {
  let secretReads = 0;
  let fetchCalls = 0;
  await assert.rejects(
    () => readProviderBalance(projectId, connectionId, db as never, {
      readSecret: async () => {
        secretReads += 1;
        return "unused";
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({});
      },
    }),
    (error: unknown) => error instanceof ProviderBillingError && error.code === expectedCode,
  );
  assert.equal(secretReads, 0);
  assert.equal(fetchCalls, 0);
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

test("balance lookup rejects unsupported providers before credential or network dispatch", async () => {
  let secretReads = 0;
  let fetchCalls = 0;
  await assert.rejects(
    () => readProviderBalance(projectId, connectionId, billingDb("qwen") as never, {
      readSecret: async () => {
        secretReads += 1;
        return "unused";
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json({});
      },
    }),
    (error: unknown) => error instanceof ProviderBillingError && error.code === "PROVIDER_BILLING_UNSUPPORTED",
  );
  assert.equal(secretReads, 0);
  assert.equal(fetchCalls, 0);
});

test("balance lookup rejects a user-scoped DeepSeek connection before dispatch", async () => {
  await assertRejectedBeforeDispatch(billingDb("deepseek", { scope: "user" }), "PROVIDER_BILLING_CONNECTION_NOT_ROUTED");
});

test("balance lookup rejects a personal connection before dispatch", async () => {
  await assertRejectedBeforeDispatch(billingDb("deepseek", {
    scope: "user",
    ownerUserId: otherOwnerUserId,
  }), "PROVIDER_BILLING_CONNECTION_NOT_ROUTED");
});

test("balance lookup rejects a platform connection carrying an owner before dispatch", async () => {
  await assertRejectedBeforeDispatch(billingDb("deepseek", {
    scope: "platform",
    ownerUserId: otherOwnerUserId,
  }), "PROVIDER_BILLING_CONNECTION_NOT_ROUTED");
});

test("balance lookup rejects a personal connection without an owner before dispatch", async () => {
  await assertRejectedBeforeDispatch(billingDb("deepseek", {
    scope: "user",
  }), "PROVIDER_BILLING_CONNECTION_NOT_ROUTED");
});

for (const status of ["configured", "error"] as const) {
  test(`balance lookup rejects a ${status} connection before dispatch`, async () => {
    await assertRejectedBeforeDispatch(billingDb("deepseek", { status }), "PROVIDER_BILLING_UNAVAILABLE");
  });
}

test("balance lookup rejects a connection with disabledAt before dispatch", async () => {
  await assertRejectedBeforeDispatch(
    billingDb("deepseek", { disabledAt: new Date("2026-09-02T00:00:00.000Z") }),
    "PROVIDER_BILLING_UNAVAILABLE",
  );
});

test("balance lookup rejects a disabled connection before dispatch", async () => {
  await assertRejectedBeforeDispatch(billingDb("deepseek", { status: "disabled" }), "PROVIDER_BILLING_UNAVAILABLE");
});

test("balance lookup rejects user-scoped Qwen before kind classification or dispatch", async () => {
  await assertRejectedBeforeDispatch(billingDb("qwen", { scope: "user" }), "PROVIDER_BILLING_CONNECTION_NOT_ROUTED");
});

test("balance lookup classifies a structurally valid non-verified Qwen as unsupported", async () => {
  await assertRejectedBeforeDispatch(billingDb("qwen", { status: "error" }), "PROVIDER_BILLING_UNSUPPORTED");
});

test("balance lookup rejects a verified DeepSeek personal connection before credential or network dispatch", async () => {
  await assertRejectedBeforeDispatch(billingDb("deepseek", {
    scope: "user",
    ownerUserId,
  }), "PROVIDER_BILLING_CONNECTION_NOT_ROUTED");
});

test("balance lookup selects current scope and owner fields before allowing the platform connection", async () => {
  let query: unknown;
  await assertRejectedBeforeDispatch(
    billingDb("deepseek", { scope: "user" }, (args) => {
      query = args;
    }),
    "PROVIDER_BILLING_CONNECTION_NOT_ROUTED",
  );
  const select = (query as { select: Record<string, unknown> }).select;
  assert.equal(select.scope, true);
  assert.equal(select.ownerUserId, true);
  assert.equal("workspaceId" in select, false);
  assert.equal("ownershipState" in select, false);
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
