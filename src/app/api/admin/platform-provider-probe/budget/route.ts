import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readRequestBody } from "@/lib/api-response";
import { assertPlatformProviderAdminHint } from "@/lib/ai-providers";
import {
  PLATFORM_PROVIDER_PROBE_MAX_BODY_BYTES,
  createAndActivatePlatformProviderProbeBudget,
  getPlatformProviderProbeBudgetSummary,
} from "@/lib/platform-provider-probe-service";

export const dynamic = "force-dynamic";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

async function readBudgetBody(request: Request): Promise<unknown> {
  const body = await readRequestBody(
    request,
    PLATFORM_PROVIDER_PROBE_MAX_BODY_BYTES,
    () => new ApiError(413, "PLATFORM_PROVIDER_PROBE_BODY_TOO_LARGE", "平台连接探测预算请求过大"),
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ApiError(400, "PLATFORM_PROVIDER_PROBE_INVALID_INPUT", "平台连接探测预算请求无效");
  }
}

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    assertPlatformProviderAdminHint(actor);
    return noStore(NextResponse.json(await getPlatformProviderProbeBudgetSummary(actor)));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    assertPlatformProviderAdminHint(actor);
    return noStore(NextResponse.json(await createAndActivatePlatformProviderProbeBudget(await readBudgetBody(request), actor), { status: 201 }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
