import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_EXTRACT_SOURCE_CHUNK_CHARACTERS,
  AUTO_EXTRACT_SOURCE_CHUNK_OVERLAP_CHARACTERS,
  splitAutoExtractSourceText,
} from "../src/lib/auto-extract-source-chunks";

function assertBoundedCoverage(sourceText: string) {
  const chunks = splitAutoExtractSourceText(sourceText);
  assert.ok(chunks.length > 0);

  let coveredUntil = 0;
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= AUTO_EXTRACT_SOURCE_CHUNK_CHARACTERS);
    assert.equal(chunk.text, sourceText.slice(chunk.start, chunk.end));
    assert.ok(chunk.start <= coveredUntil);
    assert.ok(chunk.end > coveredUntil);
    assert.equal(sourceText.charCodeAt(chunk.start) >= 0xdc00 && sourceText.charCodeAt(chunk.start) <= 0xdfff, false);
    assert.equal(chunk.end < sourceText.length && sourceText.charCodeAt(chunk.end - 1) >= 0xd800 && sourceText.charCodeAt(chunk.end - 1) <= 0xdbff, false);
    coveredUntil = chunk.end;
  }

  assert.equal(coveredUntil, sourceText.length);
  return chunks;
}

test("100k source is fully covered by at most three bounded overlapping chunks", () => {
  const sourceText = `${"a".repeat(46_000)}\n\n${"b".repeat(46_000)}\n\n${"c".repeat(7_996)}`;
  const chunks = assertBoundedCoverage(sourceText);

  assert.equal(sourceText.length, 100_000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.end, 46_002);
  for (let index = 1; index < chunks.length; index += 1) {
    const previous = chunks[index - 1]!;
    const current = chunks[index]!;
    assert.ok(current.start < previous.end);
    assert.ok(previous.end - current.start <= AUTO_EXTRACT_SOURCE_CHUNK_OVERLAP_CHARACTERS);
  }
});

test("chunk ranges keep surrogate pairs intact and preserve every source character", () => {
  const sourceText = `${"a".repeat(49_999)}😀${"b".repeat(49_999)}`;
  const chunks = assertBoundedCoverage(sourceText);

  assert.equal(sourceText.length, 100_000);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0]!.end < 50_000);
  assert.ok(chunks[1]!.start < 50_000);
});

test("short source text stays in one exact range", () => {
  const sourceText = "第一段。\n\n第二段。";
  assert.deepEqual(splitAutoExtractSourceText(sourceText), [{ start: 0, end: sourceText.length, text: sourceText }]);
});
