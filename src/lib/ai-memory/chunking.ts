import { createHash } from "node:crypto";

export const SOURCE_CHUNKER_VERSION = "unicode-text:v1" as const;
export const SOURCE_CHUNK_MAX_BYTES = 2_400;
export const SOURCE_CHUNK_OVERLAP_BYTES = 240;
export const SOURCE_CHUNK_MAX_INPUT_BYTES = 400_000;

const MIN_PREFERRED_BOUNDARY_BYTES = Math.floor(SOURCE_CHUNK_MAX_BYTES * 0.6);
const MAX_CHUNK_COUNT = 10_000;
const UNSAFE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

type TextUnit = {
  value: string;
  codeUnitStart: number;
  codeUnitEnd: number;
  byteStart: number;
  byteEnd: number;
};

export type DeterministicSourceChunk = Readonly<{
  ordinal: number;
  rangeStart: number;
  rangeEnd: number;
  contentText: string;
  contentHash: string;
  contentBytes: number;
  chunkerVersion: typeof SOURCE_CHUNKER_VERSION;
}>;

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

function toUnits(value: string): readonly TextUnit[] {
  const units: TextUnit[] = [];
  let codeUnitOffset = 0;
  let byteOffset = 0;

  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, "utf8");
    units.push({
      value: codePoint,
      codeUnitStart: codeUnitOffset,
      codeUnitEnd: codeUnitOffset + codePoint.length,
      byteStart: byteOffset,
      byteEnd: byteOffset + bytes,
    });
    codeUnitOffset += codePoint.length;
    byteOffset += bytes;
  }

  return units;
}

function boundaryPriority(units: readonly TextUnit[], endExclusive: number): number {
  const previous = units[endExclusive - 1]?.value ?? "";
  const beforePrevious = units[endExclusive - 2]?.value ?? "";
  if (previous === "\n" && beforePrevious === "\n") return 4;
  if (/[。！？!?；;.!]/u.test(previous)) return 3;
  if (previous === "\n" || previous === "\r") return 2;
  if (/\s/u.test(previous)) return 1;
  return 0;
}

function chooseEnd(
  units: readonly TextUnit[],
  start: number,
  maximumEnd: number,
): number {
  if (maximumEnd >= units.length) return units.length;

  const startByte = units[start]!.byteStart;
  let selected = maximumEnd;
  let selectedPriority = 0;
  for (let candidate = start + 1; candidate <= maximumEnd; candidate += 1) {
    const bytes = units[candidate - 1]!.byteEnd - startByte;
    if (bytes < MIN_PREFERRED_BOUNDARY_BYTES) continue;
    const priority = boundaryPriority(units, candidate);
    if (priority > selectedPriority || (priority === selectedPriority && priority > 0)) {
      selected = candidate;
      selectedPriority = priority;
    }
  }
  return selected;
}

function trimWindow(
  units: readonly TextUnit[],
  start: number,
  end: number,
): { start: number; end: number } | null {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/u.test(units[trimmedStart]!.value)) {
    trimmedStart += 1;
  }
  while (trimmedEnd > trimmedStart && /\s/u.test(units[trimmedEnd - 1]!.value)) {
    trimmedEnd -= 1;
  }
  return trimmedStart === trimmedEnd
    ? null
    : { start: trimmedStart, end: trimmedEnd };
}

function nextStart(
  units: readonly TextUnit[],
  currentStart: number,
  currentEnd: number,
): number {
  const desiredByte = Math.max(
    units[currentStart]!.byteStart + 1,
    units[currentEnd - 1]!.byteEnd - SOURCE_CHUNK_OVERLAP_BYTES,
  );
  let next = currentStart + 1;
  while (next < currentEnd && units[next]!.byteStart < desiredByte) {
    next += 1;
  }
  return Math.min(next, currentEnd);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function chunkSourceText(value: string): readonly DeterministicSourceChunk[] {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > SOURCE_CHUNK_MAX_INPUT_BYTES ||
    UNSAFE_CONTROL_PATTERN.test(value) ||
    hasUnpairedSurrogate(value)
  ) {
    throw new Error("SOURCE_CHUNK_INVALID_TEXT");
  }

  const units = toUnits(value);
  const chunks: DeterministicSourceChunk[] = [];
  let start = 0;

  while (start < units.length) {
    let maximumEnd = start;
    const startByte = units[start]!.byteStart;
    while (
      maximumEnd < units.length &&
      units[maximumEnd]!.byteEnd - startByte <= SOURCE_CHUNK_MAX_BYTES
    ) {
      maximumEnd += 1;
    }
    if (maximumEnd === start) {
      throw new Error("SOURCE_CHUNK_BOUNDARY_FAILED");
    }

    const end = chooseEnd(units, start, maximumEnd);
    const trimmed = trimWindow(units, start, end);
    if (trimmed !== null) {
      const first = units[trimmed.start]!;
      const last = units[trimmed.end - 1]!;
      const contentText = value.slice(first.codeUnitStart, last.codeUnitEnd);
      const contentBytes = last.byteEnd - first.byteStart;
      chunks.push(Object.freeze({
        ordinal: chunks.length,
        rangeStart: first.byteStart,
        rangeEnd: last.byteEnd,
        contentText,
        contentHash: sha256(contentText),
        contentBytes,
        chunkerVersion: SOURCE_CHUNKER_VERSION,
      }));
      if (chunks.length > MAX_CHUNK_COUNT) {
        throw new Error("SOURCE_CHUNK_COUNT_EXCEEDED");
      }
    }

    if (end >= units.length) break;
    start = nextStart(units, start, end);
  }

  if (chunks.length === 0) {
    throw new Error("SOURCE_CHUNK_INVALID_TEXT");
  }
  return Object.freeze(chunks);
}
