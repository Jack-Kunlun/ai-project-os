import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listAccountAccess } from "@/lib/account-access-service";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  search: z.string().max(160).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export async function GET(request: Request) {
  try {
    const admin = await requireApiSession(request);
    const url = new URL(request.url);
    const query = querySchema.parse({
      search: url.searchParams.get("search") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });
    return NextResponse.json(await listAccountAccess({ ...query, adminUserId: admin.id, adminAccountAccessVersion: admin.accountAccessVersion }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return NextResponse.json(
      { error: { code: "ACCOUNT_ACCESS_METHOD_NOT_ALLOWED", message: "账号状态变更必须先预览，再通过用户详情 PATCH 确认" } },
      { status: 405, headers: { allow: "GET" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
