import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Prisma, type AppUser, type GitAuthKind, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { CredentialVaultError, createCredential, readCredentialSecret, rotateCredential } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";
import { hashSourceContent, MAX_SOURCE_CONTENT_LENGTH } from "@/lib/source";
import { assertWebAiProjectAccess, type WebAiActor } from "@/lib/web-ai-access";
import {
  claimProjectJob,
  failProjectJob,
  finishProjectJob,
  markProviderAcknowledged,
  markProviderNotDispatched,
  startProjectJobHeartbeat,
  toPublicProjectJob,
  withProjectJobAccessTransaction,
} from "@/lib/project-workflow";
import { decodeGitCredential, encodeGitCredential, type GitCredentialPayload } from "./credentials";
import { gitRemoteUrl, GitRunnerError, withGitRunner } from "./runner";
import { GIT_REPOSITORY_SCAN_POLICY } from "./scan-policy";
import {
  assertPinnedGitEndpoint,
  canonicalExcludePatterns,
  canonicalGitBaseUrl,
  canonicalIncludeRoots,
  canonicalRepositoryPath,
  canonicalSshKnownHost,
  canonicalTlsCaCertificate,
  canonicalTrackedRef,
  type GitEndpointResolution,
  GitSafetyError,
  resolveGitEndpoint,
} from "./safety";

const MAX_SCANNED_FILES = GIT_REPOSITORY_SCAN_POLICY.maxScannedFiles;
const MAX_FILE_BYTES = GIT_REPOSITORY_SCAN_POLICY.maxFileBytes;
const MAX_TOTAL_BYTES = GIT_REPOSITORY_SCAN_POLICY.maxTotalBytes;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?\/?$)(?!.*[\u0000-\u001f\u007f-\u009f\\])[^\u0000]{1,1024}$/u;
const TEXT_EXTENSIONS = new Set([
  "", ".c", ".cc", ".conf", ".cpp", ".cs", ".css", ".csv", ".env.example", ".go", ".graphql", ".h", ".hpp",
  ".html", ".ini", ".java", ".js", ".json", ".jsx", ".kt", ".kts", ".md", ".mdx", ".mjs", ".php", ".properties",
  ".proto", ".py", ".rb", ".rs", ".scala", ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt",
  ".vue", ".xml", ".yaml", ".yml", ".zsh",
]);
const ALWAYS_EXCLUDED_SEGMENTS = new Set([".git", ".next", ".nuxt", "coverage", "dist", "node_modules", "target", "vendor"]);

// Kept as an explicit gate so the future delegation implementation has one
// auditable switch to replace. This package must remain fail-closed.
function projectPersonalDelegationEnabled(): boolean {
  return false;
}

export function gitRepositoryScanPolicy() {
  return GIT_REPOSITORY_SCAN_POLICY;
}

export type GitServiceErrorCode =
  | "GIT_CONNECTION_INVALID_INPUT"
  | "GIT_CONNECTION_NOT_FOUND"
  | "GIT_CONNECTION_NAME_CONFLICT"
  | "GIT_CONNECTION_CONFLICT"
  | "GIT_CONNECTION_IN_USE"
  | "GIT_CONNECTION_DISABLED"
  | "GIT_CONNECTION_NOT_VERIFIED"
  | "GIT_LEGACY_PROJECT_CONNECT_FROZEN"
  | "GIT_LEGACY_CONNECTION_API_FROZEN"
  | "GIT_CONNECTION_DELETE_REQUIRES_DISABLED"
  | "GIT_CONNECTION_CONFIRMATION_MISMATCH"
  | "GIT_REPOSITORY_NOT_FOUND"
  | "GIT_REPOSITORY_CONFLICT"
  | "GIT_REPOSITORY_EMPTY"
  | "GIT_REPOSITORY_TOO_LARGE"
  | "GIT_REPOSITORY_BINARY_ONLY"
  | "GIT_REPOSITORY_LINK_NOT_FOUND"
  | "GIT_REPOSITORY_LINK_DISABLED"
  | "GIT_REPOSITORY_SYNC_FAILED";

export class GitServiceError extends Error {
  constructor(readonly code: GitServiceErrorCode) {
    super(code);
    this.name = "GitServiceError";
  }
}

// A GitRunnerError can be raised while creating the temporary workspace or
// configuring the local repository, before the fetch process is started. Keep
// that distinction out of the public error shape while allowing the caller to
// undo the optimistic dispatch marker for deterministic pre-fetch failures.
const preDispatchGitErrors = new WeakSet<object>();

function markPreDispatchGitError(error: unknown): unknown {
  if (typeof error === "object" && error !== null) preDispatchGitErrors.add(error);
  return error;
}

function isDefinitelyPreDispatchGitSyncFailure(error: unknown): boolean {
  if (error instanceof CredentialVaultError) return true;
  if (typeof error === "object" && error !== null && preDispatchGitErrors.has(error)) return true;
  if (error instanceof GitSafetyError) return error.code !== "GIT_NETWORK_CHANGED";
  return error instanceof GitServiceError && [
    "GIT_CONNECTION_INVALID_INPUT",
    "GIT_REPOSITORY_LINK_NOT_FOUND",
    "GIT_REPOSITORY_LINK_DISABLED",
  ].includes(error.code);
}

const providerKindSchema = z.enum(["github", "gitee", "gitlab", "gitea", "forgejo", "generic"]);
const transportSchema = z.enum(["https", "ssh"]);
const authKindSchema = z.enum(["none", "token", "basic", "sshKey"]);
const createConnectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  providerKind: providerKindSchema,
  transport: transportSchema,
  baseUrl: z.string().min(1).max(1024),
  authKind: authKindSchema,
  username: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u).nullable().optional(),
  secret: z.string().min(1).max(24_000).nullable().optional(),
  allowPrivateNetwork: z.boolean().default(false),
  tlsCaCertificate: z.string().max(32_768).nullable().optional(),
  sshKnownHost: z.string().max(4096).nullable().optional(),
}).strict();

const updateConnectionSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  username: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u).nullable().optional(),
  secret: z.string().min(1).max(24_000).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  tlsCaCertificate: z.string().max(32_768).nullable().optional(),
  sshKnownHost: z.string().max(4096).nullable().optional(),
  enabled: z.boolean().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

const deleteConnectionSchema = z.object({
  confirmationName: z.string().min(1).max(80),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

const repositoryProbeSchema = z.object({
  repositoryPath: z.string().min(1).max(768),
  trackedRef: z.string().min(1).max(255),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

const syncSchema = z.object({
  clientKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/u),
}).strict();

const connectionSelect = {
  id: true,
  name: true,
  providerKind: true,
  transport: true,
  baseUrl: true,
  authKind: true,
  username: true,
  allowPrivateNetwork: true,
  tlsCaCertificate: true,
  sshKnownHost: true,
  status: true,
  configurationVersion: true,
  ownershipState: true,
  lastTestedAt: true,
  lastErrorCode: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
  credential: { select: { maskedSuffix: true, rotatedAt: true, updatedAt: true } },
  _count: { select: { repositories: true } },
} satisfies Prisma.GitConnectionSelect;

const linkSelect = {
  id: true,
  projectId: true,
  role: true,
  trackedRef: true,
  requiredForProjectSnapshot: true,
  codeEnabled: true,
  metadataEnabled: true,
  includeRoots: true,
  softExcludePatterns: true,
  status: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
  repository: {
    select: {
      id: true,
      repositoryPath: true,
      displayName: true,
      webUrl: true,
      defaultBranch: true,
      remoteIdentifier: true,
      isPrivate: true,
      lastVerifiedAt: true,
      connection: { select: connectionSelect },
    },
  },
  snapshotPointer: {
    select: {
      publishedAt: true,
      snapshot: {
        select: {
          id: true,
          status: true,
          frozenCommitSha: true,
          manifestFingerprint: true,
          fileCount: true,
          decodedTextBytes: true,
          completedAt: true,
        },
      },
    },
  },
  snapshots: {
    orderBy: { startedAt: "desc" },
    take: 1,
    select: {
      id: true,
      status: true,
      frozenCommitSha: true,
      fileCount: true,
      decodedTextBytes: true,
      failureCode: true,
      startedAt: true,
      completedAt: true,
    },
  },
} satisfies Prisma.ProjectGitRepositoryLinkSelect;

const projectRepositoryLinkSelect = {
  ...linkSelect,
  repository: {
    ...linkSelect.repository,
    select: {
      ...linkSelect.repository.select,
      connection: { select: { id: true, name: true, providerKind: true, transport: true } },
    },
  },
} satisfies Prisma.ProjectGitRepositoryLinkSelect;

export type GitConnectionWithSecret = Prisma.GitConnectionGetPayload<{
  include: { credential: true };
}>;

export type GitScannedFile = Readonly<{
  path: string;
  blobOid: string;
  contentText: string;
  contentHash: string;
  contentBytes: number;
  lineCount: number;
  externalRef: string | null;
}>;

function fail(code: GitServiceErrorCode): never {
  throw new GitServiceError(code);
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("GIT_CONNECTION_INVALID_INPUT");
  return value;
}

function timestamp(value: string): Date {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fail("GIT_CONNECTION_INVALID_INPUT");
}

function validateAuth(input: z.infer<typeof createConnectionSchema>): void {
  const hasSecret = typeof input.secret === "string" && input.secret.length > 0;
  if ((input.authKind === "none") !== !hasSecret) fail("GIT_CONNECTION_INVALID_INPUT");
  if (input.transport === "ssh" && input.authKind !== "sshKey") fail("GIT_CONNECTION_INVALID_INPUT");
  if (input.transport === "https" && input.authKind === "sshKey") fail("GIT_CONNECTION_INVALID_INPUT");
  if (input.transport === "ssh" && input.sshKnownHost == null) fail("GIT_CONNECTION_INVALID_INPUT");
  if (input.transport === "https" && input.sshKnownHost != null) fail("GIT_CONNECTION_INVALID_INPUT");
}

function credentialAuthKind(value: GitAuthKind): Exclude<GitAuthKind, "none"> {
  if (value === "none") return fail("GIT_CONNECTION_INVALID_INPUT");
  return value;
}

async function loadCredential(
  connection: GitConnectionWithSecret,
  db: PrismaClient,
  expectedSecretFingerprint?: string,
): Promise<GitCredentialPayload | null> {
  if (connection.authKind === "none") return null;
  if (connection.credentialId === null) return fail("GIT_CONNECTION_INVALID_INPUT");
  return decodeGitCredential(
    await readCredentialSecret(connection.credentialId, "git", db, { expectedSecretFingerprint }),
    credentialAuthKind(connection.authKind),
  );
}

function defaultUsername(connection: Pick<GitConnectionWithSecret, "providerKind" | "authKind" | "username">): string | null {
  if (connection.username !== null) return connection.username;
  if (connection.authKind === "token") {
    if (connection.providerKind === "github") return "x-access-token";
    if (connection.providerKind === "gitlab" || connection.providerKind === "gitee") return "oauth2";
  }
  return connection.authKind === "none" ? null : "git";
}

async function loadOwnedConnection(connectionId: string, actor: Pick<AppUser, "id">, db: PrismaClient): Promise<GitConnectionWithSecret> {
  const connection = await db.gitConnection.findFirst({
    where: { id: connectionId, ownerUserId: actor.id, ownershipState: "confirmed" },
    include: { credential: true },
  });
  if (connection === null) return fail("GIT_CONNECTION_NOT_FOUND");
  if (connection.status === "disabled") return fail("GIT_CONNECTION_DISABLED");
  return connection;
}

async function probeRepository(
  connection: GitConnectionWithSecret,
  repositoryPath: string,
  trackedRef: string,
  options: Readonly<{ pinExistingAddress: boolean; db: PrismaClient }>,
): Promise<Readonly<{ commitSha: string; addressFingerprint: string }>> {
  const resolution = options.pinExistingAddress
    ? await assertPinnedGitEndpoint({
        baseUrl: connection.baseUrl,
        allowPrivateNetwork: connection.allowPrivateNetwork,
        expectedFingerprint: connection.resolvedAddressFingerprint,
      })
    : await resolveGitEndpoint({
        baseUrl: connection.baseUrl,
        allowPrivateNetwork: connection.allowPrivateNetwork,
      });
  const endpointUrl = new URL(connection.baseUrl);
  const credential = await loadCredential(connection, options.db, connection.credential?.secretFingerprint ?? undefined);
  const remote = gitRemoteUrl(connection.baseUrl, repositoryPath);
  const output = await withGitRunner({
    transport: connection.transport,
    authKind: connection.authKind,
    username: defaultUsername(connection),
    credential,
    tlsCaCertificate: connection.tlsCaCertificate,
    sshKnownHost: connection.sshKnownHost,
    pinnedEndpoint: { hostname: endpointUrl.hostname, port: endpointUrl.port || (connection.transport === "ssh" ? "22" : "443"), addresses: resolution.addresses },
  }, (runner) => runner.runText(["ls-remote", "--exit-code", remote, `refs/heads/${trackedRef}`], { maxOutputBytes: 64 * 1024 }));
  const commitSha = output.trim().split(/\s+/u)[0] ?? "";
  if (!/^[0-9a-f]{40,64}$/u.test(commitSha)) return fail("GIT_REPOSITORY_NOT_FOUND");
  return Object.freeze({ commitSha, addressFingerprint: resolution.fingerprint });
}

function canonicalWebUrl(value: string | null | undefined, connection: GitConnectionWithSecret, repositoryPath: string): string {
  const candidate = value ?? (() => {
    const base = new URL(connection.baseUrl);
    return `https://${base.hostname}${base.pathname.replace(/\/$/u, "")}/${repositoryPath}`;
  })();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail("GIT_CONNECTION_INVALID_INPUT");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return fail("GIT_CONNECTION_INVALID_INPUT");
  }
  return url.toString().replace(/\/$/u, "");
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

function fileExtension(path: string): string {
  const name = path.split("/").at(-1)!.toLowerCase();
  if (["dockerfile", "makefile", "license", "readme", ".gitignore", ".dockerignore"].includes(name)) return "";
  if (name.endsWith(".env.example")) return ".env.example";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

function isIncludedPath(path: string, roots: readonly string[], excludes: readonly RegExp[]): boolean {
  if (!SAFE_PATH_PATTERN.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((segment) => ALWAYS_EXCLUDED_SEGMENTS.has(segment.toLowerCase()))) return false;
  if (!TEXT_EXTENSIONS.has(fileExtension(path))) return false;
  if (!roots.some((root) => root === "." || path === root || path.startsWith(`${root}/`))) return false;
  return !excludes.some((pattern) => pattern.test(path));
}

function sourceReference(webUrl: string, providerKind: GitConnectionWithSecret["providerKind"], commitSha: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const encodedCommit = encodeURIComponent(commitSha);
  if (providerKind === "gitlab") return `${webUrl}/-/blob/${encodedCommit}/${encodedPath}`;
  if (providerKind === "gitea" || providerKind === "forgejo") return `${webUrl}/src/commit/${encodedCommit}/${encodedPath}`;
  return `${webUrl}/blob/${encodedCommit}/${encodedPath}`;
}

function deterministicUuid(input: string): string {
  const bytes = Buffer.from(createHash("sha256").update(input, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  const text = bytes.toString("utf8").replace(/\r\n/gu, "\n");
  const replacements = [...text.matchAll(/�/gu)].length;
  if (replacements > Math.max(2, Math.floor(text.length / 1000))) return null;
  return text;
}

function parseTree(output: string): readonly { path: string; blobOid: string; bytes: number }[] {
  const rows: { path: string; blobOid: string; bytes: number }[] = [];
  for (const record of output.split("\0")) {
    if (record.length === 0) continue;
    const match = record.match(/^[0-7]{6}\s+blob\s+([0-9a-f]{40,64})\s+(\d+)\t([\s\S]+)$/u);
    if (match === null) continue;
    rows.push({ blobOid: match[1]!, bytes: Number(match[2]), path: match[3]! });
  }
  return Object.freeze(rows);
}

async function readRepositoryFiles(input: Readonly<{
  connection: GitConnectionWithSecret;
  repositoryPath: string;
  trackedRef: string;
  webUrl?: string;
  includeRoots: readonly string[];
  softExcludePatterns: readonly string[];
  db: PrismaClient;
  pinnedResolution?: GitEndpointResolution;
  onDispatchStart?: () => void;
}>): Promise<Readonly<{ commitSha: string; addressFingerprint: string; files: readonly GitScannedFile[] }>> {
  const resolution = input.pinnedResolution ?? await assertPinnedGitEndpoint({
    baseUrl: input.connection.baseUrl,
    allowPrivateNetwork: input.connection.allowPrivateNetwork,
    expectedFingerprint: input.connection.resolvedAddressFingerprint,
  });
  const credential = await loadCredential(input.connection, input.db, input.connection.credential?.secretFingerprint ?? undefined);
  const remote = gitRemoteUrl(input.connection.baseUrl, input.repositoryPath);
  const endpointUrl = new URL(input.connection.baseUrl);
  let fetchStarted = false;
  try {
    return await withGitRunner({
    transport: input.connection.transport,
    authKind: input.connection.authKind,
    username: defaultUsername(input.connection),
    credential,
    tlsCaCertificate: input.connection.tlsCaCertificate,
    sshKnownHost: input.connection.sshKnownHost,
    pinnedEndpoint: { hostname: endpointUrl.hostname, port: endpointUrl.port || (input.connection.transport === "ssh" ? "22" : "443"), addresses: resolution.addresses },
  }, async (runner) => {
    const repositoryDir = join(runner.root, "repository.git");
    await mkdir(repositoryDir, { mode: 0o700 });
    await runner.runText(["init", "--bare", repositoryDir], { maxOutputBytes: 64 * 1024 });
    await runner.runText(["-C", repositoryDir, "remote", "add", "origin", remote], { maxOutputBytes: 64 * 1024 });
    // From this point Git may contact the configured remote. Any later
    // runner error therefore keeps the dispatch marker for reconciliation.
    fetchStarted = true;
    input.onDispatchStart?.();
    await runner.runText(["-C", repositoryDir, "fetch", "--depth=1", "--no-tags", "origin", `refs/heads/${input.trackedRef}`], { timeoutMs: 180_000, maxOutputBytes: 256 * 1024 });
    const commitSha = (await runner.runText(["-C", repositoryDir, "rev-parse", "FETCH_HEAD"], { maxOutputBytes: 64 * 1024 })).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(commitSha)) return fail("GIT_REPOSITORY_EMPTY");
    const tree = parseTree(await runner.runText(["-C", repositoryDir, "ls-tree", "-r", "-l", "-z", "--full-tree", "FETCH_HEAD"], { maxOutputBytes: 8 * 1024 * 1024 }));
    const excludes = input.softExcludePatterns.map(globRegex);
    const candidates = tree
      .filter((entry) => entry.bytes <= MAX_FILE_BYTES && isIncludedPath(entry.path, input.includeRoots, excludes))
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    if (candidates.length === 0) return fail(tree.length === 0 ? "GIT_REPOSITORY_EMPTY" : "GIT_REPOSITORY_BINARY_ONLY");
    if (candidates.length > MAX_SCANNED_FILES) return fail("GIT_REPOSITORY_TOO_LARGE");
    if (candidates.reduce((sum, entry) => sum + entry.bytes, 0) > MAX_TOTAL_BYTES) return fail("GIT_REPOSITORY_TOO_LARGE");

    const files: GitScannedFile[] = [];
    for (const entry of candidates) {
      const body = normalizeText(await runner.runBytes(["-C", repositoryDir, "cat-file", "blob", entry.blobOid], { maxOutputBytes: MAX_FILE_BYTES + 1024 }));
      if (body === null) continue;
      const externalRef = input.webUrl === undefined
        ? null
        : sourceReference(input.webUrl, input.connection.providerKind, commitSha, entry.path);
      const prefix = `Repository: ${input.repositoryPath}\nRevision: ${commitSha}\nPath: ${entry.path}\n\n`;
      const contentText = `${prefix}${body}`.slice(0, MAX_SOURCE_CONTENT_LENGTH);
      const contentBytes = Buffer.byteLength(contentText, "utf8");
      files.push(Object.freeze({
        path: entry.path,
        blobOid: entry.blobOid,
        contentText,
        contentHash: hashSourceContent(contentText),
        contentBytes,
        lineCount: contentText.length === 0 ? 0 : contentText.split("\n").length,
        externalRef,
      }));
    }
    if (files.length === 0) return fail("GIT_REPOSITORY_BINARY_ONLY");
    return Object.freeze({ commitSha, addressFingerprint: resolution.fingerprint, files: Object.freeze(files) });
    });
  } catch (error) {
    if (!fetchStarted) throw markPreDispatchGitError(error);
    throw error;
  }
}

/**
 * The project-delegated runtime supplies the DNS-pinned endpoint obtained
 * during Admission A.  Keeping this wrapper narrow prevents the runtime from
 * accidentally reaching the legacy project snapshot path.
 */
export async function readGitRepositoryFilesForDelegation(input: Readonly<{
  connection: GitConnectionWithSecret;
  repositoryPath: string;
  trackedRef: string;
  includeRoots: readonly string[];
  softExcludePatterns: readonly string[];
  db: PrismaClient;
  pinnedResolution: GitEndpointResolution;
  onDispatchStart?: () => void;
}>): Promise<Readonly<{ commitSha: string; addressFingerprint: string; files: readonly GitScannedFile[] }>> {
  return readRepositoryFiles(input);
}

export function gitConnectionCatalog() {
  return Object.freeze([
    { kind: "github", label: "GitHub", defaultHttpsUrl: "https://github.com", defaultSshUrl: "ssh://git@github.com" },
    { kind: "gitee", label: "Gitee", defaultHttpsUrl: "https://gitee.com", defaultSshUrl: "ssh://git@gitee.com" },
    { kind: "gitlab", label: "GitLab / GitLab Self-Managed", defaultHttpsUrl: "https://gitlab.com", defaultSshUrl: "ssh://git@gitlab.com" },
    { kind: "gitea", label: "Gitea", defaultHttpsUrl: "https://git.example.com", defaultSshUrl: "ssh://git@git.example.com" },
    { kind: "forgejo", label: "Forgejo", defaultHttpsUrl: "https://git.example.com", defaultSshUrl: "ssh://git@git.example.com" },
    { kind: "generic", label: "通用 Git 服务", defaultHttpsUrl: "https://git.example.com", defaultSshUrl: "ssh://git@git.example.com" },
  ] as const);
}

export async function listGitConnections(actor: Pick<AppUser, "id">, db: PrismaClient = getDb()) {
  return db.gitConnection.findMany({
    where: { ownerUserId: actor.id, ownershipState: "confirmed" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: connectionSelect,
  });
}

export async function getGitConnection(connectionIdInput: unknown, actor: Pick<AppUser, "id">, db: PrismaClient = getDb()) {
  const connectionId = uuid(connectionIdInput);
  const connection = await db.gitConnection.findFirst({
    where: { id: connectionId, ownerUserId: actor.id, ownershipState: "confirmed" },
    select: connectionSelect,
  });
  if (connection === null) return fail("GIT_CONNECTION_NOT_FOUND");
  return connection;
}

export async function createGitConnection(input: unknown, actor: Pick<AppUser, "id">, db: PrismaClient = getDb()) {
  const parsed = createConnectionSchema.parse(input);
  validateAuth(parsed);
  const baseUrl = canonicalGitBaseUrl(parsed.baseUrl, parsed.transport);
  const tlsCaCertificate = parsed.transport === "https" ? canonicalTlsCaCertificate(parsed.tlsCaCertificate) : null;
  const sshKnownHost = parsed.transport === "ssh" ? canonicalSshKnownHost(parsed.sshKnownHost) : null;
  try {
    return await db.$transaction(async (tx) => {
      const credential = parsed.authKind === "none"
        ? null
        : await createCredential("git", encodeGitCredential(credentialAuthKind(parsed.authKind), parsed.secret), tx);
      return tx.gitConnection.create({
        data: {
          name: parsed.name,
          providerKind: parsed.providerKind,
          transport: parsed.transport,
          baseUrl,
          authKind: parsed.authKind,
          username: parsed.username ?? null,
          credentialId: credential?.id ?? null,
          allowPrivateNetwork: parsed.allowPrivateNetwork,
          tlsCaCertificate,
          sshKnownHost,
          createdById: actor.id,
          ownerUserId: actor.id,
          ownershipState: "confirmed",
        },
        select: connectionSelect,
      });
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("GIT_CONNECTION_NAME_CONFLICT");
    throw error;
  }
}

export async function updateGitConnection(
  connectionIdInput: unknown,
  input: unknown,
  actor: Pick<AppUser, "id">,
  db: PrismaClient = getDb(),
) {
  const connectionId = uuid(connectionIdInput);
  const parsed = updateConnectionSchema.parse(input);
  const expectedUpdatedAt = timestamp(parsed.expectedUpdatedAt);
  const existing = await db.gitConnection.findFirst({
    where: { id: connectionId, ownerUserId: actor.id, ownershipState: "confirmed" },
  });
  if (existing === null) return fail("GIT_CONNECTION_NOT_FOUND");
  if (parsed.enabled === false) {
    const activeLink = await db.projectGitRepositoryLink.findFirst({
      where: { repository: { gitConnectionId: connectionId }, status: "active" },
      select: { id: true },
    });
    if (activeLink !== null) return fail("GIT_CONNECTION_IN_USE");
  }
  const tlsCaCertificate = parsed.tlsCaCertificate === undefined
    ? undefined
    : existing.transport === "https" ? canonicalTlsCaCertificate(parsed.tlsCaCertificate) : null;
  const sshKnownHost = parsed.sshKnownHost === undefined
    ? undefined
    : existing.transport === "ssh" ? canonicalSshKnownHost(parsed.sshKnownHost) : null;
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('ai-project-git-repository-delegation-global', 0))`;
      await tx.$queryRaw`SELECT "id" FROM "GitConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`;
      const current = await tx.gitConnection.findFirst({
        where: { id: connectionId, ownerUserId: actor.id, ownershipState: "confirmed" },
      });
      if (current === null) return fail("GIT_CONNECTION_NOT_FOUND");
      if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return fail("GIT_CONNECTION_CONFLICT");
      if (parsed.secret !== undefined) {
        if (current.credentialId === null || current.authKind === "none") return fail("GIT_CONNECTION_INVALID_INPUT");
        await rotateCredential(current.credentialId, "git", encodeGitCredential(credentialAuthKind(current.authKind), parsed.secret), tx);
      }
      const securityChanged = parsed.secret !== undefined
        || (parsed.username !== undefined && parsed.username !== current.username)
        || (parsed.allowPrivateNetwork !== undefined && parsed.allowPrivateNetwork !== current.allowPrivateNetwork)
        || (tlsCaCertificate !== undefined && tlsCaCertificate !== current.tlsCaCertificate)
        || (sshKnownHost !== undefined && sshKnownHost !== current.sshKnownHost);
      const statusData = parsed.enabled === false
        ? current.status === "disabled" && current.disabledAt !== null
          ? {}
          : { status: "disabled" as const, disabledAt: current.disabledAt ?? new Date() }
        : parsed.enabled === true
          ? current.status === "configured" && current.disabledAt === null
            ? {}
            : { status: "configured" as const, disabledAt: null }
          : securityChanged && current.status !== "disabled"
            ? { status: "configured" as const, disabledAt: null }
            : {};
      return tx.gitConnection.update({
        where: { id: connectionId },
        data: {
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
          ...(parsed.username === undefined ? {} : { username: parsed.username }),
          ...(parsed.allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork: parsed.allowPrivateNetwork }),
          ...(tlsCaCertificate === undefined ? {} : { tlsCaCertificate }),
          ...(sshKnownHost === undefined ? {} : { sshKnownHost }),
          ...statusData,
          ...(securityChanged && current.resolvedAddressFingerprint !== null
            ? { resolvedAddressFingerprint: null, lastTestedAt: null, lastErrorCode: null }
            : {}),
        },
        select: connectionSelect,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("GIT_CONNECTION_NAME_CONFLICT");
    throw error;
  }
}

export async function disableGitConnection(connectionIdInput: unknown, actor: Pick<AppUser, "id">, db: PrismaClient = getDb()) {
  const connectionId = uuid(connectionIdInput);
  const connection = await db.gitConnection.findFirst({
    where: { id: connectionId, ownerUserId: actor.id, ownershipState: "confirmed" },
    select: { id: true, repositories: { select: { projectLinks: { where: { status: "active" }, select: { id: true }, take: 1 } } } },
  });
  if (connection === null) return fail("GIT_CONNECTION_NOT_FOUND");
  if (connection.repositories.some((repository) => repository.projectLinks.length > 0)) return fail("GIT_CONNECTION_IN_USE");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "GitConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`;
    const current = await tx.gitConnection.findFirst({
      where: { id: connectionId, ownerUserId: actor.id, ownershipState: "confirmed" },
    });
    if (current === null) return fail("GIT_CONNECTION_NOT_FOUND");
    if (current.status === "disabled") return tx.gitConnection.findUniqueOrThrow({ where: { id: connectionId }, select: connectionSelect });
    return tx.gitConnection.update({
      where: { id: connectionId },
      data: { status: "disabled", disabledAt: new Date() },
      select: connectionSelect,
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function deleteGitConnection(
  connectionIdInput: unknown,
  input: unknown,
  actor: Pick<AppUser, "id">,
  db: PrismaClient = getDb(),
) {
  const connectionId = uuid(connectionIdInput);
  const parsed = deleteConnectionSchema.parse(input);
  const ownedConnection = await db.gitConnection.findFirst({
    where: { id: connectionId, ownerUserId: actor.id, ownershipState: "confirmed" },
    select: { id: true },
  });
  if (ownedConnection === null) return fail("GIT_CONNECTION_NOT_FOUND");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        // Match delegation writes: take the shared fence before the connection
        // row lock, then repeat the owner/state admission under both locks.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('ai-project-git-repository-delegation-global', 0))`;
        await tx.$queryRaw`SELECT "id" FROM "GitConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`;
        const connection = await tx.gitConnection.findFirst({
          where: { id: connectionId, ownerUserId: actor.id, ownershipState: "confirmed" },
          select: {
            id: true,
            name: true,
            status: true,
            credentialId: true,
            ownerUserId: true,
            ownershipState: true,
            updatedAt: true,
            repositories: {
              select: { projectLinks: { select: { id: true }, take: 1 } },
            },
          },
        });
        if (connection === null) {
          return fail("GIT_CONNECTION_NOT_FOUND");
        }
        if (connection.updatedAt.getTime() !== timestamp(parsed.expectedUpdatedAt).getTime()) return fail("GIT_CONNECTION_CONFLICT");
        if (connection.status !== "disabled") return fail("GIT_CONNECTION_DELETE_REQUIRES_DISABLED");
        if (connection.name !== parsed.confirmationName) return fail("GIT_CONNECTION_CONFIRMATION_MISMATCH");
        if (connection.repositories.some((repository) => repository.projectLinks.length > 0)) {
          return fail("GIT_CONNECTION_IN_USE");
        }
        const liveDelegation = await tx.projectGitRepositoryDelegation.findFirst({
          where: {
            gitConnectionId: connection.id,
            status: { in: ["draft", "ownerConfirmed", "active"] },
          },
          select: { id: true },
        });
        if (liveDelegation !== null) return fail("GIT_CONNECTION_IN_USE");
        await tx.gitRepository.deleteMany({ where: { gitConnectionId: connection.id } });
        await tx.gitConnection.delete({ where: { id: connection.id } });
        if (connection.credentialId !== null) {
          await tx.externalCredential.delete({ where: { id: connection.credentialId } });
        }
        return Object.freeze({ id: connection.id });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isSerializationConflict(error) && attempt < 3) continue;
      if (isSerializationConflict(error)) return fail("GIT_CONNECTION_CONFLICT");
      if (isPrismaCode(error, "P2003")) return fail("GIT_CONNECTION_IN_USE");
      throw error;
    }
  }
  return fail("GIT_CONNECTION_CONFLICT");
}

export async function testGitConnection(
  connectionIdInput: unknown,
  input: unknown,
  actor: Pick<AppUser, "id">,
  db: PrismaClient = getDb(),
) {
  const connectionId = uuid(connectionIdInput);
  const parsed = repositoryProbeSchema.parse(input);
  const repositoryPath = canonicalRepositoryPath(parsed.repositoryPath);
  const trackedRef = canonicalTrackedRef(parsed.trackedRef);
  const expectedUpdatedAt = timestamp(parsed.expectedUpdatedAt);
  const connection = await loadOwnedConnection(connectionId, actor, db);
  if (connection.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return fail("GIT_CONNECTION_CONFLICT");
  const expectedCredentialFingerprint = connection.credential?.secretFingerprint ?? null;
  try {
    const probe = await probeRepository(connection, repositoryPath, trackedRef, { pinExistingAddress: false, db });
    const updated = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "GitConnection" WHERE "id" = ${connection.id}::uuid FOR UPDATE`;
      const current = await tx.gitConnection.findFirst({
        where: { id: connection.id, ownerUserId: actor.id, ownershipState: "confirmed" },
        include: { credential: true },
      });
      if (current === null) return fail("GIT_CONNECTION_NOT_FOUND");
      if (current.status === "disabled") return fail("GIT_CONNECTION_DISABLED");
      if (current.updatedAt.getTime() !== connection.updatedAt.getTime() ||
        (current.credential?.secretFingerprint ?? null) !== expectedCredentialFingerprint) {
        return fail("GIT_CONNECTION_CONFLICT");
      }
      return tx.gitConnection.update({
        where: { id: connection.id },
        data: {
          status: "verified",
          resolvedAddressFingerprint: probe.addressFingerprint,
          lastTestedAt: new Date(),
          lastErrorCode: null,
          disabledAt: null,
        },
        select: connectionSelect,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return Object.freeze({ connection: updated, probe: { repositoryPath, trackedRef, commitSha: probe.commitSha } });
  } catch (error) {
    if (error instanceof GitServiceError && ["GIT_CONNECTION_CONFLICT", "GIT_CONNECTION_NOT_FOUND", "GIT_CONNECTION_DISABLED"].includes(error.code)) {
      throw error;
    }
    const code = error instanceof GitSafetyError || error instanceof GitRunnerError || error instanceof GitServiceError
      ? error.code
      : "GIT_OPERATION_FAILED";
    const marked = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "GitConnection" WHERE "id" = ${connection.id}::uuid FOR UPDATE`;
      const current = await tx.gitConnection.findFirst({
        where: { id: connection.id, ownerUserId: actor.id, ownershipState: "confirmed" },
        include: { credential: true },
      });
      if (current === null || current.status === "disabled") return false;
      if (current.updatedAt.getTime() !== connection.updatedAt.getTime() ||
        (current.credential?.secretFingerprint ?? null) !== expectedCredentialFingerprint) return false;
      await tx.gitConnection.update({
        where: { id: connection.id },
        data: { status: "error", lastTestedAt: new Date(), lastErrorCode: code },
      });
      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (!marked) return fail("GIT_CONNECTION_CONFLICT");
    throw error;
  }
}

export async function listProjectGitRepositories(projectIdInput: unknown, actor: WebAiActor, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  await assertWebAiProjectAccess(actor, projectId, "view", db);
  if (!projectPersonalDelegationEnabled()) return [];
  return db.projectGitRepositoryLink.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: projectRepositoryLinkSelect });
}

export async function connectProjectGitRepository(
  projectIdInput: unknown,
  input: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  // Project-level Git PAT creation is frozen while Git ownership is being
  // moved to user-private configuration. Keep this boundary deterministic and
  // side-effect free: no project or connection metadata, credentials, probe,
  // or write transaction may be opened for this legacy endpoint.
  void projectIdInput;
  void input;
  void actor;
  void db;
  return fail("GIT_LEGACY_PROJECT_CONNECT_FROZEN");
}

export async function disableProjectGitRepository(
  projectIdInput: unknown,
  linkIdInput: unknown,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const linkId = uuid(linkIdInput);
  await assertWebAiProjectAccess(actor, projectId, "edit", db);
  return db.$transaction(async (tx) => {
    await assertWebAiProjectAccess(actor, projectId, "edit", tx as PrismaClient);
    const updated = await tx.projectGitRepositoryLink.updateMany({
      where: { id: linkId, projectId, status: "active" },
      data: { status: "disabled", disabledAt: new Date() },
    });
    if (updated.count !== 1) return fail("GIT_REPOSITORY_LINK_NOT_FOUND");
    return tx.projectGitRepositoryLink.findUniqueOrThrow({ where: { id: linkId }, select: projectRepositoryLinkSelect });
  });
}

export async function publishGitRepositorySnapshot(input: Readonly<{
  projectId: string;
  linkId: string;
  snapshotId: string;
  commitSha: string;
  files: readonly GitScannedFile[];
}>, db: PrismaClient = getDb()) {
  const manifestFingerprint = createHash("sha256").update(JSON.stringify(input.files.map((file) => [file.path, file.blobOid, file.contentHash])), "utf8").digest("hex");
  const completedAt = new Date();
  return db.$transaction(async (tx) => {
    const current = await tx.gitRepositorySnapshotPointer.findUnique({
      where: { projectId_projectGitRepositoryLinkId: { projectId: input.projectId, projectGitRepositoryLinkId: input.linkId } },
      select: {
        gitRepositorySnapshotId: true,
        snapshot: { select: { entries: { select: { projectSourceId: true } } } },
      },
    });
    if (current !== null) {
      const oldSourceIds = current.snapshot.entries.map((entry) => entry.projectSourceId);
      if (oldSourceIds.length > 0) {
        await tx.projectSource.updateMany({ where: { projectId: input.projectId, id: { in: oldSourceIds }, retiredAt: null }, data: { retiredAt: completedAt } });
      }
    }
    for (let ordinal = 0; ordinal < input.files.length; ordinal += 1) {
      const file = input.files[ordinal]!;
      const sourceIdentity = deterministicUuid(`git-source:${input.linkId}:${file.path}`);
      const revisionKey = deterministicUuid(`git-revision:${input.linkId}:${input.commitSha}:${file.path}:${file.contentHash}`);
      const existing = await tx.projectSource.findUnique({
        where: { projectId_sourceIdentity_revisionKey: { projectId: input.projectId, sourceIdentity, revisionKey } },
        select: { id: true },
      });
      const source = existing === null
        ? await tx.projectSource.create({
            data: {
              projectId: input.projectId,
              kind: "git",
              originScope: "project",
              sourceIdentity,
              revisionKey,
              externalRef: file.externalRef,
              contentText: file.contentText,
              contentHash: file.contentHash,
              manualContentDedupeKey: null,
              capturedAt: completedAt,
            },
            select: { id: true },
          })
        : await tx.projectSource.update({
            where: { projectId_id: { projectId: input.projectId, id: existing.id } },
            // A frozen Git revision is immutable evidence.  Reusing it only
            // makes the lifecycle visible again; the later snapshot carries
            // the new synchronization time.
            data: { retiredAt: null },
            select: { id: true },
          });
      await tx.gitRepositorySnapshotEntry.create({
        data: {
          projectId: input.projectId,
          projectGitRepositoryLinkId: input.linkId,
          gitRepositorySnapshotId: input.snapshotId,
          projectSourceId: source.id,
          ordinal,
          normalizedPath: file.path,
          blobOid: file.blobOid,
          contentHash: file.contentHash,
          contentBytes: file.contentBytes,
          lineCount: file.lineCount,
        },
      });
    }
    await tx.gitRepositorySnapshot.update({
      where: { id: input.snapshotId },
      data: {
        status: "complete",
        frozenCommitSha: input.commitSha,
        manifestFingerprint,
        fileCount: input.files.length,
        decodedTextBytes: input.files.reduce((sum, file) => sum + file.contentBytes, 0),
        failureCode: null,
        completedAt,
      },
    });
    if (current !== null && current.gitRepositorySnapshotId !== input.snapshotId) {
      await tx.gitRepositorySnapshot.updateMany({
        where: { id: current.gitRepositorySnapshotId, projectId: input.projectId, status: "complete" },
        data: { status: "superseded", supersededAt: completedAt },
      });
    }
    await tx.gitRepositorySnapshotPointer.upsert({
      where: { projectId_projectGitRepositoryLinkId: { projectId: input.projectId, projectGitRepositoryLinkId: input.linkId } },
      create: { projectId: input.projectId, projectGitRepositoryLinkId: input.linkId, gitRepositorySnapshotId: input.snapshotId, publishedAt: completedAt },
      update: { gitRepositorySnapshotId: input.snapshotId, publishedAt: completedAt },
    });
    return tx.projectGitRepositoryLink.findUniqueOrThrow({ where: { id: input.linkId }, select: linkSelect });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function syncRepository(projectId: string, linkId: string, jobId: string, db: PrismaClient) {
  // Project-to-personal-connection delegation is not implemented yet. Keep
  // this lower-level worker boundary fail-closed as well as the admission
  // boundary so a direct/internal caller cannot reach credential loading.
  if (!projectPersonalDelegationEnabled()) return fail("GIT_LEGACY_PROJECT_CONNECT_FROZEN");
  const link = await db.projectGitRepositoryLink.findFirst({
    where: { id: linkId, projectId },
    include: { repository: { include: { connection: { include: { credential: true } } } } },
  });
  if (link === null) return fail("GIT_REPOSITORY_LINK_NOT_FOUND");
  if (link.status !== "active") return fail("GIT_REPOSITORY_LINK_DISABLED");
  if (!link.codeEnabled) return fail("GIT_REPOSITORY_LINK_DISABLED");
  const connection = link.repository.connection;
  if (connection.status !== "verified" || connection.resolvedAddressFingerprint === null) return fail("GIT_CONNECTION_INVALID_INPUT");
  const snapshot = await db.gitRepositorySnapshot.create({
    data: { projectId, projectGitRepositoryLinkId: link.id, jobId },
    select: { id: true },
  });
  try {
    const result = await readRepositoryFiles({
      connection,
      repositoryPath: link.repository.repositoryPath,
      trackedRef: link.trackedRef,
      webUrl: link.repository.webUrl ?? canonicalWebUrl(null, connection, link.repository.repositoryPath),
      includeRoots: canonicalIncludeRoots(link.includeRoots),
      softExcludePatterns: canonicalExcludePatterns(link.softExcludePatterns),
      db,
    });
    if (result.addressFingerprint !== connection.resolvedAddressFingerprint) throw new GitSafetyError("GIT_NETWORK_CHANGED");
    return publishGitRepositorySnapshot({ projectId, linkId, snapshotId: snapshot.id, commitSha: result.commitSha, files: result.files }, db);
  } catch (error) {
    const failureCode = error instanceof GitSafetyError || error instanceof GitRunnerError || error instanceof GitServiceError
      ? error.code
      : "GIT_REPOSITORY_SYNC_FAILED";
    await db.gitRepositorySnapshot.updateMany({
      where: { id: snapshot.id, status: "staging" },
      data: { status: "failed", failureCode, completedAt: new Date() },
    });
    throw error;
  }
}

export async function runGitRepositorySyncJob(input: Readonly<{
  projectId: unknown;
  linkId: unknown;
  requestedBy: WebAiActor;
  clientKey: unknown;
}>, db: PrismaClient = getDb()) {
  const projectId = uuid(input.projectId);
  const linkId = uuid(input.linkId);
  const parsed = syncSchema.parse({ clientKey: input.clientKey });
  const currentActor = await assertWebAiProjectAccess(input.requestedBy, projectId, "edit", db);
  // Until a project Owner and connection Owner delegation record exists, no
  // project runtime is allowed to load or send a personal/legacy credential.
  if (!projectPersonalDelegationEnabled()) return fail("GIT_LEGACY_PROJECT_CONNECT_FROZEN");
  const idempotencyKey = createHash("sha256").update(`gitRepositorySync:${projectId}:${linkId}:${parsed.clientKey}`, "utf8").digest("hex");
  const existing = await db.backgroundJob.findUnique({
    where: { requestedById_idempotencyKey: { requestedById: currentActor.id, idempotencyKey } },
  });
  const job = existing ?? await db.backgroundJob.create({
    data: {
      id: randomUUID(),
      projectId,
      kind: "gitRepositorySync",
      requestedById: currentActor.id,
      idempotencyKey,
      payload: { linkId },
    },
  });
  if (job.status !== "queued") return toPublicProjectJob(job);
  const claim = await claimProjectJob(job.id, db, "gitRepositorySync");
  if (!claim) return toPublicProjectJob(await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } }));
  let heartbeat: ReturnType<typeof startProjectJobHeartbeat> | null = null;
  try {
    // The access admission and dispatch marker commit together.  The callback
    // only validates the job/link routing tuple; credential loading and the
    // first Git transport happen after this transaction resolves.
    await withProjectJobAccessTransaction(db, {
      actor: input.requestedBy,
      projectId,
      jobId: job.id,
      expectedRequestedById: currentActor.id,
      attempt: { jobId: job.id, ...claim },
      markDispatched: true,
    }, async (tx, admission) => {
      if (admission.job.kind !== "gitRepositorySync" || admission.job.requestedById !== currentActor.id) {
        return fail("GIT_CONNECTION_INVALID_INPUT");
      }
      const route = await tx.projectGitRepositoryLink.findFirst({
        where: { id: linkId, projectId },
        select: {
          id: true,
          projectId: true,
          status: true,
          codeEnabled: true,
          repository: { select: { connection: { select: { status: true, resolvedAddressFingerprint: true } } } },
        },
      });
      if (route === null) return fail("GIT_REPOSITORY_LINK_NOT_FOUND");
      if (route.status !== "active" || !route.codeEnabled) return fail("GIT_REPOSITORY_LINK_DISABLED");
      if (route.repository.connection.status !== "verified" || route.repository.connection.resolvedAddressFingerprint === null) {
        return fail("GIT_CONNECTION_INVALID_INPUT");
      }
      return route;
    });
    heartbeat = startProjectJobHeartbeat({ jobId: job.id, ...claim }, db);
    const link = await syncRepository(projectId, linkId, job.id, db);
    await heartbeat.stop();
    if (heartbeat.failure !== null) throw heartbeat.failure;
    // A completed Git transport is a known provider response. Close the
    // dispatch marker before publishing the terminal job state so a finished
    // attempt never remains indistinguishable from an in-flight request.
    await markProviderAcknowledged({ jobId: job.id, ...claim }, db);
    return toPublicProjectJob(await finishProjectJob({
      jobId: job.id,
      ...claim,
      result: {
        linkId,
        snapshotId: link.snapshotPointer?.snapshot.id ?? null,
        commitSha: link.snapshotPointer?.snapshot.frozenCommitSha ?? null,
        fileCount: link.snapshotPointer?.snapshot.fileCount ?? 0,
      },
    }, db));
  } catch (error) {
    if (heartbeat !== null) await heartbeat.stop();
    // Link/configuration, endpoint-safety, and credential-vault failures are
    // known to occur before the Git transport starts. Roll back the optimistic
    // admission marker so reconciliation is not required for a request that
    // never reached the remote.
    if (isDefinitelyPreDispatchGitSyncFailure(error)) {
      await markProviderNotDispatched({ jobId: job.id, ...claim }, db).catch(() => undefined);
    }
    await failProjectJob({ jobId: job.id, ...claim, error }, db).catch(() => undefined);
    throw error;
  }
}
