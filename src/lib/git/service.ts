import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Prisma, type AppUser, type GitAuthKind, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createCredential, readCredentialSecret, rotateCredential } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { hashSourceContent, MAX_SOURCE_CONTENT_LENGTH } from "@/lib/source";
import {
  claimProjectJob,
  failProjectJob,
  finishProjectJob,
  startProjectJobHeartbeat,
  toPublicProjectJob,
} from "@/lib/project-workflow";
import { decodeGitCredential, encodeGitCredential, type GitCredentialPayload } from "./credentials";
import { gitRemoteUrl, GitRunnerError, withGitRunner } from "./runner";
import {
  assertPinnedGitEndpoint,
  canonicalExcludePatterns,
  canonicalGitBaseUrl,
  canonicalIncludeRoots,
  canonicalRepositoryPath,
  canonicalSshKnownHost,
  canonicalTlsCaCertificate,
  canonicalTrackedRef,
  GitSafetyError,
  resolveGitEndpoint,
} from "./safety";

const MAX_SCANNED_FILES = 600;
const MAX_FILE_BYTES = 96 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?\/?$)(?!.*[\u0000-\u001f\u007f-\u009f\\])[^\u0000]{1,1024}$/u;
const TEXT_EXTENSIONS = new Set([
  "", ".c", ".cc", ".conf", ".cpp", ".cs", ".css", ".csv", ".env.example", ".go", ".graphql", ".h", ".hpp",
  ".html", ".ini", ".java", ".js", ".json", ".jsx", ".kt", ".kts", ".md", ".mdx", ".mjs", ".php", ".properties",
  ".proto", ".py", ".rb", ".rs", ".scala", ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".txt",
  ".vue", ".xml", ".yaml", ".yml", ".zsh",
]);
const ALWAYS_EXCLUDED_SEGMENTS = new Set([".git", ".next", ".nuxt", "coverage", "dist", "node_modules", "target", "vendor"]);

export type GitServiceErrorCode =
  | "GIT_CONNECTION_INVALID_INPUT"
  | "GIT_CONNECTION_NOT_FOUND"
  | "GIT_CONNECTION_NAME_CONFLICT"
  | "GIT_CONNECTION_IN_USE"
  | "GIT_CONNECTION_DISABLED"
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
}).strict();

const repositoryProbeSchema = z.object({
  repositoryPath: z.string().min(1).max(768),
  trackedRef: z.string().min(1).max(255),
}).strict();

