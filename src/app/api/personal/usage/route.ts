import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { requireApiSessionReadOnly } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import {
  getUserTokenUsagePage,
  parseUserTokenUsageFilter,
} from "@/lib/user-token-usage";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

/** Read only account-owned Token usage and currently authorized project calls. */
export async function GET(request: Request) {
  try {
    const db = getDb();
    const result = await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
      const clockRows = await tx.$queryRaw<Array<{ now?: Date | string }>>(Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`);
      const clockValue = clockRows[0]?.now;
      const current = clockValue instanceof Date ? clockValue : typeof clockValue === "string" ? new Date(clockValue) : null;
      if (current === null || Number.isNaN(current.getTime())) throw new ApiError(503, "USAGE_SNAPSHOT_UNAVAILABLE", "Usage snapshot is temporarily unavailable");
      const actor = await requireApiSessionReadOnly(request, tx, current);
      const filter = parseUserTokenUsageFilter(new URL(request.url).searchParams, current);
      return getUserTokenUsagePage(actor, filter, tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return noStore(NextResponse.json({ usage: result }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
