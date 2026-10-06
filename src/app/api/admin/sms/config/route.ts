import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { saveSmsProviderConfig } from "@/lib/sms-provider-admin-service";
import { noStore, readSmsAdminBody } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    return noStore(NextResponse.json(await saveSmsProviderConfig(await readSmsAdminBody(request), actor)));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