const linkSchema = repositoryProbeSchema.extend({
  gitConnectionId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(256).optional(),
  webUrl: z.string().url().max(1024).nullable().optional(),
  role: z.enum(["primary", "application", "infrastructure", "library", "documentation", "other"]),
  requiredForProjectSnapshot: z.boolean().default(true),
  codeEnabled: z.boolean().default(true),
  metadataEnabled: z.boolean().default(true),
  includeRoots: z.array(z.string()).min(1).max(32).default(["."]),
  softExcludePatterns: z.array(z.string()).max(64).default([]),
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

type ConnectionWithSecret = Prisma.GitConnectionGetPayload<{
  include: { credential: true };
}>;

type ScannedFile = Readonly<{
  path: string;
  blobOid: string;
  contentText: string;
  contentHash: string;
  contentBytes: number;
  lineCount: number;
  externalRef: string;
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

async function loadCredential(connection: ConnectionWithSecret): Promise<GitCredentialPayload | null> {
  if (connection.authKind === "none") return null;
  if (connection.credentialId === null) return fail("GIT_CONNECTION_INVALID_INPUT");
  return decodeGitCredential(
    await readCredentialSecret(connection.credentialId, "git"),
    credentialAuthKind(connection.authKind),
  );
}

function defaultUsername(connection: Pick<ConnectionWithSecret, "providerKind" | "authKind" | "username">): string | null {
  if (connection.username !== null) return connection.username;
  if (connection.authKind === "token") {
    if (connection.providerKind === "github") return "x-access-token";
    if (connection.providerKind === "gitlab" || connection.providerKind === "gitee") return "oauth2";
  }
  return connection.authKind === "none" ? null : "git";
}

async function loadConnection(connectionId: string, db: PrismaClient): Promise<ConnectionWithSecret> {
  const connection = await db.gitConnection.findUnique({ where: { id: connectionId }, include: { credential: true } });
  if (connection === null) return fail("GIT_CONNECTION_NOT_FOUND");
  if (connection.status === "disabled") return fail("GIT_CONNECTION_DISABLED");
  return connection;
}

async function probeRepository(
  connection: ConnectionWithSecret,
  repositoryPath: string,
  trackedRef: string,
  options: Readonly<{ pinExistingAddress: boolean }>,
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
  const credential = await loadCredential(connection);
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

function canonicalWebUrl(value: string | null | undefined, connection: ConnectionWithSecret, repositoryPath: string): string {
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

function sourceReference(webUrl: string, providerKind: ConnectionWithSecret["providerKind"], commitSha: string, path: string): string {
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
  connection: ConnectionWithSecret;
  repositoryPath: string;
  trackedRef: string;
  webUrl: string;
  includeRoots: readonly string[];
  softExcludePatterns: readonly string[];
}>): Promise<Readonly<{ commitSha: string; addressFingerprint: string; files: readonly ScannedFile[] }>> {
  const resolution = await assertPinnedGitEndpoint({
    baseUrl: input.connection.baseUrl,
    allowPrivateNetwork: input.connection.allowPrivateNetwork,
    expectedFingerprint: input.connection.resolvedAddressFingerprint,
  });
  const credential = await loadCredential(input.connection);
  const remote = gitRemoteUrl(input.connection.baseUrl, input.repositoryPath);
  const endpointUrl = new URL(input.connection.baseUrl);
  return withGitRunner({
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

    const files: ScannedFile[] = [];
    for (const entry of candidates) {
      const body = normalizeText(await runner.runBytes(["-C", repositoryDir, "cat-file", "blob", entry.blobOid], { maxOutputBytes: MAX_FILE_BYTES + 1024 }));
      if (body === null) continue;
      const externalRef = sourceReference(input.webUrl, input.connection.providerKind, commitSha, entry.path);
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

export async function listGitConnections(db: PrismaClient = getDb()) {
  return db.gitConnection.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: connectionSelect });
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
        },
        select: connectionSelect,
      });
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("GIT_CONNECTION_NAME_CONFLICT");
    throw error;
  }
}

export async function updateGitConnection(connectionIdInput: unknown, input: unknown, db: PrismaClient = getDb()) {
  const connectionId = uuid(connectionIdInput);
  const parsed = updateConnectionSchema.parse(input);
  const existing = await db.gitConnection.findUnique({ where: { id: connectionId } });
  if (existing === null) return fail("GIT_CONNECTION_NOT_FOUND");
  const tlsCaCertificate = parsed.tlsCaCertificate === undefined
    ? undefined
    : existing.transport === "https" ? canonicalTlsCaCertificate(parsed.tlsCaCertificate) : null;
  const sshKnownHost = parsed.sshKnownHost === undefined
    ? undefined
    : existing.transport === "ssh" ? canonicalSshKnownHost(parsed.sshKnownHost) : null;
  try {
    return await db.$transaction(async (tx) => {
      if (parsed.secret !== undefined) {
        if (existing.credentialId === null || existing.authKind === "none") return fail("GIT_CONNECTION_INVALID_INPUT");
        await rotateCredential(existing.credentialId, "git", encodeGitCredential(credentialAuthKind(existing.authKind), parsed.secret), tx);
      }
      return tx.gitConnection.update({
        where: { id: connectionId },
        data: {
          ...(parsed.name === undefined ? {} : { name: parsed.name }),
          ...(parsed.username === undefined ? {} : { username: parsed.username }),
          ...(parsed.allowPrivateNetwork === undefined ? {} : { allowPrivateNetwork: parsed.allowPrivateNetwork }),
          ...(tlsCaCertificate === undefined ? {} : { tlsCaCertificate }),
          ...(sshKnownHost === undefined ? {} : { sshKnownHost }),
          ...(parsed.enabled === undefined ? {} : parsed.enabled
            ? { status: "configured", disabledAt: null }
            : { status: "disabled", disabledAt: new Date() }),
          ...((parsed.secret !== undefined || parsed.allowPrivateNetwork !== undefined || tlsCaCertificate !== undefined || sshKnownHost !== undefined)
            ? { status: "configured", resolvedAddressFingerprint: null, lastTestedAt: null, lastErrorCode: null }
            : {}),
        },
        select: connectionSelect,
      });
    });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("GIT_CONNECTION_NAME_CONFLICT");
    throw error;
  }
}

export async function disableGitConnection(connectionIdInput: unknown, db: PrismaClient = getDb()) {
  const connectionId = uuid(connectionIdInput);
  const connection = await db.gitConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, repositories: { select: { projectLinks: { where: { status: "active" }, select: { id: true }, take: 1 } } } },
  });
  if (connection === null) return fail("GIT_CONNECTION_NOT_FOUND");
  if (connection.repositories.some((repository) => repository.projectLinks.length > 0)) return fail("GIT_CONNECTION_IN_USE");
  return db.gitConnection.update({
    where: { id: connectionId },
    data: { status: "disabled", disabledAt: new Date() },
    select: connectionSelect,
  });
}

