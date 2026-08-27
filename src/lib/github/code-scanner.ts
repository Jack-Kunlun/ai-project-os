import { createHash } from "node:crypto";
import {
  GITHUB_READ_ONLY_CLIENT_VERSION,
  type GitHubReadOnlyClient,
  type VerifiedGitHubTreeEntry,
} from "./read-only-client";
import {
  GITHUB_SOFT_EXCLUDE_CLASSES,
} from "./repository-ledger";

export const GITHUB_CODE_SCANNER_VERSION = "github-code-scanner:v1" as const;
export const GITHUB_CODE_SCAN_BUDGETS = Object.freeze({
  maximumFileBytes: 256 * 1_024,
  maximumIncludedFiles: 2_000,
  maximumDecodedTextBytes: 10 * 1_024 * 1_024,
  maximumIncludeRoots: 32,
  maximumVisitedTreeEntries: 50_000,
  maximumDirectoryDepth: 32,
  maximumRequests: 2_500,
  maximumWallTimeMs: 20 * 60 * 1_000,
  maximumLineBytes: 16 * 1_024,
} as const);

export const GITHUB_CODE_SCANNER_FINGERPRINT = createHash("sha256")
  .update(
    JSON.stringify({
      version: GITHUB_CODE_SCANNER_VERSION,
      budgets: GITHUB_CODE_SCAN_BUDGETS,
      acceptedMode: "100644",
      pathPolicy: "strict-utf8-relative-segments:v1",
      hardPathPolicy: "github-hard-path-excludes:v1",
      contentPolicy: "github-local-content-scan:v1",
    }),
    "utf8",
  )
  .digest("hex");

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const UNSAFE_CONTENT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const ARCHIVE_EXTENSION_PATTERN = /\.(?:7z|a|apk|bz2|cab|deb|dmg|ear|egg|gz|iso|jar|rar|rpm|tar|tgz|war|whl|xz|zip)$/i;
const BINARY_EXTENSION_PATTERN = /\.(?:avif|bin|bmp|class|db|dll|dylib|eot|exe|gif|ico|jpeg|jpg|mov|mp3|mp4|o|obj|otf|pdf|png|pyc|so|sqlite|ttf|wav|webm|webp|woff2?)$/i;
const SOURCE_MAP_PATTERN = /\.map$/i;
const MINIFIED_PATTERN = /\.min\.(?:css|js|mjs|cjs)$/i;
const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
]);
const HARD_CREDENTIAL_FILE_NAMES = new Set([
  ".dockercfg",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "service-account.json",
]);

const SECRET_PATTERNS = Object.freeze([
  Object.freeze({ category: "OPENAI_API_KEY", pattern: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,500}\b/ }),
  Object.freeze({ category: "GITHUB_TOKEN", pattern: /\b(?:github_pat_[A-Za-z0-9_]{32,240}|gh[pousr]_[A-Za-z0-9]{20,255})\b/ }),
  Object.freeze({ category: "AWS_ACCESS_KEY", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ }),
  Object.freeze({ category: "PRIVATE_KEY", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ }),
  Object.freeze({
    category: "CREDENTIAL_ASSIGNMENT",
    pattern: /\b(?:api[_-]?key|password|passwd|client[_-]?secret|access[_-]?token)\s*[:=]\s*["']?(?!(?:process\.env|os\.environ|config\.|settings\.|getenv|env\(|\$\{|<|example|placeholder|redacted|changeme|not[-_]?set)\b)[A-Za-z0-9+/_=.-]{12,}["']?/i,
  }),
  Object.freeze({ category: "CREDENTIAL_URL", pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@/i }),
]);

const PII_PATTERNS = Object.freeze([
  Object.freeze({
    category: "EMAIL_ADDRESS",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/i,
  }),
  Object.freeze({ category: "CN_MOBILE", pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/ }),
  Object.freeze({ category: "CN_ID_NUMBER", pattern: /(?<!\d)\d{17}[0-9Xx](?!\d)/ }),
]);

type GitHubSoftExcludeClass = (typeof GITHUB_SOFT_EXCLUDE_CLASSES)[number];

