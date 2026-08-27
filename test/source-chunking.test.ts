import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_CHUNKER_VERSION,
  SOURCE_CHUNK_MAX_INPUT_BYTES,
  SOURCE_CHUNK_MAX_BYTES,
  chunkSourceText,
} from "@/lib/ai-memory";

function exactByteSlice(source: string, start: number, end: number): string {
  return Buffer.from(source, "utf8").subarray(start, end).toString("utf8");
}

test("deterministic chunker preserves exact UTF-8 evidence ranges", () => {
  const source = "  前缀：项目里程碑已完成。\n下一步进行证据审核。  ";
  const chunks = chunkSourceText(source);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.ordinal, 0);
  assert.equal(chunks[0]?.chunkerVersion, SOURCE_CHUNKER_VERSION);
  assert.equal(chunks[0]?.contentText, "前缀：项目里程碑已完成。\n下一步进行证据审核。");
  assert.equal(
    exactByteSlice(source, chunks[0]!.rangeStart, chunks[0]!.rangeEnd),
    chunks[0]?.contentText,
  );
  assert.equal(chunks[0]?.contentBytes, Buffer.byteLength(chunks[0]!.contentText, "utf8"));
  assert.match(chunks[0]?.contentHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(chunks), true);
  assert.equal(Object.isFrozen(chunks[0]), true);
});

test("long CJK content uses bounded overlapping deterministic chunks", () => {
  const paragraph = "里程碑完成后进入证据审核，并记录负责人、风险与下一步。";
  const source = Array.from({ length: 120 }, (_, index) => `${index}:${paragraph}`).join("\n");
  const first = chunkSourceText(source);
  const second = chunkSourceText(source);

  assert.deepEqual(first, second);
  assert.ok(first.length > 2);
  for (const [index, chunk] of first.entries()) {
    assert.equal(chunk.ordinal, index);
    assert.ok(chunk.contentBytes <= SOURCE_CHUNK_MAX_BYTES);
    assert.equal(exactByteSlice(source, chunk.rangeStart, chunk.rangeEnd), chunk.contentText);
    if (index > 0) {
      assert.ok(chunk.rangeStart < first[index - 1]!.rangeEnd);
      assert.ok(chunk.rangeStart > first[index - 1]!.rangeStart);
    }
  }
});

test("chunker omits whitespace-only windows and rejects unsafe text", () => {
  const chunks = chunkSourceText(`${" ".repeat(3_000)}有效证据${"\n".repeat(3_000)}`);
  assert.equal(chunks.some((chunk) => chunk.contentText.trim().length === 0), false);
  assert.equal(chunks.some((chunk) => chunk.contentText.includes("有效证据")), true);

  for (const invalid of [
    "",
    "   \n",
    "unsafe\u0001control",
    "unpaired\ud800",
    "x".repeat(SOURCE_CHUNK_MAX_INPUT_BYTES + 1),
  ]) {
    assert.throws(() => chunkSourceText(invalid), /SOURCE_CHUNK_INVALID_TEXT/);
  }
});
