import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listPlatformDefaultAiRoutes } from "@/lib/platform-default-ai-routes";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    return NextResponse.json(await listPlatformDefaultAiRoutes(actor));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    return NextResponse.json({ error: { code: "PLATFORM_AI_ROUTE_MUTATIONS_DISABLED", message: "平台默认路由已改为能力配置流程，请在能力配置中完成选择、真实测试和启用。" } }, { status: 410 });
  } catch (error) {
    return handleApiError(error);
  }
}
