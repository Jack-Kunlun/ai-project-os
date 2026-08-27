import { createHash } from "node:crypto";
import {
  GITHUB_READ_ONLY_CLIENT_VERSION,
  type GitHubMaterialReadOnlyClient,
  type VerifiedGitHubPullRequestFile,
  type VerifiedGitHubTree,
  type VerifiedGitHubTreeEntry,
  type VerifiedGitHubRepository,
} from "./read-only-client";

export const GITHUB_MATERIAL_SCANNER_VERSION =
  "github-material-scanner:v1" as const;
export const GITHUB_MATERIAL_SCAN_BUDGETS = Object.freeze({
  maximumFileBytes: 256 * 1_024,
  maximumMarkdownFiles: 100,
  maximumMarkdownBytes: 5 * 1_024 * 1_024,
  maximumMaterialPagesPerClass: 100,
  maximumPullFilePages: 100,
  maximumMaterialObjects: 20_000,
  maximumPullFiles: 100_000,
  maximumSourceBytes: 32 * 1_024 * 1_024,
  maximumRequests: 5_000,
  maximumWallTimeMs: 20 * 60 * 1_000,
  maximumDirectoryDepth: 32,
} as const);

export const GITHUB_MATERIAL_SCANNER_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify({
    version: GITHUB_MATERIAL_SCANNER_VERSION,
    budgets: GITHUB_MATERIAL_SCAN_BUDGETS,
    canonicalization: "stable-json-or-exact-utf8:v1",
    pathPolicy: "explicit-markdown-files:v1",
    secretPolicy: "high-confidence-local-quarantine:v1",
    publicationPolicy: "repository-atomic:v1",
  }), "utf8")
  .digest("hex");

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const README_PRIORITIES = Object.freeze([
  "readme.md",
  "readme.markdown",
  "readme.mdown",
  "readme",
] as const);
const MATERIAL_KIND_ORDER = Object.freeze([
  "repositoryMetadata",
  "readme",
  "markdown",
  "issue",
  "pullRequest",
  "release",
] as const);
const SECRET_PATTERNS = Object.freeze([
  /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,500}\b/,
  /\b(?:github_pat_[A-Za-z0-9_]{32,240}|gh[pousr]_[A-Za-z0-9]{20,255})\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:api[_-]?key|password|passwd|client[_-]?secret|access[_-]?token)\s*[:=]\s*["']?(?!(?:process\.env|os\.environ|config\.|settings\.|getenv|env\(|\$\{|<|example|placeholder|redacted|changeme|not[-_]?set)\b)[A-Za-z0-9+/_=.-]{12,}["']?/i,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
]);

export type GitHubMaterialKindValue =
  | "repositoryMetadata"
  | "readme"
  | "markdown"
  | "issue"
  | "pullRequest"
  | "release";

export type GitHubMaterialScanErrorCode =
  | "GITHUB_MATERIAL_SCAN_INVALID_INPUT"
  | "GITHUB_MATERIAL_SCAN_IDENTITY_MISMATCH"
  | "GITHUB_MATERIAL_SCAN_REFERENCE_CHANGED"
  | "GITHUB_MATERIAL_SCAN_REMOTE_CHANGED"
  | "GITHUB_MATERIAL_SCAN_SCOPE_NOT_FOUND"
  | "GITHUB_MATERIAL_SCAN_TREE_INTEGRITY_ERROR"
  | "GITHUB_MATERIAL_SCAN_BLOB_INTEGRITY_ERROR"
  | "GITHUB_MATERIAL_SCAN_COVERAGE_INCOMPLETE"
  | "GITHUB_MATERIAL_SCAN_BUDGET_EXCEEDED";

export class GitHubMaterialScanError extends Error {
  constructor(readonly code: GitHubMaterialScanErrorCode) {
    super(code);
    this.name = "GitHubMaterialScanError";
  }
}

export type GitHubMaterialScanPolicy = Readonly<{
  metadataEnabled: boolean;
  readmeEnabled: boolean;
  markdownEnabled: boolean;
  markdownPaths: readonly string[];
  issuesEnabled: boolean;
  pullRequestsEnabled: boolean;
  releasesEnabled: boolean;
  policyFingerprint: string;
}>;

