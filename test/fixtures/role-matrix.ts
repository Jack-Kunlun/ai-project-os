export const ROLE_MEMBERSHIP_FIXTURE_VERSION = "role-membership-matrix-v1" as const;

export const SYSTEM_ROLES = ["admin", "user"] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const LEGACY_STORED_ROLES = ["admin", "member"] as const;
export type LegacyStoredRole = (typeof LEGACY_STORED_ROLES)[number];

/** Current persistence vocabulary for all new system-role writes. */
export const CURRENT_STORED_ROLES = ["admin", "user"] as const;
export type CurrentStoredRole = (typeof CURRENT_STORED_ROLES)[number];

export const CURRENT_STORED_ROLE_BY_SYSTEM_ROLE = {
  admin: "admin",
  user: "user",
} as const satisfies Record<SystemRole, CurrentStoredRole>;

/** Read-compatibility mapping only; new writes must use CURRENT_STORED_ROLE_BY_SYSTEM_ROLE. */
export const LEGACY_STORED_ROLE_BY_SYSTEM_ROLE = {
  admin: "admin",
  user: "member",
} as const satisfies Record<SystemRole, LegacyStoredRole>;

export const SYSTEM_ROLE_BY_LEGACY_STORED_ROLE = {
  admin: "admin",
  member: "user",
} as const satisfies Record<LegacyStoredRole, SystemRole>;

export const COMMERCIAL_TIERS = ["free", "member"] as const;
export type CommercialTier = (typeof COMMERCIAL_TIERS)[number];

export const MEMBERSHIP_STATES = ["none", "active", "expired", "revoked"] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer", null] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const PROJECT_ROLES = ["owner", "editor", "viewer", null] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const ACCOUNT_STATES = ["enabled", "disabled"] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

export const STABLE_ERROR_CODES = [
  "ACCOUNT_DISABLED",
  "MEMBERSHIP_REQUIRED",
  "MEMBERSHIP_EXPIRED",
  "RESOURCE_NOT_OWNED",
  "DELEGATION_REQUIRED",
  "DELEGATION_EXPIRED",
  "CONNECTION_DISABLED",
  "CONNECTION_REVERIFICATION_REQUIRED",
  "PLATFORM_ROUTE_UNAVAILABLE",
  "PLATFORM_CREDIT_EXHAUSTED",
  "INDEX_ROUTE_INCOMPATIBLE",
  "CONFIRMATION_EXPIRED",
  "VERSION_CONFLICT",
] as const;
export type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

export const REQUIRED_SCENARIO_IDS = [
  "free-user",
  "active-member-workspace-member",
  "free-workspace-owner",
  "free-project-owner",
  "expired-member",
  "revoked-member",
  "free-system-admin",
  "active-member-system-admin",
  "disabled-account",
] as const;
export type RoleMatrixScenarioId = (typeof REQUIRED_SCENARIO_IDS)[number];

export type RoleMatrixExpectedCapabilities = Readonly<{
  platformAi: Readonly<{
    canUseWithOwnQuota: boolean;
    requiresOwnQuota: true;
    adminBypass: false;
    denialCode: StableErrorCode | null;
  }>;
  personalModels: Readonly<{
    canCreate: boolean;
    canTest: boolean;
    canRotate: boolean;
    canDisable: boolean;
    canDelete: boolean;
    canInvoke: boolean;
    denialCode: StableErrorCode | null;
  }>;
  ownGitMcp: Readonly<{
    canManage: boolean;
    denialCode: StableErrorCode | null;
  }>;
  otherConnectionPrivateAccess: Readonly<{
    canList: false;
    canRead: false;
    canTest: false;
    canRotate: false;
    canDisable: false;
    canDelete: false;
    denialCode: "RESOURCE_NOT_OWNED" | "ACCOUNT_DISABLED";
  }>;
  otherConnectionProjectUseWithoutDelegation: Readonly<{
    canUse: false;
    denialCode: "DELEGATION_REQUIRED" | "ACCOUNT_DISABLED";
  }>;
  systemAdminProjectOwnership: Readonly<{
    grantsProjectOwnership: false;
  }>;
  allCapabilitiesFailClosed: boolean;
}>;

export type RoleMatrixScenario = Readonly<{
  id: RoleMatrixScenarioId;
  systemRole: SystemRole;
  legacyStoredRole: LegacyStoredRole;
  commercialTier: CommercialTier;
  membershipState: MembershipState;
  workspaceRole: WorkspaceRole;
  projectRole: ProjectRole;
  accountState: AccountState;
  expected: RoleMatrixExpectedCapabilities;
}>;

const PLATFORM_AI_REQUIRES_OWN_QUOTA = {
  requiresOwnQuota: true,
  adminBypass: false,
} as const;

const OTHER_CONNECTION_PRIVATE_ACCESS = {
  canList: false,
  canRead: false,
  canTest: false,
  canRotate: false,
  canDisable: false,
  canDelete: false,
} as const;

const OTHER_CONNECTION_PROJECT_USE_WITHOUT_DELEGATION = {
  canUse: false,
} as const;

const SYSTEM_ADMIN_DOES_NOT_GRANT_PROJECT_OWNERSHIP = {
  grantsProjectOwnership: false,
} as const;

