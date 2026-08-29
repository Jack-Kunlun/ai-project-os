import { NextResponse } from "next/server";
import { z } from "zod";
import { markNotificationRead } from "@/lib/automation";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const bodySchema = z.object({ read: z.boolean() }).strict();

export async function PATCH(request: Request, context: { params: Promise<{ notificationId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const id = idSchema.parse((await context.params).notificationId);
    const body = bodySchema.parse(await readJsonBody(request));
    return NextResponse.json({ notification: await markNotificationRead(user.id, id, body.read) });
  } catch (error) {
    return handleApiError(error);
  }
}
