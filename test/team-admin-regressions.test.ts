import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workspace invitations retain legacy callers and expose a bounded authorized cursor page", async () => {
  const [service, route, client] = await Promise.all([
    readFile("src/lib/workspaces.ts", "utf8"),
    readFile("src/app/api/workspaces/[workspaceId]/invitations/route.ts", "utf8"),
    readFile("src/app/team/team-client.tsx", "utf8"),
  ]);

  assert.match(service, /export async function listWorkspaceInvitations\([\s\S]*?listWorkspaceInvitationPage\(workspaceIdInput, actor, null, db\)\)\.invitations/u);
  assert.match(service, /export async function listWorkspaceInvitationPage\([\s\S]*?await assertWorkspaceAdmin\(actor, workspaceId, tx\)/u);
  assert.match(service, /orderBy: \[\{ createdAt: "desc" \}, \{ id: "desc" \}\],[\s\S]*?take: 101/u);
  assert.match(service, /createdAt: \{ lt: cursor\.createdAt \}[\s\S]*?id: \{ lt: cursor\.id \}/u);
  assert.match(route, /listWorkspaceInvitationPage\(workspaceId, actor, cursor\)/u);
  assert.match(client, /invitationLoadingRef\.current/u);
  assert.match(client, /const invitationReadVersionRef = useRef\(0\)/u);
  assert.match(client, /if \(invitationLoadingRef\.current && !force\) return false/u);
  assert.match(client, /if \(requestVersion !== invitationReadVersionRef\.current\) return false/u);
  assert.match(client, /loadInvitationPage\(null, \{ force: true, resetHistory: true \}\)/u);
  assert.match(client, /pageNumber=\{invitationHistory\.length \+ 1\}/u);
  assert.match(client, /setInvitationHistory\(\(items\) => \[\.\.\.items, previousCursor\]\)/u);
});

test("team page projections commit independently and expose projection-specific retries", async () => {
  const source = await readFile("src/app/team/team-client.tsx", "utf8");
  assert.match(source, /const permissionsTask = \(async \(\) => \{[\s\S]*?setPermissions\(nextPermissions\)[\s\S]*?setPermissionsError/u);
  assert.match(source, /const activityTask = \(async \(\) => \{[\s\S]*?setActivity\(nextActivity\)[\s\S]*?setActivityError/u);
  assert.match(source, /await Promise\.all\(\[overviewTask, permissionsTask, activityTask\]\)/u);
  assert.match(source, /activityError && view !== "activity" \? <TeamRetryNotice title="团队活动加载失败" message=\{activityError\} onRetry=\{\(\) => void reload\(\)\} \/>/u);
  assert.match(source, /viewError \? <TeamRetryNotice title=\{view === "permissions" \? "团队权限加载失败" : view === "activity" \? "团队活动加载失败"/u);
});

test("backup snapshots use latest-request sequencing across manual and timed refreshes", async () => {
  const source = await readFile("src/app/system/operations/system-operations-client.tsx", "utf8");
  assert.match(source, /const refreshVersionRef = useRef\(0\)/u);
  assert.match(source, /const requestVersion = \+\+refreshVersionRef\.current/u);
  assert.match(source, /if \(requestVersion !== refreshVersionRef\.current\) return/u);
  assert.match(source, /if \(requestVersion === refreshVersionRef\.current\) setRefreshing\(false\)/u);
});

test("failure inbox paging takes a synchronous lock before recording page history", async () => {
  const source = await readFile("src/app/admin/operations/failures/failure-inbox-client.tsx", "utf8");
  assert.match(source, /const pageTransitionLock = useRef\(false\)/u);
  assert.match(source, /function goNext\(\) \{\s*if \(pageTransitionLock\.current \|\| loading\) return;[\s\S]*?pageTransitionLock\.current = true;[\s\S]*?setHistory/u);
  assert.match(source, /function goPrevious\(\) \{\s*if \(pageTransitionLock\.current \|\| loading\) return;[\s\S]*?pageTransitionLock\.current = true/u);
});

test("admin list failures never render a confirmed-empty state", async () => {
  const [memberships, credits, providers] = await Promise.all([
    readFile("src/app/system/memberships/memberships-client.tsx", "utf8"),
    readFile("src/app/admin/models/platform-credit-governance-client.tsx", "utf8"),
    readFile("src/app/settings/settings-client.tsx", "utf8"),
  ]);
  assert.match(memberships, /: error \? <div[\s\S]*?items\.length === 0/u);
  assert.match(credits, /!loading && !loadError && users\.length === 0/u);
  assert.match(credits, /!loading && !loadError && grants\.length === 0/u);
  assert.match(providers, /: error \? <div[\s\S]*?providers\.length === 0/u);
});
