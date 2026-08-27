import { readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

export const GITHUB_API_ORIGIN = "https://api.github.com" as const;
export const GITHUB_API_VERSION = "2026-03-10" as const;
export const GITHUB_ACCEPT = "application/vnd.github+json" as const;
export const GITHUB_USER_AGENT = "AI-Project-OS-GitHub-Connector/1.0" as const;
export const GITHUB_CREDENTIAL_CONTRACT_VERSION =
  "github-fine-grained-pat-file:v1" as const;
export const GITHUB_READ_ONLY_CLIENT_VERSION =
  "github-read-only-client:v1" as const;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TOKEN_FILE_BYTES = 512;
const MAX_STANDARD_RESPONSE_BYTES = 1_048_576;
const MAX_TREE_RESPONSE_BYTES = 8_388_608;
const MAX_BLOB_RESPONSE_BYTES = 393_216;
const MAX_MATERIAL_PAGE_RESPONSE_BYTES = 8_388_608;
const MATERIAL_PAGE_SIZE = 100;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TOKEN_PATTERN = /^github_pat_[A-Za-z0-9_]{32,240}$/;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;|$)/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;
type ReadFileImplementation = (path: string, encoding: "utf8") => Promise<string>;
type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type GitHubReadResponse = Readonly<{
  body: unknown;
  nextPage: number | null;
}>;

export type GitHubReadErrorCode =
  | "GITHUB_DISABLED"
  | "GITHUB_CREDENTIAL_UNAVAILABLE"
  | "GITHUB_INVALID_REQUEST"
  | "GITHUB_ACCESS_UNKNOWN"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_REDIRECT_REJECTED"
  | "GITHUB_RESPONSE_TOO_LARGE"
  | "GITHUB_INVALID_RESPONSE"
  | "GITHUB_REQUEST_TIMEOUT"
  | "GITHUB_REQUEST_FAILED";

export class GitHubReadError extends Error {
  constructor(
    readonly code: GitHubReadErrorCode,
    readonly retryAtEpochSeconds: number | null = null,
    readonly requestId: string | null = null,
  ) {
    super(code);
    this.name = "GitHubReadError";
  }
}

export interface GitHubCredentialHandle {
  readonly contractVersion: typeof GITHUB_CREDENTIAL_CONTRACT_VERSION;
  readonly provider: "github";
  readonly authRef: "github-token-file:v1";
}

export type GitHubReadEndpoint =
  | Readonly<{ kind: "repository"; owner: string; repository: string }>
  | Readonly<{ kind: "reference"; owner: string; repository: string; trackedRef: string }>
  | Readonly<{ kind: "commit"; owner: string; repository: string; commitSha: string }>
  | Readonly<{ kind: "tree"; owner: string; repository: string; treeSha: string }>
  | Readonly<{ kind: "blob"; owner: string; repository: string; blobSha: string }>
  | Readonly<{ kind: "issues"; owner: string; repository: string; page: number }>
  | Readonly<{ kind: "pulls"; owner: string; repository: string; page: number }>
  | Readonly<{ kind: "pull"; owner: string; repository: string; pullNumber: number }>
  | Readonly<{ kind: "pullFiles"; owner: string; repository: string; pullNumber: number; page: number }>
  | Readonly<{ kind: "releases"; owner: string; repository: string; page: number }>;

export type GitHubReadPlan = Readonly<{
  clientVersion: typeof GITHUB_READ_ONLY_CLIENT_VERSION;
  apiVersion: typeof GITHUB_API_VERSION;
  endpointKind: GitHubReadEndpoint["kind"];
  method: "GET";
  url: string;
  redirect: "error";
  timeoutMs: typeof DEFAULT_TIMEOUT_MS;
  maximumResponseBytes: number;
}>;

export type VerifiedGitHubRepository = Readonly<{
  repositoryId: number;
  nodeId: string;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  archived: boolean;
  disabled: boolean;
  defaultBranch: string;
}>;

export type VerifiedGitHubReference = Readonly<{
  ref: string;
  commitSha: string;
}>;

export type VerifiedGitHubCommit = Readonly<{
  commitSha: string;
  treeSha: string;
}>;

export type VerifiedGitHubTreeEntry = Readonly<{
  path: string;
  mode: "040000" | "100644" | "100755" | "120000" | "160000";
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number | null;
}>;

