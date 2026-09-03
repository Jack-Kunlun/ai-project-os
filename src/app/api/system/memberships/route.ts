import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { grantOrExtendMembership, listMemberships } from "@/lib/membership-service";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  search: z.string().max(160).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

const grantSchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(["grant", "extend"]).default("grant"),
  days: z.number().int().min(1).max(3650),
  note: z.string().max(500).nullable().optional(),
  expectedVersion: z.number().int().positive().nullable().optional(),
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
    return NextResponse.json(await listMemberships({ ...query, adminUserId: admin.id }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await requireApiSession(request);
    const input = grantSchema.parse(await readJsonBody(request));
    const subscription = await grantOrExtendMembership({ ...input, adminUserId: admin.id, expectedVersion: input.expectedVersion ?? undefined });
    return NextResponse.json({ subscription }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
