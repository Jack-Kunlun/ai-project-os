import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listMemberships } from "@/lib/membership-service";

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
    const result = await listMemberships({ ...query, adminUserId: admin.id });
    return NextResponse.json({
      ...result,
      items: result.items.filter((item) => item.role === "user").map((item) => ({
        id: item.id,
        username: item.username,
        displayName: item.displayName,
        role: "user" as const,
        disabledAt: item.disabledAt,
        membershipSubscription: item.membershipSubscription === null ? null : {
          id: item.membershipSubscription.id,
          userId: item.membershipSubscription.userId,
          status: item.membershipSubscription.status,
          startsAt: item.membershipSubscription.startsAt,
          expiresAt: item.membershipSubscription.expiresAt,
          revokedAt: item.membershipSubscription.revokedAt,
          version: item.membershipSubscription.version,
          updatedAt: item.membershipSubscription.updatedAt,
        },
        membershipApplication: item.membershipApplication === null ? null : {
          id: item.membershipApplication.id,
          status: item.membershipApplication.status,
          statusVersion: item.membershipApplication.statusVersion,
          submittedAt: item.membershipApplication.submittedAt,
          fulfilledAt: item.membershipApplication.fulfilledAt,
          rejectedAt: item.membershipApplication.rejectedAt,
          withdrawnAt: item.membershipApplication.withdrawnAt,
        },
      })),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return NextResponse.json(
      { error: { code: "MEMBERSHIP_METHOD_NOT_ALLOWED", message: "会员变更必须先预览，再通过用户详情 PATCH 确认" } },
      { status: 405, headers: { allow: "GET" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}
