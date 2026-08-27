import { createHash } from "node:crypto";

export const LOCAL_SOURCE_SCANNER_VERSION = "local-source-scan-v1" as const;
export const LOCAL_SOURCE_SCANNER_FINGERPRINT = createHash("sha256")
  .update(
    [
      LOCAL_SOURCE_SCANNER_VERSION,
      "openai-key",
      "github-token",
      "github-fine-grained-token",
      "aws-access-key",
      "private-key",
      "credential-assignment",
      "credential-url",
    ].join("\u0000"),
    "utf8",
  )
  .digest("hex");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSAFE_CONTROL_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const MAX_SOURCE_COUNT = 100;
const MAX_SOURCE_BYTES = 100_000;

const SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9._-]{17,509}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:api[_-]?key|password|client[_-]?secret|access[_-]?token)\s*[:=]\s*["']?(?!(?:process\.env|os\.environ|config\.|settings\.|getenv|env\(|\$\{|<|example|placeholder|redacted|changeme|not[-_]?set)\b)[A-Za-z0-9+/_=.-]{8,}["']?/i,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
]);

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function exactSourceFields(
  value: unknown,
): value is Readonly<{ sourceId: string; content: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== "content,sourceId") return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable &&
        typeof descriptor.value === "string";
    });
  } catch {
    return false;
  }
}

export type LocalSourceScanResult = Readonly<{
  scannerVersion: typeof LOCAL_SOURCE_SCANNER_VERSION;
  scannerFingerprint: typeof LOCAL_SOURCE_SCANNER_FINGERPRINT;
  result: "passed" | "blocked";
}>;

export function scanLocalSourcesForModelTransfer(
  sources: readonly Readonly<{ sourceId: string; content: string }>[],
): LocalSourceScanResult {
  let valid = Array.isArray(sources) &&
    sources.length > 0 &&
    sources.length <= MAX_SOURCE_COUNT;
  const seen = new Set<string>();
  let blocked = false;
  try {
    for (const source of sources) {
      if (
        !exactSourceFields(source) ||
        !UUID_PATTERN.test(source.sourceId) ||
        seen.has(source.sourceId) ||
        source.content.normalize("NFC") !== source.content ||
        hasUnpairedSurrogate(source.content) ||
        Buffer.byteLength(source.content, "utf8") > MAX_SOURCE_BYTES ||
        UNSAFE_CONTROL_PATTERN.test(source.content)
      ) {
        valid = false;
        break;
      }
      seen.add(source.sourceId);
      if (SECRET_PATTERNS.some((pattern) => pattern.test(source.content))) {
        blocked = true;
      }
    }
  } catch {
    valid = false;
  }
  return Object.freeze({
    scannerVersion: LOCAL_SOURCE_SCANNER_VERSION,
    scannerFingerprint: LOCAL_SOURCE_SCANNER_FINGERPRINT,
    result: valid && !blocked ? "passed" : "blocked",
  });
}
