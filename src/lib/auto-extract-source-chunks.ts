export const AUTO_EXTRACT_SOURCE_CHUNK_CHARACTERS = 50_000;
export const AUTO_EXTRACT_SOURCE_CHUNK_OVERLAP_CHARACTERS = 1_200;

export type AutoExtractSourceChunk = Readonly<{
  start: number;
  end: number;
  text: string;
}>;

function isHighSurrogate(value: string | undefined): boolean {
  return value !== undefined && value.charCodeAt(0) >= 0xd800 && value.charCodeAt(0) <= 0xdbff;
}

function isLowSurrogate(value: string | undefined): boolean {
  return value !== undefined && value.charCodeAt(0) >= 0xdc00 && value.charCodeAt(0) <= 0xdfff;
}

/**
 * Split server-owned source text into bounded, overlapping ranges. Boundaries
 * prefer nearby paragraph and line breaks while guaranteeing enough forward
 * progress for the supported 100k source size to fit in at most three chunks.
 */
export function splitAutoExtractSourceText(sourceText: string): ReadonlyArray<AutoExtractSourceChunk> {
  if (sourceText.length === 0) return Object.freeze([]);

  const chunks: AutoExtractSourceChunk[] = [];
  const minPreferredEnd = AUTO_EXTRACT_SOURCE_CHUNK_CHARACTERS - 5_000;
  let start = 0;

  while (start < sourceText.length) {
    let end = Math.min(sourceText.length, start + AUTO_EXTRACT_SOURCE_CHUNK_CHARACTERS);
    if (end < sourceText.length) {
      const preferredParagraphEnd = sourceText.lastIndexOf("\n\n", end) + 2;
      const preferredLineEnd = sourceText.lastIndexOf("\n", end) + 1;
      const preferredEnd = [preferredParagraphEnd, preferredLineEnd].find((candidate) =>
        candidate >= start + minPreferredEnd && candidate < end,
      );
      if (preferredEnd !== undefined) end = preferredEnd;
    }

    if (isHighSurrogate(sourceText[end - 1])) end -= 1;
    if (end <= start) throw new RangeError("AUTO_EXTRACT_SOURCE_CHUNK_INVALID_BOUNDARY");

    chunks.push(Object.freeze({ start, end, text: sourceText.slice(start, end) }));
    if (end >= sourceText.length) break;

    let nextStart = Math.max(start + 1, end - AUTO_EXTRACT_SOURCE_CHUNK_OVERLAP_CHARACTERS);
    if (isLowSurrogate(sourceText[nextStart])) nextStart += 1;
    start = nextStart;
  }

  return Object.freeze(chunks);
}
