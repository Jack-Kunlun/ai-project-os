import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { assertPlatformProviderAdminHint } from "@/lib/ai-providers";

export const dynamic = "force-dynamic";

async function retired(request: Request) {
  try {
    if (request.method === "POST") assertSameOrigin(request);
    assertPlatformProviderAdminHint(await requireApiSession(request));
    return NextResponse.json({ error: { code: "PROBE_BUDGET_RETIRED", message: "模型测试次数上限已取消。" } }, { status: 410, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export { retired as GET, retired as POST };