export type GitHubCodeScanErrorCode =
  | "GITHUB_SCAN_INVALID_INPUT"
  | "GITHUB_SCAN_IDENTITY_MISMATCH"
  | "GITHUB_SCAN_SCOPE_NOT_FOUND"
  | "GITHUB_SCAN_SCOPE_EXCLUDED"
  | "GITHUB_SCAN_TREE_TRUNCATED"
  | "GITHUB_SCAN_TREE_INTEGRITY_ERROR"
  | "GITHUB_SCAN_BLOB_INTEGRITY_ERROR"
  | "GITHUB_SCAN_BUDGET_EXCEEDED"
  | "GITHUB_SCAN_UNSAFE_CONTENT"
  | "GITHUB_SCAN_SECRET_DETECTED"
  | "GITHUB_SCAN_SCANNER_UNAVAILABLE";

export class GitHubCodeScanError extends Error {
  constructor(readonly code: GitHubCodeScanErrorCode) {
    super(code);
    this.name = "GitHubCodeScanError";
  }
}

export type GitHubCodeExclusionReason =
  | "HARD_ENV_FILE"
  | "HARD_PRIVATE_KEY_FILE"
  | "HARD_CREDENTIAL_FILE"
  | "SOFT_VENDOR"
  | "SOFT_NODE_MODULES"
  | "SOFT_BUILD"
  | "SOFT_DIST"
  | "SOFT_COVERAGE"
  | "SOFT_GENERATED"
  | "SOFT_MINIFIED"
  | "SOFT_SOURCE_MAP"
  | "SOFT_LOCKFILE"
  | "SYMLINK"
  | "SUBMODULE"
  | "EXECUTABLE_NOT_ALLOWED"
  | "ARCHIVE"
  | "BINARY_EXTENSION"
  | "BINARY_CONTENT"
  | "INVALID_UTF8"
  | "GIT_LFS_POINTER";

export type GitHubCodeScanExclusion = Readonly<{
  normalizedPath: string;
  reason: GitHubCodeExclusionReason;
  blobOid: string | null;
  declaredBytes: number | null;
}>;

export type GitHubCodeSecurityFinding = Readonly<{
  normalizedPath: string;
  categories: readonly ("EMAIL_ADDRESS" | "CN_MOBILE" | "CN_ID_NUMBER")[];
}>;

export type ScannedGitHubCodeFile = Readonly<{
  normalizedPath: string;
  mode: "100644";
  blobOid: string;
  contentText: string;
  contentHash: string;
  contentBytes: number;
  lineCount: number;
}>;

export type GitHubCodeScanResult = Readonly<{
  contractVersion: typeof GITHUB_CODE_SCANNER_VERSION;
  scannerFingerprint: typeof GITHUB_CODE_SCANNER_FINGERPRINT;
  scanScopeFingerprint: string;
  repository: Readonly<{
    repositoryId: number;
    nodeId: string;
    capturedFullName: string;
    owner: string;
    name: string;
  }>;
  trackedRef: string;
  frozenCommitSha: string;
  rootTreeSha: string;
  requestCount: number;
  visitedTreeEntryCount: number;
  discoveredFileCount: number;
  decodedTextBytes: number;
  files: readonly ScannedGitHubCodeFile[];
  exclusions: readonly GitHubCodeScanExclusion[];
  securityFindings: readonly GitHubCodeSecurityFinding[];
  modelTransferScanResult: "passed" | "blocked";
  manifestFingerprint: string;
}>;

export type ScanGitHubRepositoryCodeOptions = Readonly<{
  client: GitHubReadOnlyClient;
  owner: string;
  repository: string;
  expectedRepositoryId: number;
  expectedNodeId: string;
  trackedRef: string;
  includeRoots: readonly string[];
  softExcludePatterns: readonly GitHubSoftExcludeClass[];
  scanScopeFingerprint: string;
  now?: () => number;
}>;

type TreeWork = Readonly<{ treeSha: string; prefix: string; depth: number }>;
type BlobCandidate = Readonly<{
  normalizedPath: string;
  mode: "100644";
  blobOid: string;
  declaredBytes: number;
}>;

function fail(code: GitHubCodeScanErrorCode): never {
  throw new GitHubCodeScanError(code);
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
    return fail("GITHUB_SCAN_INVALID_INPUT");
  }
  return value;
}

function safePath(value: unknown): string {
  const path = safeText(value, 1_024);
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    path.includes("\\") ||
    path.includes("%") ||
    segments.length > GITHUB_CODE_SCAN_BUDGETS.maximumDirectoryDepth ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return fail("GITHUB_SCAN_INVALID_INPUT");
  }
  return path;
}

