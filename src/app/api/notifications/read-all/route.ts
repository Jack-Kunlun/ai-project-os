import { NextResponse } from "next/server";
import { z } from "zod";
import { markAllUserNotificationsRead } from "@/lib/automation";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const bodySchema = z.object({}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    bodySchema.parse(await readJsonBody(request));
    const result = await markAllUserNotificationsRead(user.id);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
