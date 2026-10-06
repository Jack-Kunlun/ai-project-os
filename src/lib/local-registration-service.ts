import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ApiError } from "@/lib/api-errors";
import { createPasswordRecord, createSessionInTransaction, validateAccountPassword, type CreatedSession } from "@/lib/auth";
import { assertEntitlementWriterSession, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import { lockActorAccess, lockWorkspaceAccess } from "@/lib/access-linearization";
import { grantWorkspaceMembership } from "@/lib/membership-governance";

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;

export function normalizeLocalRegistrationUsername(value: unknown): string {
  if (typeof value !== "string" || !USERNAME_PATTERN.test(value)) {
    throw new ApiError(400, "LOCAL_REGISTRATION_INVALID_INPUT", "用户名格式无效");
  }
  return value.toLowerCase();
}

function requirePhoneUsernameMatches(username: string, phoneE164?: string): void {
  if (/^1[3-9][0-9]{9}$/u.test(username) && phoneE164 !== `+86${username}`) {
    throw new ApiError(400, "LOCAL_REGISTRATION_INVALID_INPUT", "手机号需验证后才能作为用户名，请使用其他用户名或完成手机号验证");
  }
}

export type LocalRegistrationAdmission = (normalizedUsername: string, db: PrismaClient) => Promise<void>;

function isUsernameUniqueConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
  if (error.code !== "P2002") return false;
  const target: unknown = error.meta?.target;
  if (Array.isArray(target)) return target.includes("username");
  return typeof target === "string" && /username/iu.test(target);
}

/**
 * Create a user account, personal Owner workspace, membership audit, and
 * session. Admission is mandatory and runs before the password KDF so callers
 * cannot accidentally expose an unbudgeted public registration path.
 */
export async function registerLocalAccount(
  input: Readonly<{ username: unknown; password: unknown }>,
  admission: LocalRegistrationAdmission,
  db: PrismaClient = getEntitlementDb(),
  now = new Date(),
): Promise<CreatedSession> {
  const username = normalizeLocalRegistrationUsername(input.username);
  requirePhoneUsernameMatches(username);
  validateAccountPassword(input.password);
  await admission(username, db);
  const password = await createPasswordRecord(input.password);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
        const adminCount = await tx.appUser.count({ where: { role: "admin" } });
        if (adminCount === 0) {
          throw new ApiError(409, "LOCAL_REGISTRATION_NOT_INITIALIZED", "平台管理员尚未完成初始化");
        }

        return createOrdinaryAccountInTransaction(tx, { username, password }, now);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 2) continue;
      if (error instanceof Prisma.PrismaClientKnownRequestError && isUsernameUniqueConflict(error)) {
        throw new ApiError(409, "LOCAL_REGISTRATION_USERNAME_TAKEN", "该用户名已被使用");
      }
      throw error;
    }
  }
}

export async function createOrdinaryAccountInTransaction(
  tx: Prisma.TransactionClient,
  input: { id?: string; username: string; password?: Awaited<ReturnType<typeof createPasswordRecord>>; phoneE164?: string },
  now: Date,
): Promise<CreatedSession> {
  const username = input.username;
  requirePhoneUsernameMatches(username, input.phoneE164);
  const existing = await tx.appUser.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing !== null) {
    throw new ApiError(409, "LOCAL_REGISTRATION_USERNAME_TAKEN", "该用户名已被使用");
  }

  const user = await tx.appUser.create({
    data: {
      id: input.id,
      username,
      role: "user",
      email: null,
      emailVerifiedAt: null,
      ...input.password,
      ...(input.phoneE164 ? { phoneE164: input.phoneE164, phoneVerifiedAt: now } : {}),
    },
  });
  await lockActorAccess(tx, user.id);

  const workspaceId = randomUUID();
  await lockWorkspaceAccess(tx, workspaceId);
  const workspace = await tx.workspace.create({
    data: {
      id: workspaceId,
      name: `${username} 的工作区`,
      slug: `user-${user.id}`,
      createdById: user.id,
    },
    select: { id: true },
  });
  await grantWorkspaceMembership(tx, {
    workspaceId: workspace.id,
    userId: user.id,
    role: "owner",
    actorId: user.id,
    reason: "local_registration_personal_workspace_created",
  });

  return createSessionInTransaction(tx, user, now);
}
