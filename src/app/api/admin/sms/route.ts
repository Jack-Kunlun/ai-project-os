import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getSmsProviderAdminState } from "@/lib/sms-provider-admin-service";
import { noStore } from "./_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    return noStore(NextResponse.json(await getSmsProviderAdminState(actor)));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
