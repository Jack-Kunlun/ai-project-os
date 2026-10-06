import { readCaptchaBrowserToken } from "@/lib/graphic-captcha-cookie";
import { getEntitlementDb } from "@/lib/db";
import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { sendSmsProviderProbe } from "@/lib/sms-provider-admin-service";
import { noStore, readSmsAdminBody } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const result = await sendSmsProviderProbe(await readSmsAdminBody(request), actor, getEntitlementDb(), readCaptchaBrowserToken(request) ?? "");
    return noStore(NextResponse.json(result, { status: 201 }));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