function safeTreeSegment(value: unknown): string {
  const segment = safePath(value);
  if (segment.includes("/")) return fail("GITHUB_SCAN_TREE_INTEGRITY_ERROR");
  return segment;
}

function validateOptions(options: ScanGitHubRepositoryCodeOptions): Readonly<{
  owner: string;
  repository: string;
  expectedRepositoryId: number;
  expectedNodeId: string;
  trackedRef: string;
  includeRoots: readonly string[];
  softExcludePatterns: ReadonlySet<GitHubSoftExcludeClass>;
  scanScopeFingerprint: string;
}> {
  if (
    typeof options !== "object" ||
    options === null ||
    options.client?.version !== GITHUB_READ_ONLY_CLIENT_VERSION ||
    typeof options.client.getRepository !== "function" ||
    typeof options.client.getReference !== "function" ||
    typeof options.client.getCommit !== "function" ||
    typeof options.client.getTree !== "function" ||
    typeof options.client.getBlob !== "function" ||
    !Number.isSafeInteger(options.expectedRepositoryId) ||
    options.expectedRepositoryId < 1 ||
    !FINGERPRINT_PATTERN.test(options.scanScopeFingerprint) ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    return fail("GITHUB_SCAN_INVALID_INPUT");
  }
  const includeRoots = Array.isArray(options.includeRoots)
    ? options.includeRoots.map(safePath).sort()
    : fail("GITHUB_SCAN_INVALID_INPUT");
  if (
    includeRoots.length < 1 ||
    includeRoots.length > GITHUB_CODE_SCAN_BUDGETS.maximumIncludeRoots ||
    new Set(includeRoots).size !== includeRoots.length
  ) {
    return fail("GITHUB_SCAN_INVALID_INPUT");
  }
  for (let index = 0; index < includeRoots.length; index += 1) {
    for (let other = index + 1; other < includeRoots.length; other += 1) {
      if (includeRoots[other]!.startsWith(`${includeRoots[index]!}/`)) {
        return fail("GITHUB_SCAN_INVALID_INPUT");
      }
    }
  }
  if (!Array.isArray(options.softExcludePatterns)) {
    return fail("GITHUB_SCAN_INVALID_INPUT");
  }
  const softExcludes = options.softExcludePatterns.map((value) => {
    if (!GITHUB_SOFT_EXCLUDE_CLASSES.includes(value)) {
      return fail("GITHUB_SCAN_INVALID_INPUT");
    }
    return value;
  });
  if (
    Object.keys(options.softExcludePatterns).length !== softExcludes.length ||
    new Set(softExcludes).size !== softExcludes.length
  ) {
    return fail("GITHUB_SCAN_INVALID_INPUT");
  }
  return Object.freeze({
    owner: safeText(options.owner, 256),
    repository: safeText(options.repository, 256),
    expectedRepositoryId: options.expectedRepositoryId,
    expectedNodeId: safeText(options.expectedNodeId, 512),
    trackedRef: safeText(options.trackedRef, 255),
    includeRoots: Object.freeze(includeRoots),
    softExcludePatterns: new Set(softExcludes),
    scanScopeFingerprint: options.scanScopeFingerprint,
  });
}

function scopeRelation(path: string, includeRoots: readonly string[]): Readonly<{
  included: boolean;
  traversable: boolean;
  explicitOrAncestor: boolean;
}> {
  let included = false;
  let traversable = false;
  let explicitOrAncestor = false;
  for (const root of includeRoots) {
    if (path === root || path.startsWith(`${root}/`)) {
      included = true;
      traversable = true;
    }
    if (root.startsWith(`${path}/`)) {
      traversable = true;
      explicitOrAncestor = true;
    }
    if (path === root) explicitOrAncestor = true;
  }
  return Object.freeze({ included, traversable, explicitOrAncestor });
}

