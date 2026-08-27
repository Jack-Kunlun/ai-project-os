import assert from "node:assert/strict";
import test from "node:test";
import {
  REPOSITORY_CODE_CHUNKER_VERSION,
  chunkRepositoryCode,
} from "@/lib/github/code-chunking";

test("repository code chunking preserves exact one-based line ranges", () => {
  const source = [
    "export function alpha() {\n",
    "  return 1;\n",
    "}\n",
    "\n",
    "export function beta() {\n",
    "  return 2;\n",
    "}\n",
  ].join("");
  const chunks = chunkRepositoryCode(source);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], {
    ordinal: 0,
    rangeStart: 1,
    rangeEnd: 8,
    contentText: source,
    contentHash: "bcd2dd2caa8fa22a75f0e5434cbd2d3cf203290e14ac285f63240a68b4686878",
    contentBytes: Buffer.byteLength(source),
    chunkerVersion: REPOSITORY_CODE_CHUNKER_VERSION,
  });
});

test("repository code chunking is deterministic and favors declaration boundaries", () => {
  const firstBlock = "export const first = 1;\n".repeat(180);
  const secondBlock = "\nexport function boundary() {\n  return true;\n}\n";
  const source = `${firstBlock}${secondBlock}${"const tail = 2;\n".repeat(180)}`;
  const first = chunkRepositoryCode(source);
  const second = chunkRepositoryCode(source);
  assert.deepEqual(first, second);
  assert.ok(first.length > 1);
  assert.equal(first.every((chunk, index) => chunk.ordinal === index), true);
  assert.equal(first.every((chunk) => chunk.rangeStart >= 1 && chunk.rangeEnd > chunk.rangeStart), true);
  assert.equal(first.every((chunk) => chunk.contentHash.length === 64), true);
});

test("repository code chunking rejects empty, unsafe and oversized inputs", () => {
  assert.throws(() => chunkRepositoryCode(""), /REPOSITORY_CODE_CHUNK_INVALID_TEXT/);
  assert.throws(() => chunkRepositoryCode("const x = '\u0000';\n"), /REPOSITORY_CODE_CHUNK_INVALID_TEXT/);
  assert.throws(
    () => chunkRepositoryCode("x".repeat(262_145)),
    /REPOSITORY_CODE_CHUNK_INVALID_TEXT/,
  );
  assert.throws(
    () => chunkRepositoryCode(`${"x".repeat(8_193)}\n`),
    /REPOSITORY_CODE_CHUNK_INVALID_TEXT/,
  );
});
