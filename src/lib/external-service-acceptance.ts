import { Prisma, type PrismaClient } from "@prisma/client";

export const EXTERNAL_SERVICE_CATEGORIES = [
  "model",
  "personal-git-manual",
  "personal-git-automatic",
  "github-issue",
  "github-pull-request",
  "github-release",
  "mcp-inbound-dispatch",
  "mcp-inbound-manual-import",
  "mcp-outbound-oauth",
  "mcp-outbound-single-use-dispatch",
  "oidc-login",
  "oidc-explicit-link",
  "registration-local-password",
  "registration-github-first",
] as const;

export const DEFAULT_EXTERNAL_ACCEPTANCE_MAX_AGE_HOURS = 24;
const MAX_ACCEPTANCE_QUERY_ROWS = EXTERNAL_SERVICE_CATEGORIES.length;

export type ExternalServiceCategory = (typeof EXTERNAL_SERVICE_CATEGORIES)[number];
export type ExternalServiceAcceptanceStatus = "ready" | "missing" | "stale";

export interface ExternalServiceCategoryResult {
  required: boolean;
  evidencePresent: boolean;
  freshEvidence: boolean;
  status: ExternalServiceAcceptanceStatus;
  reasonCode: string;
}

export interface ExternalServiceAcceptanceReport {
  ok: boolean;
  scope: "full" | "scoped";
  checkedAt: string;
  cutoff: string;
  maxAgeHours: number;
  expected: readonly ExternalServiceCategory[];
  categories: Readonly<Record<ExternalServiceCategory, ExternalServiceCategoryResult>>;
}

export class ExternalServiceAcceptanceError extends Error {
  constructor(readonly code: "EXTERNAL_ACCEPTANCE_ARGUMENT_INVALID" | "EXTERNAL_ACCEPTANCE_EVIDENCE_INVALID") {
    super(code);
    this.name = "ExternalServiceAcceptanceError";
  }
}

function invalidArguments(): never {
  throw new ExternalServiceAcceptanceError("EXTERNAL_ACCEPTANCE_ARGUMENT_INVALID");
}

function invalidEvidence(): never {
  throw new ExternalServiceAcceptanceError("EXTERNAL_ACCEPTANCE_EVIDENCE_INVALID");
}

function parseExpected(value: string): readonly ExternalServiceCategory[] {
  const values = value.split(",").map((entry) => entry.trim());
  const known = new Set<string>(EXTERNAL_SERVICE_CATEGORIES);
  if (values.length === 0 || values.some((entry) => entry.length === 0) || new Set(values).size !== values.length || values.some((entry) => !known.has(entry))) {
    return invalidArguments();
  }
  return EXTERNAL_SERVICE_CATEGORIES.filter((category) => values.includes(category));
}

export function parseExternalAcceptanceArguments(args: readonly string[]) {
  let expected: readonly ExternalServiceCategory[] = EXTERNAL_SERVICE_CATEGORIES;
  let maxAgeHours = DEFAULT_EXTERNAL_ACCEPTANCE_MAX_AGE_HOURS;
  let expectedSeen = false;
  let maxAgeSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--expected" || argument.startsWith("--expected=")) {
      if (expectedSeen) return invalidArguments();
      const value = argument === "--expected" ? args[index += 1] : argument.slice("--expected=".length);
      if (value === undefined) return invalidArguments();
      expected = parseExpected(value);
      expectedSeen = true;
      continue;
    }
    if (argument === "--max-age-hours" || argument.startsWith("--max-age-hours=")) {
      if (maxAgeSeen) return invalidArguments();
      const value = argument === "--max-age-hours" ? args[index += 1] : argument.slice("--max-age-hours=".length);
      if (value === undefined || !/^[0-9]{1,3}$/u.test(value)) return invalidArguments();
      maxAgeHours = Number(value);
      if (!Number.isInteger(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 168) return invalidArguments();
      maxAgeSeen = true;
      continue;
    }
    return invalidArguments();
  }

  return Object.freeze({ expected, maxAgeHours });
}

