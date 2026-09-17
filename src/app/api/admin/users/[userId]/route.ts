import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { getAdminUserOperationsDetail } from "@/lib/admin-user-operations-service";

export const dynamic = "force-dynamic";

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    const admin = await requireApiSession(request);
    const { userId } = await context.params;
    return noStore(NextResponse.json(await getAdminUserOperationsDetail({
      adminUserId: admin.id,
      adminAccountAccessVersion: admin.accountAccessVersion,
      userId: z.string().uuid().parse(userId),
    })));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
