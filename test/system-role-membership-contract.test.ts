import assert from "node:assert/strict";
import test from "node:test";
import type { AppUserRole } from "@prisma/client";
import { toSystemRole } from "../src/lib/system-role";
import {
  ACCOUNT_STATES,
  COMMERCIAL_TIERS,
  CURRENT_STORED_ROLE_BY_SYSTEM_ROLE,
  CURRENT_STORED_ROLES,
  LEGACY_STORED_ROLE_BY_SYSTEM_ROLE,
  LEGACY_STORED_ROLES,
  MEMBERSHIP_STATES,
  PROJECT_ROLES,
  REQUIRED_SCENARIO_IDS,
  ROLE_MATRIX_SCENARIOS,
  STABLE_ERROR_CODES,
  STABLE_ERROR_CODE_SET,
  SYSTEM_ROLES,
  SYSTEM_ROLE_BY_LEGACY_STORED_ROLE,
  WORKSPACE_ROLES,
  type RoleMatrixScenario,
} from "./fixtures/role-matrix";

const scenariosById = new Map(ROLE_MATRIX_SCENARIOS.map((scenario) => [scenario.id, scenario]));

function scenario(id: RoleMatrixScenario["id"]): RoleMatrixScenario {
  const value = scenariosById.get(id);
  assert.ok(value, `missing role matrix scenario: ${id}`);
  return value;
}

test("stored system roles expose the canonical public role", () => {
  const storedRoles: Array<[AppUserRole, "admin" | "user"]> = [
    ["admin", "admin"],
    ["member", "user"],
    ["user", "user"],
  ];
  for (const [storedRole, publicRole] of storedRoles) assert.equal(toSystemRole(storedRole), publicRole);
  assert.deepEqual(CURRENT_STORED_ROLES, ["admin", "user"]);
  assert.deepEqual(CURRENT_STORED_ROLE_BY_SYSTEM_ROLE, { admin: "admin", user: "user" });
  for (const systemRole of SYSTEM_ROLES) {
    assert.equal(toSystemRole(CURRENT_STORED_ROLE_BY_SYSTEM_ROLE[systemRole]), systemRole);
  }
  assert.equal(toSystemRole("member"), SYSTEM_ROLE_BY_LEGACY_STORED_ROLE.member);
});

test("role matrix declares every independent role, membership, collaboration, and account dimension", () => {
  assert.deepEqual(SYSTEM_ROLES, ["admin", "user"]);
  assert.deepEqual(LEGACY_STORED_ROLES, ["admin", "member"]);
  assert.deepEqual(COMMERCIAL_TIERS, ["free", "member"]);
  assert.deepEqual(MEMBERSHIP_STATES, ["none", "active", "expired", "revoked"]);
  assert.deepEqual(WORKSPACE_ROLES, ["owner", "admin", "member", "viewer", null]);
  assert.deepEqual(PROJECT_ROLES, ["owner", "editor", "viewer", null]);
  assert.deepEqual(ACCOUNT_STATES, ["enabled", "disabled"]);

  assert.deepEqual(new Set(ROLE_MATRIX_SCENARIOS.map((value) => value.systemRole)), new Set(SYSTEM_ROLES));
  assert.deepEqual(new Set(ROLE_MATRIX_SCENARIOS.map((value) => value.legacyStoredRole)), new Set(LEGACY_STORED_ROLES));
  assert.deepEqual(new Set(ROLE_MATRIX_SCENARIOS.map((value) => value.commercialTier)), new Set(COMMERCIAL_TIERS));
  assert.deepEqual(new Set(ROLE_MATRIX_SCENARIOS.map((value) => value.membershipState)), new Set(MEMBERSHIP_STATES));
  assert.deepEqual(new Set(ROLE_MATRIX_SCENARIOS.map((value) => value.workspaceRole)), new Set(WORKSPACE_ROLES));
  assert.deepEqual(new Set(ROLE_MATRIX_SCENARIOS.map((value) => value.projectRole)), new Set(PROJECT_ROLES));
  assert.deepEqual(new Set(ROLE_MATRIX_SCENARIOS.map((value) => value.accountState)), new Set(ACCOUNT_STATES));

  assert.deepEqual(LEGACY_STORED_ROLE_BY_SYSTEM_ROLE, { admin: "admin", user: "member" });
  assert.deepEqual(SYSTEM_ROLE_BY_LEGACY_STORED_ROLE, { admin: "admin", member: "user" });
  for (const value of ROLE_MATRIX_SCENARIOS) {
    assert.equal(value.legacyStoredRole, LEGACY_STORED_ROLE_BY_SYSTEM_ROLE[value.systemRole]);
  }
});