export function evaluateExternalServiceCategory(
  category: ExternalServiceCategory,
  latestEvidenceAt: Date | null,
  cutoff: Date,
  required: boolean,
): ExternalServiceCategoryResult {
  const evidencePresent = latestEvidenceAt !== null;
  const freshEvidence = evidencePresent && latestEvidenceAt >= cutoff;
  const status: ExternalServiceAcceptanceStatus = freshEvidence ? "ready" : evidencePresent ? "stale" : "missing";
  const suffix = status === "ready" ? "FRESH_EVIDENCE_PRESENT" : status === "stale" ? "EVIDENCE_STALE" : "EVIDENCE_MISSING";

  return Object.freeze({ required, evidencePresent, freshEvidence, status, reasonCode: `${category.toUpperCase().replaceAll("-", "_")}_${suffix}` });
}

interface ExternalServiceEvidenceRow {
  category: string;
  latestEvidenceAt: Date | null;
}

/**
 * Read one latest eligible event per category. Each event lookup is a scalar
 * `ORDER BY ... LIMIT 1`; identifiers, addresses, credentials and content are
 * never selected. The query is read-only and returns exactly fourteen rows.
 */
const EXTERNAL_SERVICE_EVIDENCE_SQL = (now: Date) => Prisma.sql`
  SELECT 'model'::text AS "category", (
    SELECT call."completedAt"::timestamptz
    FROM "ProviderCallAudit" call
    JOIN "AiProviderConnection" connection ON connection."id" = call."providerConnectionId"
    WHERE connection."scope"::text = 'platform'
      AND connection."ownerUserId" IS NULL
      AND connection."disabledAt" IS NULL
      AND connection."status"::text = 'verified'
      AND connection."lastErrorCode" IS NULL
      AND connection."lastTestedAt" IS NOT NULL
      AND call."status" = 'succeeded'
      AND call."completedAt" IS NOT NULL
      AND call."completedAt" >= connection."lastTestedAt"
    ORDER BY call."completedAt" DESC
    LIMIT 1
  ) AS "latestEvidenceAt"
  UNION ALL
  SELECT 'personal-git-manual'::text, (
    SELECT run."completedAt"::timestamptz
    FROM "ProjectGitRepositoryManualRun" run
    JOIN "ProjectGitRepositoryDelegation" delegation
      ON delegation."id" = run."delegationId"
      AND delegation."projectId" = run."projectId"
    JOIN "GitConnection" connection ON connection."id" = delegation."gitConnectionId"
    JOIN "ExternalCredential" git_credential
      ON git_credential."id" = connection."credentialId"
      AND git_credential."kind"::text = 'git'
      AND git_credential."secretFingerprint" = delegation."credentialFingerprint"
    JOIN "AppUser" connection_owner
      ON connection_owner."id" = connection."ownerUserId"
      AND connection_owner."disabledAt" IS NULL
    WHERE run."status"::text IN ('succeeded', 'unchanged')
      AND run."failureCode" IS NULL
      AND run."completedAt" IS NOT NULL
      AND delegation."status"::text = 'active'
      AND delegation."manualSyncAllowed" = TRUE
      AND run."manualSyncAllowed" = TRUE
      AND delegation."revokedAt" IS NULL
      AND delegation."expiresAt" > ${now}
      AND run."delegationVersion" = delegation."version"
      AND run."delegationFingerprint" = delegation."delegationFingerprint"
      AND run."connectionOwnerId" = connection_owner."id"
      AND run."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND delegation."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND connection."ownerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND run."connectionConfigurationVersion" = connection."configurationVersion"
      AND run."resolvedAddressFingerprint" = delegation."resolvedAddressFingerprint"
      AND run."credentialFingerprint" = delegation."credentialFingerprint"
      AND delegation."connectionConfigurationVersion" = connection."configurationVersion"
      AND delegation."resolvedAddressFingerprint" = connection."resolvedAddressFingerprint"
      AND connection."ownerUserId" IS NOT NULL
      AND connection."ownershipState"::text = 'confirmed'
      AND delegation."connectionOwnerId" = connection."ownerUserId"
      AND connection."disabledAt" IS NULL
      AND connection."status"::text = 'verified'
      AND connection."lastErrorCode" IS NULL
      AND connection."lastTestedAt" IS NOT NULL
      AND run."completedAt" >= connection."lastTestedAt"
    ORDER BY run."completedAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'personal-git-automatic'::text, (
    SELECT run."completedAt"::timestamptz
    FROM "ProjectGitRepositoryAutomationRun" run
    JOIN "GitConnection" connection ON connection."id" = run."gitConnectionId"
    JOIN "ExternalCredential" git_credential
      ON git_credential."id" = connection."credentialId"
      AND git_credential."kind"::text = 'git'
    JOIN "ProjectGitRepositoryAutomationGrant" grant_row
      ON grant_row."id" = run."grantId"
      AND grant_row."projectId" = run."projectId"
      AND grant_row."gitConnectionId" = run."gitConnectionId"
      AND grant_row."baseDelegationId" = run."baseDelegationId"
    JOIN "ProjectGitRepositoryDelegation" delegation
      ON delegation."id" = grant_row."baseDelegationId"
      AND delegation."projectId" = run."projectId"
      AND delegation."gitConnectionId" = run."gitConnectionId"
    JOIN "AppUser" connection_owner
      ON connection_owner."id" = connection."ownerUserId"
      AND connection_owner."disabledAt" IS NULL
    WHERE run."status"::text IN ('succeeded', 'unchanged')
      AND run."safeErrorCode" IS NULL
      AND run."completedAt" IS NOT NULL
      AND run."grantVersion" = grant_row."version"
      AND run."grantFingerprint" = grant_row."grantFingerprint"
      AND run."baseDelegationVersion" = delegation."version"
      AND run."baseDelegationFingerprint" = delegation."delegationFingerprint"
      AND run."connectionOwnerId" = connection_owner."id"
      AND grant_row."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND delegation."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND connection."ownerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND grant_row."status"::text = 'active'
      AND grant_row."expiresAt" > ${now}
      AND grant_row."baseDelegationVersion" = delegation."version"
      AND grant_row."baseDelegationFingerprint" = delegation."delegationFingerprint"
      AND delegation."status"::text = 'active'
      AND delegation."automationAllowed" = TRUE
      AND delegation."revokedAt" IS NULL
      AND delegation."expiresAt" > ${now}
      AND connection."ownerUserId" IS NOT NULL
      AND connection."ownershipState"::text = 'confirmed'
      AND grant_row."connectionOwnerId" = connection."ownerUserId"
      AND delegation."connectionOwnerId" = connection."ownerUserId"
      AND delegation."connectionConfigurationVersion" = connection."configurationVersion"
      AND delegation."resolvedAddressFingerprint" = connection."resolvedAddressFingerprint"
      AND git_credential."secretFingerprint" = delegation."credentialFingerprint"
      AND connection."disabledAt" IS NULL
      AND connection."status"::text = 'verified'
      AND connection."lastErrorCode" IS NULL
      AND connection."lastTestedAt" IS NOT NULL
      AND run."completedAt" >= connection."lastTestedAt"
    ORDER BY run."completedAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'github-issue'::text, (
    SELECT run."completedAt"::timestamptz
    FROM "ProjectGitRepositoryMaterialRun" run
    JOIN "GitConnection" connection ON connection."id" = run."gitConnectionId"
    JOIN "ExternalCredential" git_credential
      ON git_credential."id" = connection."credentialId"
      AND git_credential."kind"::text = 'git'
    JOIN "ProjectGitRepositoryAutomationGrant" grant_row
      ON grant_row."id" = run."grantId"
      AND grant_row."projectId" = run."projectId"
      AND grant_row."gitConnectionId" = run."gitConnectionId"
      AND grant_row."baseDelegationId" = run."baseDelegationId"
    JOIN "ProjectGitRepositoryDelegation" delegation
      ON delegation."id" = grant_row."baseDelegationId"
      AND delegation."projectId" = run."projectId"
      AND delegation."gitConnectionId" = run."gitConnectionId"
    JOIN "AppUser" connection_owner
      ON connection_owner."id" = connection."ownerUserId"
      AND connection_owner."disabledAt" IS NULL
    WHERE run."materialKind"::text = 'issue'
      AND run."status"::text IN ('succeeded', 'unchanged')
      AND run."safeErrorCode" IS NULL
      AND run."completedAt" IS NOT NULL
      AND run."grantVersion" = grant_row."version"
      AND run."grantFingerprint" = grant_row."grantFingerprint"
      AND run."baseDelegationVersion" = delegation."version"
      AND run."baseDelegationFingerprint" = delegation."delegationFingerprint"
      AND run."connectionOwnerId" = connection_owner."id"
      AND grant_row."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND delegation."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND connection."ownerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND grant_row."status"::text = 'active'
      AND grant_row."issuesEnabled" = TRUE
      AND grant_row."expiresAt" > ${now}
      AND grant_row."baseDelegationVersion" = delegation."version"
      AND grant_row."baseDelegationFingerprint" = delegation."delegationFingerprint"
      AND delegation."status"::text = 'active'
      AND delegation."automationAllowed" = TRUE
      AND delegation."revokedAt" IS NULL
      AND delegation."expiresAt" > ${now}
      AND connection."ownershipState"::text = 'confirmed'
      AND grant_row."connectionOwnerId" = connection."ownerUserId"
      AND delegation."connectionOwnerId" = connection."ownerUserId"
      AND delegation."connectionConfigurationVersion" = connection."configurationVersion"
      AND delegation."resolvedAddressFingerprint" = connection."resolvedAddressFingerprint"
      AND git_credential."secretFingerprint" = delegation."credentialFingerprint"
      AND connection."providerKind"::text = 'github'
      AND connection."ownerUserId" IS NOT NULL
      AND connection."disabledAt" IS NULL
      AND connection."status"::text = 'verified'
      AND connection."lastErrorCode" IS NULL
      AND connection."lastTestedAt" IS NOT NULL
      AND run."completedAt" >= connection."lastTestedAt"
    ORDER BY run."completedAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'github-pull-request'::text, (
    SELECT run."completedAt"::timestamptz
    FROM "ProjectGitRepositoryMaterialRun" run
    JOIN "GitConnection" connection ON connection."id" = run."gitConnectionId"
    JOIN "ExternalCredential" git_credential
      ON git_credential."id" = connection."credentialId"
      AND git_credential."kind"::text = 'git'
    JOIN "ProjectGitRepositoryAutomationGrant" grant_row
      ON grant_row."id" = run."grantId"
      AND grant_row."projectId" = run."projectId"
      AND grant_row."gitConnectionId" = run."gitConnectionId"
      AND grant_row."baseDelegationId" = run."baseDelegationId"
    JOIN "ProjectGitRepositoryDelegation" delegation
      ON delegation."id" = grant_row."baseDelegationId"
      AND delegation."projectId" = run."projectId"
      AND delegation."gitConnectionId" = run."gitConnectionId"
    JOIN "AppUser" connection_owner
      ON connection_owner."id" = connection."ownerUserId"
      AND connection_owner."disabledAt" IS NULL
    WHERE run."materialKind"::text = 'pull_request'
      AND run."status"::text IN ('succeeded', 'unchanged')
      AND run."safeErrorCode" IS NULL
      AND run."completedAt" IS NOT NULL
      AND run."grantVersion" = grant_row."version"
      AND run."grantFingerprint" = grant_row."grantFingerprint"
      AND run."baseDelegationVersion" = delegation."version"
      AND run."baseDelegationFingerprint" = delegation."delegationFingerprint"
      AND run."connectionOwnerId" = connection_owner."id"
      AND grant_row."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND delegation."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND connection."ownerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND grant_row."pullRequestsEnabled" = TRUE
      AND grant_row."status"::text = 'active'
      AND grant_row."expiresAt" > ${now}
      AND grant_row."baseDelegationVersion" = delegation."version"
      AND grant_row."baseDelegationFingerprint" = delegation."delegationFingerprint"
      AND delegation."status"::text = 'active'
      AND delegation."automationAllowed" = TRUE
      AND delegation."revokedAt" IS NULL
      AND delegation."expiresAt" > ${now}
      AND connection."ownershipState"::text = 'confirmed'
      AND grant_row."connectionOwnerId" = connection."ownerUserId"
      AND delegation."connectionOwnerId" = connection."ownerUserId"
      AND delegation."connectionConfigurationVersion" = connection."configurationVersion"
      AND delegation."resolvedAddressFingerprint" = connection."resolvedAddressFingerprint"
      AND git_credential."secretFingerprint" = delegation."credentialFingerprint"
      AND connection."providerKind"::text = 'github'
      AND connection."ownerUserId" IS NOT NULL
      AND connection."disabledAt" IS NULL
      AND connection."status"::text = 'verified'
      AND connection."lastErrorCode" IS NULL
      AND connection."lastTestedAt" IS NOT NULL
      AND run."completedAt" >= connection."lastTestedAt"
    ORDER BY run."completedAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'github-release'::text, (
    SELECT run."completedAt"::timestamptz
    FROM "ProjectGitRepositoryMaterialRun" run
    JOIN "GitConnection" connection ON connection."id" = run."gitConnectionId"
    JOIN "ExternalCredential" git_credential
      ON git_credential."id" = connection."credentialId"
      AND git_credential."kind"::text = 'git'
    JOIN "ProjectGitRepositoryAutomationGrant" grant_row
      ON grant_row."id" = run."grantId"
      AND grant_row."projectId" = run."projectId"
      AND grant_row."gitConnectionId" = run."gitConnectionId"
      AND grant_row."baseDelegationId" = run."baseDelegationId"
    JOIN "ProjectGitRepositoryDelegation" delegation
      ON delegation."id" = grant_row."baseDelegationId"
      AND delegation."projectId" = run."projectId"
      AND delegation."gitConnectionId" = run."gitConnectionId"
    JOIN "AppUser" connection_owner
      ON connection_owner."id" = connection."ownerUserId"
      AND connection_owner."disabledAt" IS NULL
    WHERE run."materialKind"::text = 'release'
      AND run."status"::text IN ('succeeded', 'unchanged')
      AND run."safeErrorCode" IS NULL
      AND run."completedAt" IS NOT NULL
      AND run."grantVersion" = grant_row."version"
      AND run."grantFingerprint" = grant_row."grantFingerprint"
      AND run."baseDelegationVersion" = delegation."version"
      AND run."baseDelegationFingerprint" = delegation."delegationFingerprint"
      AND run."connectionOwnerId" = connection_owner."id"
      AND grant_row."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND delegation."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND connection."ownerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND grant_row."releasesEnabled" = TRUE
      AND grant_row."status"::text = 'active'
      AND grant_row."expiresAt" > ${now}
      AND grant_row."baseDelegationVersion" = delegation."version"
      AND grant_row."baseDelegationFingerprint" = delegation."delegationFingerprint"
      AND delegation."status"::text = 'active'
      AND delegation."automationAllowed" = TRUE
      AND delegation."revokedAt" IS NULL
      AND delegation."expiresAt" > ${now}
      AND connection."ownershipState"::text = 'confirmed'
      AND grant_row."connectionOwnerId" = connection."ownerUserId"
      AND delegation."connectionOwnerId" = connection."ownerUserId"
      AND delegation."connectionConfigurationVersion" = connection."configurationVersion"
      AND delegation."resolvedAddressFingerprint" = connection."resolvedAddressFingerprint"
      AND git_credential."secretFingerprint" = delegation."credentialFingerprint"
      AND connection."providerKind"::text = 'github'
      AND connection."ownerUserId" IS NOT NULL
      AND connection."disabledAt" IS NULL
      AND connection."status"::text = 'verified'
      AND connection."lastErrorCode" IS NULL
      AND connection."lastTestedAt" IS NOT NULL
      AND run."completedAt" >= connection."lastTestedAt"
    ORDER BY run."completedAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'mcp-inbound-dispatch'::text, (
    SELECT attempt."completedAt"::timestamptz
    FROM "ProjectMcpActionDispatchAttempt" attempt
    JOIN "ProjectMcpAction" action ON action."id" = attempt."actionId" AND action."projectId" = attempt."projectId"
    JOIN "McpConnection" connection ON connection."id" = action."connectionId"
    JOIN "ProjectMcpConnectionDelegation" delegation
      ON delegation."id" = action."delegationId"
      AND delegation."projectId" = action."projectId"
      AND delegation."mcpConnectionId" = action."connectionId"
    JOIN "AppUser" connection_owner
      ON connection_owner."id" = connection."ownerUserId"
      AND connection_owner."disabledAt" IS NULL
    WHERE attempt."status"::text = 'succeeded'
      AND attempt."completedAt" IS NOT NULL
      AND action."status"::text = 'succeeded'
      AND action."delegationVersion" = delegation."version"
      AND action."delegationFingerprint" = delegation."delegationFingerprint"
      AND action."credentialFingerprint" = connection."credentialFingerprint"
      AND delegation."credentialFingerprint" = connection."credentialFingerprint"
      AND action."connectionOwnerId" = connection_owner."id"
      AND action."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND action."connectionConfigurationRevision" = connection."configurationRevision"
      AND delegation."status"::text = 'active'
      AND delegation."revokedAt" IS NULL
      AND delegation."expiresAt" > ${now}
      AND delegation."connectionOwnerId" = connection."ownerUserId"
      AND connection."ownerUserId" IS NOT NULL
      AND connection."ownershipState"::text = 'confirmed'
      AND connection."ownerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND delegation."connectionOwnerAccountAccessVersion" = connection_owner."accountAccessVersion"
      AND delegation."connectionConfigurationRevision" = connection."configurationRevision"
      AND delegation."resolvedAddressFingerprint" = connection."resolvedAddressFingerprint"
      AND connection."disabledAt" IS NULL
      AND connection."status"::text = 'verified'
      AND connection."lastErrorCode" IS NULL
      AND connection."resolvedAddressFingerprint" IS NOT NULL
      AND connection."lastDiscoveredAt" IS NOT NULL
      AND attempt."completedAt" >= connection."lastDiscoveredAt"
    ORDER BY attempt."completedAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'mcp-inbound-manual-import'::text, (
    SELECT import_row."createdAt"::timestamptz
    FROM "ProjectMcpActionResultImport" import_row
    JOIN "ProjectMcpAction" action ON action."id" = import_row."actionId" AND action."projectId" = import_row."projectId"
    JOIN "ProjectMcpActionDispatchAttempt" attempt ON attempt."actionId" = action."id" AND attempt."projectId" = action."projectId"
    JOIN "ProjectMcpActionDispatchResult" result_row
      ON result_row."id" = import_row."dispatchResultId"
      AND result_row."actionId" = action."id"
      AND result_row."projectId" = action."projectId"
    WHERE action."status"::text = 'succeeded'
      AND attempt."status"::text = 'succeeded'
      AND attempt."completedAt" IS NOT NULL
      AND import_row."createdAt" >= attempt."completedAt"
    ORDER BY import_row."createdAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'mcp-outbound-oauth'::text, (
    SELECT token."createdAt"::timestamptz
    FROM "McpExportOAuthAccessToken" token
    JOIN "McpExportGrant" grant_row ON grant_row."id" = token."grantId"
    WHERE token."revokedAt" IS NULL
      AND token."expiresAt" > ${now}
      AND grant_row."grantType"::text = 'oauth'
      AND grant_row."revokedAt" IS NULL
      AND grant_row."expiresAt" > ${now}
    ORDER BY token."createdAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'mcp-outbound-single-use-dispatch'::text, (
    SELECT audit."createdAt"::timestamptz
    FROM "McpExportDispatchAudit" audit
    JOIN "McpExportGrant" grant_row ON grant_row."id" = audit."grantId"
    JOIN "McpExportApproval" approval
      ON approval."id" = audit."approvalId"
      AND approval."grantId" = audit."grantId"
      AND approval."projectId" = audit."projectId"
      AND approval."ownerUserId" = audit."ownerUserId"
    WHERE grant_row."grantType"::text = 'oauth'
      AND grant_row."projectId" = audit."projectId"
      AND grant_row."ownerUserId" = audit."ownerUserId"
      AND grant_row."revokedAt" IS NULL
      AND grant_row."expiresAt" > ${now}
      AND approval."expiresAt" >= approval."consumedAt"
      AND approval."approvedAt" IS NOT NULL
      AND approval."consumedAt" IS NOT NULL
      AND approval."consumedAt" >= approval."approvedAt"
      AND audit."createdAt" >= approval."consumedAt"
    ORDER BY audit."createdAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'oidc-login'::text, (
    SELECT identity."lastLoginAt"::timestamptz
    FROM "OidcIdentity" identity
    JOIN "OidcProvider" provider ON provider."id" = identity."providerId"
    JOIN "AppUser" app_user ON app_user."id" = identity."userId"
    WHERE provider."disabledAt" IS NULL
      AND provider."status"::text = 'verified'
      AND provider."lastErrorCode" IS NULL
      AND provider."lastTestedAt" IS NOT NULL
      AND identity."lastLoginAt" >= provider."lastTestedAt"
      AND app_user."disabledAt" IS NULL
    ORDER BY identity."lastLoginAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'oidc-explicit-link'::text, (
    SELECT audit."createdAt"::timestamptz
    FROM "OidcIdentityLinkAudit" audit
    JOIN "OidcProvider" provider ON provider."id" = audit."providerId"
    JOIN "AppUser" app_user ON app_user."id" = audit."userId"
    WHERE provider."disabledAt" IS NULL
      AND provider."status"::text = 'verified'
      AND provider."lastErrorCode" IS NULL
      AND provider."lastTestedAt" IS NOT NULL
      AND audit."createdAt" >= provider."lastTestedAt"
      AND app_user."disabledAt" IS NULL
    ORDER BY audit."createdAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'registration-local-password'::text, (
    SELECT app_user."createdAt"::timestamptz
    FROM "AppUser" app_user
    WHERE app_user."role"::text = 'user'
      AND app_user."disabledAt" IS NULL
      AND app_user."passwordHash" IS NOT NULL
      AND app_user."passwordSalt" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "GitHubIdentity" github_identity WHERE github_identity."userId" = app_user."id")
    ORDER BY app_user."createdAt" DESC
    LIMIT 1
  )
  UNION ALL
  SELECT 'registration-github-first'::text, (
    SELECT github_identity."createdAt"::timestamptz
    FROM "GitHubIdentity" github_identity
    JOIN "AppUser" app_user ON app_user."id" = github_identity."userId"
    WHERE app_user."role"::text = 'user'
      AND app_user."disabledAt" IS NULL
      AND app_user."passwordHash" IS NULL
      AND app_user."createdAt" = github_identity."createdAt"
    ORDER BY github_identity."createdAt" DESC
    LIMIT 1
  )
`;

