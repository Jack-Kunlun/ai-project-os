import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  assertSystemFailureInboxAdmin,
  listSystemFailureInbox,
  parseSystemFailureInboxQuery,
} from "@/lib/system-failure-inbox";

const noStore = { "cache-control": "private, no-store" } as const;

export async function handleSystemFailureInboxGet(
  request: Request,
  dependencies: Readonly<{ db?: Parameters<typeof requireApiSession>[1] }> = {},
): Promise<NextResponse> {
  const db = dependencies.db ?? getDb();
  try {
    const actor = await requireApiSession(request, db);
    await assertSystemFailureInboxAdmin(actor, db);
    const query = parseSystemFailureInboxQuery(Object.fromEntries(new URL(request.url).searchParams.entries()));
    return NextResponse.json(await listSystemFailureInbox(actor, query, db), { headers: noStore });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", noStore["cache-control"]);
    return response;
  }
}