export type VerifiedGitHubTree = Readonly<{
  treeSha: string;
  truncated: boolean;
  entries: readonly VerifiedGitHubTreeEntry[];
}>;

export type VerifiedGitHubBlob = Readonly<{
  blobSha: string;
  size: number;
  encoding: "base64";
  content: string;
}>;

export type VerifiedGitHubPage<T> = Readonly<{
  items: readonly Readonly<T>[];
  nextPage: number | null;
}>;

export type VerifiedGitHubIssue = Readonly<{
  nodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: readonly string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  htmlUrl: string;
}>;

export type VerifiedGitHubPullRequestSummary = Readonly<{
  nodeId: string;
  number: number;
  updatedAt: string;
}>;

export type VerifiedGitHubPullRequest = Readonly<{
  nodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  htmlUrl: string;
}>;

export type VerifiedGitHubPullRequestFile = Readonly<{
  blobSha: string;
  filename: string;
  previousFilename: string | null;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
}>;

export type VerifiedGitHubRelease = Readonly<{
  releaseId: number;
  nodeId: string;
  tagName: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  createdAt: string;
  publishedAt: string | null;
  htmlUrl: string;
}>;

export interface GitHubReadOnlyClient {
  readonly version: typeof GITHUB_READ_ONLY_CLIENT_VERSION;
  getRepository(input: Readonly<{ owner: string; repository: string }>): Promise<VerifiedGitHubRepository>;
  getReference(input: Readonly<{ owner: string; repository: string; trackedRef: string }>): Promise<VerifiedGitHubReference>;
  getCommit(input: Readonly<{ owner: string; repository: string; commitSha: string }>): Promise<VerifiedGitHubCommit>;
  getTree(input: Readonly<{ owner: string; repository: string; treeSha: string }>): Promise<VerifiedGitHubTree>;
  getBlob(input: Readonly<{ owner: string; repository: string; blobSha: string }>): Promise<VerifiedGitHubBlob>;
}

export interface GitHubMaterialReadOnlyClient extends GitHubReadOnlyClient {
  getIssuesPage(input: Readonly<{ owner: string; repository: string; page: number }>): Promise<VerifiedGitHubPage<VerifiedGitHubIssue>>;
  getPullRequestsPage(input: Readonly<{ owner: string; repository: string; page: number }>): Promise<VerifiedGitHubPage<VerifiedGitHubPullRequestSummary>>;
  getPullRequest(input: Readonly<{ owner: string; repository: string; pullNumber: number }>): Promise<VerifiedGitHubPullRequest>;
  getPullRequestFilesPage(input: Readonly<{ owner: string; repository: string; pullNumber: number; page: number }>): Promise<VerifiedGitHubPage<VerifiedGitHubPullRequestFile>>;
  getReleasesPage(input: Readonly<{ owner: string; repository: string; page: number }>): Promise<VerifiedGitHubPage<VerifiedGitHubRelease>>;
}

const credentialValues = new WeakMap<object, string>();

function fail(
  code: GitHubReadErrorCode,
  retryAtEpochSeconds: number | null = null,
  requestId: string | null = null,
): never {
  throw new GitHubReadError(code, retryAtEpochSeconds, requestId);
}

function enabled(environment: RuntimeEnvironment): boolean {
  return environment.GITHUB_ENABLED?.trim().toLowerCase() === "true";
}

function canonicalTokenFilePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !isAbsolute(value) ||
    normalize(value) !== value
  ) {
    return fail("GITHUB_CREDENTIAL_UNAVAILABLE");
  }
  return value;
}

function tokenFromFileContent(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_TOKEN_FILE_BYTES) {
    return fail("GITHUB_CREDENTIAL_UNAVAILABLE");
  }
  const token = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  if (!TOKEN_PATTERN.test(token)) {
    return fail("GITHUB_CREDENTIAL_UNAVAILABLE");
  }
  return token;
}

