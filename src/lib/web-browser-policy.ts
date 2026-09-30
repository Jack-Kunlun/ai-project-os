import { isIP } from "node:net";

export const WEB_BROWSER_PROXY_ERROR_CODES = [
  "WEB_BROWSER_INVALID_TARGET",
  "WEB_BROWSER_PROXY_AUTH_REQUIRED",
  "WEB_BROWSER_TARGET_REJECTED",
  "WEB_BROWSER_DNS_REJECTED",
  "WEB_BROWSER_METHOD_REJECTED",
  "WEB_BROWSER_REDIRECT_REJECTED",
  "WEB_BROWSER_RESOURCE_LIMIT",
  "WEB_BROWSER_UPSTREAM_FAILED",
  "WEB_BROWSER_RENDER_FAILED",
  "WEB_BROWSER_ISOLATION_UNAVAILABLE",
] as const;

export type WebBrowserProxyErrorCode = (typeof WEB_BROWSER_PROXY_ERROR_CODES)[number];

export class WebBrowserProxyError extends Error {
  constructor(readonly code: WebBrowserProxyErrorCode) {
    super(code);
    this.name = "WebBrowserProxyError";
  }
}

export type WebBrowserTarget = Readonly<{
  url: string;
  origin: string;
  hostname: string;
}>;

export function normalizeWebBrowserTarget(value: unknown): WebBrowserTarget {
  if (typeof value !== "string" || value.length < 8 || value.length > 2048 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WebBrowserProxyError("WEB_BROWSER_INVALID_TARGET");
  }

  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new WebBrowserProxyError("WEB_BROWSER_INVALID_TARGET");
  }

  if (
    target.protocol !== "https:" ||
    target.username.length > 0 ||
    target.password.length > 0 ||
    target.hostname.length === 0 ||
    target.port === "0"
  ) {
    throw new WebBrowserProxyError("WEB_BROWSER_INVALID_TARGET");
  }

  target.hash = "";
  return Object.freeze({ url: target.toString(), origin: target.origin, hostname: target.hostname.toLowerCase() });
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((value, part) => (value * 256) + part, 0);
}

function inIpv4Range(address: number, base: string, prefix: number): boolean {
  const baseNumber = ipv4Number(base);
  if (baseNumber === null) return false;
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(address / blockSize) === Math.floor(baseNumber / blockSize);
}

function parseIpv6(address: string): readonly number[] | null {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase().split("%")[0]!;

  const dottedTail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (dottedTail !== undefined) {
    const v4 = ipv4Number(dottedTail);
    if (v4 === null) return null;
    const high = Math.floor(v4 / 65_536).toString(16);
    const low = (v4 % 65_536).toString(16);
    normalized = normalized.slice(0, normalized.length - dottedTail.length) + high + ":" + low;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const zeroCount = halves.length === 1 ? 0 : 8 - left.length - right.length;
  if ((halves.length === 1 && left.length !== 8) || zeroCount < 0 || (halves.length === 2 && zeroCount < 1)) return null;

  const segments = [...left, ...Array.from({ length: zeroCount }, () => "0"), ...right];
  if (segments.length !== 8 || segments.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return null;
  return segments.map((part) => Number.parseInt(part, 16));
}

function inIpv6Range(address: readonly number[], base: string, prefix: number): boolean {
  const baseSegments = parseIpv6(base);
  if (baseSegments === null) return false;
  const fullSegments = Math.floor(prefix / 16);
  if (address.some((segment, index) => index < fullSegments && segment !== baseSegments[index])) return false;
  const remainingBits = prefix % 16;
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return ((address[fullSegments] ?? 0) & mask) === ((baseSegments[fullSegments] ?? 0) & mask);
}

/**
 * Return true only for globally routable unicast addresses. The allow list is
 * deliberately conservative: reserved, documentation, transition, multicast,
 * private, link-local, loopback, and unspecified ranges fail closed.
 */
export function isPublicWebBrowserAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (value === null) return false;
    const blockedRanges: ReadonlyArray<readonly [string, number]> = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !blockedRanges.some(([base, prefix]) => inIpv4Range(value, base, prefix));
  }

  if (family !== 6) return false;
  const value = parseIpv6(address);
  if (value === null) return false;

  // IPv6 global unicast is allocated from 2000::/3. Exclude special-purpose,
  // documentation, and transition ranges within that allocation.
  return inIpv6Range(value, "2000::", 3) &&
    !inIpv6Range(value, "2001::", 23) &&
    !inIpv6Range(value, "2002::", 16) &&
    !inIpv6Range(value, "2001:db8::", 32) &&
    !inIpv6Range(value, "3fff::", 20);
}

export function assertWebBrowserExactOrigin(value: string, expectedOrigin: string): URL {
  let candidate: URL;
  try {
    candidate = new URL(value, expectedOrigin);
  } catch {
    throw new WebBrowserProxyError("WEB_BROWSER_TARGET_REJECTED");
  }

  if (candidate.protocol !== "https:" || candidate.origin !== expectedOrigin || candidate.username || candidate.password) {
    throw new WebBrowserProxyError("WEB_BROWSER_TARGET_REJECTED");
  }
  return candidate;
}