test("role matrix contains the minimum named subjects exactly once", () => {
  assert.equal(new Set(REQUIRED_SCENARIO_IDS).size, REQUIRED_SCENARIO_IDS.length);
  assert.equal(new Set(ROLE_MATRIX_SCENARIOS.map((value) => value.id)).size, ROLE_MATRIX_SCENARIOS.length);
  for (const id of REQUIRED_SCENARIO_IDS) assert.ok(scenariosById.has(id), `missing scenario: ${id}`);

  for (const value of ROLE_MATRIX_SCENARIOS) {
    assert.ok(SYSTEM_ROLES.includes(value.systemRole));
    assert.ok(LEGACY_STORED_ROLES.includes(value.legacyStoredRole));
    assert.ok(COMMERCIAL_TIERS.includes(value.commercialTier));
    assert.ok(MEMBERSHIP_STATES.includes(value.membershipState));
    assert.ok(WORKSPACE_ROLES.includes(value.workspaceRole));
    assert.ok(PROJECT_ROLES.includes(value.projectRole));
    assert.ok(ACCOUNT_STATES.includes(value.accountState));
    assert.equal(value.expected.otherConnectionPrivateAccess.canList, false);
    assert.equal(value.expected.otherConnectionPrivateAccess.canRead, false);
    assert.equal(value.expected.otherConnectionPrivateAccess.canTest, false);
    assert.equal(value.expected.otherConnectionPrivateAccess.canRotate, false);
    assert.equal(value.expected.otherConnectionPrivateAccess.canDisable, false);
    assert.equal(value.expected.otherConnectionPrivateAccess.canDelete, false);
    assert.equal(
      value.expected.otherConnectionPrivateAccess.denialCode,
      value.accountState === "disabled" ? "ACCOUNT_DISABLED" : "RESOURCE_NOT_OWNED",
    );
    assert.equal(value.expected.otherConnectionProjectUseWithoutDelegation.canUse, false);
    assert.equal(
      value.expected.otherConnectionProjectUseWithoutDelegation.denialCode,
      value.accountState === "disabled" ? "ACCOUNT_DISABLED" : "DELEGATION_REQUIRED",
    );
    assert.equal(value.expected.systemAdminProjectOwnership.grantsProjectOwnership, false);
  }
});

test("system role does not imply commercial membership or collaboration ownership", () => {
  const freeUser = scenario("free-user");
  const freeAdmin = scenario("free-system-admin");
  assert.equal(freeUser.commercialTier, freeAdmin.commercialTier);
  assert.equal(freeUser.membershipState, freeAdmin.membershipState);
  assert.equal(freeUser.expected.personalModels.canCreate, false);
  assert.equal(freeAdmin.expected.personalModels.canCreate, false);
  assert.equal(freeUser.expected.ownGitMcp.canManage, true);
  assert.equal(freeAdmin.expected.ownGitMcp.canManage, true);
  assert.equal(freeAdmin.projectRole, null);
  assert.equal(freeAdmin.expected.systemAdminProjectOwnership.grantsProjectOwnership, false);

  const workspaceOwner = scenario("free-workspace-owner");
  const projectOwner = scenario("free-project-owner");
  assert.equal(workspaceOwner.systemRole, projectOwner.systemRole);
  assert.equal(workspaceOwner.commercialTier, projectOwner.commercialTier);
  assert.equal(workspaceOwner.workspaceRole, "owner");
  assert.equal(projectOwner.projectRole, "owner");
  assert.equal(workspaceOwner.expected.personalModels.canCreate, projectOwner.expected.personalModels.canCreate);
});

