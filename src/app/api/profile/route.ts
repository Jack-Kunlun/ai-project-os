import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertSameOrigin,
  changeAccountPassword,
  expiredSessionCookie,
  requireApiSession,
  requireApiSessionReadOnly,
  setLocalAccountPassword,
  updateAccountProfile,
  updateAccountUsername,
} from "@/lib/auth";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import { toSystemRole } from "@/lib/system-role";

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
    const db = getDb();
    const profile = await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
      const clockRows = await tx.$queryRaw<Array<{ now?: Date | string }>>(Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`);
      const clockValue = clockRows[0]?.now;
      const current = clockValue instanceof Date ? clockValue : typeof clockValue === "string" ? new Date(clockValue) : null;
      if (current === null || Number.isNaN(current.getTime())) {
        throw new ApiError(503, "PROFILE_SNAPSHOT_UNAVAILABLE", "个人信息暂时无法读取");
      }
      const sessionUser = await requireApiSessionReadOnly(request, tx, current);
      const [user, activeSessionCount, latestSession] = await Promise.all([
        tx.appUser.findUnique({
          where: { id: sessionUser.id },
          select: {
            id: true, username: true, displayName: true, email: true, emailVerifiedAt: true, role: true, passwordHash: true, createdAt: true, updatedAt: true,
            workspaceMemberships: { where: { accessState: "confirmed" }, select: { role: true, workspace: { select: { id: true, name: true } } } },
            oidcIdentities: { select: { email: true, lastLoginAt: true, provider: { select: { id: true, name: true } } } },
            githubIdentity: { select: { githubUserId: true, login: true, email: true, displayName: true, lastLoginAt: true } },
          },
        }),
        tx.appSession.count({
          where: { userId: sessionUser.id, revokedAt: null, expiresAt: { gt: current } },
        }),
        tx.appSession.findFirst({
          where: { userId: sessionUser.id, revokedAt: null, expiresAt: { gt: current } },
          orderBy: { lastSeenAt: "desc" },
          select: { lastSeenAt: true, expiresAt: true },
        }),
      ]);
      if (user === null) throw new ApiError(401, "AUTH_REQUIRED", "请先登录");
      const { passwordHash, githubIdentity, role, ...safeUser } = user;
      return {
        ...safeUser,
        role: toSystemRole(role),
        githubIdentity: githubIdentity ? { ...githubIdentity, githubUserId: githubIdentity.githubUserId.toString() } : null,
        hasLocalPassword: passwordHash !== null,
        activeSessionCount,
        lastSeenAt: latestSession?.lastSeenAt ?? null,
        sessionExpiresAt: latestSession?.expiresAt ?? null,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return NextResponse.json(
      { profile },
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
