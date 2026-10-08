import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

export type AccountSecurityAuditAction = "password_set" | "password_changed" | "password_recovered" | "phone_bound" | "phone_changed";

export type AccountSecurityAuditInput = Readonly<{
  userId: string;
  actorId: string | null;
  action: AccountSecurityAuditAction;
  securityRevisionBefore: number;
  phoneFingerprintBefore?: string | null;
  phoneFingerprintAfter?: string | null;
  proofChallengeId?: string | null;
  secondaryProofChallengeId?: string | null;
}>;

/** Append immutable evidence in the same transaction as the account mutation. */
export async function appendAccountSecurityAudit(tx: Prisma.TransactionClient, input: AccountSecurityAuditInput): Promise<string> {
  const id = randomUUID();
  await tx.$executeRaw`SELECT set_config('app.account_security_audit_id',${id},true)`;
  await tx.appUserSecurityAudit.create({
    data: {
      id,
      userId: input.userId,
      actorId: input.actorId,
      action: input.action,
      securityRevisionBefore: input.securityRevisionBefore,
      securityRevisionAfter: input.securityRevisionBefore + 1,
      phoneFingerprintBefore: input.phoneFingerprintBefore ?? null,
      phoneFingerprintAfter: input.phoneFingerprintAfter ?? null,
      proofChallengeId: input.proofChallengeId ?? null,
      secondaryProofChallengeId: input.secondaryProofChallengeId ?? null,
    },
  });
  return id;
}
