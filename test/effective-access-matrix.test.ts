import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  highestProjectPermission,
  projectRolePermission,
  workspaceRolePermission,
} from "../src/lib/access-control";
import {
  AccountAccessServiceError,
  groupAccessMatrixMembershipRows,
  type AccessMatrixMembershipRow,
} from "../src/lib/account-access-service";

test("matrix membership grouping keeps one current row and the newest revoked evidence", () => {
  const base = new Date("2026-09-15T00:00:00.000Z");
  const rows: Array<AccessMatrixMembershipRow & { scope: string }> = [
    { id: "revoked-old", scope: "workspace-a", role: "owner", accessState: "revoked", createdAt: base, updatedAt: new Date(base.getTime() + 1) },
    { id: "revoked-new", scope: "workspace-a", role: "owner", accessState: "revoked", createdAt: base, updatedAt: new Date(base.getTime() + 2) },
    { id: "current", scope: "workspace-a", role: "owner", accessState: "confirmed", createdAt: base, updatedAt: new Date(base.getTime() + 3) },
  ];
  const grouped = groupAccessMatrixMembershipRows(rows, (row) => row.scope);
  assert.equal(grouped.current.get("workspace-a")?.id, "current");
  assert.equal(grouped.latestRevoked.get("workspace-a")?.id, "revoked-new");

  assert.throws(
    () => groupAccessMatrixMembershipRows([
      ...rows,
      { id: "current-pending", scope: "workspace-a", role: "owner", accessState: "pending", createdAt: base, updatedAt: base },
    ], (row) => row.scope),
    (error: unknown) => error instanceof AccountAccessServiceError && error.code === "ACCOUNT_ACCESS_CONFLICT",
  );
});

test("effective project permission uses the same role projection as runtime access control", () => {
  assert.equal(projectRolePermission("owner"), "owner");
  assert.equal(projectRolePermission("editor"), "edit");
  assert.equal(projectRolePermission("viewer"), "view");
  assert.equal(workspaceRolePermission("owner"), "owner");
  assert.equal(workspaceRolePermission("admin"), "owner");
  assert.equal(workspaceRolePermission("member"), null);
  assert.equal(workspaceRolePermission("viewer"), null);

  assert.equal(highestProjectPermission("view", "edit"), "edit");
  assert.equal(highestProjectPermission("edit", "owner"), "owner");
  assert.equal(highestProjectPermission("owner", "owner"), "owner");
  assert.equal(highestProjectPermission(null, "view"), "view");
  assert.equal(highestProjectPermission(null, null), null);
});

test("ADM-008 matrix is a read-only, bounded detail surface", async () => {
  const [service, route, client] = await Promise.all([
    readFile("src/lib/account-access-service.ts", "utf8"),
    readFile("src/app/api/system/account-access/[userId]/route.ts", "utf8"),
    readFile("src/app/system/account-access/account-access-client.tsx", "utf8"),
  ]);

  assert.match(service, /export async function getEffectiveAccessMatrix/u);
  assert.match(service, /Serializable/u);
  assert.match(service, /take: input\.pageSize \+ 1/u);
  assert.match(service, /nextCursor/u);
  assert.match(service, /createHmac\("sha256"/u);
  assert.match(service, /timingSafeEqual/u);
  assert.match(service, /loadOrCreateMasterKey/u);
  assert.match(service, /ACCESS_MATRIX_CURSOR_CONTEXT/u);
  assert.match(service, /supplied\.toString\("base64url"\) !== signature/u);
  assert.match(service, /subjectId[\s\S]*kind[\s\S]*pageSize/iu);
  assert.match(service, /groupAccessMatrixMembershipRows/u);
  assert.match(service, /row_number\(\) OVER/u);
  assert.match(service, /candidateRank[\s\S]*<= 2/u);
  assert.match(service, /candidateRank[\s\S]*= 1/u);
  assert.match(service, /db\.\$queryRaw/u);
  assert.match(service, /IN \(\$\{scopes\}\)/u);
  assert.match(service, /\$\{subjectId\}::uuid/u);
  const membershipLoaders = service.slice(
    service.indexOf("async function workspaceMembershipRows"),
    service.indexOf("async function getEffectiveAccessMatrixInTransaction"),
  );
  assert.doesNotMatch(membershipLoaders, /db\.workspaceMembership\.findMany/u);
  assert.doesNotMatch(membershipLoaders, /db\.projectMembership\.findMany/u);
  assert.doesNotMatch(service, /Promise\.all\(workspaceRows\.map/u);
  assert.doesNotMatch(service, /Promise\.all\(projectRows\.map/u);
  assert.doesNotMatch(service, /Promise\.all\(projectWorkspaceIds\.map/u);
  assert.doesNotMatch(service, /latestRevokedWorkspaceMembership/u);
  assert.doesNotMatch(service, /latestRevokedProjectMembership/u);
  assert.match(service, /direct_project_assignment/u);
  assert.match(service, /workspace_inherited_owner_or_admin/u);
  assert.match(service, /membership_access_audit/u);
  assert.match(route, /export async function GET/u);
  assert.match(route, /const noStoreHeaders = \{[\s\S]*cache-control.*no-store/u);
  assert.match(route, /handleNoStoreApiError/u);
  assert.doesNotMatch(route, /return handleApiError\(error\)/u);
  assert.match(route, /allow: "PATCH"[\s\S]*noStoreHeaders|noStoreHeaders[\s\S]*allow: "PATCH"/u);
  assert.match(route, /workspaceCursor/u);
  assert.match(route, /projectCursor/u);
  assert.match(client, /查看有效访问矩阵/u);
  assert.match(client, /查看下一页工作区/u);
  assert.match(client, /查看下一页项目/u);
  assert.match(client, /setMatrix\(next\)/u);
  assert.match(client, /setMatrix\(null\)/u);
  assert.doesNotMatch(client, /mergeMatrixItems/u);
  assert.doesNotMatch(client, /disabledReason/u);
  assert.doesNotMatch(client, /passwordHash/u);
  assert.doesNotMatch(client, /tokenHash/u);
});
