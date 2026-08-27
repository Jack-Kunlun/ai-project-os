import { createHash } from "node:crypto";

export const REPOSITORY_CODE_CHUNKER_VERSION = "code-lines-identifiers:v1" as const;
export const REPOSITORY_CODE_CHUNK_TARGET_BYTES = 7_200;
export const REPOSITORY_CODE_CHUNK_MAX_BYTES = 8_192;
export const REPOSITORY_CODE_CHUNK_MAX_LINES = 160;
export const REPOSITORY_CODE_CHUNK_OVERLAP_LINES = 8;
export const REPOSITORY_CODE_CHUNK_MAX_INPUT_BYTES = 262_144;

const MAX_CHUNK_COUNT = 20_000;
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const DECLARATION_PATTERN = /^\s*(?:export\s+)?(?:async\s+)?(?:class|interface|type|enum|function|const|let|var|namespace|module|def|async\s+def|fn|struct|trait|impl|package|func)\b/u;

export type DeterministicRepositoryCodeChunk = Readonly<{
  ordinal: number;
  rangeStart: number;
  rangeEnd: number;
  contentText: string;
  contentHash: string;
  contentBytes: number;
  chunkerVersion: typeof REPOSITORY_CODE_CHUNKER_VERSION;
}>;

function fail(): never {
  throw new Error("REPOSITORY_CODE_CHUNK_INVALID_TEXT");
}

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

function preservedLines(value: string): readonly string[] {
  const lines = value.match(/[^\n]*\n|[^\n]+$/gu);
  if (lines === null || lines.length === 0 || lines.join("") !== value) return fail();
  return Object.freeze(lines);
}

function preferredEnd(lines: readonly string[], start: number, maximumEnd: number): number {
  if (maximumEnd >= lines.length) return lines.length;
  const minimumCandidate = Math.max(start + 1, maximumEnd - 32);
  for (let candidate = maximumEnd; candidate > minimumCandidate; candidate -= 1) {
    const previous = lines[candidate - 1]!.replace(/\r?\n$/u, "");
    const next = lines[candidate] ?? "";
    if (previous.trim().length === 0 || DECLARATION_PATTERN.test(next)) {
      return candidate;
    }
  }
  return maximumEnd;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function chunkRepositoryCode(
  value: string,
): readonly DeterministicRepositoryCodeChunk[] {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > REPOSITORY_CODE_CHUNK_MAX_INPUT_BYTES ||
    UNSAFE_CONTROL_PATTERN.test(value) ||
    hasUnpairedSurrogate(value)
  ) {
    return fail();
  }

  const lines = preservedLines(value);
  const chunks: DeterministicRepositoryCodeChunk[] = [];
  let start = 0;

  while (start < lines.length) {
    let maximumEnd = start;
    let bytes = 0;
    while (maximumEnd < lines.length && maximumEnd - start < REPOSITORY_CODE_CHUNK_MAX_LINES) {
      const nextBytes = Buffer.byteLength(lines[maximumEnd]!, "utf8");
      if (nextBytes > REPOSITORY_CODE_CHUNK_MAX_BYTES) return fail();
      if (maximumEnd > start && bytes + nextBytes > REPOSITORY_CODE_CHUNK_TARGET_BYTES) break;
      bytes += nextBytes;
      maximumEnd += 1;
    }
    if (maximumEnd === start) return fail();

    const end = preferredEnd(lines, start, maximumEnd);
    const contentText = lines.slice(start, end).join("");
    const contentBytes = Buffer.byteLength(contentText, "utf8");
    if (contentBytes <= 0 || contentBytes > REPOSITORY_CODE_CHUNK_MAX_BYTES) return fail();
    chunks.push(Object.freeze({
      ordinal: chunks.length,
      rangeStart: start + 1,
      rangeEnd: end + 1,
      contentText,
      contentHash: sha256(contentText),
      contentBytes,
      chunkerVersion: REPOSITORY_CODE_CHUNKER_VERSION,
    }));
    if (chunks.length > MAX_CHUNK_COUNT) return fail();
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - REPOSITORY_CODE_CHUNK_OVERLAP_LINES);
  }

  return Object.freeze(chunks);
}
