import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { listAdminUsers } from "@/lib/admin-user-operations-service";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  search: z.string().trim().max(160).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const admin = await requireApiSession(request);
    const url = new URL(request.url);
    const query = querySchema.parse({
      search: url.searchParams.get("search") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      pageSize: url.searchParams.get("pageSize") ?? undefined,
    });
    return noStore(NextResponse.json(await listAdminUsers({
      ...query,
      adminUserId: admin.id,
      adminAccountAccessVersion: admin.accountAccessVersion,
    })));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
