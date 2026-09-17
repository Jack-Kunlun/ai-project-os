import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, changeAccountPassword, expiredSessionCookie, requireApiSession, setLocalAccountPassword, updateAccountProfile } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const updateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("updateProfile"), displayName: z.string().nullable(), email: z.string().nullable() }).strict(),
  z.object({ action: z.literal("setLocalPassword"), newPassword: z.string() }).strict(),
  z.object({ action: z.literal("changePassword"), currentPassword: z.string(), newPassword: z.string() }).strict(),
]);

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    if (actor.role !== "admin") throw new ApiError(403, "AUTH_FORBIDDEN", "没有权限执行此操作");
    const db = getDb();
    const [user, activeSessionCount, latestSession] = await Promise.all([
      db.appUser.findUnique({ where: { id: actor.id }, select: { username: true, displayName: true, email: true, emailVerifiedAt: true, passwordHash: true } }),
      db.appSession.count({ where: { userId: actor.id, revokedAt: null, expiresAt: { gt: new Date() } } }),
      db.appSession.findFirst({ where: { userId: actor.id, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: "desc" }, select: { lastSeenAt: true } }),
    ]);
    if (user === null) throw new ApiError(401, "AUTH_REQUIRED", "请先登录");
    const { passwordHash, ...profile } = user;
    return NextResponse.json({ profile: { ...profile, hasLocalPassword: passwordHash !== null, activeSessionCount, lastSeenAt: latestSession?.lastSeenAt ?? null } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    if (actor.role !== "admin") throw new ApiError(403, "AUTH_FORBIDDEN", "没有权限执行此操作");
    const input = updateSchema.parse(await readJsonBody(request));
    if (input.action === "updateProfile") {
      return NextResponse.json({ user: await updateAccountProfile(actor.id, input) }, { headers: { "cache-control": "no-store" } });
    }
    if (input.action === "setLocalPassword") await setLocalAccountPassword(actor.id, input.newPassword);
    else await changeAccountPassword(actor.id, input.currentPassword, input.newPassword);
    return NextResponse.json({ passwordChanged: true }, { headers: { "cache-control": "no-store", "set-cookie": expiredSessionCookie() } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return handleApiError(new ApiError(409, "AUTH_USERNAME_CONFLICT", "该登录名已被使用"));
    }
    return handleApiError(error);
  }
}
