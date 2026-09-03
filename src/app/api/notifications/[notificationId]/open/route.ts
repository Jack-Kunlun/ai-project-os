import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { openNotification } from "@/lib/automation";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

/**
 * Mark a notification as read as part of opening it. The service operation is
 * idempotent and returns the sanitized destination so the client never has to
 * navigate using an untrusted stored URL.
 */
export async function POST(request: Request, context: { params: Promise<{ notificationId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const notificationId = idSchema.parse((await context.params).notificationId);
    return NextResponse.json({ notification: await openNotification(user.id, notificationId) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