export async function testGitConnection(connectionIdInput: unknown, input: unknown, db: PrismaClient = getDb()) {
  const connectionId = uuid(connectionIdInput);
  const parsed = repositoryProbeSchema.parse(input);
  const repositoryPath = canonicalRepositoryPath(parsed.repositoryPath);
  const trackedRef = canonicalTrackedRef(parsed.trackedRef);
  const connection = await loadConnection(connectionId, db);
  try {
    const probe = await probeRepository(connection, repositoryPath, trackedRef, { pinExistingAddress: false });
    const updated = await db.gitConnection.update({
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
    return Object.freeze({ connection: updated, probe: { repositoryPath, trackedRef, commitSha: probe.commitSha } });
  } catch (error) {
    const code = error instanceof GitSafetyError || error instanceof GitRunnerError || error instanceof GitServiceError
      ? error.code
      : "GIT_OPERATION_FAILED";
    await db.gitConnection.updateMany({
      where: { id: connection.id, status: { not: "disabled" } },
      data: { status: "error", lastTestedAt: new Date(), lastErrorCode: code },
    });
    throw error;
  }
}

export async function listProjectGitRepositories(projectIdInput: unknown, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (project === null) return fail("GIT_REPOSITORY_NOT_FOUND");
  return db.projectGitRepositoryLink.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: linkSelect });
}

