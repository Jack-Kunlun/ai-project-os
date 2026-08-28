import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createCredential, readCredentialSecret, rotateCredential } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import {
  GITHUB_SOFT_EXCLUDE_CLASSES,
  GITHUB_VAULT_AUTH_REF,
  createGitHubRepositoryLedgerService,
} from "@/lib/github/repository-ledger";
import {
  createGitHubCredentialFromToken,
  createGitHubReadOnlyClient,
  type GitHubMaterialReadOnlyClient,
} from "@/lib/github/read-only-client";

export type WebGitHubCredentialClient = GitHubMaterialReadOnlyClient;

export type WebGitHubErrorCode =
  | "GITHUB_WEB_INVALID_INPUT"
  | "GITHUB_WEB_CREDENTIAL_REQUIRED"
  | "GITHUB_WEB_CREDENTIAL_CONFLICT"
  | "PROJECT_NOT_FOUND";

export class WebGitHubError extends Error {
  constructor(readonly code: WebGitHubErrorCode) {
    super(code);
    this.name = "WebGitHubError";
  }
}

const ownerSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);
const repositorySchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/)
  .refine((value) => value !== "." && value !== ".." && !value.toLowerCase().endsWith(".git"));
const branchSchema = z.string().min(1).max(220).regex(/^[A-Za-z0-9._/-]+$/)
  .refine((value) => !value.includes("..") && !value.includes("//") && !value.endsWith(".lock"));
const pathSchema = z.string().min(1).max(480).regex(/^[^\\*?\[\]\u0000-\u001f]+$/)
  .refine((value) => !value.startsWith("/") && !value.endsWith("/") && !value.includes("//") && !value.split("/").some((part) => part === "." || part === ".."));
const softExcludeSchema = z.enum(GITHUB_SOFT_EXCLUDE_CLASSES);
const connectSchema = z.object({
  owner: ownerSchema,
  repository: repositorySchema,
  token: z.string().min(8).max(512).optional(),
  role: z.enum(["primary", "application", "infrastructure", "library", "documentation", "other"]),
  requiredForProjectSnapshot: z.boolean(),
  trackedBranch: branchSchema,
  codeEnabled: z.boolean(),
  metadataEnabled: z.boolean(),
  readmeEnabled: z.boolean(),
  markdownPaths: z.array(pathSchema.refine((value) => /\.(md|markdown)$/i.test(value))).max(100),
  issuesEnabled: z.boolean(),
  pullRequestsEnabled: z.boolean(),
  releasesEnabled: z.boolean(),
  includeRoots: z.array(pathSchema).min(1).max(32),
  softExcludePatterns: z.array(softExcludeSchema).min(1).max(GITHUB_SOFT_EXCLUDE_CLASSES.length),
}).strict().superRefine((value, context) => {
  if (!value.codeEnabled && !value.metadataEnabled && !value.readmeEnabled && value.markdownPaths.length === 0 && !value.issuesEnabled && !value.pullRequestsEnabled && !value.releasesEnabled) {
    context.addIssue({ code: "custom", message: "At least one repository source must be enabled" });
  }
});

function fail(code: WebGitHubErrorCode): never {
  throw new WebGitHubError(code);
}

async function currentCredential(projectId: string, db: PrismaClient): Promise<Readonly<{
  id: string;
  maskedSuffix: string;
}> | null> {
  const rows = await db.gitHubConnection.findMany({
    where: { projectId, credentialId: { not: null }, status: { not: "disabled" } },
    select: { credential: { select: { id: true, maskedSuffix: true } } },
  });
  const credentials = rows.flatMap((row) => row.credential === null ? [] : [row.credential]);
  const ids = new Set(credentials.map((credential) => credential.id));
  if (ids.size > 1) return fail("GITHUB_WEB_CREDENTIAL_CONFLICT");
  return credentials[0] ?? null;
}

export async function getWebGitHubStatus(projectId: string, db: PrismaClient = getDb()) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (project === null) return fail("PROJECT_NOT_FOUND");
  const [repositories, credential] = await Promise.all([
    createGitHubRepositoryLedgerService({ db }).list(projectId),
    currentCredential(projectId, db),
  ]);
  return Object.freeze({
    repositories,
    credential: credential === null ? null : { maskedSuffix: credential.maskedSuffix },
    defaults: {
      includeRoots: ["src"],
      softExcludePatterns: [...GITHUB_SOFT_EXCLUDE_CLASSES],
    },
  });
}