export type ScannedGitHubMaterialSource = Readonly<{
  materialKind: GitHubMaterialKindValue;
  remoteIdentity: string;
  remoteRevisionFingerprint: string;
  remoteNumber: number | null;
  normalizedPath: string | null;
  externalRef: string;
  capturedAt: string;
  contentText: string;
  contentHash: string;
  contentBytes: number;
}>;

export type GitHubMaterialQuarantineFinding = Readonly<{
  materialKind: GitHubMaterialKindValue;
  remoteIdentityFingerprint: string;
  reasonCode: "secretDetected" | "unsafeContent";
}>;

export type GitHubMaterialScanResult = Readonly<{
  contractVersion: typeof GITHUB_MATERIAL_SCANNER_VERSION;
  scannerFingerprint: typeof GITHUB_MATERIAL_SCANNER_FINGERPRINT;
  policyFingerprint: string;
  repository: Readonly<{
    repositoryId: number;
    nodeId: string;
    capturedFullName: string;
    owner: string;
    name: string;
  }>;
  trackedRef: string;
  observedHeadCommitSha: string;
  rootTreeSha: string;
  requestCount: number;
  fetchedObjectCount: number;
  inspectedSourceBytes: number;
  decodedTextBytes: number;
  sourceSetFingerprint: string;
  enabledClassManifest: Readonly<Record<string, unknown>>;
  coverageManifest: Readonly<Record<string, unknown>>;
  sources: readonly ScannedGitHubMaterialSource[];
  quarantines: readonly GitHubMaterialQuarantineFinding[];
}>;

export type ScanGitHubRepositoryMaterialsOptions = Readonly<{
  client: GitHubMaterialReadOnlyClient;
  owner: string;
  repository: string;
  expectedRepositoryId: number;
  expectedNodeId: string;
  trackedRef: string;
  policy: GitHubMaterialScanPolicy;
  now?: () => number;
}>;

function fail(code: GitHubMaterialScanErrorCode): never {
  throw new GitHubMaterialScanError(code);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  }
  return value;
}

function safePath(value: unknown): string {
  const path = safeText(value, 480);
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.includes("\\") ||
    path.includes("%") ||
    ["*", "?", "[", "]"].some((character) => path.includes(character)) ||
    segments.length > GITHUB_MATERIAL_SCAN_BUDGETS.maximumDirectoryDepth ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    !/\.(?:md|markdown)$/iu.test(path)
  ) {
    return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  }
  return path;
}

function validatePolicy(value: unknown): GitHubMaterialScanPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  }
  const policy = value as Record<string, unknown>;
  const expectedKeys = [
    "issuesEnabled",
    "markdownEnabled",
    "markdownPaths",
    "metadataEnabled",
    "policyFingerprint",
    "pullRequestsEnabled",
    "readmeEnabled",
    "releasesEnabled",
  ].sort();
  if (Object.keys(policy).sort().join("\u0000") !== expectedKeys.join("\u0000")) {
    return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  }
  for (const key of [
    "metadataEnabled",
    "readmeEnabled",
    "markdownEnabled",
    "issuesEnabled",
    "pullRequestsEnabled",
    "releasesEnabled",
  ]) {
    if (typeof policy[key] !== "boolean") return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  }
  if (!Array.isArray(policy.markdownPaths)) {
    return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  }
  const markdownPaths = policy.markdownPaths.map(safePath).sort();
  if (
    markdownPaths.length > GITHUB_MATERIAL_SCAN_BUDGETS.maximumMarkdownFiles ||
    Object.keys(policy.markdownPaths).length !== policy.markdownPaths.length ||
    new Set(markdownPaths).size !== markdownPaths.length ||
    policy.markdownEnabled !== (markdownPaths.length > 0) ||
    typeof policy.policyFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(policy.policyFingerprint)
  ) {
    return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  }
  if (
    policy.metadataEnabled !== true &&
    policy.readmeEnabled !== true &&
    policy.markdownEnabled !== true &&
    policy.issuesEnabled !== true &&
    policy.pullRequestsEnabled !== true &&
    policy.releasesEnabled !== true
  ) {
    return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  }
  return Object.freeze({
    metadataEnabled: policy.metadataEnabled as boolean,
    readmeEnabled: policy.readmeEnabled as boolean,
    markdownEnabled: policy.markdownEnabled as boolean,
    markdownPaths: Object.freeze(markdownPaths),
    issuesEnabled: policy.issuesEnabled as boolean,
    pullRequestsEnabled: policy.pullRequestsEnabled as boolean,
    releasesEnabled: policy.releasesEnabled as boolean,
    policyFingerprint: policy.policyFingerprint,
  });
}

