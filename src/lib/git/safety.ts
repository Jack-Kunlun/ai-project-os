import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { GitProviderKind, GitTransport } from "@prisma/client";

const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
const INCLUDE_ROOT_PATTERN = /^(?:\.|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/;

export type GitSafetyErrorCode =
  | "GIT_BASE_URL_INVALID"
  | "GIT_REPOSITORY_PATH_INVALID"
  | "GIT_REF_INVALID"
  | "GIT_SCAN_SCOPE_INVALID"
  | "GIT_HOST_UNRESOLVED"
  | "GIT_NETWORK_BLOCKED"
  | "GIT_NETWORK_CHANGED"
  | "GIT_TLS_CA_INVALID"
  | "GIT_SSH_KNOWN_HOST_INVALID";

export class GitSafetyError extends Error {
  constructor(readonly code: GitSafetyErrorCode) {
    super(code);
    this.name = "GitSafetyError";
  }
}

export type GitEndpointResolution = Readonly<{ addresses: readonly string[]; fingerprint: string }>;

function fail(code: GitSafetyErrorCode): never {
  throw new GitSafetyError(code);
}

function ipv4Parts(address: string): readonly number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isMetadataAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (normalized === "169.254.169.254" || normalized === "fd00:ec2::254") return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  return mapped === "169.254.169.254";
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (mapped !== undefined) return isPrivateAddress(mapped);
  const parts = ipv4Parts(normalized);
  if (parts !== null) {
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a! >= 224;
  }
  if (isIP(normalized) !== 6) return true;
  return normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized);
}

export function canonicalGitBaseUrl(value: unknown, transport: GitTransport): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 1024 || value.trim() !== value || CONTROL_PATTERN.test(value)) {
    return fail("GIT_BASE_URL_INVALID");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("GIT_BASE_URL_INVALID");
  }
  const expectedProtocol = transport === "https" ? "https:" : "ssh:";
  if (
    url.protocol !== expectedProtocol ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !HOST_PATTERN.test(url.hostname) && isIP(url.hostname) === 0
  ) {
    return fail("GIT_BASE_URL_INVALID");
  }
  if (transport === "https" && url.username.length > 0) return fail("GIT_BASE_URL_INVALID");
  if (transport === "ssh" && url.username.length > 0 && !/^[A-Za-z0-9._-]{1,64}$/u.test(url.username)) {
    return fail("GIT_BASE_URL_INVALID");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    const segments = url.pathname.replace(/^\/+|\/+$/gu, "").split("/");
    if (segments.some((segment) => !REPOSITORY_SEGMENT_PATTERN.test(segment))) return fail("GIT_BASE_URL_INVALID");
  }
  url.pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export function canonicalRepositoryPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 768 || value.trim() !== value || CONTROL_PATTERN.test(value)) {
    return fail("GIT_REPOSITORY_PATH_INVALID");
  }
  const normalized = value.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  const segments = normalized.split("/");
  if (segments.length < 1 || segments.length > 12 || segments.some((segment) => !REPOSITORY_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..")) {
    return fail("GIT_REPOSITORY_PATH_INVALID");
  }
  return normalized;
}

export function canonicalTrackedRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.trim() !== value ||
    CONTROL_PATTERN.test(value) ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    /[ ~^:?*\[\\]/u.test(value)
  ) {
    return fail("GIT_REF_INVALID");
  }
  return value;
}

export function canonicalIncludeRoots(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return fail("GIT_SCAN_SCOPE_INVALID");
  const roots = [...new Set(value.map((entry) => {
    if (typeof entry !== "string" || !INCLUDE_ROOT_PATTERN.test(entry) || entry.includes("..")) {
      return fail("GIT_SCAN_SCOPE_INVALID");
    }
    return entry.replace(/^\.\//u, "").replace(/\/$/u, "") || ".";
  }))].sort();
  return Object.freeze(roots);
}

export function canonicalExcludePatterns(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) return fail("GIT_SCAN_SCOPE_INVALID");
  const patterns = [...new Set(value.map((entry) => {
    if (
      typeof entry !== "string" || entry.length < 1 || entry.length > 256 || entry.trim() !== entry ||
      CONTROL_PATTERN.test(entry) || entry.startsWith("/") || entry.includes("..") || !/^[A-Za-z0-9._*?/-]+$/u.test(entry)
    ) return fail("GIT_SCAN_SCOPE_INVALID");
    return entry;
  }))].sort();
  return Object.freeze(patterns);
}

export function canonicalTlsCaCertificate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 32_768 || CONTROL_PATTERN.test(value.replace(/\n/gu, ""))) {
    return fail("GIT_TLS_CA_INVALID");
  }
  const normalized = value.replace(/\r\n/gu, "\n").trim();
  if (!/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----$/u.test(normalized)) {
    return fail("GIT_TLS_CA_INVALID");
  }
  return `${normalized}\n`;
}

export function canonicalSshKnownHost(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || value.trim() !== value || value.includes("\n") || CONTROL_PATTERN.test(value)) {
    return fail("GIT_SSH_KNOWN_HOST_INVALID");
  }
  if (!/^(?:\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+|\[[^\]]+\]:\d{1,5}|[^\s,]+)(?:,[^\s]+)*\s+(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/u.test(value)) {
    return fail("GIT_SSH_KNOWN_HOST_INVALID");
  }
  return value;
}

export async function resolveGitEndpoint(input: Readonly<{
  baseUrl: string;
  allowPrivateNetwork: boolean;
}>): Promise<GitEndpointResolution> {
  const url = new URL(input.baseUrl);
  let rows: readonly { address: string }[];
  try {
    rows = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    return fail("GIT_HOST_UNRESOLVED");
  }
  const addresses = [...new Set(rows.map((row) => row.address.toLowerCase()))].sort();
  if (addresses.length === 0) return fail("GIT_HOST_UNRESOLVED");
  if (addresses.some(isMetadataAddress)) return fail("GIT_NETWORK_BLOCKED");
  if (!input.allowPrivateNetwork && addresses.some(isPrivateAddress)) return fail("GIT_NETWORK_BLOCKED");
  const fingerprint = createHash("sha256")
    .update(`${url.hostname.toLowerCase()}:${url.port || (url.protocol === "ssh:" ? "22" : "443")}:${addresses.join(",")}`, "utf8")
    .digest("hex");
  return Object.freeze({ addresses: Object.freeze(addresses), fingerprint });
}

export async function assertPinnedGitEndpoint(input: Readonly<{
  baseUrl: string;
  allowPrivateNetwork: boolean;
  expectedFingerprint: string | null;
}>): Promise<GitEndpointResolution> {
  const resolved = await resolveGitEndpoint(input);
  if (input.expectedFingerprint !== null && resolved.fingerprint !== input.expectedFingerprint) {
    return fail("GIT_NETWORK_CHANGED");
  }
  return resolved;
}

export function providerDefaultBaseUrl(provider: GitProviderKind, transport: GitTransport): string {
  const host = provider === "github" ? "github.com" : provider === "gitee" ? "gitee.com" : "gitlab.com";
  return transport === "https" ? `https://${host}` : `ssh://git@${host}`;
}
