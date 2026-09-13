import { NextResponse } from "next/server";
import { listUserNotifications, type NotificationFilter } from "@/lib/automation";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  filter: z.enum(["all", "unread", "pending", "system"]).default("all"),
  cursor: z.string().trim().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export async function GET(request: Request) {
  try {
    const user = await requireApiSession(request);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    return NextResponse.json(await listUserNotifications(user.id, undefined, { filter: query.filter as NotificationFilter, cursor: query.cursor, limit: query.limit }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