test("commercial membership is independent from workspace and project roles", () => {
  const activeWorkspaceMember = scenario("active-member-workspace-member");
  const freeWorkspaceOwner = scenario("free-workspace-owner");
  assert.equal(activeWorkspaceMember.systemRole, freeWorkspaceOwner.systemRole);
  assert.equal(activeWorkspaceMember.accountState, freeWorkspaceOwner.accountState);
  assert.notEqual(activeWorkspaceMember.commercialTier, freeWorkspaceOwner.commercialTier);
  assert.equal(activeWorkspaceMember.workspaceRole, "member");
  assert.equal(freeWorkspaceOwner.workspaceRole, "owner");
  assert.equal(activeWorkspaceMember.expected.ownGitMcp.canManage, true);
  assert.equal(freeWorkspaceOwner.expected.ownGitMcp.canManage, true);
  assert.equal(activeWorkspaceMember.expected.personalModels.canCreate, true);
  assert.equal(freeWorkspaceOwner.expected.personalModels.canCreate, false);

  const activeAdmin = scenario("active-member-system-admin");
  assert.equal(activeAdmin.commercialTier, activeWorkspaceMember.commercialTier);
  assert.equal(activeAdmin.membershipState, activeWorkspaceMember.membershipState);
  assert.equal(activeAdmin.expected.personalModels.canCreate, true);
  assert.equal(activeAdmin.expected.personalModels.canInvoke, true);
});

test("membership state controls personal model access while own Git and MCP remain account-scoped", () => {
  const free = scenario("free-user");
  assert.equal(free.commercialTier, "free");
  assert.equal(free.membershipState, "none");
  assert.equal(free.expected.personalModels.canCreate, false);
  assert.equal(free.expected.personalModels.canTest, false);
  assert.equal(free.expected.personalModels.canRotate, false);
  assert.equal(free.expected.personalModels.canDisable, false);
  assert.equal(free.expected.personalModels.canDelete, false);
  assert.equal(free.expected.personalModels.canInvoke, false);
  assert.equal(free.expected.personalModels.denialCode, "MEMBERSHIP_REQUIRED");

  const active = scenario("active-member-workspace-member");
  const expired = scenario("expired-member");
  const revoked = scenario("revoked-member");
  assert.equal(active.expected.personalModels.canCreate, true);
  assert.equal(active.expected.personalModels.canTest, true);
  assert.equal(active.expected.personalModels.canRotate, true);
  assert.equal(active.expected.personalModels.canDisable, true);
  assert.equal(active.expected.personalModels.canDelete, true);
  assert.equal(active.expected.personalModels.canInvoke, true);
  assert.equal(expired.commercialTier, "free");
  assert.equal(expired.expected.personalModels.canCreate, false);
  assert.equal(expired.expected.personalModels.canTest, false);
  assert.equal(expired.expected.personalModels.canRotate, true);
  assert.equal(expired.expected.personalModels.canDisable, true);
  assert.equal(expired.expected.personalModels.canDelete, true);
  assert.equal(expired.expected.personalModels.canInvoke, false);
  assert.equal(expired.expected.personalModels.denialCode, "MEMBERSHIP_EXPIRED");
  assert.equal(revoked.commercialTier, "free");
  assert.equal(revoked.expected.personalModels.canCreate, false);
  assert.equal(revoked.expected.personalModels.canTest, false);
  assert.equal(revoked.expected.personalModels.canRotate, true);
  assert.equal(revoked.expected.personalModels.canDisable, true);
  assert.equal(revoked.expected.personalModels.canDelete, true);
  assert.equal(revoked.expected.personalModels.canInvoke, false);
  assert.equal(revoked.expected.personalModels.denialCode, "MEMBERSHIP_REQUIRED");
  assert.equal(active.expected.ownGitMcp.canManage, true);
  assert.equal(expired.expected.ownGitMcp.canManage, true);
  assert.equal(revoked.expected.ownGitMcp.canManage, true);
});

