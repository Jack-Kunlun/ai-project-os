import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertSameOrigin,
  changeAccountPassword,
  expiredSessionCookie,
  requireApiSession,
  setLocalAccountPassword,
  updateAccountProfile,
  updateAccountUsername,
} from "@/lib/auth";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const profileUpdateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("updateUsername"), username: z.string() }).strict(),
  z.object({ action: z.literal("updateProfile"), displayName: z.string().nullable(), email: z.string().nullable() }).strict(),
  z.object({ action: z.literal("setLocalPassword"), newPassword: z.string() }).strict(),
  z.object({
    action: z.literal("changePassword"),
    currentPassword: z.string(),
    newPassword: z.string(),
  }).strict(),
]);

export async function GET(request: Request) {
  try {
    const sessionUser = await requireApiSession(request);
    const db = getDb();
    const [user, activeSessionCount, latestSession] = await Promise.all([
      db.appUser.findUnique({
        where: { id: sessionUser.id },
        select: {
          id: true, username: true, displayName: true, email: true, role: true, passwordHash: true, createdAt: true, updatedAt: true,
          workspaceMemberships: { select: { role: true, workspace: { select: { id: true, name: true } } } },
          oidcIdentities: { select: { email: true, lastLoginAt: true, provider: { select: { id: true, name: true } } } },
        },
      }),
      db.appSession.count({
        where: { userId: sessionUser.id, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      db.appSession.findFirst({
        where: { userId: sessionUser.id, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastSeenAt: "desc" },
        select: { lastSeenAt: true, expiresAt: true },
      }),
    ]);
    if (user === null) throw new ApiError(401, "AUTH_REQUIRED", "请先登录");
    return NextResponse.json(
      { profile: { ...user, passwordHash: undefined, hasLocalPassword: user.passwordHash !== null, activeSessionCount, lastSeenAt: latestSession?.lastSeenAt ?? null, sessionExpiresAt: latestSession?.expiresAt ?? null } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const sessionUser = await requireApiSession(request);
    const input = profileUpdateSchema.parse(await readJsonBody(request));
    if (input.action === "updateUsername") {
      const user = await updateAccountUsername(sessionUser.id, input.username);
      return NextResponse.json({ user }, { headers: { "cache-control": "no-store" } });
    }
    if (input.action === "updateProfile") {
      const user = await updateAccountProfile(sessionUser.id, input);
      return NextResponse.json({ user }, { headers: { "cache-control": "no-store" } });
    }
    if (input.action === "setLocalPassword") {
      await setLocalAccountPassword(sessionUser.id, input.newPassword);
      return NextResponse.json({ passwordChanged: true }, { headers: { "cache-control": "no-store", "set-cookie": expiredSessionCookie() } });
    }

    await changeAccountPassword(sessionUser.id, input.currentPassword, input.newPassword);
    return NextResponse.json(
      { passwordChanged: true },
      {
        headers: {
          "cache-control": "no-store",
          "set-cookie": expiredSessionCookie(),
        },
      },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return handleApiError(new ApiError(409, "AUTH_USERNAME_CONFLICT", "该登录名已被使用"));
    }
    return handleApiError(error);
  }
}
