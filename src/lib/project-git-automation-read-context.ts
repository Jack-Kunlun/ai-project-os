import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { openSealedSecret, readExistingMasterKey } from "@/lib/credential-vault";
import { assertGitAutomationWorkerSession, isGitAutomationWorkerDatabase } from "@/lib/db";

const uuid = z.string().uuid();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const contextSchema = z.object({
  connection: z.object({
    id: uuid,
    providerKind: z.enum(["github", "gitee", "gitlab", "gitea", "forgejo", "generic"]),
    transport: z.enum(["https", "ssh"]),
    baseUrl: z.string().min(1).max(1024),
    authKind: z.enum(["none", "token", "basic", "sshKey"]),
    username: z.string().max(128).nullable(),
    allowPrivateNetwork: z.boolean(),
    tlsCaCertificate: z.string().nullable(),
    sshKnownHost: z.string().nullable(),
    resolvedAddressFingerprint: hex64,
    credentialId: uuid,
  }).strict(),
  credential: z.object({
    kind: z.literal("git"),
    ciphertext: base64,
    nonce: base64,
    authTag: base64,
    keyVersion: z.literal(1),
    secretFingerprint: hex64,
  }).strict(),
  baseline: z.object({ frozenCommitSha: oid }).strict().nullable(),
}).strict();

export type GitAutomationReadContext = z.infer<typeof contextSchema>;

function decodeCanonicalBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("GIT_AUTOMATION_CONTEXT_INVALID");
  return Uint8Array.from(decoded);
}

/**
 * The only Git I/O context read available to the dedicated worker. The SQL
 * function fences a dispatched lease and returns no arbitrary connection or
 * source selected by the caller.
 */
export async function loadGitAutomationReadContext(
  input: Readonly<{ runId: string; workerId: string; leaseToken: string }>,
  db: PrismaClient,
): Promise<GitAutomationReadContext | null> {
  if (!isGitAutomationWorkerDatabase(db)) throw new Error("GIT_AUTOMATION_WORKER_DATABASE_REQUIRED");
  await assertGitAutomationWorkerSession(db);
  const runId = uuid.parse(input.runId);
  const workerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).parse(input.workerId);
  const leaseToken = uuid.parse(input.leaseToken);
  const rows = await db.$transaction((tx) => tx.$queryRaw<Array<{ context: unknown }>>(Prisma.sql`
    SELECT public."project_git_automation_read_context"(
      ${runId}::uuid, ${workerId}::varchar, ${leaseToken}::uuid
    ) AS "context"
  `), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (rows[0]?.context == null) return null;
  const parsed = contextSchema.safeParse(rows[0].context);
  if (!parsed.success) throw new Error("GIT_AUTOMATION_CONTEXT_INVALID");
  if (parsed.data.connection.authKind === "none"
    || (parsed.data.connection.transport === "ssh") !== (parsed.data.connection.authKind === "sshKey")) {
    throw new Error("GIT_AUTOMATION_CONTEXT_INVALID");
  }
  return Object.freeze(parsed.data);
}

/**
 * Decrypt only after the reader's credential boundary has accepted the live
 * lease. A missing master key never creates replacement key material.
 */
export async function openGitAutomationCredential(context: GitAutomationReadContext): Promise<string> {
  const secret = openSealedSecret({
    kind: "git",
    ciphertext: decodeCanonicalBase64(context.credential.ciphertext),
    nonce: decodeCanonicalBase64(context.credential.nonce),
    authTag: decodeCanonicalBase64(context.credential.authTag),
    keyVersion: context.credential.keyVersion,
  }, await readExistingMasterKey());
  if (createHash("sha256").update(secret, "utf8").digest("hex") !== context.credential.secretFingerprint) {
    throw new Error("GIT_AUTOMATION_CONTEXT_INVALID");
  }
  return secret;
}
