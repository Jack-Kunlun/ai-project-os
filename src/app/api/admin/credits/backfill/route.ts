import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { AccountEntitlementBackfillError, ACCOUNT_ENTITLEMENT_BACKFILL_MAX_BODY_BYTES, executeAccountEntitlementBackfill, previewAccountEntitlementBackfill } from "@/lib/account-entitlement-backfill-service";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readRequestBody } from "@/lib/api-response";

export const dynamic = "force-dynamic";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

async function readBody(request: Request): Promise<unknown> {
  const body = await readRequestBody(
    request,
    ACCOUNT_ENTITLEMENT_BACKFILL_MAX_BODY_BYTES,
    () => new ApiError(413, "ACCOUNT_ENTITLEMENT_BACKFILL_BODY_TOO_LARGE", "账号权益回填请求过大"),
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ApiError(400, "ACCOUNT_ENTITLEMENT_BACKFILL_INVALID_INPUT", "账号权益回填请求无效");
  }
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview") }).strict(),
  z.object({
    action: z.literal("execute"),
    runId: z.string().uuid(),
    impactFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    confirmation: z.literal(true),
    requestKey: z.string().uuid(),
    reason: z.string().trim().min(1).max(500),
  }).strict(),
]);

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const body = await readBody(request);
    const action = actionSchema.safeParse(body);
    if (!action.success) throw new AccountEntitlementBackfillError("ACCOUNT_ENTITLEMENT_BACKFILL_INVALID_INPUT");
    if (action.data.action === "preview") {
      return noStore(NextResponse.json({ preview: await previewAccountEntitlementBackfill(actor) }, { status: 201 }));
    }
    const parsed = action.data;
    if (parsed.action !== "execute") throw new AccountEntitlementBackfillError("ACCOUNT_ENTITLEMENT_BACKFILL_INVALID_INPUT");
    const executeInput = {
      runId: parsed.runId,
      impactFingerprint: parsed.impactFingerprint,
      confirmation: parsed.confirmation,
      requestKey: parsed.requestKey,
      reason: parsed.reason,
    };
    return noStore(NextResponse.json({ result: await executeAccountEntitlementBackfill(executeInput, actor) }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
