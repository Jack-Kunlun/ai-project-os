import { NextResponse } from "next/server";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  createPersonalProjectSearchService,
  parsePersonalProjectSearchInput,
} from "@/lib/personal-project-search-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

/** Search only the explicitly selected, currently accessible project indexes. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const input = parsePersonalProjectSearchInput(await readJsonBody(request));
    const service = createPersonalProjectSearchService({ db: getDb() });
    return noStore(NextResponse.json(await service.search(actor, input)));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