/** Fixture-only expectation builder; this is not runtime authorization logic. */
const expectedFor = (input: Readonly<{
  accountState: AccountState;
  commercialTier: CommercialTier;
  membershipState: MembershipState;
}>): RoleMatrixExpectedCapabilities => {
  const accountDisabled = input.accountState === "disabled";
  const activeMember = input.accountState === "enabled" && input.commercialTier === "member" && input.membershipState === "active";
  const existingPersonalModelCanBeCleanedUp = input.accountState === "enabled" && ["active", "expired", "revoked"].includes(input.membershipState);
  const personalModelDenialCode = accountDisabled
    ? "ACCOUNT_DISABLED"
    : input.membershipState === "expired"
      ? "MEMBERSHIP_EXPIRED"
      : "MEMBERSHIP_REQUIRED";

  return {
    platformAi: {
      ...PLATFORM_AI_REQUIRES_OWN_QUOTA,
      canUseWithOwnQuota: !accountDisabled,
      denialCode: accountDisabled ? "ACCOUNT_DISABLED" : null,
    },
    personalModels: {
      canCreate: activeMember,
      canTest: activeMember,
      canRotate: existingPersonalModelCanBeCleanedUp,
      canDisable: existingPersonalModelCanBeCleanedUp,
      canDelete: existingPersonalModelCanBeCleanedUp,
      canInvoke: activeMember,
      denialCode: activeMember ? null : personalModelDenialCode,
    },
    ownGitMcp: {
      canManage: !accountDisabled,
      denialCode: accountDisabled ? "ACCOUNT_DISABLED" : null,
    },
    otherConnectionPrivateAccess: {
      ...OTHER_CONNECTION_PRIVATE_ACCESS,
      denialCode: accountDisabled ? "ACCOUNT_DISABLED" : "RESOURCE_NOT_OWNED",
    },
    otherConnectionProjectUseWithoutDelegation: {
      ...OTHER_CONNECTION_PROJECT_USE_WITHOUT_DELEGATION,
      denialCode: accountDisabled ? "ACCOUNT_DISABLED" : "DELEGATION_REQUIRED",
    },
    systemAdminProjectOwnership: SYSTEM_ADMIN_DOES_NOT_GRANT_PROJECT_OWNERSHIP,
    allCapabilitiesFailClosed: accountDisabled,
  };
};

export const ROLE_MATRIX_SCENARIOS = [
  {
    id: "free-user",
    systemRole: "user",
    legacyStoredRole: "member",
    commercialTier: "free",
    membershipState: "none",
    workspaceRole: null,
    projectRole: null,
    accountState: "enabled",
    expected: expectedFor({ accountState: "enabled", commercialTier: "free", membershipState: "none" }),
  },
  {
    id: "active-member-workspace-member",
    systemRole: "user",
    legacyStoredRole: "member",
    commercialTier: "member",
    membershipState: "active",
    workspaceRole: "member",
    projectRole: null,
    accountState: "enabled",
    expected: expectedFor({ accountState: "enabled", commercialTier: "member", membershipState: "active" }),
  },
  {
    id: "free-workspace-owner",
    systemRole: "user",
    legacyStoredRole: "member",
    commercialTier: "free",
    membershipState: "none",
    workspaceRole: "owner",
    projectRole: null,
    accountState: "enabled",
    expected: expectedFor({ accountState: "enabled", commercialTier: "free", membershipState: "none" }),
  },
  {
    id: "free-project-owner",
    systemRole: "user",
    legacyStoredRole: "member",
    commercialTier: "free",
    membershipState: "none",
    workspaceRole: null,
    projectRole: "owner",
    accountState: "enabled",
    expected: expectedFor({ accountState: "enabled", commercialTier: "free", membershipState: "none" }),
  },
  {
    id: "expired-member",
    systemRole: "user",
    legacyStoredRole: "member",
    commercialTier: "free",
    membershipState: "expired",
    workspaceRole: "admin",
    projectRole: "editor",
    accountState: "enabled",
    expected: expectedFor({ accountState: "enabled", commercialTier: "free", membershipState: "expired" }),
  },
  {
    id: "revoked-member",
    systemRole: "user",
    legacyStoredRole: "member",
    commercialTier: "free",
    membershipState: "revoked",
    workspaceRole: "viewer",
    projectRole: "viewer",
    accountState: "enabled",
    expected: expectedFor({ accountState: "enabled", commercialTier: "free", membershipState: "revoked" }),
  },
  {
    id: "free-system-admin",
    systemRole: "admin",
    legacyStoredRole: "admin",
    commercialTier: "free",
    membershipState: "none",
    workspaceRole: null,
    projectRole: null,
    accountState: "enabled",
    expected: expectedFor({ accountState: "enabled", commercialTier: "free", membershipState: "none" }),
  },
  {
    id: "active-member-system-admin",
    systemRole: "admin",
    legacyStoredRole: "admin",
    commercialTier: "member",
    membershipState: "active",
    workspaceRole: null,
    projectRole: null,
    accountState: "enabled",
    expected: expectedFor({ accountState: "enabled", commercialTier: "member", membershipState: "active" }),
  },
  {
    id: "disabled-account",
    systemRole: "user",
    legacyStoredRole: "member",
    commercialTier: "member",
    membershipState: "active",
    workspaceRole: "owner",
    projectRole: "owner",
    accountState: "disabled",
    expected: expectedFor({ accountState: "disabled", commercialTier: "member", membershipState: "active" }),
  },
] as const satisfies readonly RoleMatrixScenario[];

export const roleMatrixScenarios = ROLE_MATRIX_SCENARIOS;

export const STABLE_ERROR_CODE_SET: ReadonlySet<StableErrorCode> = new Set(STABLE_ERROR_CODES);