function hardPathReason(path: string): GitHubCodeExclusionReason | null {
  const segments = path.split("/");
  const name = segments[segments.length - 1]!.toLowerCase();
  if (segments.some((segment) => /^\.env(?:\..+)?$/i.test(segment))) {
    return "HARD_ENV_FILE";
  }
  if (
    /\.(?:cer|crt|der|jks|key|keystore|p12|pfx|pem)$/i.test(name) ||
    /^(?:id_(?:dsa|ecdsa|ed25519|rsa))(?:\.pub)?$/i.test(name)
  ) {
    return "HARD_PRIVATE_KEY_FILE";
  }
  if (
    HARD_CREDENTIAL_FILE_NAMES.has(name) ||
    /^(?:credentials|service[-_]?account)(?:\.[a-z0-9_-]+)?\.json$/i.test(name)
  ) {
    return "HARD_CREDENTIAL_FILE";
  }
  return null;
}

function softPathReason(
  path: string,
  enabled: ReadonlySet<GitHubSoftExcludeClass>,
): GitHubCodeExclusionReason | null {
  const segments = path.toLowerCase().split("/");
  const name = segments[segments.length - 1]!;
  if (enabled.has("vendor") && segments.includes("vendor")) return "SOFT_VENDOR";
  if (enabled.has("node_modules") && segments.includes("node_modules")) {
    return "SOFT_NODE_MODULES";
  }
  if (enabled.has("build") && segments.some((segment) => [".next", "build", "out", "target"].includes(segment))) {
    return "SOFT_BUILD";
  }
  if (enabled.has("dist") && segments.includes("dist")) return "SOFT_DIST";
  if (enabled.has("coverage") && segments.includes("coverage")) return "SOFT_COVERAGE";
  if (enabled.has("generated") && segments.some((segment) => ["gen", "generated"].includes(segment))) {
    return "SOFT_GENERATED";
  }
  if (enabled.has("minified") && MINIFIED_PATTERN.test(name)) return "SOFT_MINIFIED";
  if (enabled.has("source_map") && SOURCE_MAP_PATTERN.test(name)) return "SOFT_SOURCE_MAP";
  if (enabled.has("lockfile") && LOCKFILE_NAMES.has(name)) return "SOFT_LOCKFILE";
  return null;
}

function exclusion(
  normalizedPath: string,
  reason: GitHubCodeExclusionReason,
  entry?: Pick<VerifiedGitHubTreeEntry, "sha" | "size">,
): GitHubCodeScanExclusion {
  return Object.freeze({
    normalizedPath,
    reason,
    blobOid: entry?.sha ?? null,
    declaredBytes: entry?.size ?? null,
  });
}

function entryShapeValid(entry: VerifiedGitHubTreeEntry): boolean {
  if (entry.type === "tree") return entry.mode === "040000" && entry.size === null;
  if (entry.type === "commit") return entry.mode === "160000";
  if (entry.type === "blob") {
    return ["100644", "100755", "120000"].includes(entry.mode) &&
      Number.isSafeInteger(entry.size) &&
      (entry.size as number) >= 0;
  }
  return false;
}

function strictBase64(value: string): Uint8Array {
  const normalized = value.replace(/\r?\n/g, "");
  if (
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)
  ) {
    return fail("GITHUB_SCAN_BLOB_INTEGRITY_ERROR");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.toString("base64") !== normalized) {
    return fail("GITHUB_SCAN_BLOB_INTEGRITY_ERROR");
  }
  return bytes;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

function hasOversizedLine(text: string): boolean {
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text.charCodeAt(index) === 10) {
      const line = text.slice(start, index);
      if (Buffer.byteLength(line, "utf8") > GITHUB_CODE_SCAN_BUDGETS.maximumLineBytes) {
        return true;
      }
      start = index + 1;
    }
  }
  return false;
}

function secretCategory(text: string): string | null {
  for (const scanner of SECRET_PATTERNS) {
    if (scanner.pattern.test(text)) return scanner.category;
  }
  return null;
}

function piiCategories(
  text: string,
): readonly ("EMAIL_ADDRESS" | "CN_MOBILE" | "CN_ID_NUMBER")[] {
  const categories: ("EMAIL_ADDRESS" | "CN_MOBILE" | "CN_ID_NUMBER")[] = [];
  for (const scanner of PII_PATTERNS) {
    if (scanner.pattern.test(text)) categories.push(scanner.category);
  }
  return Object.freeze(categories);
}