function validateOptions(options: ScanGitHubRepositoryMaterialsOptions): Readonly<{
  client: GitHubMaterialReadOnlyClient;
  owner: string;
  repository: string;
  expectedRepositoryId: number;
  expectedNodeId: string;
  trackedRef: string;
  policy: GitHubMaterialScanPolicy;
  now: () => number;
}> {
  if (
    typeof options !== "object" ||
    options === null ||
    options.client?.version !== GITHUB_READ_ONLY_CLIENT_VERSION ||
    ![
      "getRepository",
      "getReference",
      "getCommit",
      "getTree",
      "getBlob",
      "getIssuesPage",
      "getPullRequestsPage",
      "getPullRequest",
      "getPullRequestFilesPage",
      "getReleasesPage",
    ].every((method) => typeof (options.client as unknown as Record<string, unknown>)[method] === "function") ||
    !Number.isSafeInteger(options.expectedRepositoryId) ||
    options.expectedRepositoryId < 1 ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  }
  const owner = safeText(options.owner, 256);
  const repository = safeText(options.repository, 256);
  const expectedNodeId = safeText(options.expectedNodeId, 512);
  const trackedRef = safeText(options.trackedRef, 255);
  if (
    !OWNER_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(repository) ||
    repository === "." ||
    repository === ".." ||
    repository.toLowerCase().endsWith(".git") ||
    !trackedRef.startsWith("refs/heads/")
  ) {
    return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  }
  return Object.freeze({
    client: options.client,
    owner,
    repository,
    expectedRepositoryId: options.expectedRepositoryId,
    expectedNodeId,
    trackedRef,
    policy: validatePolicy(options.policy),
    now: options.now ?? Date.now,
  });
}

function stableJson(value: unknown): string {
  const visit = (entry: unknown): unknown => {
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry)) return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
      return entry;
    }
    if (typeof entry === "string") {
      if (
        entry.normalize("NFC") !== entry ||
        CONTROL_CHARACTER_PATTERN.test(entry) ||
        BIDI_CONTROL_PATTERN.test(entry)
      ) {
        return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
      }
      return entry;
    }
    if (Array.isArray(entry)) {
      if (Object.keys(entry).length !== entry.length) {
        return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
      }
      return entry.map(visit);
    }
    if (typeof entry === "object" && entry !== null) {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) {
        return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
      }
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, visit(child)]),
      );
    }
    return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
  };
  return JSON.stringify(visit(value));
}

function repositoryIdentity(repository: VerifiedGitHubRepository): string {
  return stableJson({
    archived: repository.archived,
    defaultBranch: repository.defaultBranch,
    disabled: repository.disabled,
    fullName: repository.fullName,
    nodeId: repository.nodeId,
    owner: repository.owner,
    private: repository.private,
    repositoryId: repository.repositoryId,
    repositoryName: repository.name,
  });
}

