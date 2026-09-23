import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { requireApiSessionReadOnly } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import { getCreditReportInTransaction, parseCreditReportQuery, resolveCreditReportQuery } from "@/lib/credit-reporting";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const input = parseCreditReportQuery(new URL(request.url).searchParams);
    const db = getDb();
    const report = await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
      const clockRows = await tx.$queryRaw<Array<{ now?: Date | string }>>(Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`);
      const clockValue = clockRows[0]?.now;
      const current = clockValue instanceof Date ? clockValue : typeof clockValue === "string" ? new Date(clockValue) : null;
      if (current === null || Number.isNaN(current.getTime())) throw new ApiError(503, "CREDITS_SNAPSHOT_UNAVAILABLE", "额度快照暂时无法读取");
      const sessionUser = await requireApiSessionReadOnly(request, tx, current);
      const query = resolveCreditReportQuery(input, current);
      return getCreditReportInTransaction(sessionUser.id, tx, query, current);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return NextResponse.json({ report }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
