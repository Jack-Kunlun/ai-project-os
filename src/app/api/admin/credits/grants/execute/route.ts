import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readRequestBody } from "@/lib/api-response";
import {
  executePlatformTokenGrantMutation,
  PLATFORM_CREDIT_GOVERNANCE_MAX_BODY_BYTES,
} from "@/lib/platform-credit-governance-service";

export const dynamic = "force-dynamic";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}
async function readBody(request: Request): Promise<unknown> {
  const body = await readRequestBody(
    request,
    PLATFORM_CREDIT_GOVERNANCE_MAX_BODY_BYTES,
    () => new ApiError(413, "PLATFORM_CREDIT_GOVERNANCE_BODY_TOO_LARGE", "平台额度治理请求过大"),
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ApiError(400, "PLATFORM_CREDIT_GOVERNANCE_INVALID_INPUT", "平台额度治理请求无效");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    return noStore(NextResponse.json({ result: await executePlatformTokenGrantMutation(await readBody(request), actor) }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
