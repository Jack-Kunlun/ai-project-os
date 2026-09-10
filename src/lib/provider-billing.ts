import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { readCredentialSecret } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { canonicalProviderBaseUrl } from "@/lib/ai-providers/registry";

const BILLING_RESPONSE_MAX_BYTES = 64 * 1024;
const BILLING_REQUEST_TIMEOUT_MS = 10_000;
const decimalSchema = z.string().min(1).max(32).regex(/^\d+(?:\.\d+)?$/u);
const deepSeekBalanceSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(z.object({
    currency: z.enum(["CNY", "USD"]),
    total_balance: decimalSchema,
    granted_balance: decimalSchema,
    topped_up_balance: decimalSchema,
  }).strict()).max(8),
}).strict();

export type ProviderBillingErrorCode =
  | "PROVIDER_BILLING_CONNECTION_NOT_ROUTED"
  | "PROVIDER_BILLING_UNSUPPORTED"
  | "PROVIDER_BILLING_AUTH_FAILED"
  | "PROVIDER_BILLING_UNAVAILABLE"
  | "PROVIDER_BILLING_INVALID_RESPONSE";

export class ProviderBillingError extends Error {
  constructor(readonly code: ProviderBillingErrorCode) {
    super(code);
    this.name = "ProviderBillingError";
  }
}

function fail(code: ProviderBillingErrorCode): never {
  throw new ProviderBillingError(code);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > BILLING_RESPONSE_MAX_BYTES) {
    return fail("PROVIDER_BILLING_INVALID_RESPONSE");
  }
  if (response.body === null) return fail("PROVIDER_BILLING_INVALID_RESPONSE");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > BILLING_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      return fail("PROVIDER_BILLING_INVALID_RESPONSE");
    }
    chunks.push(value);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return fail("PROVIDER_BILLING_INVALID_RESPONSE");
  }
}

function isAllowedProjectProviderScope(
  scope: unknown,
  providerOwnerUserId: unknown,
): boolean {
  // Balance lookup is an external billing read and is only supported for the
  // platform-owned connection selected by an active default route. Personal
  // connections are never eligible for this platform billing endpoint.
  return scope === "platform"
    && providerOwnerUserId === null;
}

export async function readProviderBalance(
  projectId: string,
  providerConnectionId: string,
  db: PrismaClient = getDb(),
  dependencies: Readonly<{
    fetchImpl?: typeof fetch;
    readSecret?: (credentialId: string) => Promise<string>;
    now?: () => Date;
  }> = {},
) {
  const [project, activeRoute, connection] = await Promise.all([
    db.project.findUnique({ where: { id: projectId }, select: { id: true } }),
    db.platformDefaultAiRoute.findFirst({
      where: { providerConnectionId, status: "active" },
      select: { id: true },
    }),
    db.aiProviderConnection.findUnique({
      where: { id: providerConnectionId },
      select: {
        id: true,
        name: true,
        kind: true,
        scope: true,
        ownerUserId: true,
        status: true,
        disabledAt: true,
        credentialId: true,
      },
    }),
  ]);
  if (
    project === null
    || activeRoute === null
    || connection === null
    || !isAllowedProjectProviderScope(connection.scope, connection.ownerUserId)
  ) return fail("PROVIDER_BILLING_CONNECTION_NOT_ROUTED");
  if (connection.kind !== "deepseek") return fail("PROVIDER_BILLING_UNSUPPORTED");
  if (connection.status !== "verified" || connection.disabledAt !== null) return fail("PROVIDER_BILLING_UNAVAILABLE");

  const readSecret = dependencies.readSecret
    ?? ((credentialId: string) => readCredentialSecret(credentialId, "aiProvider", db));
  const apiKey = await readSecret(connection.credentialId).catch(() => fail("PROVIDER_BILLING_AUTH_FAILED"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BILLING_REQUEST_TIMEOUT_MS);
  try {
    const response = await (dependencies.fetchImpl ?? fetch)(
      new URL("/user/balance", canonicalProviderBaseUrl("deepseek")),
      {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      },
    );

    if (response.status === 401 || response.status === 403) return fail("PROVIDER_BILLING_AUTH_FAILED");
    if (!response.ok) return fail("PROVIDER_BILLING_UNAVAILABLE");
    const parsed = deepSeekBalanceSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) return fail("PROVIDER_BILLING_INVALID_RESPONSE");

    return Object.freeze({
      providerConnectionId: connection.id,
      providerName: connection.name,
      providerKind: connection.kind,
      isAvailable: parsed.data.is_available,
      balances: Object.freeze(parsed.data.balance_infos.map((balance) => Object.freeze({
        currency: balance.currency,
        total: balance.total_balance,
        granted: balance.granted_balance,
        toppedUp: balance.topped_up_balance,
      }))),
      fetchedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    });
  } catch (error) {
    if (error instanceof ProviderBillingError) throw error;
    return fail("PROVIDER_BILLING_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}