export async function loadGitHubCredential(options: Readonly<{
  environment?: RuntimeEnvironment;
  readFileImplementation?: ReadFileImplementation;
}> = {}): Promise<GitHubCredentialHandle | null> {
  const environment = options.environment ?? process.env;
  if (!enabled(environment)) return null;
  const path = canonicalTokenFilePath(environment.GITHUB_TOKEN_FILE);
  let fileContent: string;
  try {
    fileContent = await (options.readFileImplementation ?? readFile)(path, "utf8");
  } catch {
    return fail("GITHUB_CREDENTIAL_UNAVAILABLE");
  }
  const token = tokenFromFileContent(fileContent);
  const handle = Object.freeze({
    contractVersion: GITHUB_CREDENTIAL_CONTRACT_VERSION,
    provider: "github" as const,
    authRef: "github-token-file:v1" as const,
  });
  credentialValues.set(handle, token);
  return handle;
}

function resolveCredential(handle: unknown): string {
  if (typeof handle !== "object" || handle === null) {
    return fail("GITHUB_CREDENTIAL_UNAVAILABLE");
  }
  const token = credentialValues.get(handle);
  return token ?? fail("GITHUB_CREDENTIAL_UNAVAILABLE");
}

function canonicalOwner(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)
  ) {
    return fail("GITHUB_INVALID_REQUEST");
  }
  return value;
}

function canonicalRepository(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^[A-Za-z0-9_.-]+$/.test(value) ||
    value === "." ||
    value === ".." ||
    value.toLowerCase().endsWith(".git")
  ) {
    return fail("GITHUB_INVALID_REQUEST");
  }
  return value;
}

function canonicalSha(value: unknown): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    return fail("GITHUB_INVALID_REQUEST");
  }
  return value;
}

function canonicalPage(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    return fail("GITHUB_INVALID_REQUEST");
  }
  return value as number;
}

function canonicalRemoteNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) {
    return fail("GITHUB_INVALID_REQUEST");
  }
  return value as number;
}

function canonicalTrackedRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("refs/heads/") ||
    Buffer.byteLength(value, "utf8") > 255 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    ["\\", "~", "^", ":", "?", "*", "["].some((character) => value.includes(character)) ||
    value.includes("@{") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  ) {
    return fail("GITHUB_INVALID_REQUEST");
  }
  const segments = value.slice("refs/heads/".length).split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return fail("GITHUB_INVALID_REQUEST");
  }
  return value;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function createGitHubReadPlan(endpoint: GitHubReadEndpoint): GitHubReadPlan {
  if (typeof endpoint !== "object" || endpoint === null) {
    return fail("GITHUB_INVALID_REQUEST");
  }
  const owner = canonicalOwner(endpoint.owner);
  const repository = canonicalRepository(endpoint.repository);
  const repositoryPath = `/repos/${encodeSegment(owner)}/${encodeSegment(repository)}`;
  let path: string;
  let maximumResponseBytes = MAX_STANDARD_RESPONSE_BYTES;
  if (endpoint.kind === "repository") {
    path = repositoryPath;
  } else if (endpoint.kind === "reference") {
    const trackedRef = canonicalTrackedRef(endpoint.trackedRef);
    path = `${repositoryPath}/git/ref/${trackedRef.slice("refs/".length).split("/").map(encodeSegment).join("/")}`;
  } else if (endpoint.kind === "commit") {
    path = `${repositoryPath}/git/commits/${canonicalSha(endpoint.commitSha)}`;
  } else if (endpoint.kind === "tree") {
    path = `${repositoryPath}/git/trees/${canonicalSha(endpoint.treeSha)}`;
    maximumResponseBytes = MAX_TREE_RESPONSE_BYTES;
  } else if (endpoint.kind === "blob") {
    path = `${repositoryPath}/git/blobs/${canonicalSha(endpoint.blobSha)}`;
    maximumResponseBytes = MAX_BLOB_RESPONSE_BYTES;
  } else if (endpoint.kind === "issues") {
    const page = canonicalPage(endpoint.page);
    path = `${repositoryPath}/issues?state=all&sort=updated&direction=asc&per_page=${MATERIAL_PAGE_SIZE}&page=${page}`;
    maximumResponseBytes = MAX_MATERIAL_PAGE_RESPONSE_BYTES;
  } else if (endpoint.kind === "pulls") {
    const page = canonicalPage(endpoint.page);
    path = `${repositoryPath}/pulls?state=all&sort=updated&direction=asc&per_page=${MATERIAL_PAGE_SIZE}&page=${page}`;
    maximumResponseBytes = MAX_MATERIAL_PAGE_RESPONSE_BYTES;
  } else if (endpoint.kind === "pull") {
    path = `${repositoryPath}/pulls/${canonicalRemoteNumber(endpoint.pullNumber)}`;
  } else if (endpoint.kind === "pullFiles") {
    const pullNumber = canonicalRemoteNumber(endpoint.pullNumber);
    const page = canonicalPage(endpoint.page);
    path = `${repositoryPath}/pulls/${pullNumber}/files?per_page=${MATERIAL_PAGE_SIZE}&page=${page}`;
    maximumResponseBytes = MAX_MATERIAL_PAGE_RESPONSE_BYTES;
  } else if (endpoint.kind === "releases") {
    const page = canonicalPage(endpoint.page);
    path = `${repositoryPath}/releases?per_page=${MATERIAL_PAGE_SIZE}&page=${page}`;
    maximumResponseBytes = MAX_MATERIAL_PAGE_RESPONSE_BYTES;
  } else {
    return fail("GITHUB_INVALID_REQUEST");
  }
  return Object.freeze({
    clientVersion: GITHUB_READ_ONLY_CLIENT_VERSION,
    apiVersion: GITHUB_API_VERSION,
    endpointKind: endpoint.kind,
    method: "GET" as const,
    url: `${GITHUB_API_ORIGIN}${path}`,
    redirect: "error" as const,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maximumResponseBytes,
  });
}