function resultManifestFingerprint(input: Readonly<{
  scanScopeFingerprint: string;
  repositoryId: number;
  nodeId: string;
  capturedFullName: string;
  trackedRef: string;
  frozenCommitSha: string;
  rootTreeSha: string;
  files: readonly ScannedGitHubCodeFile[];
  exclusions: readonly GitHubCodeScanExclusion[];
  securityFindings: readonly GitHubCodeSecurityFinding[];
}>): string {
  return sha256(JSON.stringify({
    contractVersion: GITHUB_CODE_SCANNER_VERSION,
    scannerFingerprint: GITHUB_CODE_SCANNER_FINGERPRINT,
    scanScopeFingerprint: input.scanScopeFingerprint,
    repositoryId: input.repositoryId,
    nodeId: input.nodeId,
    capturedFullName: input.capturedFullName,
    trackedRef: input.trackedRef,
    frozenCommitSha: input.frozenCommitSha,
    rootTreeSha: input.rootTreeSha,
    files: input.files.map((file) => ({
      normalizedPath: file.normalizedPath,
      mode: file.mode,
      blobOid: file.blobOid,
      contentHash: file.contentHash,
      contentBytes: file.contentBytes,
      lineCount: file.lineCount,
    })),
    exclusions: input.exclusions,
    securityFindings: input.securityFindings,
    budgets: GITHUB_CODE_SCAN_BUDGETS,
  }));
}

