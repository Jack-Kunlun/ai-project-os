import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import test from "node:test";

const SOURCE_EXTENSIONS = new Set([".css", ".ts", ".tsx"]);
const EXPLICIT_PIXEL = /(?<!\d)(\d+)px/gu;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

test("UI source uses even explicit pixel values above three", async () => {
  const violations: string[] = [];
  for (const file of await sourceFiles("src")) {
    const content = await readFile(file, "utf8");
    for (const match of content.matchAll(EXPLICIT_PIXEL)) {
      const pixels = Number(match[1]);
      if (pixels <= 3 || pixels % 2 === 0) continue;
      const line = content.slice(0, match.index).split("\n").length;
      violations.push(`${file}:${line}:${pixels}px`);
    }
  }
  assert.deepEqual(violations, []);
});
