import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { grantWorkspaceMembership } from "../src/lib/membership-governance";

/**
 * Create the smallest complete workspace fixture for a disposable PostgreSQL
 * gate.  The production default workspace is intentionally not used: project
 * rows must always point at an explicitly owned workspace.
 */
export async function createPostgresWorkspaceFixture(
  db: PrismaClient,
): Promise<Readonly<{ workspaceId: string; ownerId: string }>> {
  const suffix = randomUUID().slice(0, 8);
  const ownerId = randomUUID();
  const workspaceId = randomUUID();

  await db.$transaction(async (tx) => {
    await tx.appUser.create({
      data: {
        id: ownerId,
        username: `postgres_gate_workspace_owner_${suffix}`,
        role: "user",
        passwordHash: null,
        passwordSalt: null,
      },
    });
    await tx.workspace.create({
      data: {
        id: workspaceId,
        name: `Postgres gate workspace ${suffix}`,
        slug: `postgres-gate-${suffix}`,
        createdById: ownerId,
      },
    });
    await grantWorkspaceMembership(tx, {
      workspaceId,
      userId: ownerId,
      role: "owner",
      actorId: ownerId,
      reason: "postgres_gate_explicit_workspace_fixture",
    });
  });

  return { workspaceId, ownerId };
}