function htmlFileUrl(owner: string, repository: string, commitSha: string, path: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/blob/${commitSha}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function sourceSort(left: ScannedGitHubMaterialSource, right: ScannedGitHubMaterialSource): number {
  return MATERIAL_KIND_ORDER.indexOf(left.materialKind) -
    MATERIAL_KIND_ORDER.indexOf(right.materialKind) ||
    left.remoteIdentity.localeCompare(right.remoteIdentity) ||
    left.remoteRevisionFingerprint.localeCompare(right.remoteRevisionFingerprint);
}

export async function scanGitHubRepositoryMaterials(
  rawOptions: ScanGitHubRepositoryMaterialsOptions,
): Promise<GitHubMaterialScanResult> {
  const options = validateOptions(rawOptions);
  const startedAtMs = options.now();
  if (!Number.isFinite(startedAtMs)) return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  const capturedAt = new Date(startedAtMs);
  if (!Number.isFinite(capturedAt.getTime())) return fail("GITHUB_MATERIAL_SCAN_INVALID_INPUT");
  const capturedAtIso = capturedAt.toISOString();
  let requestCount = 0;
  let fetchedObjectCount = 0;
  let inspectedSourceBytes = 0;
  let markdownBytes = 0;
  let pullFileCount = 0;
  const sources: ScannedGitHubMaterialSource[] = [];
  const quarantines: GitHubMaterialQuarantineFinding[] = [];
  const sourceIdentityKeys = new Map<string, string>();

  const guardBudget = (): void => {
    const current = options.now();
    if (
      !Number.isFinite(current) ||
      current < startedAtMs ||
      current - startedAtMs > GITHUB_MATERIAL_SCAN_BUDGETS.maximumWallTimeMs ||
      requestCount > GITHUB_MATERIAL_SCAN_BUDGETS.maximumRequests ||
      fetchedObjectCount > GITHUB_MATERIAL_SCAN_BUDGETS.maximumMaterialObjects ||
      inspectedSourceBytes > GITHUB_MATERIAL_SCAN_BUDGETS.maximumSourceBytes ||
      markdownBytes > GITHUB_MATERIAL_SCAN_BUDGETS.maximumMarkdownBytes ||
      pullFileCount > GITHUB_MATERIAL_SCAN_BUDGETS.maximumPullFiles
    ) {
      return fail("GITHUB_MATERIAL_SCAN_BUDGET_EXCEEDED");
    }
  };
  const request = async <T>(operation: () => Promise<T>): Promise<T> => {
    requestCount += 1;
    guardBudget();
    const result = await operation();
    guardBudget();
    return result;
  };
  const addQuarantine = (
    materialKind: GitHubMaterialKindValue,
    remoteIdentity: string,
    remoteRevisionFingerprint: string,
    reasonCode: GitHubMaterialQuarantineFinding["reasonCode"],
  ): void => {
    const remoteIdentityFingerprint = sha256(stableJson({
      materialKind,
      remoteIdentity,
      remoteRevisionFingerprint,
    }));
    if (!quarantines.some((entry) => entry.remoteIdentityFingerprint === remoteIdentityFingerprint)) {
      quarantines.push(Object.freeze({ materialKind, remoteIdentityFingerprint, reasonCode }));
    }
  };
  const addSource = (input: Omit<ScannedGitHubMaterialSource, "contentHash" | "contentBytes">): void => {
    fetchedObjectCount += 1;
    const contentBytes = Buffer.byteLength(input.contentText, "utf8");
    inspectedSourceBytes += contentBytes;
    guardBudget();
    const identityKey = `${input.materialKind}\u0000${input.remoteIdentity}`;
    const existingRevision = sourceIdentityKeys.get(identityKey);
    if (existingRevision !== undefined) {
      if (existingRevision !== input.remoteRevisionFingerprint) {
        return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
      }
      return;
    }
    sourceIdentityKeys.set(identityKey, input.remoteRevisionFingerprint);
    if (
      input.contentText.normalize("NFC") !== input.contentText ||
      CONTROL_CHARACTER_PATTERN.test(input.contentText) ||
      BIDI_CONTROL_PATTERN.test(input.contentText)
    ) {
      addQuarantine(
        input.materialKind,
        input.remoteIdentity,
        input.remoteRevisionFingerprint,
        "unsafeContent",
      );
      return;
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(input.contentText))) {
      addQuarantine(
        input.materialKind,
        input.remoteIdentity,
        input.remoteRevisionFingerprint,
        "secretDetected",
      );
      return;
    }
    if (contentBytes === 0) return;
    sources.push(Object.freeze({
      ...input,
      contentHash: sha256(input.contentText),
      contentBytes,
    }));
  };

  const repository = await request(() => options.client.getRepository({
    owner: options.owner,
    repository: options.repository,
  }));
  if (
    repository.repositoryId !== options.expectedRepositoryId ||
    repository.nodeId !== options.expectedNodeId ||
    repository.owner.toLowerCase() !== options.owner.toLowerCase() ||
    repository.name.toLowerCase() !== options.repository.toLowerCase() ||
    repository.fullName.toLowerCase() !==
      `${repository.owner}/${repository.name}`.toLowerCase()
  ) {
    return fail("GITHUB_MATERIAL_SCAN_IDENTITY_MISMATCH");
  }
  const initialRepositoryIdentity = repositoryIdentity(repository);
  const reference = await request(() => options.client.getReference({
    owner: options.owner,
    repository: options.repository,
    trackedRef: options.trackedRef,
  }));
  if (reference.ref !== options.trackedRef || !SHA_PATTERN.test(reference.commitSha)) {
    return fail("GITHUB_MATERIAL_SCAN_REFERENCE_CHANGED");
  }
  const commit = await request(() => options.client.getCommit({
    owner: options.owner,
    repository: options.repository,
    commitSha: reference.commitSha,
  }));
  if (commit.commitSha !== reference.commitSha || !SHA_PATTERN.test(commit.treeSha)) {
    return fail("GITHUB_MATERIAL_SCAN_REFERENCE_CHANGED");
  }

  if (options.policy.metadataEnabled) {
    const contentText = stableJson({
      repository: JSON.parse(initialRepositoryIdentity) as unknown,
      trackedRef: options.trackedRef,
      observedHeadCommitSha: reference.commitSha,
    });
    addSource({
      materialKind: "repositoryMetadata",
      remoteIdentity: `repository:${repository.repositoryId}`,
      remoteRevisionFingerprint: sha256(contentText),
      remoteNumber: null,
      normalizedPath: null,
      externalRef: `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`,
      capturedAt: capturedAtIso,
      contentText,
    });
  }

  const treeCache = new Map<string, VerifiedGitHubTree>();
  const readTree = async (treeSha: string): Promise<VerifiedGitHubTree> => {
    const existing = treeCache.get(treeSha);
    if (existing !== undefined) return existing;
    const tree = await request(() => options.client.getTree({
      owner: options.owner,
      repository: options.repository,
      treeSha,
    }));
    if (tree.treeSha !== treeSha || tree.truncated) {
      return fail("GITHUB_MATERIAL_SCAN_TREE_INTEGRITY_ERROR");
    }
    const paths = new Set<string>();
    for (const entry of tree.entries) {
      if (
        entry.path.length === 0 ||
        entry.path.includes("/") ||
        entry.path.includes("\\") ||
        entry.path.normalize("NFC") !== entry.path ||
        CONTROL_CHARACTER_PATTERN.test(entry.path) ||
        paths.has(entry.path)
      ) {
        return fail("GITHUB_MATERIAL_SCAN_TREE_INTEGRITY_ERROR");
      }
      paths.add(entry.path);
    }
    treeCache.set(treeSha, tree);
    return tree;
  };
  const resolveBlob = async (path: string): Promise<VerifiedGitHubTreeEntry | null> => {
    const segments = path.split("/");
    let treeSha = commit.treeSha;
    for (let index = 0; index < segments.length; index += 1) {
      const tree = await readTree(treeSha);
      const entry = tree.entries.find((candidate) => candidate.path === segments[index]);
      if (entry === undefined) return null;
      const terminal = index === segments.length - 1;
      if (terminal) {
        return entry.type === "blob" && entry.mode === "100644" ? entry : null;
      }
      if (entry.type !== "tree" || entry.mode !== "040000") return null;
      treeSha = entry.sha;
    }
    return null;
  };
  const readTextBlob = async (
    entry: VerifiedGitHubTreeEntry,
  ): Promise<{ contentText: string | null; unsafe: boolean }> => {
    if (
      entry.size === null ||
      entry.size < 0 ||
      entry.size > GITHUB_MATERIAL_SCAN_BUDGETS.maximumFileBytes
    ) {
      return fail("GITHUB_MATERIAL_SCAN_BUDGET_EXCEEDED");
    }
    const blob = await request(() => options.client.getBlob({
      owner: options.owner,
      repository: options.repository,
      blobSha: entry.sha,
    }));
    if (blob.blobSha !== entry.sha || blob.size !== entry.size) {
      return fail("GITHUB_MATERIAL_SCAN_BLOB_INTEGRITY_ERROR");
    }
    const compact = blob.content.replace(/[\r\n]/g, "");
    let bytes: Buffer;
    try {
      bytes = Buffer.from(compact, "base64");
    } catch {
      return fail("GITHUB_MATERIAL_SCAN_BLOB_INTEGRITY_ERROR");
    }
    if (bytes.byteLength !== blob.size) {
      return fail("GITHUB_MATERIAL_SCAN_BLOB_INTEGRITY_ERROR");
    }
    markdownBytes += bytes.byteLength;
    guardBudget();
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return Object.freeze({
        contentText: text,
        unsafe: text.normalize("NFC") !== text ||
          CONTROL_CHARACTER_PATTERN.test(text) ||
          BIDI_CONTROL_PATTERN.test(text),
      });
    } catch {
      return Object.freeze({ contentText: null, unsafe: true });
    }
  };
  const addFile = async (
    materialKind: "readme" | "markdown",
    normalizedPath: string,
    required: boolean,
  ): Promise<boolean> => {
    const entry = await resolveBlob(normalizedPath);
    if (entry === null) {
      if (required) return fail("GITHUB_MATERIAL_SCAN_SCOPE_NOT_FOUND");
      return false;
    }
    fetchedObjectCount += 1;
    const remoteIdentity = `${materialKind}:${normalizedPath}`;
    const remoteRevisionFingerprint = sha256(stableJson({
      blobSha: entry.sha,
      materialKind,
      normalizedPath,
    }));
    const decoded = await readTextBlob(entry);
    if (decoded.unsafe || decoded.contentText === null) {
      addQuarantine(materialKind, remoteIdentity, remoteRevisionFingerprint, "unsafeContent");
      return true;
    }
    fetchedObjectCount -= 1;
    addSource({
      materialKind,
      remoteIdentity,
      remoteRevisionFingerprint,
      remoteNumber: null,
      normalizedPath,
      externalRef: htmlFileUrl(repository.owner, repository.name, reference.commitSha, normalizedPath),
      capturedAt: capturedAtIso,
      contentText: decoded.contentText,
    });
    return true;
  };

  let readmeFound = false;
  if (options.policy.readmeEnabled || options.policy.markdownEnabled) {
    const rootTree = await readTree(commit.treeSha);
    if (options.policy.readmeEnabled) {
      for (const priority of README_PRIORITIES) {
        const matches = rootTree.entries.filter((entry) => entry.path.toLowerCase() === priority);
        if (matches.length > 1) return fail("GITHUB_MATERIAL_SCAN_TREE_INTEGRITY_ERROR");
        const match = matches[0];
        if (match !== undefined) {
          readmeFound = await addFile("readme", match.path, false);
          break;
        }
      }
    }
    for (const path of options.policy.markdownPaths) {
      await addFile("markdown", path, true);
    }
  }

  const issueNumbers = new Set<number>();
  let issueCount = 0;
  if (options.policy.issuesEnabled) {
    let page: number | null = 1;
    let pageCount = 0;
    while (page !== null) {
      pageCount += 1;
      if (pageCount > GITHUB_MATERIAL_SCAN_BUDGETS.maximumMaterialPagesPerClass) {
        return fail("GITHUB_MATERIAL_SCAN_BUDGET_EXCEEDED");
      }
      const result = await request(() => options.client.getIssuesPage({
        owner: options.owner,
        repository: options.repository,
        page: page!,
      }));
      for (const issue of result.items) {
        if (issueNumbers.has(issue.number)) {
          return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
        }
        issueNumbers.add(issue.number);
        issueCount += 1;
        const contentText = stableJson(issue);
        const remoteIdentity = `issue:${issue.number}`;
        const remoteRevisionFingerprint = sha256(stableJson({
          nodeId: issue.nodeId,
          number: issue.number,
          updatedAt: issue.updatedAt,
          contentHash: sha256(contentText),
        }));
        addSource({
          materialKind: "issue",
          remoteIdentity,
          remoteRevisionFingerprint,
          remoteNumber: issue.number,
          normalizedPath: null,
          externalRef: issue.htmlUrl,
          capturedAt: issue.updatedAt,
          contentText,
        });
      }
      if (result.nextPage !== null && result.nextPage !== page + 1) {
        return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
      }
      page = result.nextPage;
    }
  }

  const pullSummaries = new Map<number, { nodeId: string; updatedAt: string }>();
  let pullCount = 0;
  if (options.policy.pullRequestsEnabled) {
    let page: number | null = 1;
    let pageCount = 0;
    while (page !== null) {
      pageCount += 1;
      if (pageCount > GITHUB_MATERIAL_SCAN_BUDGETS.maximumMaterialPagesPerClass) {
        return fail("GITHUB_MATERIAL_SCAN_BUDGET_EXCEEDED");
      }
      const result = await request(() => options.client.getPullRequestsPage({
        owner: options.owner,
        repository: options.repository,
        page: page!,
      }));
      for (const summary of result.items) {
        if (pullSummaries.has(summary.number)) {
          return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
        }
        pullSummaries.set(summary.number, { nodeId: summary.nodeId, updatedAt: summary.updatedAt });
      }
      if (result.nextPage !== null && result.nextPage !== page + 1) {
        return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
      }
      page = result.nextPage;
    }
    for (const [pullNumber, summary] of [...pullSummaries.entries()].sort(([left], [right]) => left - right)) {
      const pull = await request(() => options.client.getPullRequest({
        owner: options.owner,
        repository: options.repository,
        pullNumber,
      }));
      if (
        pull.number !== pullNumber ||
        pull.nodeId !== summary.nodeId ||
        pull.updatedAt !== summary.updatedAt
      ) {
        return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
      }
      const files: VerifiedGitHubPullRequestFile[] = [];
      let filePage: number | null = 1;
      let filePageCount = 0;
      while (filePage !== null) {
        filePageCount += 1;
        if (filePageCount > GITHUB_MATERIAL_SCAN_BUDGETS.maximumPullFilePages) {
          return fail("GITHUB_MATERIAL_SCAN_BUDGET_EXCEEDED");
        }
        const result = await request(() => options.client.getPullRequestFilesPage({
          owner: options.owner,
          repository: options.repository,
          pullNumber,
          page: filePage!,
        }));
        files.push(...result.items);
        pullFileCount += result.items.length;
        guardBudget();
        if (result.nextPage !== null && result.nextPage !== filePage + 1) {
          return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
        }
        filePage = result.nextPage;
      }
      const sortedFiles = [...files].sort((left, right) =>
        left.filename.localeCompare(right.filename) || left.blobSha.localeCompare(right.blobSha));
      if (
        pull.changedFiles !== sortedFiles.length ||
        new Set(sortedFiles.map((file) => file.filename)).size !== sortedFiles.length
      ) {
        return fail("GITHUB_MATERIAL_SCAN_COVERAGE_INCOMPLETE");
      }
      pullCount += 1;
      const contentText = stableJson({ ...pull, files: sortedFiles });
      addSource({
        materialKind: "pullRequest",
        remoteIdentity: `pull_request:${pull.number}`,
        remoteRevisionFingerprint: sha256(stableJson({
          nodeId: pull.nodeId,
          number: pull.number,
          updatedAt: pull.updatedAt,
          baseSha: pull.baseSha,
          headSha: pull.headSha,
          contentHash: sha256(contentText),
        })),
        remoteNumber: pull.number,
        normalizedPath: null,
        externalRef: pull.htmlUrl,
        capturedAt: pull.updatedAt,
        contentText,
      });
    }
  }

  const releaseIds = new Set<number>();
  let releaseCount = 0;
  if (options.policy.releasesEnabled) {
    let page: number | null = 1;
    let pageCount = 0;
    while (page !== null) {
      pageCount += 1;
      if (pageCount > GITHUB_MATERIAL_SCAN_BUDGETS.maximumMaterialPagesPerClass) {
        return fail("GITHUB_MATERIAL_SCAN_BUDGET_EXCEEDED");
      }
      const result = await request(() => options.client.getReleasesPage({
        owner: options.owner,
        repository: options.repository,
        page: page!,
      }));
      for (const release of result.items) {
        if (releaseIds.has(release.releaseId)) {
          return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
        }
        releaseIds.add(release.releaseId);
        releaseCount += 1;
        const contentText = stableJson(release);
        addSource({
          materialKind: "release",
          remoteIdentity: `release:${release.releaseId}`,
          remoteRevisionFingerprint: sha256(stableJson({
            releaseId: release.releaseId,
            nodeId: release.nodeId,
            updatedAt: release.updatedAt,
            contentHash: sha256(contentText),
          })),
          remoteNumber: release.releaseId,
          normalizedPath: null,
          externalRef: release.htmlUrl,
          capturedAt: release.updatedAt,
          contentText,
        });
      }
      if (result.nextPage !== null && result.nextPage !== page + 1) {
        return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
      }
      page = result.nextPage;
    }
  }

  const finalReference = await request(() => options.client.getReference({
    owner: options.owner,
    repository: options.repository,
    trackedRef: options.trackedRef,
  }));
  if (finalReference.ref !== options.trackedRef || finalReference.commitSha !== reference.commitSha) {
    return fail("GITHUB_MATERIAL_SCAN_REFERENCE_CHANGED");
  }
  const finalRepository = await request(() => options.client.getRepository({
    owner: options.owner,
    repository: options.repository,
  }));
  if (repositoryIdentity(finalRepository) !== initialRepositoryIdentity) {
    return fail("GITHUB_MATERIAL_SCAN_REMOTE_CHANGED");
  }

  sources.sort(sourceSort);
  quarantines.sort((left, right) =>
    MATERIAL_KIND_ORDER.indexOf(left.materialKind) -
      MATERIAL_KIND_ORDER.indexOf(right.materialKind) ||
    left.remoteIdentityFingerprint.localeCompare(right.remoteIdentityFingerprint));
  const decodedTextBytes = sources.reduce((total, source) => total + source.contentBytes, 0);
  const sourceSetFingerprint = sha256(stableJson({
    sources: sources.map((source) => ({
      materialKind: source.materialKind,
      remoteIdentity: source.remoteIdentity,
      remoteRevisionFingerprint: source.remoteRevisionFingerprint,
      contentHash: source.contentHash,
      contentBytes: source.contentBytes,
    })),
    quarantines,
  }));
  const enabledClassManifest = Object.freeze({
    repositoryMetadata: options.policy.metadataEnabled,
    readme: options.policy.readmeEnabled,
    markdown: Object.freeze({
      enabled: options.policy.markdownEnabled,
      paths: options.policy.markdownPaths,
    }),
    issues: options.policy.issuesEnabled,
    pullRequests: options.policy.pullRequestsEnabled,
    releases: options.policy.releasesEnabled,
  });
  const coverageManifest = Object.freeze({
    observedHeadCommitSha: reference.commitSha,
    sourceSetFingerprint,
    repositoryMetadata: Object.freeze({ enabled: options.policy.metadataEnabled, fetched: 1 }),
    readme: Object.freeze({ enabled: options.policy.readmeEnabled, found: readmeFound }),
    markdown: Object.freeze({ enabled: options.policy.markdownEnabled, requested: options.policy.markdownPaths.length }),
    issues: Object.freeze({ enabled: options.policy.issuesEnabled, fetched: issueCount }),
    pullRequests: Object.freeze({ enabled: options.policy.pullRequestsEnabled, fetched: pullCount, files: pullFileCount }),
    releases: Object.freeze({ enabled: options.policy.releasesEnabled, fetched: releaseCount }),
    publishedSources: sources.length,
    quarantinedSources: quarantines.length,
    inspectedSourceBytes,
  });
  guardBudget();
  return Object.freeze({
    contractVersion: GITHUB_MATERIAL_SCANNER_VERSION,
    scannerFingerprint: GITHUB_MATERIAL_SCANNER_FINGERPRINT,
    policyFingerprint: options.policy.policyFingerprint,
    repository: Object.freeze({
      repositoryId: repository.repositoryId,
      nodeId: repository.nodeId,
      capturedFullName: repository.fullName,
      owner: repository.owner,
      name: repository.name,
    }),
    trackedRef: options.trackedRef,
    observedHeadCommitSha: reference.commitSha,
    rootTreeSha: commit.treeSha,
    requestCount,
    fetchedObjectCount,
    inspectedSourceBytes,
    decodedTextBytes,
    sourceSetFingerprint,
    enabledClassManifest,
    coverageManifest,
    sources: Object.freeze(sources),
    quarantines: Object.freeze(quarantines),
  });
}
