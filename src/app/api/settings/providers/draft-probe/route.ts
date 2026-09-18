import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { assertPlatformProviderAdminHint } from "@/lib/ai-providers";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readRequestBody } from "@/lib/api-response";
import {
  PLATFORM_PROVIDER_DRAFT_PROBE_MAX_BODY_BYTES,
  parsePlatformProviderDraftProbeInput,
  runPlatformProviderDraftProbe,
} from "@/lib/platform-provider-draft-probe-service";

export const dynamic = "force-dynamic";

async function readDraftBody(request: Request): Promise<unknown> {
  const body = await readRequestBody(request, PLATFORM_PROVIDER_DRAFT_PROBE_MAX_BODY_BYTES, () => new ApiError(413, "PLATFORM_PROVIDER_PROBE_BODY_TOO_LARGE", "平台连接探测请求过大"));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ApiError(400, "PLATFORM_PROVIDER_PROBE_INVALID_INPUT", "平台连接探测请求无效");
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    assertPlatformProviderAdminHint(actor);
    const input = parsePlatformProviderDraftProbeInput(await readDraftBody(request));
    return NextResponse.json(await runPlatformProviderDraftProbe(input, actor), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