export async function connectWebGitHubRepository(
  projectId: string,
  input: unknown,
  db: PrismaClient = getDb(),
) {
  const parsed = connectSchema.parse(input);
  const current = await currentCredential(projectId, db);
  let credentialId = current?.id ?? null;
  let token: string;
  if (parsed.token !== undefined) {
    token = parsed.token;
  } else if (credentialId !== null) {
    token = await readCredentialSecret(credentialId, "github", db);
  } else {
    return fail("GITHUB_WEB_CREDENTIAL_REQUIRED");
  }

  const client = createGitHubReadOnlyClient({ credential: createGitHubCredentialFromToken(token) });
  const repository = await client.getRepository({ owner: parsed.owner, repository: parsed.repository });

  let newlyCreatedCredentialId: string | null = null;
  if (parsed.token !== undefined) {
    if (credentialId === null) {
      const credential = await createCredential("github", token, db);
      credentialId = credential.id;
      newlyCreatedCredentialId = credential.id;
    } else {
      await rotateCredential(credentialId, "github", token, db);
    }
  }
  if (credentialId === null) return fail("GITHUB_WEB_CREDENTIAL_REQUIRED");

  try {
    const link = await createGitHubRepositoryLedgerService({
      db,
      authRef: GITHUB_VAULT_AUTH_REF,
      credentialId,
    }).connect({
      projectId,
      repository,
      config: {
        role: parsed.role,
        requiredForProjectSnapshot: parsed.requiredForProjectSnapshot,
        trackedRef: `refs/heads/${parsed.trackedBranch}`,
        codeEnabled: parsed.codeEnabled,
        metadataEnabled: parsed.metadataEnabled,
        readmeEnabled: parsed.readmeEnabled,
        markdownEnabled: parsed.markdownPaths.length > 0,
        markdownPaths: parsed.markdownPaths,
        issuesEnabled: parsed.issuesEnabled,
        pullRequestsEnabled: parsed.pullRequestsEnabled,
        releasesEnabled: parsed.releasesEnabled,
        includeRoots: parsed.includeRoots,
        softExcludePatterns: parsed.softExcludePatterns,
      },
    });
    return Object.freeze({ link, credential: { maskedSuffix: token.slice(-4) } });
  } catch (error) {
    if (newlyCreatedCredentialId !== null) {
      await db.externalCredential.deleteMany({
        where: { id: newlyCreatedCredentialId, githubConnections: { none: {} } },
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function loadProjectGitHubClient(
  projectId: string,
  db: PrismaClient = getDb(),
): Promise<GitHubMaterialReadOnlyClient> {
  const links = await db.projectRepositoryLink.findMany({
    where: { projectId, status: "active" },
    select: { githubConnection: { select: { credentialId: true } } },
  });
  if (links.length === 0) return fail("GITHUB_WEB_INVALID_INPUT");
  const ids = new Set(links.map((link) => link.githubConnection.credentialId).filter((id): id is string => id !== null));
  if (ids.size !== 1) return fail(ids.size === 0 ? "GITHUB_WEB_CREDENTIAL_REQUIRED" : "GITHUB_WEB_CREDENTIAL_CONFLICT");
  const credentialId = [...ids][0]!;
  const token = await readCredentialSecret(credentialId, "github", db);
  return createGitHubReadOnlyClient({ credential: createGitHubCredentialFromToken(token) });
}

/** Resolve one frozen credential identity without reselecting project scope. */
export async function loadGitHubClientForCredential(
  credentialId: string,
  db: PrismaClient = getDb(),
  options: Readonly<{ absoluteDeadlineAt?: Date | number | null; expectedSecretFingerprint?: string }> = {},
): Promise<WebGitHubCredentialClient> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(credentialId)) {
    return fail("GITHUB_WEB_INVALID_INPUT");
  }
  const credential = await db.externalCredential.findUnique({
    where: { id: credentialId },
    select: { id: true, kind: true, secretFingerprint: true },
  });
  if (credential === null || credential.kind !== "github") return fail("GITHUB_WEB_CREDENTIAL_REQUIRED");
  if (options.expectedSecretFingerprint !== undefined &&
    (typeof options.expectedSecretFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(options.expectedSecretFingerprint) ||
      credential.secretFingerprint !== options.expectedSecretFingerprint)) {
    return fail("GITHUB_WEB_CREDENTIAL_REQUIRED");
  }
  const token = await readCredentialSecret(credential.id, "github", db, {
    expectedSecretFingerprint: options.expectedSecretFingerprint,
  });
  return createGitHubReadOnlyClient({
    credential: createGitHubCredentialFromToken(token),
    absoluteDeadlineAt: options.absoluteDeadlineAt,
  });
}

export async function disableWebGitHubRepository(
  projectId: string,
  linkId: string,
  db: PrismaClient = getDb(),
) {
  return createGitHubRepositoryLedgerService({ db }).disable({ projectId, linkId });
}

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