function isCategory(value: string): value is ExternalServiceCategory {
  return EXTERNAL_SERVICE_CATEGORIES.some((category) => category === value);
}

function validateEvidenceRows(rows: readonly ExternalServiceEvidenceRow[]): ReadonlyMap<ExternalServiceCategory, Date | null> {
  if (!Array.isArray(rows) || rows.length !== MAX_ACCEPTANCE_QUERY_ROWS) return invalidEvidence();
  const evidence = new Map<ExternalServiceCategory, Date | null>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null || !isCategory(row.category) || evidence.has(row.category)) return invalidEvidence();
    if (row.latestEvidenceAt !== null && (!(row.latestEvidenceAt instanceof Date) || !Number.isFinite(row.latestEvidenceAt.getTime()))) return invalidEvidence();
    evidence.set(row.category, row.latestEvidenceAt);
  }
  if (evidence.size !== MAX_ACCEPTANCE_QUERY_ROWS) return invalidEvidence();
  return evidence;
}

export async function buildExternalServiceAcceptanceReport(
  db: PrismaClient,
  options: { expected?: readonly ExternalServiceCategory[]; maxAgeHours?: number; now?: Date } = {},
): Promise<ExternalServiceAcceptanceReport> {
  const requestedExpected = options.expected ?? EXTERNAL_SERVICE_CATEGORIES;
  const expectedSet = new Set(requestedExpected);
  const expected = EXTERNAL_SERVICE_CATEGORIES.filter((category) => expectedSet.has(category));
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_EXTERNAL_ACCEPTANCE_MAX_AGE_HOURS;
  const now = options.now ?? new Date();
  if (
    expected.length === 0 || expected.length !== requestedExpected.length ||
    requestedExpected.some((value) => !isCategory(value)) ||
    !Number.isInteger(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 168 ||
    !Number.isFinite(now.getTime())
  ) return invalidArguments();

  const cutoff = new Date(now.getTime() - maxAgeHours * 60 * 60 * 1_000);
  const rows = await db.$queryRaw<ExternalServiceEvidenceRow[]>(EXTERNAL_SERVICE_EVIDENCE_SQL(now));
  const latestEvidence = validateEvidenceRows(rows);
  const required = new Set(expected);
  const categories = Object.freeze(Object.fromEntries(EXTERNAL_SERVICE_CATEGORIES.map((category) => [
    category,
    evaluateExternalServiceCategory(category, latestEvidence.get(category) ?? null, cutoff, required.has(category)),
  ])) as Record<ExternalServiceCategory, ExternalServiceCategoryResult>);

  return Object.freeze({
    ok: expected.every((category) => categories[category].status === "ready"),
    scope: expected.length === EXTERNAL_SERVICE_CATEGORIES.length ? "full" : "scoped",
    checkedAt: now.toISOString(),
    cutoff: cutoff.toISOString(),
    maxAgeHours,
    expected: Object.freeze([...expected]),
    categories,
  });
}