function safeRequestId(response: Response): string | null {
  const value = response.headers.get("x-github-request-id");
  return value !== null && SAFE_REQUEST_ID_PATTERN.test(value) ? value : null;
}

function safeEpochHeader(response: Response, name: string): number | null {
  const value = response.headers.get(name);
  if (value === null || !/^[0-9]{1,12}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Error bodies are intentionally never read or logged.
  }
}

async function readJsonWithinLimit(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType === null || !JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    await discardBody(response);
    return fail("GITHUB_INVALID_RESPONSE", null, safeRequestId(response));
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > maximumBytes) {
      await discardBody(response);
      return fail("GITHUB_RESPONSE_TOO_LARGE", null, safeRequestId(response));
    }
  }
  if (response.body === null) {
    return fail("GITHUB_INVALID_RESPONSE", null, safeRequestId(response));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) {
        await reader.cancel();
        return fail("GITHUB_RESPONSE_TOO_LARGE", null, safeRequestId(response));
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail("GITHUB_INVALID_RESPONSE", null, safeRequestId(response));
  }
}

async function executeReadPlan(
  plan: GitHubReadPlan,
  token: string,
  fetchImplementation: FetchImplementation,
): Promise<GitHubReadResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), plan.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImplementation(plan.url, {
        method: plan.method,
        headers: {
          accept: GITHUB_ACCEPT,
          authorization: `Bearer ${token}`,
          "user-agent": GITHUB_USER_AGENT,
          "x-github-api-version": plan.apiVersion,
        },
        cache: "no-store",
        credentials: "omit",
        redirect: plan.redirect,
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch {
      return fail(
        controller.signal.aborted ? "GITHUB_REQUEST_TIMEOUT" : "GITHUB_REQUEST_FAILED",
      );
    }
    const requestId = safeRequestId(response);
    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      return fail("GITHUB_REDIRECT_REJECTED", null, requestId);
    }
    if (response.status === 403 || response.status === 429) {
      const remaining = safeEpochHeader(response, "x-ratelimit-remaining");
      const retryAfter = safeEpochHeader(response, "retry-after");
      if (remaining === 0 || retryAfter !== null || response.status === 429) {
        const reset = safeEpochHeader(response, "x-ratelimit-reset");
        const retryAt = reset ?? (retryAfter === null
          ? null
          : Math.floor(Date.now() / 1_000) + retryAfter);
        await discardBody(response);
        return fail("GITHUB_RATE_LIMITED", retryAt, requestId);
      }
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      await discardBody(response);
      return fail("GITHUB_ACCESS_UNKNOWN", null, requestId);
    }
    if (!response.ok) {
      await discardBody(response);
      return fail("GITHUB_REQUEST_FAILED", null, requestId);
    }
    const nextPage = nextPageFromLink(response, plan);
    return Object.freeze({
      body: await readJsonWithinLimit(response, plan.maximumResponseBytes),
      nextPage,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isPagedEndpoint(kind: GitHubReadEndpoint["kind"]): boolean {
  return kind === "issues" || kind === "pulls" ||
    kind === "pullFiles" || kind === "releases";
}

function sortedQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function nextPageFromLink(response: Response, plan: GitHubReadPlan): number | null {
  const header = response.headers.get("link");
  if (header === null) return null;
  if (
    Buffer.byteLength(header, "utf8") > 4_096 ||
    CONTROL_CHARACTER_PATTERN.test(header)
  ) {
    return fail("GITHUB_INVALID_RESPONSE", null, safeRequestId(response));
  }
  const nextTargets: string[] = [];
  for (const rawPart of header.split(",")) {
    const part = rawPart.trim();
    const match = /^<([^<>]+)>;\s*rel="([A-Za-z ]+)"$/.exec(part);
    if (match === null) {
      return fail("GITHUB_INVALID_RESPONSE", null, safeRequestId(response));
    }
    if (match[2]!.split(" ").includes("next")) nextTargets.push(match[1]!);
  }
  if (nextTargets.length === 0) return null;
  if (nextTargets.length !== 1 || !isPagedEndpoint(plan.endpointKind)) {
    return fail("GITHUB_INVALID_RESPONSE", null, safeRequestId(response));
  }
  let current: URL;
  let candidate: URL;
  try {
    current = new URL(plan.url);
    candidate = new URL(nextTargets[0]!);
  } catch {
    return fail("GITHUB_INVALID_RESPONSE", null, safeRequestId(response));
  }
  const currentPageText = current.searchParams.get("page");
  const candidatePageText = candidate.searchParams.get("page");
  if (
    currentPageText === null || candidatePageText === null ||
    !/^[1-9][0-9]{0,4}$/.test(currentPageText) ||
    !/^[1-9][0-9]{0,4}$/.test(candidatePageText)
  ) {
    return fail("GITHUB_INVALID_RESPONSE", null, safeRequestId(response));
  }
  const currentPage = Number(currentPageText);
  const candidatePage = Number(candidatePageText);
  if (currentPage > 10_000 || candidatePage > 10_000) {
    return fail("GITHUB_INVALID_RESPONSE", null, safeRequestId(response));
  }
  const expected = new URL(current);
  expected.searchParams.set("page", String(currentPage + 1));
  if (
    candidatePage !== currentPage + 1 ||
    candidate.origin !== GITHUB_API_ORIGIN ||
    candidate.username !== "" ||
    candidate.password !== "" ||
    candidate.hash !== "" ||
    candidate.pathname !== expected.pathname ||
    sortedQuery(candidate) !== sortedQuery(expected)
  ) {
    return fail("GITHUB_INVALID_RESPONSE", null, safeRequestId(response));
  }
  return candidatePage;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return value as Record<string, unknown>;
}

function safeString(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return value;
}

function responseSha(value: unknown): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return value;
}

function safeInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return value as number;
}

function parseRepository(value: unknown, expectedOwner: string, expectedRepository: string): VerifiedGitHubRepository {
  const result = record(value);
  const owner = record(result.owner);
  const repositoryId = safeInteger(result.id, Number.MAX_SAFE_INTEGER);
  if (repositoryId === 0) return fail("GITHUB_INVALID_RESPONSE");
  const login = safeString(owner.login, 256);
  const name = safeString(result.name, 256);
  const fullName = safeString(result.full_name, 512);
  if (
    login.toLowerCase() !== expectedOwner.toLowerCase() ||
    name.toLowerCase() !== expectedRepository.toLowerCase() ||
    fullName.toLowerCase() !== `${login}/${name}`.toLowerCase() ||
    typeof result.private !== "boolean" ||
    typeof result.archived !== "boolean" ||
    typeof result.disabled !== "boolean"
  ) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return Object.freeze({
    repositoryId,
    nodeId: safeString(result.node_id, 512),
    name,
    fullName,
    owner: login,
    private: result.private,
    archived: result.archived,
    disabled: result.disabled,
    defaultBranch: safeString(result.default_branch, 1_024),
  });
}

function parseReference(value: unknown, expectedRef: string): VerifiedGitHubReference {
  const result = record(value);
  const object = record(result.object);
  if (result.ref !== expectedRef || object.type !== "commit") {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return Object.freeze({ ref: expectedRef, commitSha: responseSha(object.sha) });
}

function parseCommit(value: unknown, expectedSha: string): VerifiedGitHubCommit {
  const result = record(value);
  const tree = record(result.tree);
  if (result.sha !== expectedSha) return fail("GITHUB_INVALID_RESPONSE");
  return Object.freeze({ commitSha: expectedSha, treeSha: responseSha(tree.sha) });
}

function parseTree(value: unknown, expectedSha: string): VerifiedGitHubTree {
  const result = record(value);
  if (result.sha !== expectedSha || typeof result.truncated !== "boolean" || !Array.isArray(result.tree)) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  if (result.tree.length > 100_000 || Object.keys(result.tree).length !== result.tree.length) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  const entries = result.tree.map((raw): VerifiedGitHubTreeEntry => {
    const entry = record(raw);
    const mode = entry.mode;
    const type = entry.type;
    if (
      mode !== "040000" &&
      mode !== "100644" &&
      mode !== "100755" &&
      mode !== "120000" &&
      mode !== "160000"
    ) {
      return fail("GITHUB_INVALID_RESPONSE");
    }
    if (type !== "blob" && type !== "tree" && type !== "commit") {
      return fail("GITHUB_INVALID_RESPONSE");
    }
    return Object.freeze({
      path: safeString(entry.path, 4_096),
      mode,
      type,
      sha: responseSha(entry.sha),
      size: entry.size === undefined || entry.size === null
        ? null
        : safeInteger(entry.size, 100_000_000),
    });
  });
  return Object.freeze({
    treeSha: expectedSha,
    truncated: result.truncated,
    entries: Object.freeze(entries),
  });
}

function parseBlob(value: unknown, expectedSha: string): VerifiedGitHubBlob {
  const result = record(value);
  if (
    result.sha !== expectedSha ||
    result.encoding !== "base64" ||
    typeof result.content !== "string" ||
    !/^[A-Za-z0-9+/=\r\n]*$/.test(result.content)
  ) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return Object.freeze({
    blobSha: expectedSha,
    size: safeInteger(result.size, 100_000_000),
    encoding: "base64" as const,
    content: result.content,
  });
}

function safeMaterialText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return value;
}

function nullableMaterialText(value: unknown, maximumBytes: number): string | null {
  if (value === null) return null;
  return safeMaterialText(value, maximumBytes);
}

function responseRemoteNumber(value: unknown): number {
  const result = safeInteger(value, 2_147_483_647);
  return result > 0 ? result : fail("GITHUB_INVALID_RESPONSE");
}

function safeTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : safeTimestamp(value);
}