export async function connectProjectGitRepository(
  projectIdInput: unknown,
  input: unknown,
  actor: Pick<AppUser, "id">,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const parsed = linkSchema.parse(input);
  const repositoryPath = canonicalRepositoryPath(parsed.repositoryPath);
  const trackedRef = canonicalTrackedRef(parsed.trackedRef);
  const includeRoots = canonicalIncludeRoots(parsed.includeRoots);
  const softExcludePatterns = canonicalExcludePatterns(parsed.softExcludePatterns);
  const connection = await loadConnection(parsed.gitConnectionId, db);
  const probe = await probeRepository(connection, repositoryPath, trackedRef, { pinExistingAddress: connection.resolvedAddressFingerprint !== null });
  const webUrl = canonicalWebUrl(parsed.webUrl, connection, repositoryPath);
  try {
    return await db.$transaction(async (tx) => {
      await tx.gitConnection.update({
        where: { id: connection.id },
        data: { status: "verified", resolvedAddressFingerprint: probe.addressFingerprint, lastTestedAt: new Date(), lastErrorCode: null },
      });
      const repository = await tx.gitRepository.upsert({
        where: { gitConnectionId_repositoryPath: { gitConnectionId: connection.id, repositoryPath } },
        create: {
          gitConnectionId: connection.id,
          repositoryPath,
          displayName: parsed.displayName ?? repositoryPath.split("/").at(-1)!,
          webUrl,
          defaultBranch: trackedRef,
          remoteIdentifier: probe.commitSha,
          lastVerifiedAt: new Date(),
        },
        update: {
          displayName: parsed.displayName ?? repositoryPath.split("/").at(-1)!,
          webUrl,
          defaultBranch: trackedRef,
          remoteIdentifier: probe.commitSha,
          lastVerifiedAt: new Date(),
        },
      });
      const existing = await tx.projectGitRepositoryLink.findUnique({
        where: { projectId_gitRepositoryId: { projectId, gitRepositoryId: repository.id } },
        select: { id: true },
      });
      const data = {
        role: parsed.role,
        trackedRef,
        requiredForProjectSnapshot: parsed.requiredForProjectSnapshot,
        codeEnabled: parsed.codeEnabled,
        metadataEnabled: parsed.metadataEnabled,
        includeRoots: [...includeRoots],
        softExcludePatterns: [...softExcludePatterns],
        status: "active" as const,
        disabledAt: null,
      };
      if (existing === null) {
        return tx.projectGitRepositoryLink.create({
          data: { projectId, gitRepositoryId: repository.id, createdById: actor.id, ...data },
          select: linkSelect,
        });
      }
      return tx.projectGitRepositoryLink.update({ where: { id: existing.id }, data, select: linkSelect });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isPrismaCode(error, "P2002")) return fail("GIT_REPOSITORY_CONFLICT");
    throw error;
  }
}

export async function disableProjectGitRepository(projectIdInput: unknown, linkIdInput: unknown, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const linkId = uuid(linkIdInput);
  const updated = await db.projectGitRepositoryLink.updateMany({
    where: { id: linkId, projectId, status: "active" },
    data: { status: "disabled", disabledAt: new Date() },
  });
  if (updated.count !== 1) return fail("GIT_REPOSITORY_LINK_NOT_FOUND");
  return db.projectGitRepositoryLink.findUniqueOrThrow({ where: { id: linkId }, select: linkSelect });
}

export async function publishGitRepositorySnapshot(input: Readonly<{
  projectId: string;
  linkId: string;
  snapshotId: string;
  commitSha: string;
  files: readonly ScannedFile[];
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
            data: { retiredAt: null, capturedAt: completedAt, externalRef: file.externalRef },
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
  requestedBy: Pick<AppUser, "id">;
  clientKey: unknown;
}>, db: PrismaClient = getDb()) {
  const projectId = uuid(input.projectId);
  const linkId = uuid(input.linkId);
  const parsed = syncSchema.parse({ clientKey: input.clientKey });
  const idempotencyKey = createHash("sha256").update(`gitRepositorySync:${projectId}:${linkId}:${parsed.clientKey}`, "utf8").digest("hex");
  const existing = await db.backgroundJob.findUnique({
    where: { requestedById_idempotencyKey: { requestedById: input.requestedBy.id, idempotencyKey } },
  });
  const job = existing ?? await db.backgroundJob.create({
    data: {
      id: randomUUID(),
      projectId,
      kind: "gitRepositorySync",
      requestedById: input.requestedBy.id,
      idempotencyKey,
      payload: { linkId },
    },
  });
  if (job.status !== "queued") return toPublicProjectJob(job);
  const claim = await claimProjectJob(job.id, db, "gitRepositorySync");
  if (!claim) return toPublicProjectJob(await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } }));
  const heartbeat = startProjectJobHeartbeat({ jobId: job.id, ...claim }, db);
  try {
    const link = await syncRepository(projectId, linkId, job.id, db);
    await heartbeat.stop();
    if (heartbeat.failure !== null) throw heartbeat.failure;
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
    await heartbeat.stop();
    await failProjectJob({ jobId: job.id, ...claim, error }, db).catch(() => undefined);
    throw error;
  }
}
