import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readRequestBody } from "@/lib/api-response";
import { assertPlatformProviderAdminHint } from "@/lib/ai-providers";
import { PLATFORM_PROVIDER_PROBE_MAX_BODY_BYTES, parsePlatformProviderProbeInput, runPlatformProviderProbe } from "@/lib/platform-provider-probe-service";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

async function readProbeBody(request: Request): Promise<unknown> {
  const body = await readRequestBody(
    request,
    PLATFORM_PROVIDER_PROBE_MAX_BODY_BYTES,
    () => new ApiError(413, "PLATFORM_PROVIDER_PROBE_BODY_TOO_LARGE", "平台连接探测请求过大"),
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new ApiError(400, "PLATFORM_PROVIDER_PROBE_INVALID_INPUT", "平台连接探测请求无效");
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ providerId: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    assertPlatformProviderAdminHint(actor);
    const providerId = idSchema.parse((await context.params).providerId);
    const input = parsePlatformProviderProbeInput(await readProbeBody(request));
    return NextResponse.json(await runPlatformProviderProbe(providerId, actor, input), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
