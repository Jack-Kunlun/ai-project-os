import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readRequestBody } from "@/lib/api-response";
import {
  assertPlatformGrantOfferPolicyAdmin,
  changePlatformGrantOfferPolicyLifecycle,
  PLATFORM_GRANT_OFFER_MAX_BODY_BYTES,
} from "@/lib/platform-grant-offer-policy-service";

export const dynamic = "force-dynamic";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

async function readLifecycleBody(request: Request): Promise<unknown> {
  const body = await readRequestBody(
    request,
    PLATFORM_GRANT_OFFER_MAX_BODY_BYTES,
    () => new ApiError(413, "PLATFORM_GRANT_OFFER_POLICY_BODY_TOO_LARGE", "平台赠送策略请求过大"),
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ApiError(400, "PLATFORM_GRANT_OFFER_POLICY_INVALID_INPUT", "平台赠送策略请求无效");
  }
}

export async function POST(request: Request, context: { params: Promise<{ policyId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    await assertPlatformGrantOfferPolicyAdmin(actor);
    const policyId = (await context.params).policyId;
    const policy = await changePlatformGrantOfferPolicyLifecycle(policyId, await readLifecycleBody(request), actor);
    return noStore(NextResponse.json({ policy }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
