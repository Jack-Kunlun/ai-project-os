import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { listPagination } from "../src/lib/list-pagination";

test("list pagination reports stable bounds including an empty result", () => {
  assert.deepEqual(listPagination(1, 20, 0), { page: 1, pageSize: 20, total: 0, totalPages: 1 });
  assert.deepEqual(listPagination(3, 20, 45), { page: 3, pageSize: 20, total: 45, totalPages: 3 });
});

test("high-growth project lists use server pagination with search and filters", async () => {
  const files = await Promise.all([
    readFile("src/app/api/projects/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/sources/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/items/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/assets/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/web-sources/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/actions/route.ts", "utf8"),
  ]);

  for (const source of files) {
    assert.match(source, /pageSize/u);
    assert.match(source, /search/u);
    assert.match(source, /pagination/u);
  }

  const [projects, materials, assets, webSources, actions, governance, reviewQueue] = await Promise.all([
    readFile("src/app/projects/projects-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/assets/project-assets-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/external-sources/project-external-sources-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/actions/project-actions-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/governance/project-governance-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-material-review-queue.tsx", "utf8"),
  ]);
  for (const client of [projects, materials, assets, webSources, actions]) {
    assert.match(client, /ListPagination/u);
    assert.match(client, /placeholder="搜索/u);
  }
  assert.match(governance, /CursorPagination/u);
  assert.match(governance, /搜索任务记录/u);
  assert.match(governance, /搜索模型路由变更/u);
  assert.match(reviewQueue, /CursorPagination/u);
  assert.match(reviewQueue, /搜索待审核候选/u);
});

test("destructive and approval flows use the shared app dialog instead of browser dialogs", async () => {
  const paths = [
    "src/app/settings/settings-client.tsx",
    "src/app/connections/connections-client.tsx",
    "src/app/connections/mcp/mcp-connections-client.tsx",
    "src/app/projects/[projectId]/project-client.tsx",
    "src/app/projects/[projectId]/assets/project-assets-client.tsx",
    "src/app/projects/[projectId]/tools/project-tools-client.tsx",
    "src/app/projects/[projectId]/actions/project-actions-client.tsx",
    "src/app/team/team-client.tsx",
  ];
  const sources = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  for (const source of sources) {
    assert.doesNotMatch(source, /window\.(?:prompt|confirm)/u);
    assert.match(source, /useAppConfirmDialog/u);
  }
  const dialog = await readFile("src/components/app-confirm-dialog.tsx", "utf8");
  assert.match(dialog, /role="dialog"/u);
  assert.match(dialog, /aria-modal="true"/u);
  assert.match(dialog, /requiredValue/u);
});