test("effective commercial tier follows membership state", () => {
  for (const value of ROLE_MATRIX_SCENARIOS) {
    if (value.membershipState === "active") assert.equal(value.commercialTier, "member", value.id);
    else assert.equal(value.commercialTier, "free", value.id);
  }
});

test("platform AI always carries the caller quota invariant, including system admins", () => {
  for (const value of ROLE_MATRIX_SCENARIOS) {
    assert.equal(value.expected.platformAi.requiresOwnQuota, true, value.id);
    assert.equal(value.expected.platformAi.adminBypass, false, value.id);
    if (value.accountState === "disabled") {
      assert.equal(value.expected.platformAi.canUseWithOwnQuota, false, value.id);
      assert.equal(value.expected.platformAi.denialCode, "ACCOUNT_DISABLED", value.id);
    } else {
      assert.equal(value.expected.platformAi.canUseWithOwnQuota, true, value.id);
      assert.equal(value.expected.platformAi.denialCode, null, value.id);
    }
  }
});

test("disabled accounts fail closed across every capability in the fixture", () => {
  const disabled = scenario("disabled-account");
  assert.equal(disabled.accountState, "disabled");
  assert.equal(disabled.expected.platformAi.canUseWithOwnQuota, false);
  assert.equal(disabled.expected.personalModels.canCreate, false);
  assert.equal(disabled.expected.personalModels.canTest, false);
  assert.equal(disabled.expected.personalModels.canRotate, false);
  assert.equal(disabled.expected.personalModels.canDisable, false);
  assert.equal(disabled.expected.personalModels.canDelete, false);
  assert.equal(disabled.expected.personalModels.canInvoke, false);
  assert.equal(disabled.expected.ownGitMcp.canManage, false);
  assert.equal(disabled.expected.otherConnectionPrivateAccess.canList, false);
  assert.equal(disabled.expected.otherConnectionPrivateAccess.canRead, false);
  assert.equal(disabled.expected.otherConnectionPrivateAccess.canTest, false);
  assert.equal(disabled.expected.otherConnectionPrivateAccess.canRotate, false);
  assert.equal(disabled.expected.otherConnectionPrivateAccess.canDisable, false);
  assert.equal(disabled.expected.otherConnectionPrivateAccess.canDelete, false);
  assert.equal(disabled.expected.otherConnectionPrivateAccess.denialCode, "ACCOUNT_DISABLED");
  assert.equal(disabled.expected.otherConnectionProjectUseWithoutDelegation.canUse, false);
  assert.equal(disabled.expected.otherConnectionProjectUseWithoutDelegation.denialCode, "ACCOUNT_DISABLED");
  assert.equal(disabled.expected.platformAi.denialCode, "ACCOUNT_DISABLED");
  assert.equal(disabled.expected.personalModels.denialCode, "ACCOUNT_DISABLED");
  assert.equal(disabled.expected.ownGitMcp.denialCode, "ACCOUNT_DISABLED");
  assert.equal(disabled.expected.allCapabilitiesFailClosed, true);
});

test("stable error code contract is unique, complete, and reusable", () => {
  assert.equal(STABLE_ERROR_CODES.length, 13);
  assert.equal(STABLE_ERROR_CODE_SET.size, STABLE_ERROR_CODES.length);
  for (const code of STABLE_ERROR_CODES) {
    assert.equal(STABLE_ERROR_CODE_SET.has(code), true);
    assert.match(code, /^[A-Z][A-Z0-9_]+$/u);
  }
  assert.deepEqual([...STABLE_ERROR_CODE_SET], STABLE_ERROR_CODES);
});
