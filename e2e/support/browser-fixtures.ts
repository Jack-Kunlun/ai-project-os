import { randomUUID } from "node:crypto";
import { activateAccountEntitlements } from "@/lib/account-entitlement-activation-service";
import { createPasswordRecord } from "@/lib/auth";
import { getEntitlementDb } from "@/lib/db";
import { appendWorkspaceMembershipAudit } from "@/lib/membership-governance";

export type BrowserPersonalUser = Readonly<{
  id: string;
  username: string;
  password: string;
  workspaceId: string;
  activationId: string;
}>;

/**
 * Creates the ordinary-user identity used by browser suites.  Platform admin
 * setup is deliberately separate: an ordinary user owns only this personal
 * workspace and is never created through the retired global Owner flow.
 */
export async function seedBrowserPersonalUser(username: string, password: string): Promise<BrowserPersonalUser> {
  const db = getEntitlementDb();
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const passwordRecord = await createPasswordRecord(password);
  let activationId = "";

  await db.$transaction(async (tx) => {
    const user = await tx.appUser.create({
      data: { id: userId, username, role: "user", ...passwordRecord },
      select: { id: true, accountAccessVersion: true },
    });
    await tx.workspace.create({
      data: {
        id: workspaceId,
        name: `${username} 的个人工作区`,
        slug: `user-${user.id}`,
        createdById: user.id,
      },
    });
    const membership = await tx.workspaceMembership.create({
      data: {
        id: randomUUID(),
        workspaceId,
        userId: user.id,
        role: "owner",
        accessState: "confirmed",
      },
    });
    await appendWorkspaceMembershipAudit(tx, membership, {
      action: "confirmed",
      previousState: null,
      actorId: user.id,
      reason: "browser_personal_workspace_fixture_created",
    });
    const activation = await activateAccountEntitlements({
      userId: user.id,
      source: "localProvisioning",
      actorId: user.id,
      accountAccessVersion: user.accountAccessVersion,
      actorAccountAccessVersion: user.accountAccessVersion,
      evidenceKind: "browser-fixture",
      evidenceRef: `browser-personal-workspace:${user.id}`,
    }, tx);
    activationId = activation.id;
  });

  return { id: userId, username, password, workspaceId, activationId };
}
