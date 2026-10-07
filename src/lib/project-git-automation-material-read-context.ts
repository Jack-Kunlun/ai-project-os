import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { openSealedSecret, readExistingMasterKey } from "@/lib/credential-vault";
import { assertGitAutomationWorkerSession, isGitAutomationWorkerDatabase } from "@/lib/db";
import { decodeGitCredential } from "@/lib/git/credentials";

const uuid = z.string().uuid();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/u);
const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
const contextSchema = z.object({
  scope: z.object({
    repositoryPath: z.string().min(3).max(768),
    trackedRef: z.string().min(1).max(255),
    materialKind: z.enum(["issue", "pull_request", "release"]),
  }).strict(),
  connection: z.object({
    id: uuid,
    baseUrl: z.literal("https://github.com").or(z.literal("https://github.com/")),
    providerKind: z.literal("github"),
    transport: z.literal("https"),
    authKind: z.literal("token"),
  }).strict(),
  credential: z.object({
    kind: z.literal("git"),
    ciphertext: base64,
    nonce: base64,
    authTag: base64,
    keyVersion: z.literal(1),
    secretFingerprint: hex64,
  }).strict(),
  baseline: z.object({
    publicationVersionId: uuid,
    generation: z.number().int().positive(),
    repositoryId: z.number().int().positive().safe(),
    nodeId: z.string().min(1).max(512),
  }).strict().nullable(),
}).strict();

export type GitAutomationMaterialReadContext = z.infer<typeof contextSchema>;

function decodeCanonicalBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("GIT_AUTOMATION_MATERIAL_CONTEXT_INVALID");
  return Uint8Array.from(decoded);
}

/** The material credential is released only for a live, dispatched per-kind lease. */
export async function loadGitAutomationMaterialReadContext(
  input: Readonly<{ runId: string; workerId: string; leaseToken: string }>,
  db: PrismaClient,
): Promise<GitAutomationMaterialReadContext | null> {
  if (!isGitAutomationWorkerDatabase(db)) throw new Error("GIT_AUTOMATION_WORKER_DATABASE_REQUIRED");
  await assertGitAutomationWorkerSession(db);
  const runId = uuid.parse(input.runId);
  const workerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).parse(input.workerId);
  const leaseToken = uuid.parse(input.leaseToken);
  const rows = await db.$transaction((tx) => tx.$queryRaw<Array<{ context: unknown }>>(Prisma.sql`
    SELECT public."project_git_material_read_context"(
      ${runId}::uuid, ${workerId}::varchar, ${leaseToken}::uuid
    ) AS "context"
  `), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (rows[0]?.context == null) return null;
  const parsed = contextSchema.safeParse(rows[0].context);
  if (!parsed.success || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(parsed.data.scope.repositoryPath)) {
    throw new Error("GIT_AUTOMATION_MATERIAL_CONTEXT_INVALID");
  }
  return Object.freeze(parsed.data);
}

/** Open the sealed token only after PostgreSQL has revalidated the live lease and consent. */
export async function openGitAutomationMaterialCredential(context: GitAutomationMaterialReadContext): Promise<string> {
  const secret = openSealedSecret({
    kind: "git",
    ciphertext: decodeCanonicalBase64(context.credential.ciphertext),
    nonce: decodeCanonicalBase64(context.credential.nonce),
    authTag: decodeCanonicalBase64(context.credential.authTag),
    keyVersion: context.credential.keyVersion,
  }, await readExistingMasterKey());
  if (createHash("sha256").update(secret, "utf8").digest("hex") !== context.credential.secretFingerprint) {
    throw new Error("GIT_AUTOMATION_MATERIAL_CONTEXT_INVALID");
  }
  try {
    const credential = decodeGitCredential(secret, "token");
    if (credential.authKind !== "token") throw new Error("GIT_AUTOMATION_MATERIAL_CONTEXT_INVALID");
    return credential.token;
  } catch {
    throw new Error("GIT_AUTOMATION_MATERIAL_CONTEXT_INVALID");
  }
}
