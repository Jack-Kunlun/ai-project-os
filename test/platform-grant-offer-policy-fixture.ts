import type { PrismaClient } from "@prisma/client";
import { createBootstrapSignupOfferPolicy } from "../src/lib/platform-grant-offer-policy-service";

/**
 * Test-only setup for gates that exercise a verified signup identity.  The
 * production migration intentionally does not seed an offer; disposable
 * fixtures must opt in through the same bootstrap service used by setup.
 */
export async function createSignupOfferFixture(db: PrismaClient, actorId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const activePolicy = await tx.platformGrantOfferPolicy.findFirst({
      where: { status: "active" },
      select: { id: true },
    });
    if (activePolicy !== null) return;
    await createBootstrapSignupOfferPolicy(tx, actorId);
  });
}
