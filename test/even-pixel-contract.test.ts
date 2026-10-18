import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import test from "node:test";

const SOURCE_EXTENSIONS = new Set([".css", ".ts", ".tsx"]);
const EXPLICIT_PIXEL = /(?<!\d)(\d+)px/gu;

// v1.1.0 follows the approved prototype, including its 11/13/25px type scale
// and compact spacing. Keep the preceding grid rule for existing surfaces;
// do not round the confirmed design merely to satisfy the old style contract.
const APPROVED_PROTOTYPE_STYLES = new Set([
  "src/app/admin/admin-workspace.module.css",
  "src/app/ask/ask-client.module.css",
  "src/app/dashboard/dashboard-client.module.css",
  "src/app/login/login.module.css",
  "src/app/personal/knowledge/graph/knowledge-graph.module.css",
  "src/app/personal/knowledge/personal-knowledge.module.css",
  "src/app/projects/[projectId]/automations/project-automations-client.module.css",
  "src/app/projects/[projectId]/governance/project-management.module.css",
  "src/app/projects/[projectId]/intelligence/project-intelligence-client.module.css",
  "src/app/projects/[projectId]/plan/project-plan-client.module.css",
  "src/app/projects/[projectId]/project-materials.module.css",
  "src/app/projects/[projectId]/project-overview-client.module.css",
  "src/app/projects/[projectId]/project-support.module.css",
  "src/app/projects/projects-client.module.css",
  "src/app/support-pages.module.css",
  "src/components/user-shell.module.css",
  "src/components/workspace-ui.module.css",
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

test("legacy UI keeps its even pixel grid outside the approved v1.1.0 prototype styles", async () => {
  const violations: string[] = [];
  for (const file of await sourceFiles("src")) {
    if (APPROVED_PROTOTYPE_STYLES.has(file)) continue;
    const original = await readFile(file, "utf8");
    const content = file === "src/app/globals.css"
      ? original.replace(/\/\* Match user operation surfaces to the compact workspace design\. \*\/[\s\S]*?(?=\/\* Tables use)/u, "")
      : original;
    for (const match of content.matchAll(EXPLICIT_PIXEL)) {
      const pixels = Number(match[1]);
      if (pixels <= 3 || pixels % 2 === 0) continue;
      const line = content.slice(0, match.index).split("\n").length;
      violations.push(`${file}:${line}:${pixels}px`);
    }
  }
  assert.deepEqual(violations, []);
});
