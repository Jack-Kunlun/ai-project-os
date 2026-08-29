import type { GitAuthKind } from "@prisma/client";
import { z } from "zod";

const tokenSchema = z.object({
  authKind: z.literal("token"),
  token: z.string().min(8).max(4096).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value)),
}).strict();

const basicSchema = z.object({
  authKind: z.literal("basic"),
  password: z.string().min(1).max(4096).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value)),
}).strict();

const sshSchema = z.object({
  authKind: z.literal("sshKey"),
  privateKey: z.string().min(64).max(24_000),
}).strict().superRefine((value, context) => {
  const normalized = value.privateKey.replace(/\r\n/gu, "\n").trim();
  if (
    !/^-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----\n[\s\S]+\n-----END (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----$/u.test(normalized) ||
    normalized.includes("ENCRYPTED")
  ) {
    context.addIssue({ code: "custom", message: "GIT_CREDENTIAL_INVALID" });
  }
});

const payloadSchema = z.discriminatedUnion("authKind", [tokenSchema, basicSchema, sshSchema]);
export type GitCredentialPayload = z.infer<typeof payloadSchema>;

export function encodeGitCredential(authKind: Exclude<GitAuthKind, "none">, secret: unknown): string {
  const payload = authKind === "token"
    ? tokenSchema.parse({ authKind, token: secret })
    : authKind === "basic"
      ? basicSchema.parse({ authKind, password: secret })
      : sshSchema.parse({ authKind, privateKey: secret });
  const normalized = payload.authKind === "sshKey"
    ? { ...payload, privateKey: `${payload.privateKey.replace(/\r\n/gu, "\n").trim()}\n` }
    : payload;
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url");
}

export function decodeGitCredential(encoded: string, expectedAuthKind: Exclude<GitAuthKind, "none">): GitCredentialPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("GIT_CREDENTIAL_INVALID");
  }
  const payload = payloadSchema.parse(parsed);
  if (payload.authKind !== expectedAuthKind) throw new Error("GIT_CREDENTIAL_INVALID");
  return payload;
}