export async function scanGitHubRepositoryCode(
  options: ScanGitHubRepositoryCodeOptions,
): Promise<GitHubCodeScanResult> {
  const input = validateOptions(options);
  const now = options.now ?? Date.now;
  let lastTime = now();
  if (!Number.isFinite(lastTime)) return fail("GITHUB_SCAN_SCANNER_UNAVAILABLE");
  const startedAt = lastTime;
  let requestCount = 0;
  let visitedTreeEntryCount = 0;

  const assertTime = (): void => {
    const value = now();
    if (
      !Number.isFinite(value) ||
      value < lastTime ||
      value - startedAt > GITHUB_CODE_SCAN_BUDGETS.maximumWallTimeMs
    ) {
      return fail("GITHUB_SCAN_BUDGET_EXCEEDED");
    }
    lastTime = value;
  };
  const request = async <T>(action: () => Promise<T>): Promise<T> => {
    assertTime();
    requestCount += 1;
    if (requestCount > GITHUB_CODE_SCAN_BUDGETS.maximumRequests) {
      return fail("GITHUB_SCAN_BUDGET_EXCEEDED");
    }
    const value = await action();
    assertTime();
    return value;
  };

  const repository = await request(() => options.client.getRepository({
    owner: input.owner,
    repository: input.repository,
  }));
  if (
    repository.repositoryId !== input.expectedRepositoryId ||
    repository.nodeId !== input.expectedNodeId ||
    repository.owner.toLowerCase() !== input.owner.toLowerCase() ||
    repository.name.toLowerCase() !== input.repository.toLowerCase()
  ) {
    return fail("GITHUB_SCAN_IDENTITY_MISMATCH");
  }
  const reference = await request(() => options.client.getReference({
    owner: input.owner,
    repository: input.repository,
    trackedRef: input.trackedRef,
  }));
  const commit = await request(() => options.client.getCommit({
    owner: input.owner,
    repository: input.repository,
    commitSha: reference.commitSha,
  }));
  if (!SHA_PATTERN.test(reference.commitSha) || !SHA_PATTERN.test(commit.treeSha)) {
    return fail("GITHUB_SCAN_TREE_INTEGRITY_ERROR");
  }

  const queue: TreeWork[] = [{ treeSha: commit.treeSha, prefix: "", depth: 0 }];
  const candidates: BlobCandidate[] = [];
  const exclusions: GitHubCodeScanExclusion[] = [];
  const matchedRoots = new Set<string>();
  const seenPaths = new Set<string>();

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const work = queue[cursor]!;
    const tree = await request(() => options.client.getTree({
      owner: input.owner,
      repository: input.repository,
      treeSha: work.treeSha,
    }));
    if (tree.truncated) return fail("GITHUB_SCAN_TREE_TRUNCATED");
    if (tree.treeSha !== work.treeSha) return fail("GITHUB_SCAN_TREE_INTEGRITY_ERROR");
    const entries = [...tree.entries].sort((left, right) => left.path.localeCompare(right.path));
    const treeSegments = new Set<string>();
    for (const entry of entries) {
      assertTime();
      const segment = safeTreeSegment(entry.path);
      if (treeSegments.has(segment) || !entryShapeValid(entry)) {
        return fail("GITHUB_SCAN_TREE_INTEGRITY_ERROR");
      }
      treeSegments.add(segment);
      const path = safePath(work.prefix.length === 0 ? segment : `${work.prefix}/${segment}`);
      if (seenPaths.has(path)) return fail("GITHUB_SCAN_TREE_INTEGRITY_ERROR");
      seenPaths.add(path);
      visitedTreeEntryCount += 1;
      if (visitedTreeEntryCount > GITHUB_CODE_SCAN_BUDGETS.maximumVisitedTreeEntries) {
        return fail("GITHUB_SCAN_BUDGET_EXCEEDED");
      }
      const relation = scopeRelation(path, input.includeRoots);
      if (!relation.traversable && !relation.included) continue;
      for (const root of input.includeRoots) {
        if (root === path) matchedRoots.add(root);
      }
      const hardReason = hardPathReason(path);
      const softReason = softPathReason(path, input.softExcludePatterns);
      if (hardReason !== null || softReason !== null) {
        if (relation.explicitOrAncestor) return fail("GITHUB_SCAN_SCOPE_EXCLUDED");
        exclusions.push(exclusion(path, hardReason ?? softReason!, entry));
        continue;
      }
      if (entry.type === "tree") {
        if (!relation.traversable) continue;
        const depth = work.depth + 1;
        if (depth > GITHUB_CODE_SCAN_BUDGETS.maximumDirectoryDepth) {
          return fail("GITHUB_SCAN_BUDGET_EXCEEDED");
        }
        queue.push(Object.freeze({ treeSha: entry.sha, prefix: path, depth }));
        continue;
      }
      if (!relation.included) continue;
      if (entry.type === "commit" || entry.mode === "160000") {
        exclusions.push(exclusion(path, "SUBMODULE", entry));
        continue;
      }
      if (entry.mode === "120000") {
        exclusions.push(exclusion(path, "SYMLINK", entry));
        continue;
      }
      if (entry.mode === "100755") {
        exclusions.push(exclusion(path, "EXECUTABLE_NOT_ALLOWED", entry));
        continue;
      }
      if (entry.type !== "blob" || entry.mode !== "100644" || entry.size === null) {
        return fail("GITHUB_SCAN_TREE_INTEGRITY_ERROR");
      }
      if (ARCHIVE_EXTENSION_PATTERN.test(path)) {
        exclusions.push(exclusion(path, "ARCHIVE", entry));
        continue;
      }
      if (BINARY_EXTENSION_PATTERN.test(path)) {
        exclusions.push(exclusion(path, "BINARY_EXTENSION", entry));
        continue;
      }
      if (entry.size > GITHUB_CODE_SCAN_BUDGETS.maximumFileBytes) {
        return fail("GITHUB_SCAN_BUDGET_EXCEEDED");
      }
      candidates.push(Object.freeze({
        normalizedPath: path,
        mode: "100644" as const,
        blobOid: entry.sha,
        declaredBytes: entry.size,
      }));
      if (candidates.length > GITHUB_CODE_SCAN_BUDGETS.maximumIncludedFiles) {
        return fail("GITHUB_SCAN_BUDGET_EXCEEDED");
      }
    }
  }

  if (matchedRoots.size !== input.includeRoots.length) {
    return fail("GITHUB_SCAN_SCOPE_NOT_FOUND");
  }
  candidates.sort((left, right) => left.normalizedPath.localeCompare(right.normalizedPath));
  const declaredBytes = candidates.reduce((total, candidate) => total + candidate.declaredBytes, 0);
  if (
    declaredBytes > GITHUB_CODE_SCAN_BUDGETS.maximumDecodedTextBytes ||
    requestCount + candidates.length > GITHUB_CODE_SCAN_BUDGETS.maximumRequests
  ) {
    return fail("GITHUB_SCAN_BUDGET_EXCEEDED");
  }

  const files: ScannedGitHubCodeFile[] = [];
  const securityFindings: GitHubCodeSecurityFinding[] = [];
  let decodedTextBytes = 0;
  for (const candidate of candidates) {
    const blob = await request(() => options.client.getBlob({
      owner: input.owner,
      repository: input.repository,
      blobSha: candidate.blobOid,
    }));
    if (blob.blobSha !== candidate.blobOid || blob.size !== candidate.declaredBytes) {
      return fail("GITHUB_SCAN_BLOB_INTEGRITY_ERROR");
    }
    const bytes = strictBase64(blob.content);
    if (bytes.byteLength !== blob.size || bytes.byteLength > GITHUB_CODE_SCAN_BUDGETS.maximumFileBytes) {
      return fail("GITHUB_SCAN_BLOB_INTEGRITY_ERROR");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      exclusions.push(exclusion(candidate.normalizedPath, "INVALID_UTF8", {
        sha: candidate.blobOid,
        size: candidate.declaredBytes,
      }));
      continue;
    }
    if (text.startsWith("version https://git-lfs.github.com/spec/v1\n")) {
      exclusions.push(exclusion(candidate.normalizedPath, "GIT_LFS_POINTER", {
        sha: candidate.blobOid,
        size: candidate.declaredBytes,
      }));
      continue;
    }
    if (UNSAFE_CONTENT_CONTROL_PATTERN.test(text)) {
      exclusions.push(exclusion(candidate.normalizedPath, "BINARY_CONTENT", {
        sha: candidate.blobOid,
        size: candidate.declaredBytes,
      }));
      continue;
    }
    if (BIDI_CONTROL_PATTERN.test(text) || hasOversizedLine(text)) {
      return fail("GITHUB_SCAN_UNSAFE_CONTENT");
    }
    try {
      if (secretCategory(text) !== null) return fail("GITHUB_SCAN_SECRET_DETECTED");
    } catch (error) {
      if (error instanceof GitHubCodeScanError) throw error;
      return fail("GITHUB_SCAN_SCANNER_UNAVAILABLE");
    }
    const findings = piiCategories(text);
    if (findings.length > 0) {
      securityFindings.push(Object.freeze({
        normalizedPath: candidate.normalizedPath,
        categories: findings,
      }));
    }
    decodedTextBytes += bytes.byteLength;
    if (decodedTextBytes > GITHUB_CODE_SCAN_BUDGETS.maximumDecodedTextBytes) {
      return fail("GITHUB_SCAN_BUDGET_EXCEEDED");
    }
    files.push(Object.freeze({
      normalizedPath: candidate.normalizedPath,
      mode: candidate.mode,
      blobOid: candidate.blobOid,
      contentText: text,
      contentHash: sha256(bytes),
      contentBytes: bytes.byteLength,
      lineCount: lineCount(text),
    }));
  }

  exclusions.sort((left, right) =>
    left.normalizedPath.localeCompare(right.normalizedPath) || left.reason.localeCompare(right.reason));
  securityFindings.sort((left, right) => left.normalizedPath.localeCompare(right.normalizedPath));
  const frozenFiles = Object.freeze(files);
  const frozenExclusions = Object.freeze(exclusions);
  const frozenFindings = Object.freeze(securityFindings);
  const manifestFingerprint = resultManifestFingerprint({
    scanScopeFingerprint: input.scanScopeFingerprint,
    repositoryId: repository.repositoryId,
    nodeId: repository.nodeId,
    capturedFullName: repository.fullName,
    trackedRef: input.trackedRef,
    frozenCommitSha: reference.commitSha,
    rootTreeSha: commit.treeSha,
    files: frozenFiles,
    exclusions: frozenExclusions,
    securityFindings: frozenFindings,
  });
  return Object.freeze({
    contractVersion: GITHUB_CODE_SCANNER_VERSION,
    scannerFingerprint: GITHUB_CODE_SCANNER_FINGERPRINT,
    scanScopeFingerprint: input.scanScopeFingerprint,
    repository: Object.freeze({
      repositoryId: repository.repositoryId,
      nodeId: repository.nodeId,
      capturedFullName: repository.fullName,
      owner: repository.owner,
      name: repository.name,
    }),
    trackedRef: input.trackedRef,
    frozenCommitSha: reference.commitSha,
    rootTreeSha: commit.treeSha,
    requestCount,
    visitedTreeEntryCount,
    discoveredFileCount: candidates.length,
    decodedTextBytes,
    files: frozenFiles,
    exclusions: frozenExclusions,
    securityFindings: frozenFindings,
    modelTransferScanResult: frozenFindings.length === 0 ? "passed" : "blocked",
    manifestFingerprint,
  });
}
