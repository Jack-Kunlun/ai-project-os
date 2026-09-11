import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { listPlatformTokenGrants } from "@/lib/platform-credit-governance-service";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  search: z.string().trim().max(160).optional(),
  kind: z.enum(["signup", "manual"]).optional(),
  status: z.enum(["active", "expired", "revoked"]).optional(),
  // `page`/`pageSize` remain grants-table aliases for existing callers.
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  grantPage: z.coerce.number().int().min(1).max(10_000).optional(),
  grantPageSize: z.coerce.number().int().min(1).max(100).optional(),
  userPage: z.coerce.number().int().min(1).max(10_000).optional(),
  userPageSize: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return noStore(NextResponse.json(await listPlatformTokenGrants(query, actor)));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
