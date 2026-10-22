import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("page return links use the shared named parent control without browser history", () => {
  const parentLink = source("src/components/parent-page-link.tsx");
  const backButton = source("src/components/back-button.tsx");
  assert.match(parentLink, /className=\{PARENT_PAGE_LINK_CLASS_NAME\}/u);
  assert.match(parentLink, /<ShellIcon name="back"/u);
  assert.match(backButton, /<Link href=\{fallbackHref\}/u);
  assert.doesNotMatch(backButton, /history\.back|router\.back/u);

  const routeFiles = [
    "src/app/projects/[projectId]/plan/project-plan-client.tsx",
    "src/app/projects/[projectId]/intelligence/project-intelligence-client.tsx",
    "src/app/projects/[projectId]/governance/project-governance-client.tsx",
    "src/app/projects/[projectId]/project-client.tsx",
    "src/app/projects/[projectId]/project-material-review-queue.tsx",
    "src/app/projects/[projectId]/repositories/project-repositories-client.tsx",
    "src/app/projects/[projectId]/github-syncs/[syncRunId]/page.tsx",
    "src/app/projects/[projectId]/jobs/[jobId]/project-job-detail-client.tsx",
  ];
  for (const path of routeFiles) {
    const page = source(path);
    assert.match(page, /ParentPageLink/u, path);
    assert.doesNotMatch(page, /←/u, path);
  }

  const jobs = source("src/app/projects/[projectId]/jobs/[jobId]/project-job-detail-client.tsx");
  assert.match(jobs, /const safeReturnTo = navigation\.returnTo/u);
  assert.match(jobs, /ParentPageLink href=\{backHref\}/u);
  const sync = source("src/app/projects/[projectId]/github-syncs/[syncRunId]/page.tsx");
  assert.match(sync, /const backHref = fromNotifications \? "\/notifications"/u);
  assert.match(sync, /ParentPageLink href=\{backHref\}/u);

  const mcpReview = source("src/app/admin/connectors/mcp/mcp-review-workbench.tsx");
  assert.match(mcpReview, /className=\{PARENT_PAGE_LINK_CLASS_NAME\}/u);
  assert.match(mcpReview, /setSelectedId\(""\); window\.scrollTo\(0, 0\)/u);
});

test("personal knowledge uses only its controlled in-app detail entry for history restoration", () => {
  const knowledge = source("src/app/personal/knowledge/knowledge-client.tsx");
  assert.match(knowledge, /detailHistoryEntryRef\.current = true;[\s\S]*?router\.push\(/u);
  assert.match(knowledge, /if \(detailHistoryEntryRef\.current\) \{[\s\S]*?router\.back\(\)/u);
  assert.match(knowledge, /Only list-row selection creates this controlled same-route history entry/u);
  assert.doesNotMatch(knowledge, /history\.back\(/u);
});

test("modal and drawer headers use accessible icon-only close buttons", () => {
  const dialogFiles = [
    "src/app/profile/connections/connection-create-dialog.tsx",
    "src/app/projects/[projectId]/project-material-intake.tsx",
    "src/app/personal/knowledge/knowledge-client.tsx",
    "src/app/personal/knowledge/personal-knowledge-editor.tsx",
    "src/app/settings/settings-client.tsx",
    "src/app/admin/sms/sms-provider-admin-client.tsx",
  ];
  for (const path of dialogFiles) {
    const page = source(path);
    assert.match(page, /app-icon-button[\s\S]*?<ShellIcon name="close" className="app-icon--control"/u, path);
  }
  assert.doesNotMatch(source("src/app/admin/sms/sms-provider-admin-client.tsx"), /✕/u);
});

test("shared workspace content keeps the project-plan width and narrow-screen margins", () => {
  const sharedPage = source("src/components/workspace-ui.module.css");
  assert.match(sharedPage, /padding:var\(--app-page-padding\)/u);
  const tokens = source("src/app/globals.css");
  assert.match(tokens, /--app-page-padding: 28px 32px 32px/u);
  assert.match(tokens, /--app-page-padding: 23px 18px 32px/u);
});