function safeGitHubHtmlUrl(
  value: unknown,
  owner: string,
  repository: string,
  expectedPrefix: string,
): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4_096) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  const repositoryPrefix = `/${owner}/${repository}/${expectedPrefix}`.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.pathname.toLowerCase().startsWith(repositoryPrefix)
  ) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return value;
}

function responseArray(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > MATERIAL_PAGE_SIZE ||
    Object.keys(value).length !== value.length
  ) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return value;
}

function parseIssue(
  value: unknown,
  owner: string,
  repository: string,
): VerifiedGitHubIssue {
  const issue = record(value);
  const state = issue.state;
  if (state !== "open" && state !== "closed") {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  const rawLabels = responseArray(issue.labels);
  const labels = rawLabels.map((rawLabel) => {
    const label = record(rawLabel);
    return safeString(label.name, 256);
  });
  if (new Set(labels).size !== labels.length) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return Object.freeze({
    nodeId: safeString(issue.node_id, 512),
    number: responseRemoteNumber(issue.number),
    title: safeString(issue.title, 16_384),
    body: nullableMaterialText(issue.body, 1_048_576),
    state,
    labels: Object.freeze([...labels].sort()),
    createdAt: safeTimestamp(issue.created_at),
    updatedAt: safeTimestamp(issue.updated_at),
    closedAt: nullableTimestamp(issue.closed_at),
    htmlUrl: safeGitHubHtmlUrl(issue.html_url, owner, repository, "issues/"),
  });
}

function parseIssuesPage(
  value: unknown,
  nextPage: number | null,
  owner: string,
  repository: string,
): VerifiedGitHubPage<VerifiedGitHubIssue> {
  const items = responseArray(value)
    .filter((raw) => !("pull_request" in record(raw)))
    .map((raw) => parseIssue(raw, owner, repository));
  return Object.freeze({ items: Object.freeze(items), nextPage });
}

function parsePullRequestSummary(value: unknown): VerifiedGitHubPullRequestSummary {
  const pull = record(value);
  return Object.freeze({
    nodeId: safeString(pull.node_id, 512),
    number: responseRemoteNumber(pull.number),
    updatedAt: safeTimestamp(pull.updated_at),
  });
}

function parsePullRequestsPage(
  value: unknown,
  nextPage: number | null,
): VerifiedGitHubPage<VerifiedGitHubPullRequestSummary> {
  const items = responseArray(value).map(parsePullRequestSummary);
  return Object.freeze({ items: Object.freeze(items), nextPage });
}

function parsePullRequest(
  value: unknown,
  owner: string,
  repository: string,
  expectedNumber: number,
): VerifiedGitHubPullRequest {
  const pull = record(value);
  const base = record(pull.base);
  const head = record(pull.head);
  const baseRepository = record(base.repo);
  const state = pull.state;
  if (
    pull.number !== expectedNumber ||
    (state !== "open" && state !== "closed") ||
    typeof pull.draft !== "boolean" ||
    String(baseRepository.full_name).toLowerCase() !==
      `${owner}/${repository}`.toLowerCase()
  ) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return Object.freeze({
    nodeId: safeString(pull.node_id, 512),
    number: expectedNumber,
    title: safeString(pull.title, 16_384),
    body: nullableMaterialText(pull.body, 1_048_576),
    state,
    draft: pull.draft,
    baseRef: safeString(base.ref, 1_024),
    baseSha: responseSha(base.sha),
    headRef: safeString(head.ref, 1_024),
    headSha: responseSha(head.sha),
    additions: safeInteger(pull.additions, 100_000_000),
    deletions: safeInteger(pull.deletions, 100_000_000),
    changedFiles: safeInteger(pull.changed_files, 100_000),
    createdAt: safeTimestamp(pull.created_at),
    updatedAt: safeTimestamp(pull.updated_at),
    closedAt: nullableTimestamp(pull.closed_at),
    mergedAt: nullableTimestamp(pull.merged_at),
    htmlUrl: safeGitHubHtmlUrl(pull.html_url, owner, repository, "pull/"),
  });
}

const PULL_FILE_STATUSES = Object.freeze([
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
] as const);

function parsePullRequestFile(value: unknown): VerifiedGitHubPullRequestFile {
  const file = record(value);
  if (!PULL_FILE_STATUSES.includes(file.status as (typeof PULL_FILE_STATUSES)[number])) {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  const previousFilename = file.previous_filename === undefined
    ? null
    : safeString(file.previous_filename, 4_096);
  return Object.freeze({
    blobSha: responseSha(file.sha),
    filename: safeString(file.filename, 4_096),
    previousFilename,
    status: file.status as VerifiedGitHubPullRequestFile["status"],
    additions: safeInteger(file.additions, 100_000_000),
    deletions: safeInteger(file.deletions, 100_000_000),
    changes: safeInteger(file.changes, 100_000_000),
  });
}

function parsePullRequestFilesPage(
  value: unknown,
  nextPage: number | null,
): VerifiedGitHubPage<VerifiedGitHubPullRequestFile> {
  const items = responseArray(value).map(parsePullRequestFile);
  return Object.freeze({ items: Object.freeze(items), nextPage });
}

function parseRelease(
  value: unknown,
  owner: string,
  repository: string,
): VerifiedGitHubRelease {
  const release = record(value);
  if (typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean") {
    return fail("GITHUB_INVALID_RESPONSE");
  }
  return Object.freeze({
    releaseId: responseRemoteNumber(release.id),
    nodeId: safeString(release.node_id, 512),
    tagName: safeString(release.tag_name, 1_024),
    name: nullableMaterialText(release.name, 16_384),
    body: nullableMaterialText(release.body, 1_048_576),
    draft: release.draft,
    prerelease: release.prerelease,
    createdAt: safeTimestamp(release.created_at),
    publishedAt: nullableTimestamp(release.published_at),
    htmlUrl: safeGitHubHtmlUrl(release.html_url, owner, repository, "releases/"),
  });
}

function parseReleasesPage(
  value: unknown,
  nextPage: number | null,
  owner: string,
  repository: string,
): VerifiedGitHubPage<VerifiedGitHubRelease> {
  const items = responseArray(value).map((raw) => parseRelease(raw, owner, repository));
  return Object.freeze({ items: Object.freeze(items), nextPage });
}

export function createGitHubReadOnlyClient(options: Readonly<{
  credential: GitHubCredentialHandle;
  fetchImplementation?: FetchImplementation;
}>): GitHubMaterialReadOnlyClient {
  const token = resolveCredential(options.credential);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const request = async (endpoint: GitHubReadEndpoint): Promise<GitHubReadResponse> => {
    const plan = createGitHubReadPlan(endpoint);
    return executeReadPlan(plan, token, fetchImplementation);
  };
  const client: GitHubMaterialReadOnlyClient = {
    version: GITHUB_READ_ONLY_CLIENT_VERSION,
    async getRepository(input) {
      const owner = canonicalOwner(input.owner);
      const repository = canonicalRepository(input.repository);
      return parseRepository(
        (await request({ kind: "repository", owner, repository })).body,
        owner,
        repository,
      );
    },
    async getReference(input) {
      const trackedRef = canonicalTrackedRef(input.trackedRef);
      return parseReference((await request({
        kind: "reference",
        owner: input.owner,
        repository: input.repository,
        trackedRef,
      })).body, trackedRef);
    },
    async getCommit(input) {
      const commitSha = canonicalSha(input.commitSha);
      return parseCommit((await request({
        kind: "commit",
        owner: input.owner,
        repository: input.repository,
        commitSha,
      })).body, commitSha);
    },
    async getTree(input) {
      const treeSha = canonicalSha(input.treeSha);
      return parseTree((await request({
        kind: "tree",
        owner: input.owner,
        repository: input.repository,
        treeSha,
      })).body, treeSha);
    },
    async getBlob(input) {
      const blobSha = canonicalSha(input.blobSha);
      return parseBlob((await request({
        kind: "blob",
        owner: input.owner,
        repository: input.repository,
        blobSha,
      })).body, blobSha);
    },
    async getIssuesPage(input) {
      const owner = canonicalOwner(input.owner);
      const repository = canonicalRepository(input.repository);
      const page = canonicalPage(input.page);
      const response = await request({ kind: "issues", owner, repository, page });
      return parseIssuesPage(response.body, response.nextPage, owner, repository);
    },
    async getPullRequestsPage(input) {
      const owner = canonicalOwner(input.owner);
      const repository = canonicalRepository(input.repository);
      const page = canonicalPage(input.page);
      const response = await request({ kind: "pulls", owner, repository, page });
      return parsePullRequestsPage(response.body, response.nextPage);
    },
    async getPullRequest(input) {
      const owner = canonicalOwner(input.owner);
      const repository = canonicalRepository(input.repository);
      const pullNumber = canonicalRemoteNumber(input.pullNumber);
      const response = await request({
        kind: "pull",
        owner,
        repository,
        pullNumber,
      });
      return parsePullRequest(response.body, owner, repository, pullNumber);
    },
    async getPullRequestFilesPage(input) {
      const owner = canonicalOwner(input.owner);
      const repository = canonicalRepository(input.repository);
      const pullNumber = canonicalRemoteNumber(input.pullNumber);
      const page = canonicalPage(input.page);
      const response = await request({
        kind: "pullFiles",
        owner,
        repository,
        pullNumber,
        page,
      });
      return parsePullRequestFilesPage(response.body, response.nextPage);
    },
    async getReleasesPage(input) {
      const owner = canonicalOwner(input.owner);
      const repository = canonicalRepository(input.repository);
      const page = canonicalPage(input.page);
      const response = await request({ kind: "releases", owner, repository, page });
      return parseReleasesPage(response.body, response.nextPage, owner, repository);
    },
  };
  return Object.freeze(client);
}
