import { NextResponse } from "next/server";
import { listUserNotifications } from "@/lib/automation";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireApiSession(request);
    return NextResponse.json(await listUserNotifications(user.id));
  } catch (error) {
    return handleApiError(error);
  }
}
