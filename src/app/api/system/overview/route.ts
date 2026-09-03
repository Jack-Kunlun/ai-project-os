import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { getSystemOverview } from "@/lib/system-overview";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireApiSession(request);
    if (user.role !== "admin") return NextResponse.json({ error: { code: "ACCESS_FORBIDDEN", message: "需要系统管理员权限" } }, { status: 403 });
    return NextResponse.json(await getSystemOverview(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
