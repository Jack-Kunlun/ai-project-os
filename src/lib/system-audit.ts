import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import {
  SYSTEM_AUDIT_ACTIONS,
  SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE,
  SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE,
  SYSTEM_AUDIT_RESULTS,
  SYSTEM_AUDIT_SOURCES,
  SYSTEM_AUDIT_SOURCE_LABELS,
  type SystemAuditAction,
  type SystemAuditResult,
  type SystemAuditSource,
} from "@/lib/system-audit-catalog";

export {
  SYSTEM_AUDIT_ACTIONS,
  SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE,
  SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE,
  SYSTEM_AUDIT_RESULTS,
  SYSTEM_AUDIT_SOURCES,
  SYSTEM_AUDIT_SOURCE_LABELS,
} from "@/lib/system-audit-catalog";
export type { SystemAuditAction, SystemAuditResult, SystemAuditSource } from "@/lib/system-audit-catalog";

export type SystemAuditRegistryEntry = Readonly<{
  source: SystemAuditSource;
  label: string;
  table: string;
  selectedFields: readonly string[];
  referenceFields: readonly string[];
  actionField: string;
  allowedActions: readonly string[];
  actionMap: Readonly<Record<string, string>>;
  resultField: string;
  allowedResults: readonly SystemAuditResult[];
  resultMap: Readonly<Partial<Record<SystemAuditResult, readonly string[]>>>;
}>;

function actionMapping(actions: readonly string[]): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(actions.map((action) => [action, action])));
}

function resultMapping(input: Readonly<Partial<Record<SystemAuditResult, readonly string[]>>>): Readonly<Partial<Record<SystemAuditResult, readonly string[]>>> {
  return Object.freeze(input);
}

/**
 * The registry is intentionally declarative.  Query code below is still a
 * static switch so a request can never choose a Prisma delegate, relation, or
 * field by name.
 */
export const SYSTEM_AUDIT_REGISTRY: Readonly<Record<SystemAuditSource, SystemAuditRegistryEntry>> = {
  platformDefaultAiRoute: {
    source: "platformDefaultAiRoute",
    label: SYSTEM_AUDIT_SOURCE_LABELS.platformDefaultAiRoute,
    table: "PlatformDefaultAiRouteAudit",
    selectedFields: ["id", "action", "routeVersion", "providerConfigurationVersion", "actorId", "reason", "createdAt"],
    referenceFields: ["routeId", "providerConnectionId"],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.platformDefaultAiRoute,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.platformDefaultAiRoute),
    resultField: "action",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.platformDefaultAiRoute,
    resultMap: resultMapping({ applied: ["draftCreated", "draftUpdated", "validated", "activated", "retired"] }),
  },
  membershipSubscription: {
    source: "membershipSubscription",
    label: SYSTEM_AUDIT_SOURCE_LABELS.membershipSubscription,
    table: "MembershipSubscriptionAudit",
    selectedFields: ["id", "userId", "actorId", "eventKind", "versionBefore", "versionAfter", "statusBefore", "statusAfter", "reason", "createdAt"],
    referenceFields: ["subscriptionId", "userId"],
    actionField: "eventKind",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.membershipSubscription,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.membershipSubscription),
    resultField: "eventKind",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.membershipSubscription,
    resultMap: resultMapping({ applied: ["grant", "extend"], revoked: ["revoke"] }),
  },
  accountAccess: {
    source: "accountAccess",
    label: SYSTEM_AUDIT_SOURCE_LABELS.accountAccess,
    table: "AccountAccessAudit",
    selectedFields: ["id", "userId", "actorId", "event", "versionBefore", "versionAfter", "disabledAtBefore", "disabledAtAfter", "reason", "createdAt"],
    referenceFields: ["userId", "previewId"],
    actionField: "event",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.accountAccess,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.accountAccess),
    resultField: "event",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.accountAccess,
    resultMap: resultMapping({ disabled: ["disabled"], restored: ["restored"] }),
  },
  membershipAccess: {
    source: "membershipAccess",
    label: SYSTEM_AUDIT_SOURCE_LABELS.membershipAccess,
    table: "MembershipAccessAudit",
    selectedFields: ["id", "workspaceId", "projectId", "userId", "action", "previousState", "newState", "roleSnapshot", "actorId", "createdAt"],
    referenceFields: ["membershipId", "workspaceId", "projectId", "userId"],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.membershipAccess,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.membershipAccess),
    resultField: "action",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.membershipAccess,
    resultMap: resultMapping({ applied: ["confirmed", "bootstrapConfirmed"], pending: ["migrationQuarantined"], revoked: ["revoked"] }),
  },
  workspaceInvitation: {
    source: "workspaceInvitation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.workspaceInvitation,
    table: "WorkspaceInvitationAudit",
    selectedFields: ["id", "workspaceId", "event", "versionBefore", "versionAfter", "statusBefore", "statusAfter", "actorId", "createdAt"],
    referenceFields: ["invitationId", "workspaceId"],
    actionField: "event",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.workspaceInvitation,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.workspaceInvitation),
    resultField: "event",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.workspaceInvitation,
    resultMap: resultMapping({ pending: ["created"], applied: ["accepted"], revoked: ["revoked"] }),
  },
  gitConnectionMutation: {
    source: "gitConnectionMutation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.gitConnectionMutation,
    table: "GitConnectionMutationAudit",
    selectedFields: ["id", "connectionId", "ownerUserId", "action", "statusBefore", "statusAfter", "connectionConfigurationVersion", "impactCount", "executionStatus", "safeErrorCode", "actorId", "createdAt"],
    referenceFields: ["connectionId", "ownerUserId"],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.gitConnectionMutation,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.gitConnectionMutation),
    resultField: "executionStatus",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.gitConnectionMutation,
    resultMap: resultMapping({ pending: ["previewed", "dispatched"], applied: ["completed"], disabled: ["completed"], failed: ["failed"], unknown: ["unknown", "held"] }),
  },
  mcpConnectionMutation: {
    source: "mcpConnectionMutation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.mcpConnectionMutation,
    table: "McpConnectionMutationAudit",
    selectedFields: ["id", "connectionId", "ownerUserId", "action", "statusBefore", "statusAfter", "configurationRevision", "impactCount", "executionStatus", "safeErrorCode", "actorId", "createdAt"],
    referenceFields: ["connectionId", "ownerUserId"],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.mcpConnectionMutation,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.mcpConnectionMutation),
    resultField: "executionStatus",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.mcpConnectionMutation,
    resultMap: resultMapping({ pending: ["previewed", "dispatched"], applied: ["completed"], disabled: ["completed"], failed: ["failed"], unknown: ["unknown", "held"] }),
  },
  mcpToolAttestation: {
    source: "mcpToolAttestation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.mcpToolAttestation,
    table: "McpToolAttestationAudit",
    selectedFields: ["id", "event", "actorId", "controlPlaneVersion", "attestationVersion", "statusBefore", "statusAfter", "connectionConfigurationRevision", "createdAt"],
    referenceFields: ["attestationId", "connectionId", "toolDefinitionId"],
    actionField: "event",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.mcpToolAttestation,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.mcpToolAttestation),
    resultField: "event",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.mcpToolAttestation,
    resultMap: resultMapping({ applied: ["attested"], revoked: ["revoked"] }),
  },
  mcpToolReview: {
    source: "mcpToolReview",
    label: SYSTEM_AUDIT_SOURCE_LABELS.mcpToolReview,
    table: "McpToolReviewAudit",
    // The review note is intentionally absent.  Only its presence, controlled
    // conclusion and risk enums are projected into system audit.
    selectedFields: ["id", "reviewerId", "conclusion", "riskLevel", "riskReasonCode", "evidenceNotePresent", "connectionConfigurationRevision", "reviewerAccountAccessVersion", "transactionId", "createdAt"],
    referenceFields: ["reviewId", "connectionId", "toolDefinitionId"],
    actionField: "conclusion",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.mcpToolReview,
    actionMap: Object.freeze({ attested: "read_only_verified", rejected: "read_only_rejected", reviewed: "needs_research" }),
    resultField: "conclusion",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.mcpToolReview,
    resultMap: resultMapping({ applied: ["read_only_verified"], rejected: ["read_only_rejected"], pending: ["needs_research"] }),
  },
  projectAiProviderDelegation: {
    source: "projectAiProviderDelegation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectAiProviderDelegation,
    table: "ProjectAiProviderDelegationAudit",
    selectedFields: ["id", "projectId", "entity", "action", "delegationVersion", "selectionVersion", "statusBefore", "statusAfter", "selectionSource", "connectionOwnerId", "providerConfigurationVersion", "connectionOwnerAccountAccessVersion", "actorKind", "actorId", "createdAt"],
    referenceFields: ["projectId", "delegationId", "selectionId", "providerConnectionId", "connectionOwnerId"],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectAiProviderDelegation,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectAiProviderDelegation),
    resultField: "action",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.projectAiProviderDelegation,
    resultMap: resultMapping({ applied: ["activated", "platformSelected", "personalSelected", "selectionUpdated"], pending: ["proposed", "ownerConfirmed"], rejected: ["rejected"], revoked: ["revoked"], expired: ["expired"] }),
  },
  projectGitRepositoryDelegation: {
    source: "projectGitRepositoryDelegation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectGitRepositoryDelegation,
    table: "ProjectGitRepositoryDelegationAudit",
    selectedFields: ["id", "projectId", "connectionOwnerId", "action", "delegationVersion", "statusBefore", "statusAfter", "actorKind", "actorId", "connectionConfigurationVersion", "connectionOwnerAccountAccessVersion", "createdAt"],
    referenceFields: ["projectId", "gitConnectionId", "delegationId", "connectionOwnerId"],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectGitRepositoryDelegation,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectGitRepositoryDelegation),
    resultField: "action",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.projectGitRepositoryDelegation,
    resultMap: resultMapping({ applied: ["activated"], pending: ["proposed", "ownerConfirmed"], rejected: ["rejected"], revoked: ["revoked"], expired: ["expired"] }),
  },
  projectMcpConnectionDelegation: {
    source: "projectMcpConnectionDelegation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectMcpConnectionDelegation,
    table: "ProjectMcpConnectionDelegationAudit",
    selectedFields: ["id", "projectId", "connectionOwnerId", "action", "delegationVersion", "statusBefore", "statusAfter", "actorKind", "actorId", "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "createdAt"],
    referenceFields: ["projectId", "mcpConnectionId", "delegationId", "connectionOwnerId"],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectMcpConnectionDelegation,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectMcpConnectionDelegation),
    resultField: "action",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.projectMcpConnectionDelegation,
    resultMap: resultMapping({ applied: ["activated"], pending: ["proposed", "ownerConfirmed"], rejected: ["rejected"], revoked: ["revoked"], expired: ["expired"] }),
  },
  projectMcpToolGrantLedger: {
    source: "projectMcpToolGrantLedger",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectMcpToolGrantLedger,
    table: "ProjectMcpToolGrantLedger",
    selectedFields: ["id", "projectId", "connectionOwnerId", "controlPlaneVersion", "grantVersion", "event", "statusBefore", "statusAfter", "actorId", "delegationVersion", "connectionConfigurationRevision", "createdAt"],
    referenceFields: ["projectId", "grantId", "connectionId", "delegationId", "toolDefinitionId", "attestationId", "connectionOwnerId"],
    actionField: "event",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectMcpToolGrantLedger,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectMcpToolGrantLedger),
    resultField: "event",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.projectMcpToolGrantLedger,
    resultMap: resultMapping({ applied: ["granted"], revoked: ["revoked"] }),
  },
  projectGitManualRun: {
    source: "projectGitManualRun",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectGitManualRun,
    table: "ProjectGitRepositoryManualRunAudit",
    selectedFields: ["id", "projectId", "action", "statusBefore", "statusAfter", "dispatchState", "actorId", "connectionOwnerId", "delegationVersion", "connectionConfigurationVersion", "role", "createdAt"],
    referenceFields: ["projectId"],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectGitManualRun,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectGitManualRun),
    resultField: "action",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.projectGitManualRun,
    resultMap: resultMapping({ applied: ["succeeded"], pending: ["requested", "admitted", "dispatched"], rejected: ["conflict"], failed: ["failed"], unknown: ["unknown"] }),
  },
  projectMcpActionApproval: {
    source: "projectMcpActionApproval",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectMcpActionApproval,
    table: "ProjectMcpActionLedger",
    selectedFields: ["id", "projectId", "event", "statusBefore", "statusAfter", "stateVersion", "actorId", "connectionOwnerId", "grantVersion", "delegationVersion", "attestationVersion", "createdAt"],
    referenceFields: ["projectId"],
    actionField: "event",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectMcpActionApproval,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectMcpActionApproval),
    resultField: "event",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.projectMcpActionApproval,
    resultMap: resultMapping({ applied: ["approved"], pending: ["proposed"], rejected: ["rejected"], cancelled: ["cancelled"] }),
  },
  projectMcpActionRuntime: {
    source: "projectMcpActionRuntime",
    label: SYSTEM_AUDIT_SOURCE_LABELS.projectMcpActionRuntime,
    table: "ProjectMcpActionRuntimeLedger",
    selectedFields: ["id", "projectId", "event", "statusBefore", "statusAfter", "stateVersion", "actorKind", "actorId", "connectionOwnerId", "safeErrorCode", "resultBytes", "resultNodes", "resultDepth", "createdAt"],
    referenceFields: ["projectId"],
    actionField: "event",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectMcpActionRuntime,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.projectMcpActionRuntime),
    resultField: "event",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.projectMcpActionRuntime,
    resultMap: resultMapping({ applied: ["succeeded"], pending: ["reserved"], failed: ["failed"], unknown: ["unknown"], expired: ["expired"], invalidated: ["invalidated"] }),
  },
  aiRuntime: {
    source: "aiRuntime",
    label: SYSTEM_AUDIT_SOURCE_LABELS.aiRuntime,
    table: "AiAuditEvent",
    selectedFields: ["id", "projectId", "eventType", "safeCode", "createdAt"],
    referenceFields: ["projectId"],
    actionField: "eventType",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.aiRuntime,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.aiRuntime),
    resultField: "eventType",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.aiRuntime,
    resultMap: resultMapping({ applied: ["policyCreated", "policyAdvanced", "grantIssued", "runClaimed", "dispatchSent", "runSucceeded", "attemptSucceeded"], revoked: ["grantRevoked"], pending: ["runCreated"], rejected: ["preflightRejected", "scannerRejected", "budgetRejected"], failed: ["runFailed", "attemptFailed"], cancelled: ["runCancelled", "attemptCancelled"], unknown: ["runUnknown", "attemptUnknown"] }),
  },
  webAiConfirmation: {
    source: "webAiConfirmation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.webAiConfirmation,
    table: "WebAiConfirmationChallenge",
    selectedFields: ["id", "projectId", "actorId", "actorAccountAccessVersion", "targetAction", "issuedAt", "expiresAt", "consumedAt"],
    referenceFields: ["projectId"],
    actionField: "targetAction",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.webAiConfirmation,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.webAiConfirmation),
    resultField: "targetAction",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.webAiConfirmation,
    resultMap: resultMapping({ applied: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.webAiConfirmation, pending: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.webAiConfirmation, expired: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.webAiConfirmation }),
  },
  platformProviderProbe: {
    source: "platformProviderProbe",
    label: SYSTEM_AUDIT_SOURCE_LABELS.platformProviderProbe,
    table: "PlatformProviderProbeLedger",
    selectedFields: ["id", "actorId", "event", "capability", "units", "safeErrorCode", "createdAt"],
    referenceFields: [],
    actionField: "event",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.platformProviderProbe,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.platformProviderProbe),
    resultField: "event",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.platformProviderProbe,
    resultMap: resultMapping({ applied: ["settled", "released"], pending: ["reserved", "dispatched"], rejected: ["rejected"], unknown: ["held"] }),
  },
  platformGrantOfferPolicy: {
    source: "platformGrantOfferPolicy",
    label: SYSTEM_AUDIT_SOURCE_LABELS.platformGrantOfferPolicy,
    table: "PlatformGrantOfferPolicyAudit",
    selectedFields: ["id", "action", "statusBefore", "statusAfter", "offerVersion", "amount", "validForDays", "eligibilityKey", "reasonRecorded", "actorId", "createdAt"],
    referenceFields: [],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.platformGrantOfferPolicy,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.platformGrantOfferPolicy),
    resultField: "action",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.platformGrantOfferPolicy,
    resultMap: resultMapping({ applied: ["activated"], pending: ["created"], revoked: ["retired"] }),
  },
  platformCreditGovernance: {
    source: "platformCreditGovernance",
    label: SYSTEM_AUDIT_SOURCE_LABELS.platformCreditGovernance,
    table: "PlatformTokenGrantAudit",
    selectedFields: ["id", "event", "versionBefore", "versionAfter", "statusBefore", "statusAfter", "userId", "actorId", "reason", "createdAt"],
    referenceFields: [],
    actionField: "event",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.platformCreditGovernance,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.platformCreditGovernance),
    resultField: "event",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.platformCreditGovernance,
    resultMap: resultMapping({ applied: ["grant"], revoked: ["revoke"] }),
  },
  workspaceRoleMutation: {
    source: "workspaceRoleMutation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.workspaceRoleMutation,
    table: "WorkspaceRoleMutationAudit",
    // Keep this registry projection deliberately narrower than the durable
    // audit row: reason, request keys, fingerprints and membership IDs are
    // governance evidence, not user-facing system-audit data.
    selectedFields: ["id", "event", "oldRole", "newRole", "ownerCountBefore", "ownerCountAfter", "projectGrantCount", "actorId", "subjectId", "createdAt"],
    referenceFields: [],
    actionField: "event",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.workspaceRoleMutation,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.workspaceRoleMutation),
    resultField: "event",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.workspaceRoleMutation,
    resultMap: resultMapping({ applied: ["roleChanged"] }),
  },
  membershipApplication: {
    source: "membershipApplication",
    label: SYSTEM_AUDIT_SOURCE_LABELS.membershipApplication,
    table: "MembershipApplicationAudit",
    selectedFields: ["id", "event", "statusBefore", "statusAfter", "statusVersionBefore", "statusVersionAfter", "userId", "actorId", "reason", "createdAt"],
    referenceFields: [],
    actionField: "event",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.membershipApplication,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.membershipApplication),
    resultField: "event",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.membershipApplication,
    resultMap: resultMapping({ pending: ["requested"], applied: ["fulfilled"], rejected: ["rejected"], cancelled: ["cancelled"] }),
  },
  accountEntitlementActivation: {
    source: "accountEntitlementActivation",
    label: SYSTEM_AUDIT_SOURCE_LABELS.accountEntitlementActivation,
    table: "AccountEntitlementActivationAudit",
    selectedFields: ["id", "userId", "source", "action", "decision", "statusAfter", "actorKind", "actorId", "offerVersion", "offerAmount", "offerValidForDays", "eligibilityKey", "policyRevision", "createdAt"],
    referenceFields: ["userId"],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.accountEntitlementActivation,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.accountEntitlementActivation),
    resultField: "action",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.accountEntitlementActivation,
    resultMap: resultMapping({ applied: ["created", "linked"], rejected: ["created", "linked"] }),
  },
  accountEntitlementBackfill: {
    source: "accountEntitlementBackfill",
    label: SYSTEM_AUDIT_SOURCE_LABELS.accountEntitlementBackfill,
    table: "AccountEntitlementBackfillAudit",
    selectedFields: [
      "id", "action", "statusBefore", "statusAfter", "actorId", "reasonRecorded", "createdAt",
      "run.candidateCount", "run.alreadyIssuedCount", "run.eligibleMissingCount", "run.legacyAmbiguousCount",
      "run.grantedCount", "run.skippedCount", "run.expiresAt",
      "run.confirmedAt", "run.activeOfferVersion", "run.activeOfferAmount", "run.activeOfferValidForDays",
    ],
    referenceFields: [],
    actionField: "action",
    allowedActions: SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.accountEntitlementBackfill,
    actionMap: actionMapping(SYSTEM_AUDIT_ALLOWED_ACTIONS_BY_SOURCE.accountEntitlementBackfill),
    resultField: "action",
    allowedResults: SYSTEM_AUDIT_ALLOWED_RESULTS_BY_SOURCE.accountEntitlementBackfill,
    resultMap: resultMapping({ pending: ["previewed", "confirmed"], applied: ["executed"], rejected: ["stale"], expired: ["expired"], failed: ["failed"] }),
  },
};

export type SystemAuditFilters = Readonly<{
  source?: SystemAuditSource;
  action?: SystemAuditAction;
  result?: SystemAuditResult;
  actor?: string;
  subject?: string;
  projectId?: string;
  workspaceId?: string;
  userId?: string;
  from?: Date;
  to?: Date;
}>;

export type SystemAuditQuery = Readonly<SystemAuditFilters & {
  cursor?: string;
  pageSize?: number;
}>;

export const SYSTEM_AUDIT_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const SYSTEM_AUDIT_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
const SYSTEM_AUDIT_CURSOR_CONTEXT = "ai-project-os:system-audit-cursor:v1";
const SYSTEM_AUDIT_FILTER_CONTEXT = "ai-project-os:system-audit-filter:v1";
export const SYSTEM_AUDIT_MAX_PAGE_SIZE = 50;
const MAX_USER_LOOKUP_RESULTS = 2;
const MAX_HYDRATED_USER_IDS = SYSTEM_AUDIT_MAX_PAGE_SIZE * 2;
export const SYSTEM_AUDIT_MAX_WORKSPACE_PROJECTS = 1_000;

export type SystemAuditPrincipal = Readonly<{
  kind: "user" | "system" | "unrecorded";
  id: string | null;
  username: string | null;
  displayName: string | null;
}>;

export type SystemAuditReferences = Readonly<Record<string, string>>;

export type SystemAuditEvidence = Readonly<{
  before: Readonly<Record<string, string | number | boolean | null>>;
  after: Readonly<Record<string, string | number | boolean | null>>;
  versions: Readonly<Record<string, number | null>>;
  safeErrorCode: string | null;
  reasonRecorded: boolean;
}>;

export type SystemAuditEvent = Readonly<{
  id: string;
  source: SystemAuditSource;
  action: string;
  result: SystemAuditResult;
  occurredAt: string;
  actor: SystemAuditPrincipal;
  subject: SystemAuditPrincipal | null;
  references: SystemAuditReferences;
  evidence: SystemAuditEvidence;
}>;

export type SystemAuditList = Readonly<{
  events: readonly SystemAuditEvent[];
  nextCursor: string | null;
  snapshotAt: string;
  pageSize: number;
}>;

const querySchema = z.object({
  source: z.enum(SYSTEM_AUDIT_SOURCES).optional(),
  action: z.enum(SYSTEM_AUDIT_ACTIONS).optional(),
  result: z.enum(SYSTEM_AUDIT_RESULTS).optional(),
  actor: z.string().trim().min(1).max(160).optional(),
  subject: z.string().trim().min(1).max(160).optional(),
  projectId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  to: z.string().datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  cursor: z.string().min(1).max(2_048).optional(),
  pageSize: z.coerce.number().int().min(1).max(SYSTEM_AUDIT_MAX_PAGE_SIZE).default(20),
}).strict().superRefine((value, context) => {
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
    context.addIssue({ code: "custom", path: ["from"], message: "from must be before to" });
  }
});

export function parseSystemAuditQuery(input: Readonly<Record<string, string | undefined>>): SystemAuditQuery {
  return querySchema.parse(input) as SystemAuditQuery;
}

type CursorPayload = Readonly<{
  version: 1;
  filterHash: string;
  snapshotAt: string;
  createdAt: string;
  source: SystemAuditSource;
  id: string;
}>;

const CURSOR_VERSION = 1 as const;
const BASE64URL_UNPADDED_PATTERN = /^[A-Za-z0-9_-]+$/u;

function auditError(code: string, message: string, status = 400): never {
  throw new ApiError(status, code, message);
}

function canonicalFilters(filters: SystemAuditFilters): string {
  return JSON.stringify({
    source: filters.source ?? null,
    action: filters.action ?? null,
    result: filters.result ?? null,
    actor: filters.actor ?? null,
    subject: filters.subject ?? null,
    projectId: filters.projectId ?? null,
    workspaceId: filters.workspaceId ?? null,
    userId: filters.userId ?? null,
    from: filters.from?.toISOString() ?? null,
    to: filters.to?.toISOString() ?? null,
  });
}

/** Bind the effective filters without exposing an unauthenticated checksum. */
async function filterHash(filters: SystemAuditFilters): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update(SYSTEM_AUDIT_FILTER_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(canonicalFilters(filters), "utf8")
    .digest("hex");
}

async function cursorSignature(encodedPayload: string): Promise<string> {
  const key = await loadOrCreateMasterKey();
  return createHmac("sha256", key)
    .update(SYSTEM_AUDIT_CURSOR_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

async function encodeCursor(payload: CursorPayload): Promise<string> {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${await cursorSignature(encodedPayload)}`;
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!BASE64URL_UNPADDED_PATTERN.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

async function decodeCursor(value: string): Promise<CursorPayload> {
  const [encodedPayload, signature, ...rest] = value.split(".");
  if (!encodedPayload || !signature || rest.length > 0) return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标无效");
  const decodedPayload = decodeCanonicalBase64Url(encodedPayload);
  const supplied = decodeCanonicalBase64Url(signature);
  if (decodedPayload === null || supplied === null) return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标无效");
  const expectedSignature = await cursorSignature(encodedPayload);
  const expected = decodeCanonicalBase64Url(expectedSignature);
  if (expected === null || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标无效");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedPayload.toString("utf8")) as unknown;
  } catch {
    return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标无效");
  }
  const result = z.object({
    version: z.literal(CURSOR_VERSION),
    filterHash: z.string().length(64),
    snapshotAt: z.string().datetime({ offset: true }),
    createdAt: z.string().datetime({ offset: true }),
    source: z.enum(SYSTEM_AUDIT_SOURCES),
    id: z.string().uuid(),
  }).strict().safeParse(parsed);
  if (!result.success) return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标无效");
  return result.data;
}

type RawAuditEvent = Readonly<{
  id: string;
  source: SystemAuditSource;
  action: string;
  result: SystemAuditResult;
  createdAt: Date;
  actorId: string | null;
  actorKind: "user" | "system" | "unrecorded";
  subjectId: string | null;
  references: SystemAuditReferences;
  evidence: SystemAuditEvidence;
}>;

type AuditValue = string | number | boolean | null;

function safeReferences(input: Readonly<{
  categories: readonly string[];
  projectId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
}>): SystemAuditReferences {
  return Object.freeze(Object.fromEntries([
    ["categories", input.categories.join(",")],
    ...(input.projectId === undefined || input.projectId === null ? [] : [["projectId", input.projectId]]),
    ...(input.workspaceId === undefined || input.workspaceId === null ? [] : [["workspaceId", input.workspaceId]]),
    ...(input.userId === undefined || input.userId === null ? [] : [["userId", input.userId]]),
  ]));
}

function principalKind(value: unknown): "user" | "system" | "unrecorded" {
  if (value === "user") return "user";
  if (typeof value === "string" && value.toLowerCase().includes("system")) return "system";
  return "unrecorded";
}

function statusResult(action: string, statusAfter: string | null | undefined): SystemAuditResult {
  if (action === "disabled" || action === "disable") return "disabled";
  if (action === "restored" || action === "restore") return "restored";
  if (action === "rejected") return "rejected";
  if (action === "revoked" || action === "revoke") return "revoked";
  if (action === "expired") return "expired";
  if (statusAfter === "rejected") return "rejected";
  if (statusAfter === "revoked") return "revoked";
  if (statusAfter === "expired") return "expired";
  if (statusAfter === "draft" || statusAfter === "ownerConfirmed" || statusAfter === "pending") return "pending";
  if (statusAfter === "active" || statusAfter === "confirmed") return "applied";
  if (action.length > 0) return "applied";
  return "unknown";
}

function manualRunResult(action: string, statusAfter: string): SystemAuditResult {
  if (action === "succeeded" || statusAfter === "succeeded") return "applied";
  if (action === "failed" || statusAfter === "failed") return "failed";
  if (action === "unknown" || statusAfter === "unknown") return "unknown";
  if (action === "conflict") return "rejected";
  return "pending";
}

function aiRuntimeResult(action: string): SystemAuditResult {
  if (["preflightRejected", "scannerRejected", "budgetRejected"].includes(action)) return "rejected";
  if (["runFailed", "attemptFailed"].includes(action)) return "failed";
  if (["runCancelled", "attemptCancelled"].includes(action)) return "cancelled";
  if (["runUnknown", "attemptUnknown"].includes(action)) return "unknown";
  if (action === "grantRevoked") return "revoked";
  if (action === "runCreated") return "pending";
  return "applied";
}

const AI_SAFE_ERROR_CODES: Readonly<Record<string, string>> = {
  aiDisabled: "AI_DISABLED",
  AI_DISABLED: "AI_DISABLED",
  aiProviderDisabled: "AI_PROVIDER_DISABLED",
  AI_PROVIDER_DISABLED: "AI_PROVIDER_DISABLED",
  aiInvalidOperationKeyInput: "AI_INVALID_OPERATION_KEY_INPUT",
  AI_INVALID_OPERATION_KEY_INPUT: "AI_INVALID_OPERATION_KEY_INPUT",
  aiInvalidStateTransition: "AI_INVALID_STATE_TRANSITION",
  AI_INVALID_STATE_TRANSITION: "AI_INVALID_STATE_TRANSITION",
  aiRedispatchForbidden: "AI_REDISPATCH_FORBIDDEN",
  AI_REDISPATCH_FORBIDDEN: "AI_REDISPATCH_FORBIDDEN",
  aiProviderIncomplete: "AI_PROVIDER_INCOMPLETE",
  AI_PROVIDER_INCOMPLETE: "AI_PROVIDER_INCOMPLETE",
  aiProviderUnknown: "AI_PROVIDER_UNKNOWN",
  AI_PROVIDER_UNKNOWN: "AI_PROVIDER_UNKNOWN",
  aiProviderFailed: "AI_PROVIDER_FAILED",
  AI_PROVIDER_FAILED: "AI_PROVIDER_FAILED",
  aiProviderCancelled: "AI_PROVIDER_CANCELLED",
  AI_PROVIDER_CANCELLED: "AI_PROVIDER_CANCELLED",
  aiDispatchNotSent: "AI_DISPATCH_NOT_SENT",
  AI_DISPATCH_NOT_SENT: "AI_DISPATCH_NOT_SENT",
  aiPolicyDenied: "AI_POLICY_DENIED",
  AI_POLICY_DENIED: "AI_POLICY_DENIED",
  aiGrantDenied: "AI_GRANT_DENIED",
  AI_GRANT_DENIED: "AI_GRANT_DENIED",
  aiScannerDenied: "AI_SCANNER_DENIED",
  AI_SCANNER_DENIED: "AI_SCANNER_DENIED",
  aiBudgetDenied: "AI_BUDGET_DENIED",
  AI_BUDGET_DENIED: "AI_BUDGET_DENIED",
  aiInvalidProviderResponse: "AI_INVALID_PROVIDER_RESPONSE",
  AI_INVALID_PROVIDER_RESPONSE: "AI_INVALID_PROVIDER_RESPONSE",
  sourceInUse: "SOURCE_IN_USE",
  SOURCE_IN_USE: "SOURCE_IN_USE",
};

const MCP_SAFE_ERROR_CODES = new Set([
  "MCP_NETWORK_BLOCKED",
  "MCP_NETWORK_CHANGED",
  "MCP_TRANSPORT_FAILED",
  "MCP_PROTOCOL_UNSUPPORTED",
  "MCP_RESPONSE_INVALID",
  "MCP_RESPONSE_TOO_LARGE",
  "MCP_TOOL_INPUT_REQUIRED_UNSUPPORTED",
  "MCP_TOOL_OUTPUT_INVALID",
  "MCP_TOOL_CALL_FAILED",
  "MCP_DISPATCH_APPROVAL_EXPIRED",
  "MCP_DISPATCH_SOURCE_DRIFT",
  "MCP_DISPATCH_OWNER_DRIFT",
  "MCP_DISPATCH_OWNER_EPOCH_DRIFT",
  "MCP_DISPATCH_RESERVATION_STALE",
  "MCP_AUTH_UNAVAILABLE",
  "MCP_DISPATCH_FAILED",
  "MCP_DISPATCH_UNKNOWN",
  "MCP_EXTERNAL_IO_PLANNED_NOT_DISPATCHED",
]);

function safeAiErrorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return AI_SAFE_ERROR_CODES[String(value)] ?? "AI_PROVIDER_UNKNOWN";
}

function safeMcpErrorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value);
  return MCP_SAFE_ERROR_CODES.has(normalized) ? normalized : "MCP_DISPATCH_UNKNOWN";
}

function evidence(
  before: Readonly<Record<string, AuditValue>> = {},
  after: Readonly<Record<string, AuditValue>> = {},
  versions: Readonly<Record<string, number | null>> = {},
  reasonRecorded = false,
  safeErrorCode: string | null = null,
): SystemAuditEvidence {
  return Object.freeze({
    before: Object.freeze(before),
    after: Object.freeze(after),
    versions: Object.freeze(versions),
    safeErrorCode,
    reasonRecorded,
  });
}

function rawEvent(input: Omit<RawAuditEvent, "result"> & { result?: SystemAuditResult }): RawAuditEvent {
  return Object.freeze({ ...input, result: input.result ?? "unknown" });
}

type PlatformRow = Prisma.PlatformDefaultAiRouteAuditGetPayload<{ select: typeof platformSelect }>;
const platformSelect = {
  id: true,
  action: true,
  routeVersion: true,
  providerConfigurationVersion: true,
  actorId: true,
  reason: true,
  createdAt: true,
} as const;

type SubscriptionRow = Prisma.MembershipSubscriptionAuditGetPayload<{ select: typeof subscriptionSelect }>;
const subscriptionSelect = {
  id: true,
  userId: true,
  actorId: true,
  eventKind: true,
  versionBefore: true,
  versionAfter: true,
  statusBefore: true,
  statusAfter: true,
  reason: true,
  createdAt: true,
} as const;

type AccountAccessRow = Prisma.AccountAccessAuditGetPayload<{ select: typeof accountAccessSelect }>;
const accountAccessSelect = {
  id: true,
  userId: true,
  actorId: true,
  event: true,
  versionBefore: true,
  versionAfter: true,
  disabledAtBefore: true,
  disabledAtAfter: true,
  reason: true,
  createdAt: true,
} as const;

type MembershipAccessRow = Prisma.MembershipAccessAuditGetPayload<{ select: typeof membershipAccessSelect }>;
const membershipAccessSelect = {
  id: true,
  workspaceId: true,
  projectId: true,
  userId: true,
  action: true,
  previousState: true,
  newState: true,
  roleSnapshot: true,
  actorId: true,
  createdAt: true,
} as const;

type InvitationRow = Prisma.WorkspaceInvitationAuditGetPayload<{ select: typeof invitationSelect }>;
const invitationSelect = {
  id: true,
  workspaceId: true,
  event: true,
  versionBefore: true,
  versionAfter: true,
  statusBefore: true,
  statusAfter: true,
  actorId: true,
  createdAt: true,
} as const;

type GitConnectionMutationAuditRow = Prisma.GitConnectionMutationAuditGetPayload<{ select: typeof gitConnectionMutationAuditSelect }>;
const gitConnectionMutationAuditSelect = {
  id: true,
  connectionId: true,
  ownerUserId: true,
  action: true,
  statusBefore: true,
  statusAfter: true,
  connectionConfigurationVersion: true,
  impactCount: true,
  executionStatus: true,
  safeErrorCode: true,
  actorId: true,
  createdAt: true,
} as const;

type McpConnectionMutationAuditRow = Prisma.McpConnectionMutationAuditGetPayload<{ select: typeof mcpConnectionMutationAuditSelect }>;
const mcpConnectionMutationAuditSelect = {
  id: true,
  connectionId: true,
  ownerUserId: true,
  action: true,
  statusBefore: true,
  statusAfter: true,
  configurationRevision: true,
  impactCount: true,
  executionStatus: true,
  safeErrorCode: true,
  actorId: true,
  createdAt: true,
} as const;

type AttestationRow = Prisma.McpToolAttestationAuditGetPayload<{ select: typeof attestationSelect }>;
const attestationSelect = {
  id: true,
  event: true,
  actorId: true,
  controlPlaneVersion: true,
  attestationVersion: true,
  statusBefore: true,
  statusAfter: true,
  connectionConfigurationRevision: true,
  createdAt: true,
} as const;

type McpToolReviewAuditRow = Prisma.McpToolReviewAuditGetPayload<{ select: typeof mcpToolReviewAuditSelect }>;
const mcpToolReviewAuditSelect = {
  id: true,
  reviewId: true,
  connectionId: true,
  toolDefinitionId: true,
  reviewerId: true,
  conclusion: true,
  riskLevel: true,
  riskReasonCode: true,
  evidenceNotePresent: true,
  connectionConfigurationRevision: true,
  reviewerAccountAccessVersion: true,
  transactionId: true,
  createdAt: true,
} as const;

type ProjectAiRow = Prisma.ProjectAiProviderDelegationAuditGetPayload<{ select: typeof projectAiSelect }>;
const projectAiSelect = {
  id: true,
  projectId: true,
  entity: true,
  action: true,
  delegationVersion: true,
  selectionVersion: true,
  statusBefore: true,
  statusAfter: true,
  selectionSource: true,
  connectionOwnerId: true,
  providerConfigurationVersion: true,
  connectionOwnerAccountAccessVersion: true,
  actorKind: true,
  actorId: true,
  createdAt: true,
} as const;

type GitRow = Prisma.ProjectGitRepositoryDelegationAuditGetPayload<{ select: typeof gitSelect }>;
const gitSelect = {
  id: true,
  projectId: true,
  connectionOwnerId: true,
  action: true,
  delegationVersion: true,
  statusBefore: true,
  statusAfter: true,
  actorKind: true,
  actorId: true,
  connectionConfigurationVersion: true,
  connectionOwnerAccountAccessVersion: true,
  createdAt: true,
} as const;

type McpDelegationRow = Prisma.ProjectMcpConnectionDelegationAuditGetPayload<{ select: typeof mcpDelegationSelect }>;
const mcpDelegationSelect = {
  id: true,
  projectId: true,
  connectionOwnerId: true,
  action: true,
  delegationVersion: true,
  statusBefore: true,
  statusAfter: true,
  actorKind: true,
  actorId: true,
  connectionConfigurationRevision: true,
  connectionOwnerAccountAccessVersion: true,
  createdAt: true,
} as const;

type GrantRow = Prisma.ProjectMcpToolGrantLedgerGetPayload<{ select: typeof grantSelect }>;
const grantSelect = {
  id: true,
  projectId: true,
  connectionOwnerId: true,
  controlPlaneVersion: true,
  grantVersion: true,
  event: true,
  statusBefore: true,
  statusAfter: true,
  actorId: true,
  delegationVersion: true,
  connectionConfigurationRevision: true,
  createdAt: true,
} as const;

type GitManualRunRow = Prisma.ProjectGitRepositoryManualRunAuditGetPayload<{ select: typeof gitManualRunSelect }>;
const gitManualRunSelect = {
  id: true,
  projectId: true,
  action: true,
  statusBefore: true,
  statusAfter: true,
  dispatchState: true,
  actorId: true,
  connectionOwnerId: true,
  delegationVersion: true,
  connectionConfigurationVersion: true,
  role: true,
  createdAt: true,
} as const;

type McpActionApprovalRow = Prisma.ProjectMcpActionLedgerGetPayload<{ select: typeof mcpActionApprovalSelect }>;
const mcpActionApprovalSelect = {
  id: true,
  projectId: true,
  event: true,
  statusBefore: true,
  statusAfter: true,
  stateVersion: true,
  actorId: true,
  connectionOwnerId: true,
  grantVersion: true,
  delegationVersion: true,
  attestationVersion: true,
  createdAt: true,
} as const;

type McpActionRuntimeRow = Prisma.ProjectMcpActionRuntimeLedgerGetPayload<{ select: typeof mcpActionRuntimeSelect }>;
const mcpActionRuntimeSelect = {
  id: true,
  projectId: true,
  event: true,
  statusBefore: true,
  statusAfter: true,
  stateVersion: true,
  actorKind: true,
  actorId: true,
  connectionOwnerId: true,
  safeErrorCode: true,
  resultBytes: true,
  resultNodes: true,
  resultDepth: true,
  createdAt: true,
} as const;

type AiRuntimeRow = Prisma.AiAuditEventGetPayload<{ select: typeof aiRuntimeSelect }>;
const aiRuntimeSelect = {
  id: true,
  projectId: true,
  eventType: true,
  safeCode: true,
  createdAt: true,
} as const;

type WebAiConfirmationRow = Prisma.WebAiConfirmationChallengeGetPayload<{ select: typeof webAiConfirmationSelect }>;
const webAiConfirmationSelect = {
  id: true,
  projectId: true,
  actorId: true,
  actorAccountAccessVersion: true,
  targetAction: true,
  issuedAt: true,
  expiresAt: true,
  consumedAt: true,
} as const;

type PlatformProviderProbeRow = Prisma.PlatformProviderProbeLedgerGetPayload<{ select: typeof platformProviderProbeSelect }>;
const platformProviderProbeSelect = {
  id: true,
  actorId: true,
  event: true,
  capability: true,
  units: true,
  safeErrorCode: true,
  createdAt: true,
} as const;

type PlatformGrantOfferPolicyAuditRow = Prisma.PlatformGrantOfferPolicyAuditGetPayload<{ select: typeof platformGrantOfferPolicyAuditSelect }>;
const platformGrantOfferPolicyAuditSelect = {
  id: true,
  action: true,
  statusBefore: true,
  statusAfter: true,
  offerVersion: true,
  amount: true,
  validForDays: true,
  eligibilityKey: true,
  reasonRecorded: true,
  actorId: true,
  createdAt: true,
} as const;

type AccountEntitlementActivationAuditRow = Prisma.AccountEntitlementActivationAuditGetPayload<{ select: typeof accountEntitlementActivationAuditSelect }>;
const accountEntitlementActivationAuditSelect = {
  id: true,
  userId: true,
  source: true,
  action: true,
  decision: true,
  statusAfter: true,
  actorKind: true,
  actorId: true,
  offerVersion: true,
  offerAmount: true,
  offerValidForDays: true,
  eligibilityKey: true,
  policyRevision: true,
  createdAt: true,
} as const;

type AccountEntitlementBackfillAuditRow = Prisma.AccountEntitlementBackfillAuditGetPayload<{ select: typeof accountEntitlementBackfillAuditSelect }>;
const accountEntitlementBackfillAuditSelect = {
  id: true,
  action: true,
  statusBefore: true,
  statusAfter: true,
  actorId: true,
  reasonRecorded: true,
  createdAt: true,
  run: {
    select: {
      candidateCount: true,
      alreadyIssuedCount: true,
      eligibleMissingCount: true,
      legacyAmbiguousCount: true,
      grantedCount: true,
      skippedCount: true,
      expiresAt: true,
      confirmedAt: true,
      activeOfferVersion: true,
      activeOfferAmount: true,
      activeOfferValidForDays: true,
    },
  },
} as const;

type PlatformCreditGovernanceAuditRow = Prisma.PlatformTokenGrantAuditGetPayload<{ select: typeof platformCreditGovernanceAuditSelect }>;
const platformCreditGovernanceAuditSelect = {
  id: true,
  event: true,
  versionBefore: true,
  versionAfter: true,
  statusBefore: true,
  statusAfter: true,
  userId: true,
  actorId: true,
  reason: true,
  createdAt: true,
} as const;

type WorkspaceRoleMutationAuditRow = Prisma.WorkspaceRoleMutationAuditGetPayload<{ select: typeof workspaceRoleMutationAuditSelect }>;
const workspaceRoleMutationAuditSelect = {
  id: true,
  event: true,
  oldRole: true,
  newRole: true,
  ownerCountBefore: true,
  ownerCountAfter: true,
  projectGrantCount: true,
  actorId: true,
  subjectId: true,
  createdAt: true,
} as const;

type MembershipApplicationAuditRow = Prisma.MembershipApplicationAuditGetPayload<{ select: typeof membershipApplicationAuditSelect }>;
const membershipApplicationAuditSelect = {
  id: true,
  event: true,
  statusBefore: true,
  statusAfter: true,
  statusVersionBefore: true,
  statusVersionAfter: true,
  userId: true,
  actorId: true,
  reason: true,
  createdAt: true,
} as const;

type QueryContext = Readonly<{
  db: PrismaClient;
  filters: SystemAuditFilters;
  actorIds?: readonly string[];
  subjectIds?: readonly string[];
  workspaceProjectIds?: readonly string[];
  snapshotAt: Date;
  cursor: CursorPayload | null;
  auditId?: string;
  take: number;
}>;

type SourceWhereOptions = Readonly<{
  actorField?: string;
  subjectField?: string;
  projectField?: string;
  workspaceField?: string;
  actorKindField?: string;
}>;

function temporalWhere(context: QueryContext, source: SystemAuditSource, dateField = "createdAt"): Record<string, unknown> {
  const dateRange: Record<string, Date> = { lte: context.snapshotAt };
  if (context.filters.from !== undefined) dateRange.gte = context.filters.from;
  if (context.filters.to !== undefined) dateRange.lte = context.filters.to;
  const cursor = context.cursor;
  if (cursor === null) return { [dateField]: dateRange };
  if (source < cursor.source) return { [dateField]: { ...dateRange, lt: new Date(cursor.createdAt) } };
  if (source > cursor.source) return { [dateField]: { ...dateRange, lte: new Date(cursor.createdAt) } };
  return {
    AND: [{
      OR: [
        { [dateField]: { ...dateRange, lt: new Date(cursor.createdAt) } },
        { [dateField]: { ...dateRange, equals: new Date(cursor.createdAt) }, id: { lt: cursor.id } },
      ],
    }],
  };
}

function sourceWhere(context: QueryContext, source: SystemAuditSource, options: SourceWhereOptions): Record<string, unknown> {
  const where: Record<string, unknown> = { ...temporalWhere(context, source, source === "webAiConfirmation" ? "issuedAt" : "createdAt") };
  const filters = context.filters;
  const impossible = { in: [] as string[] };
  const registry = SYSTEM_AUDIT_REGISTRY[source];
  if (context.auditId !== undefined) where.id = context.auditId;
  if (filters.action !== undefined) {
    const mappedAction = registry.actionMap[filters.action];
    if (mappedAction === undefined) where.id = impossible;
    else where[registry.actionField] = mappedAction;
  }
  if (filters.projectId !== undefined) {
    if (options.projectField === undefined) where.id = impossible;
    else where[options.projectField] = filters.projectId;
  }
  if (filters.workspaceId !== undefined) {
    if (options.workspaceField !== undefined) where[options.workspaceField] = filters.workspaceId;
    else if (options.projectField !== undefined) {
      const projectIds = context.workspaceProjectIds ?? [];
      if (filters.projectId !== undefined) {
        where[options.projectField] = projectIds.includes(filters.projectId) ? filters.projectId : impossible;
      } else {
        where[options.projectField] = { in: [...projectIds] };
      }
    } else where.id = impossible;
  }
  if (filters.userId !== undefined) {
    if (options.subjectField === undefined) where.id = impossible;
    else where[options.subjectField] = filters.userId;
  }
  if (context.actorIds !== undefined) {
    if (options.actorField === undefined) where.id = impossible;
    else {
      where[options.actorField] = { in: context.actorIds };
      if (options.actorKindField !== undefined) where[options.actorKindField] = "owner";
    }
  }
  if (context.subjectIds !== undefined) {
    if (options.subjectField === undefined) where.id = impossible;
    else where[options.subjectField] = { in: context.subjectIds };
  }
  if (filters.result !== undefined && source === "webAiConfirmation") {
    if (filters.result === "applied") {
      where.consumedAt = { lte: context.snapshotAt };
    } else if (filters.result === "expired" || filters.result === "pending") {
      const existingAnd = Array.isArray(where.AND) ? where.AND : [];
      const expiresAt = filters.result === "expired"
        ? { lte: context.snapshotAt }
        : { gt: context.snapshotAt };
      where.AND = [
        ...existingAnd,
        {
          OR: [
            { consumedAt: null, expiresAt },
            { consumedAt: { gt: context.snapshotAt }, expiresAt },
          ],
        },
      ];
    } else where.id = impossible;
  } else if (filters.result !== undefined && source === "platformGrantOfferPolicy") {
    if (filters.result === "pending") {
      if (filters.action !== undefined && filters.action !== "created") where.id = impossible;
      else {
        where.action = "created";
        where.statusAfter = "draft";
      }
    } else if (filters.result === "applied") {
      if (filters.action === undefined) {
        where.OR = [
          { action: "created", statusAfter: "active" },
          { action: "activated" },
        ];
      } else if (filters.action === "created") {
        where.action = "created";
        where.statusAfter = "active";
      } else if (filters.action !== "activated") where.id = impossible;
    } else if (filters.result === "revoked") {
      if (filters.action !== undefined && filters.action !== "retired") where.id = impossible;
      else where.action = "retired";
    } else where.id = impossible;
  } else if (filters.result !== undefined && source === "accountEntitlementActivation") {
    const decisions = filters.result === "applied"
      ? ["granted", "already_issued"]
      : filters.result === "rejected"
        ? ["no_active_offer"]
        : [];
    if (decisions === undefined || decisions.length === 0) where.id = impossible;
    else where.decision = { in: decisions };
  } else if (filters.result !== undefined) {
    const mappedResults = registry.resultMap[filters.result];
    if (mappedResults === undefined || mappedResults.length === 0) where.id = impossible;
    else if (filters.action === undefined) where[registry.resultField] = { in: mappedResults };
    else {
      const mappedAction = registry.actionMap[filters.action];
      if (mappedAction === undefined || !mappedResults.includes(mappedAction)) where.id = impossible;
    }
  }
  return where;
}

function orderBy(): Array<{ createdAt: "desc" } | { id: "desc" }> {
  return [{ createdAt: "desc" }, { id: "desc" }];
}

function orderByIssuedAt(): Array<{ issuedAt: "desc" } | { id: "desc" }> {
  return [{ issuedAt: "desc" }, { id: "desc" }];
}

function platformProjection(row: PlatformRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "platformDefaultAiRoute",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: null,
    references: safeReferences({ categories: ["platformDefaultRoute", "providerConnection"] }),
    evidence: evidence({}, {}, { route: row.routeVersion, providerConfiguration: row.providerConfigurationVersion }, row.reason !== null),
    result: statusResult(action, null),
  });
}

function subscriptionProjection(row: SubscriptionRow): RawAuditEvent {
  const action = String(row.eventKind);
  return rawEvent({
    id: row.id,
    source: "membershipSubscription",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.userId,
    references: safeReferences({ categories: ["membershipSubscription"], userId: row.userId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore), version: row.versionBefore },
      { status: row.statusAfter === null ? null : String(row.statusAfter), version: row.versionAfter },
      { before: row.versionBefore, after: row.versionAfter },
      row.reason !== null,
    ),
    result: statusResult(action, row.statusAfter === null ? null : String(row.statusAfter)),
  });
}

function accountAccessProjection(row: AccountAccessRow): RawAuditEvent {
  const action = String(row.event);
  return rawEvent({
    id: row.id,
    source: "accountAccess",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.userId,
    references: safeReferences({ categories: ["accountAccessPreview"], userId: row.userId }),
    evidence: evidence(
      { state: row.disabledAtBefore === null ? "enabled" : "disabled" },
      { state: row.disabledAtAfter === null ? "enabled" : "disabled" },
      { before: row.versionBefore, after: row.versionAfter },
      true,
    ),
    result: statusResult(action, null),
  });
}

function membershipAccessProjection(row: MembershipAccessRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "membershipAccess",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: row.actorId === null ? "unrecorded" : "user",
    subjectId: row.userId,
    references: safeReferences({ categories: ["membership"], workspaceId: row.workspaceId, projectId: row.projectId, userId: row.userId }),
    evidence: evidence(
      { state: row.previousState === null ? null : String(row.previousState), role: row.roleSnapshot },
      { state: String(row.newState), role: row.roleSnapshot },
      {},
      true,
    ),
    result: statusResult(action, String(row.newState)),
  });
}

function invitationProjection(row: InvitationRow): RawAuditEvent {
  const action = String(row.event);
  return rawEvent({
    id: row.id,
    source: "workspaceInvitation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: row.actorId === null ? "unrecorded" : "user",
    subjectId: null,
    references: safeReferences({ categories: ["workspaceInvitation"], workspaceId: row.workspaceId }),
    evidence: evidence(
      { status: row.statusBefore, version: row.versionBefore },
      { status: row.statusAfter, version: row.versionAfter },
      { before: row.versionBefore, after: row.versionAfter },
      true,
    ),
    result: action === "created" ? "pending" : action === "accepted" ? "applied" : action === "revoked" ? "revoked" : "unknown",
  });
}

function connectionMutationResult(executionStatus: string, statusAfter: string | null): SystemAuditResult {
  if (executionStatus === "failed") return "failed";
  if (executionStatus === "unknown") return "unknown";
  if (executionStatus === "held") return "unknown";
  if (executionStatus === "previewed" || executionStatus === "dispatched") return "pending";
  if (statusAfter === "disabled") return "disabled";
  return executionStatus === "completed" ? "applied" : "unknown";
}

function gitConnectionMutationProjection(row: GitConnectionMutationAuditRow): RawAuditEvent {
  const action = String(row.action);
  const statusAfter = row.statusAfter === null ? null : String(row.statusAfter);
  const safeErrorCode = row.safeErrorCode === "GIT_EXTERNAL_IO_PLANNED_NOT_DISPATCHED" ? row.safeErrorCode : null;
  return rawEvent({
    id: row.id,
    source: "gitConnectionMutation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.ownerUserId,
    references: safeReferences({ categories: ["gitConnection", "connectionGovernance"], userId: row.ownerUserId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: statusAfter, impactCount: row.impactCount },
      { connectionConfiguration: row.connectionConfigurationVersion },
      false,
      safeErrorCode,
    ),
    result: connectionMutationResult(String(row.executionStatus), statusAfter),
  });
}

function mcpConnectionMutationProjection(row: McpConnectionMutationAuditRow): RawAuditEvent {
  const action = String(row.action);
  const statusAfter = row.statusAfter === null ? null : String(row.statusAfter);
  return rawEvent({
    id: row.id,
    source: "mcpConnectionMutation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.ownerUserId,
    references: safeReferences({ categories: ["mcpConnection", "connectionGovernance"], userId: row.ownerUserId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: statusAfter, impactCount: row.impactCount },
      { connectionConfiguration: row.configurationRevision },
      false,
      safeMcpErrorCode(row.safeErrorCode),
    ),
    result: connectionMutationResult(String(row.executionStatus), statusAfter),
  });
}

function attestationProjection(row: AttestationRow): RawAuditEvent {
  const action = String(row.event);
  return rawEvent({
    id: row.id,
    source: "mcpToolAttestation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: null,
    references: safeReferences({ categories: ["mcpConnection", "mcpTool", "attestation"] }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: row.statusAfter === null ? null : String(row.statusAfter) },
      { controlPlane: row.controlPlaneVersion, attestation: row.attestationVersion, connectionConfiguration: row.connectionConfigurationRevision },
      false,
    ),
    result: statusResult(action, row.statusAfter === null ? null : String(row.statusAfter)),
  });
}

function mcpToolReviewProjection(row: McpToolReviewAuditRow): RawAuditEvent {
  const conclusion = String(row.conclusion);
  const action = conclusion === "read_only_verified"
    ? "attested"
    : conclusion === "read_only_rejected"
      ? "rejected"
      : "reviewed";
  const result: SystemAuditResult = conclusion === "read_only_verified"
    ? "applied"
    : conclusion === "read_only_rejected"
      ? "rejected"
      : "pending";
  return rawEvent({
    id: row.id,
    source: "mcpToolReview",
    action,
    createdAt: row.createdAt,
    actorId: row.reviewerId,
    actorKind: "user",
    subjectId: null,
    references: safeReferences({ categories: ["mcpConnection", "mcpTool", "mcpToolReview"] }),
    evidence: evidence(
      {},
      { conclusion, riskLevel: String(row.riskLevel), riskReasonCode: String(row.riskReasonCode), evidenceNotePresent: row.evidenceNotePresent },
      { connectionConfiguration: row.connectionConfigurationRevision, reviewerAccountAccess: row.reviewerAccountAccessVersion },
      false,
    ),
    result,
  });
}

function projectAiProjection(row: ProjectAiRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "projectAiProviderDelegation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: principalKind(row.actorKind),
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["projectAiDelegation", "provider"], projectId: row.projectId, userId: row.connectionOwnerId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore), entity: String(row.entity) },
      { status: row.statusAfter === null ? null : String(row.statusAfter), source: row.selectionSource === null ? null : String(row.selectionSource) },
      { delegation: row.delegationVersion, selection: row.selectionVersion, providerConfiguration: row.providerConfigurationVersion, accountAccess: row.connectionOwnerAccountAccessVersion },
      true,
    ),
    result: statusResult(action, row.statusAfter === null ? null : String(row.statusAfter)),
  });
}

function gitProjection(row: GitRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "projectGitRepositoryDelegation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: principalKind(row.actorKind),
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["gitConnection", "repositoryDelegation"], projectId: row.projectId, userId: row.connectionOwnerId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: row.statusAfter === null ? null : String(row.statusAfter) },
      { delegation: row.delegationVersion, connectionConfiguration: row.connectionConfigurationVersion, accountAccess: row.connectionOwnerAccountAccessVersion },
      true,
    ),
    result: statusResult(action, row.statusAfter === null ? null : String(row.statusAfter)),
  });
}

function mcpDelegationProjection(row: McpDelegationRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "projectMcpConnectionDelegation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: principalKind(row.actorKind),
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["mcpConnection", "connectionDelegation"], projectId: row.projectId, userId: row.connectionOwnerId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: row.statusAfter === null ? null : String(row.statusAfter) },
      { delegation: row.delegationVersion, connectionConfiguration: row.connectionConfigurationRevision, accountAccess: row.connectionOwnerAccountAccessVersion },
      true,
    ),
    result: statusResult(action, row.statusAfter === null ? null : String(row.statusAfter)),
  });
}

function grantProjection(row: GrantRow): RawAuditEvent {
  const action = String(row.event);
  return rawEvent({
    id: row.id,
    source: "projectMcpToolGrantLedger",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["mcpConnection", "mcpTool", "grant", "attestation", "delegation"], projectId: row.projectId, userId: row.connectionOwnerId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: String(row.statusAfter) },
      { controlPlane: row.controlPlaneVersion, grant: row.grantVersion, delegation: row.delegationVersion, connectionConfiguration: row.connectionConfigurationRevision },
      false,
    ),
    result: statusResult(action, String(row.statusAfter)),
  });
}

function gitManualRunProjection(row: GitManualRunRow): RawAuditEvent {
  const action = String(row.action);
  const statusAfter = String(row.statusAfter);
  const isSystemRecovery = action === "unknown" && row.actorId === null;
  return rawEvent({
    id: row.id,
    source: "projectGitManualRun",
    action,
    createdAt: row.createdAt,
    actorId: isSystemRecovery ? null : row.actorId,
    actorKind: isSystemRecovery ? "system" : row.actorId === null ? "unrecorded" : "user",
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["gitManualRun"], projectId: row.projectId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: statusAfter, dispatch: String(row.dispatchState), role: String(row.role) },
      { delegation: row.delegationVersion, connectionConfiguration: row.connectionConfigurationVersion },
      true,
    ),
    result: manualRunResult(action, statusAfter),
  });
}

function mcpActionApprovalProjection(row: McpActionApprovalRow): RawAuditEvent {
  const action = String(row.event);
  return rawEvent({
    id: row.id,
    source: "projectMcpActionApproval",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["mcpActionApproval"], projectId: row.projectId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: String(row.statusAfter) },
      { state: row.stateVersion, grant: row.grantVersion, delegation: row.delegationVersion, attestation: row.attestationVersion },
      false,
    ),
    result: action === "approved" ? "applied" : action === "rejected" ? "rejected" : action === "cancelled" ? "cancelled" : "pending",
  });
}

function mcpActionRuntimeProjection(row: McpActionRuntimeRow): RawAuditEvent {
  const action = String(row.event);
  const result = action === "succeeded"
    ? "applied"
    : action === "reserved"
      ? "pending"
      : action === "failed"
        ? "failed"
        : action === "unknown"
          ? "unknown"
          : action === "expired"
            ? "expired"
            : "invalidated";
  const actorKind = String(row.actorKind) === "systemRecovery" ? "system" : "user";
  return rawEvent({
    id: row.id,
    source: "projectMcpActionRuntime",
    action,
    createdAt: row.createdAt,
    actorId: actorKind === "system" ? null : row.actorId,
    actorKind,
    subjectId: row.connectionOwnerId,
    references: safeReferences({ categories: ["mcpActionRuntime"], projectId: row.projectId }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      { status: String(row.statusAfter), resultBytes: row.resultBytes, resultNodes: row.resultNodes, resultDepth: row.resultDepth },
      { state: row.stateVersion },
      false,
      safeMcpErrorCode(row.safeErrorCode),
    ),
    result,
  });
}

function aiRuntimeProjection(row: AiRuntimeRow): RawAuditEvent {
  const action = String(row.eventType);
  const safeCode = safeAiErrorCode(row.safeCode);
  return rawEvent({
    id: row.id,
    source: "aiRuntime",
    action,
    createdAt: row.createdAt,
    actorId: null,
    actorKind: "unrecorded",
    subjectId: null,
    references: safeReferences({ categories: ["aiRuntime"], projectId: row.projectId }),
    evidence: evidence(
      {},
      { event: action, safeCode },
      {},
      false,
      safeCode,
    ),
    result: aiRuntimeResult(action),
  });
}

function webAiConfirmationProjection(row: WebAiConfirmationRow, snapshotAt: Date): RawAuditEvent {
  const action = String(row.targetAction);
  const consumedAtAtSnapshot = row.consumedAt !== null && row.consumedAt <= snapshotAt;
  const result: SystemAuditResult = consumedAtAtSnapshot
    ? "applied"
    : row.expiresAt <= snapshotAt
      ? "expired"
      : "pending";
  return rawEvent({
    id: row.id,
    source: "webAiConfirmation",
    action,
    createdAt: row.issuedAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: null,
    references: safeReferences({ categories: ["webAiConfirmation"], projectId: row.projectId }),
    evidence: evidence(
      {},
      { result },
      { actorAccountAccess: row.actorAccountAccessVersion },
      false,
    ),
    result,
  });
}

const PLATFORM_PROBE_SAFE_ERROR_CODES = new Set([
  "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED",
  "PLATFORM_PROVIDER_PROBE_BUDGET_EXHAUSTED",
  "PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT",
  "PLATFORM_PROVIDER_PROBE_CANONICAL_ENDPOINT_REQUIRED",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_AUTH_FAILED",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_RATE_LIMITED",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_REJECTED",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_INVALID_RESPONSE",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_RESPONSE_TOO_LARGE",
  "PLATFORM_PROVIDER_PROBE_PROVIDER_TIMEOUT",
  "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD",
  "PLATFORM_PROVIDER_PROBE_RECONCILED_NO_DISPATCH",
]);

function safePlatformProbeErrorCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value);
  return PLATFORM_PROBE_SAFE_ERROR_CODES.has(normalized) ? normalized : "PLATFORM_PROVIDER_PROBE_PROVIDER_UNAVAILABLE";
}

function platformProviderProbeResult(action: string): SystemAuditResult {
  if (action === "rejected") return "rejected";
  if (action === "held") return "unknown";
  if (action === "reserved" || action === "dispatched") return "pending";
  return "applied";
}

function platformProviderProbeProjection(row: PlatformProviderProbeRow): RawAuditEvent {
  const action = String(row.event);
  const capability = row.capability === null ? null : String(row.capability);
  const safeErrorCode = safePlatformProbeErrorCode(row.safeErrorCode);
  return rawEvent({
    id: row.id,
    source: "platformProviderProbe",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: row.actorId === null ? "unrecorded" : "user",
    subjectId: null,
    references: safeReferences({ categories: ["platformProviderProbe"] }),
    evidence: evidence({}, { capability, units: row.units }, {}, false, safeErrorCode),
    result: platformProviderProbeResult(action),
  });
}

function platformGrantOfferPolicyResult(action: string, statusAfter: string | null | undefined): SystemAuditResult {
  if (action === "created" && statusAfter === "draft") return "pending";
  if (action === "created" && statusAfter === "active") return "applied";
  if (action === "activated") return "applied";
  if (action === "retired") return "revoked";
  return "unknown";
}

function platformGrantOfferPolicyProjection(row: PlatformGrantOfferPolicyAuditRow): RawAuditEvent {
  const action = String(row.action);
  return rawEvent({
    id: row.id,
    source: "platformGrantOfferPolicy",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: null,
    references: safeReferences({ categories: ["platformGrantOfferPolicy"] }),
    evidence: evidence(
      { status: row.statusBefore === null ? null : String(row.statusBefore) },
      {
        status: String(row.statusAfter),
        offerVersion: row.offerVersion,
        amount: row.amount,
        validForDays: row.validForDays,
        eligibilityKey: row.eligibilityKey,
        reasonRecorded: row.reasonRecorded,
      },
      {},
      row.reasonRecorded,
    ),
    result: platformGrantOfferPolicyResult(action, String(row.statusAfter)),
  });
}

function accountEntitlementActivationProjection(row: AccountEntitlementActivationAuditRow): RawAuditEvent {
  const action = String(row.action);
  const decision = String(row.decision);
  const actorKind = row.actorKind === "system" ? "system" : "user";
  const result: SystemAuditResult = decision === "no_active_offer"
    ? "rejected"
    : decision === "granted" || decision === "already_issued"
      ? "applied"
      : "unknown";
  return rawEvent({
    id: row.id,
    source: "accountEntitlementActivation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind,
    subjectId: row.userId,
    references: safeReferences({ categories: ["accountEntitlementActivation"], userId: row.userId }),
    evidence: evidence({}, {
      decision,
      status: String(row.statusAfter),
      source: String(row.source),
      offerVersion: row.offerVersion,
      offerAmount: row.offerAmount,
      offerValidForDays: row.offerValidForDays,
      eligibilityKey: row.eligibilityKey,
      policyRevision: row.policyRevision,
    }),
    result,
  });
}

function accountEntitlementBackfillResult(action: string): SystemAuditResult {
  if (action === "previewed" || action === "confirmed") return "pending";
  if (action === "executed") return "applied";
  if (action === "stale") return "rejected";
  if (action === "expired") return "expired";
  if (action === "failed") return "failed";
  return "unknown";
}

function accountEntitlementBackfillProjection(row: AccountEntitlementBackfillAuditRow): RawAuditEvent {
  const action = String(row.action);
  const confirmedAt = row.run.confirmedAt instanceof Date
    ? row.run.confirmedAt
    : typeof row.run.confirmedAt === "string" && !Number.isNaN(Date.parse(row.run.confirmedAt))
      ? new Date(row.run.confirmedAt)
      : null;
  const offerValidForDays = typeof row.run.activeOfferValidForDays === "number" ? row.run.activeOfferValidForDays : null;
  const grantExpiresAt = confirmedAt !== null && offerValidForDays !== null
    ? new Date(confirmedAt.getTime() + offerValidForDays * 86_400_000).toISOString()
    : null;
  return rawEvent({
    id: row.id,
    source: "accountEntitlementBackfill",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: null,
    references: safeReferences({ categories: ["accountEntitlementBackfill"] }),
    evidence: evidence(
      { status: row.statusBefore },
      {
        status: String(row.statusAfter),
        candidateCount: row.run.candidateCount,
        alreadyIssuedCount: row.run.alreadyIssuedCount,
        eligibleMissingCount: row.run.eligibleMissingCount,
        legacyAmbiguousCount: row.run.legacyAmbiguousCount,
        grantedCount: row.run.grantedCount,
        skippedCount: row.run.skippedCount,
        expiresAt: row.run.expiresAt instanceof Date ? row.run.expiresAt.toISOString() : String(row.run.expiresAt ?? ""),
        offerVersion: row.run.activeOfferVersion,
        offerAmount: row.run.activeOfferAmount,
        offerValidForDays: row.run.activeOfferValidForDays,
        grantExpiresAt,
      },
      {},
      row.reasonRecorded,
    ),
    result: accountEntitlementBackfillResult(action),
  });
}

function platformCreditGovernanceProjection(row: PlatformCreditGovernanceAuditRow): RawAuditEvent {
  const action = String(row.event);
  const result: SystemAuditResult = action === "grant"
    ? "applied"
    : action === "revoke"
      ? "revoked"
      : "unknown";
  return rawEvent({
    id: row.id,
    source: "platformCreditGovernance",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.userId,
    references: safeReferences({ categories: ["platformCreditGovernance"] }),
    evidence: evidence(
      { status: row.statusBefore, version: row.versionBefore },
      { status: row.statusAfter, version: row.versionAfter },
      { before: row.versionBefore, after: row.versionAfter },
      row.reason.trim().length > 0,
    ),
    result,
  });
}

function workspaceRoleMutationProjection(row: WorkspaceRoleMutationAuditRow): RawAuditEvent {
  const action = String(row.event) === "roleChanged" || String(row.event) === "role_changed"
    ? "roleChanged"
    : String(row.event);
  return rawEvent({
    id: row.id,
    source: "workspaceRoleMutation",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.subjectId,
    references: safeReferences({ categories: ["workspaceRoleMutation"] }),
    evidence: evidence(
      {
        role: String(row.oldRole),
        ownerCount: row.ownerCountBefore,
      },
      {
        role: String(row.newRole),
        ownerCount: row.ownerCountAfter,
        projectGrantCount: row.projectGrantCount,
      },
      {},
      false,
    ),
    result: action === "roleChanged" ? "applied" : "unknown",
  });
}

function membershipApplicationProjection(row: MembershipApplicationAuditRow): RawAuditEvent {
  const action = row.event === "submitted" ? "requested" : row.event === "fulfilled" ? "fulfilled" : row.event === "rejected" ? "rejected" : "cancelled";
  const result: SystemAuditResult = row.event === "submitted" ? "pending" : row.event === "fulfilled" ? "applied" : row.event === "rejected" ? "rejected" : "cancelled";
  return rawEvent({
    id: row.id,
    source: "membershipApplication",
    action,
    createdAt: row.createdAt,
    actorId: row.actorId,
    actorKind: "user",
    subjectId: row.userId,
    references: safeReferences({ categories: ["membershipApplication"] }),
    evidence: evidence(
      { status: row.statusBefore, version: row.statusVersionBefore },
      { status: row.statusAfter, version: row.statusVersionAfter },
      { before: row.statusVersionBefore, after: row.statusVersionAfter },
      row.reason !== null && row.reason.trim().length > 0,
    ),
    result,
  });
}

async function fetchPlatform(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.platformDefaultAiRouteAudit.findMany({
    where: sourceWhere(context, "platformDefaultAiRoute", { actorField: "actorId" }) as Prisma.PlatformDefaultAiRouteAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: platformSelect,
  });
  return rows.map(platformProjection);
}

async function fetchSubscription(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.membershipSubscriptionAudit.findMany({
    where: sourceWhere(context, "membershipSubscription", { actorField: "actorId", subjectField: "userId" }) as Prisma.MembershipSubscriptionAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: subscriptionSelect,
  });
  return rows.map(subscriptionProjection);
}

async function fetchAccountAccess(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.accountAccessAudit.findMany({
    where: sourceWhere(context, "accountAccess", { actorField: "actorId", subjectField: "userId" }) as Prisma.AccountAccessAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: accountAccessSelect,
  });
  return rows.map(accountAccessProjection);
}

async function fetchMembershipAccess(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.membershipAccessAudit.findMany({
    where: sourceWhere(context, "membershipAccess", { actorField: "actorId", subjectField: "userId", projectField: "projectId", workspaceField: "workspaceId" }) as Prisma.MembershipAccessAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: membershipAccessSelect,
  });
  return rows.map(membershipAccessProjection);
}

async function fetchInvitation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.workspaceInvitationAudit.findMany({
    where: sourceWhere(context, "workspaceInvitation", { actorField: "actorId", workspaceField: "workspaceId" }) as Prisma.WorkspaceInvitationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: invitationSelect,
  });
  return rows.map(invitationProjection);
}

async function fetchGitConnectionMutation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.gitConnectionMutationAudit.findMany({
    where: sourceWhere(context, "gitConnectionMutation", { actorField: "actorId", subjectField: "ownerUserId" }) as Prisma.GitConnectionMutationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: gitConnectionMutationAuditSelect,
  });
  return rows.map(gitConnectionMutationProjection);
}

async function fetchMcpConnectionMutation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.mcpConnectionMutationAudit.findMany({
    where: sourceWhere(context, "mcpConnectionMutation", { actorField: "actorId", subjectField: "ownerUserId" }) as Prisma.McpConnectionMutationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: mcpConnectionMutationAuditSelect,
  });
  return rows.map(mcpConnectionMutationProjection);
}

async function fetchAttestation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.mcpToolAttestationAudit.findMany({
    where: sourceWhere(context, "mcpToolAttestation", { actorField: "actorId" }) as Prisma.McpToolAttestationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: attestationSelect,
  });
  return rows.map(attestationProjection);
}

async function fetchMcpToolReview(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.mcpToolReviewAudit.findMany({
    where: sourceWhere(context, "mcpToolReview", { actorField: "reviewerId" }) as Prisma.McpToolReviewAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: mcpToolReviewAuditSelect,
  });
  return rows.map(mcpToolReviewProjection);
}

async function fetchProjectAi(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectAiProviderDelegationAudit.findMany({
    where: sourceWhere(context, "projectAiProviderDelegation", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId" }) as Prisma.ProjectAiProviderDelegationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: projectAiSelect,
  });
  return rows.map(projectAiProjection);
}

async function fetchGit(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectGitRepositoryDelegationAudit.findMany({
    where: sourceWhere(context, "projectGitRepositoryDelegation", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId" }) as Prisma.ProjectGitRepositoryDelegationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: gitSelect,
  });
  return rows.map(gitProjection);
}

async function fetchMcpDelegation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectMcpConnectionDelegationAudit.findMany({
    where: sourceWhere(context, "projectMcpConnectionDelegation", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId" }) as Prisma.ProjectMcpConnectionDelegationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: mcpDelegationSelect,
  });
  return rows.map(mcpDelegationProjection);
}

async function fetchGrant(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectMcpToolGrantLedger.findMany({
    where: sourceWhere(context, "projectMcpToolGrantLedger", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId" }) as Prisma.ProjectMcpToolGrantLedgerWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: grantSelect,
  });
  return rows.map(grantProjection);
}

async function fetchGitManualRun(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectGitRepositoryManualRunAudit.findMany({
    where: sourceWhere(context, "projectGitManualRun", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId" }) as Prisma.ProjectGitRepositoryManualRunAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: gitManualRunSelect,
  });
  return rows.map(gitManualRunProjection);
}

async function fetchMcpActionApproval(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectMcpActionLedger.findMany({
    where: sourceWhere(context, "projectMcpActionApproval", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId" }) as Prisma.ProjectMcpActionLedgerWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: mcpActionApprovalSelect,
  });
  return rows.map(mcpActionApprovalProjection);
}

async function fetchMcpActionRuntime(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.projectMcpActionRuntimeLedger.findMany({
    where: sourceWhere(context, "projectMcpActionRuntime", { actorField: "actorId", subjectField: "connectionOwnerId", projectField: "projectId", actorKindField: "actorKind" }) as Prisma.ProjectMcpActionRuntimeLedgerWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: mcpActionRuntimeSelect,
  });
  return rows.map(mcpActionRuntimeProjection);
}

async function fetchAiRuntime(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.aiAuditEvent.findMany({
    where: sourceWhere(context, "aiRuntime", { projectField: "projectId" }) as Prisma.AiAuditEventWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: aiRuntimeSelect,
  });
  return rows.map(aiRuntimeProjection);
}

async function fetchWebAiConfirmation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.webAiConfirmationChallenge.findMany({
    where: sourceWhere(context, "webAiConfirmation", { actorField: "actorId", projectField: "projectId" }) as Prisma.WebAiConfirmationChallengeWhereInput,
    orderBy: orderByIssuedAt(),
    take: context.take,
    select: webAiConfirmationSelect,
  });
  return rows.map((row) => webAiConfirmationProjection(row, context.snapshotAt));
}

async function fetchPlatformProviderProbe(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.platformProviderProbeLedger.findMany({
    where: sourceWhere(context, "platformProviderProbe", { actorField: "actorId" }) as Prisma.PlatformProviderProbeLedgerWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: platformProviderProbeSelect,
  });
  return rows.map(platformProviderProbeProjection);
}

async function fetchPlatformGrantOfferPolicy(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.platformGrantOfferPolicyAudit.findMany({
    where: sourceWhere(context, "platformGrantOfferPolicy", { actorField: "actorId" }) as Prisma.PlatformGrantOfferPolicyAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: platformGrantOfferPolicyAuditSelect,
  });
  return rows.map(platformGrantOfferPolicyProjection);
}

async function fetchAccountEntitlementActivation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.accountEntitlementActivationAudit.findMany({
    where: sourceWhere(context, "accountEntitlementActivation", { actorField: "actorId", subjectField: "userId" }) as Prisma.AccountEntitlementActivationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: accountEntitlementActivationAuditSelect,
  });
  return rows.map(accountEntitlementActivationProjection);
}

async function fetchAccountEntitlementBackfill(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.accountEntitlementBackfillAudit.findMany({
    where: sourceWhere(context, "accountEntitlementBackfill", { actorField: "actorId" }) as Prisma.AccountEntitlementBackfillAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: accountEntitlementBackfillAuditSelect,
  });
  return rows.map(accountEntitlementBackfillProjection);
}

async function fetchPlatformCreditGovernance(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.platformTokenGrantAudit.findMany({
    where: sourceWhere(context, "platformCreditGovernance", { actorField: "actorId", subjectField: "userId" }) as Prisma.PlatformTokenGrantAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: platformCreditGovernanceAuditSelect,
  });
  return rows.map(platformCreditGovernanceProjection);
}

async function fetchWorkspaceRoleMutation(context: QueryContext): Promise<RawAuditEvent[]> {
  const rows = await context.db.workspaceRoleMutationAudit.findMany({
    where: sourceWhere(context, "workspaceRoleMutation", { actorField: "actorId", subjectField: "subjectId" }) as Prisma.WorkspaceRoleMutationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: workspaceRoleMutationAuditSelect,
  });
  return rows.map(workspaceRoleMutationProjection);
}

async function fetchMembershipApplications(context: QueryContext): Promise<RawAuditEvent[]> {
  const delegate = (context.db as unknown as { membershipApplicationAudit?: { findMany: (input: unknown) => Promise<MembershipApplicationAuditRow[]> } }).membershipApplicationAudit;
  if (delegate === undefined) return [];
  const rows = await delegate.findMany({
    where: sourceWhere(context, "membershipApplication", { actorField: "actorId", subjectField: "userId" }) as Prisma.MembershipApplicationAuditWhereInput,
    orderBy: orderBy(),
    take: context.take,
    select: membershipApplicationAuditSelect,
  });
  return rows.map(membershipApplicationProjection);
}

async function fetchSource(context: QueryContext, source: SystemAuditSource): Promise<RawAuditEvent[]> {
  switch (source) {
    case "platformDefaultAiRoute": return fetchPlatform(context);
    case "membershipSubscription": return fetchSubscription(context);
    case "accountAccess": return fetchAccountAccess(context);
    case "membershipAccess": return fetchMembershipAccess(context);
    case "workspaceInvitation": return fetchInvitation(context);
    case "gitConnectionMutation": return fetchGitConnectionMutation(context);
    case "mcpConnectionMutation": return fetchMcpConnectionMutation(context);
    case "mcpToolAttestation": return fetchAttestation(context);
    case "mcpToolReview": return fetchMcpToolReview(context);
    case "projectAiProviderDelegation": return fetchProjectAi(context);
    case "projectGitRepositoryDelegation": return fetchGit(context);
    case "projectGitManualRun": return fetchGitManualRun(context);
    case "projectMcpConnectionDelegation": return fetchMcpDelegation(context);
    case "projectMcpToolGrantLedger": return fetchGrant(context);
    case "projectMcpActionApproval": return fetchMcpActionApproval(context);
    case "projectMcpActionRuntime": return fetchMcpActionRuntime(context);
    case "aiRuntime": return fetchAiRuntime(context);
    case "webAiConfirmation": return fetchWebAiConfirmation(context);
    case "platformProviderProbe": return fetchPlatformProviderProbe(context);
    case "platformGrantOfferPolicy": return fetchPlatformGrantOfferPolicy(context);
    case "platformCreditGovernance": return fetchPlatformCreditGovernance(context);
    case "workspaceRoleMutation": return fetchWorkspaceRoleMutation(context);
    case "membershipApplication": return fetchMembershipApplications(context);
    case "accountEntitlementActivation": return fetchAccountEntitlementActivation(context);
    case "accountEntitlementBackfill": return fetchAccountEntitlementBackfill(context);
  }
}

async function resolveUserIds(db: PrismaClient, value: string): Promise<readonly string[]> {
  if (z.string().uuid().safeParse(value).success) return [value];
  const users = await db.appUser.findMany({
    where: { username: value },
    select: { id: true },
    take: MAX_USER_LOOKUP_RESULTS,
  });
  if (users.length !== 1) return [];
  return [users[0]!.id];
}

async function resolveWorkspaceProjectIds(db: PrismaClient, workspaceId: string): Promise<readonly string[]> {
  const projects = await db.project.findMany({
    where: { workspaceId },
    select: { id: true },
    orderBy: { id: "asc" },
    take: SYSTEM_AUDIT_MAX_WORKSPACE_PROJECTS + 1,
  });
  if (projects.length > SYSTEM_AUDIT_MAX_WORKSPACE_PROJECTS) {
    return auditError("SYSTEM_AUDIT_WORKSPACE_SCOPE_TOO_LARGE", "工作区项目范围超过安全上限", 422);
  }
  return projects.map((project) => project.id);
}

function normalizeFilters(input: SystemAuditQuery, snapshotAt: Date, now: Date): SystemAuditFilters {
  const from = input.from ?? new Date(snapshotAt.getTime() - SYSTEM_AUDIT_DEFAULT_WINDOW_MS);
  const requestedTo = input.to ?? snapshotAt;
  if (
    !Number.isFinite(now.getTime())
    ||
    !Number.isFinite(snapshotAt.getTime())
    || snapshotAt.getTime() > now.getTime()
    || snapshotAt.getTime() < now.getTime() - SYSTEM_AUDIT_MAX_WINDOW_MS
  ) {
    return auditError("SYSTEM_AUDIT_TIME_INVALID", "审计时间快照无效");
  }
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(requestedTo.getTime()) || requestedTo > now) {
    return auditError("SYSTEM_AUDIT_TIME_INVALID", "审计时间范围无效或不能包含未来时间");
  }
  const to = new Date(Math.min(requestedTo.getTime(), snapshotAt.getTime()));
  if (from > to) return auditError("SYSTEM_AUDIT_TIME_INVALID", "审计时间范围无效或不能包含未来时间");
  if (to.getTime() - from.getTime() > SYSTEM_AUDIT_MAX_WINDOW_MS) {
    return auditError("SYSTEM_AUDIT_TIME_RANGE_TOO_LARGE", "审计查询时间范围不能超过 90 天");
  }
  return {
    source: input.source,
    action: input.action,
    result: input.result,
    actor: input.actor,
    subject: input.subject,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    from,
    to,
  };
}

function sourceSupportsFilters(source: SystemAuditSource, filters: SystemAuditFilters): boolean {
  const registry = SYSTEM_AUDIT_REGISTRY[source];
  if (filters.action !== undefined && registry.actionMap[filters.action] === undefined) return false;
  if (filters.result !== undefined && !registry.allowedResults.includes(filters.result)) return false;
  return true;
}

function compareEvents(left: RawAuditEvent, right: RawAuditEvent): number {
  const dateDelta = right.createdAt.getTime() - left.createdAt.getTime();
  if (dateDelta !== 0) return dateDelta;
  if (left.source !== right.source) return left.source < right.source ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

function publicPrincipal(id: string | null, kind: RawAuditEvent["actorKind"], users: ReadonlyMap<string, Readonly<{ username: string; displayName: string | null }>>): SystemAuditPrincipal {
  if (id === null || kind !== "user") {
    return { kind, id: null, username: null, displayName: null };
  }
  const user = users.get(id);
  return { kind: "user", id, username: user?.username ?? null, displayName: user?.displayName ?? null };
}

function toPublicEvent(event: RawAuditEvent, users: ReadonlyMap<string, Readonly<{ username: string; displayName: string | null }>>): SystemAuditEvent {
  return Object.freeze({
    id: event.id,
    source: event.source,
    action: event.action,
    result: event.result,
    occurredAt: event.createdAt.toISOString(),
    actor: publicPrincipal(event.actorId, event.actorKind, users),
    subject: event.subjectId === null ? null : publicPrincipal(event.subjectId, "user", users),
    references: event.references,
    evidence: event.evidence,
  });
}

async function hydrateUsers(db: PrismaClient, events: readonly RawAuditEvent[]): Promise<ReadonlyMap<string, Readonly<{ username: string; displayName: string | null }>>> {
  const ids = [...new Set(events.flatMap((event) => [event.actorKind === "user" ? event.actorId : null, event.subjectId]).filter((value): value is string => value !== null))].slice(0, MAX_HYDRATED_USER_IDS);
  if (ids.length === 0) return new Map();
  const users = await db.appUser.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, displayName: true } });
  return new Map(users.map((user) => [user.id, { username: user.username, displayName: user.displayName }]));
}

function emptyList(snapshotAt: Date, pageSize: number): SystemAuditList {
  return Object.freeze({ events: Object.freeze([]), nextCursor: null, snapshotAt: snapshotAt.toISOString(), pageSize });
}

export async function listSystemAudit(
  input: SystemAuditQuery,
  db: PrismaClient = getDb(),
  now = new Date(),
): Promise<SystemAuditList> {
  const cursor = input.cursor === undefined ? null : await decodeCursor(input.cursor);
  const snapshotAt = cursor === null ? now : new Date(cursor.snapshotAt);
  const filters = normalizeFilters(input, snapshotAt, now);
  const hash = await filterHash(filters);
  const pageSize = input.pageSize ?? 20;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > SYSTEM_AUDIT_MAX_PAGE_SIZE) {
    return auditError("SYSTEM_AUDIT_PAGE_SIZE_INVALID", "审计分页大小必须在 1 到 50 之间");
  }
  const cursorCreatedAt = cursor === null ? null : new Date(cursor.createdAt);
  if (
    cursor !== null
    && (
      cursor.filterHash !== hash
      || cursorCreatedAt === null
      || !Number.isFinite(cursorCreatedAt.getTime())
      || cursorCreatedAt > snapshotAt
    )
  ) {
    return auditError("SYSTEM_AUDIT_CURSOR_INVALID", "审计分页游标与当前筛选条件或快照不匹配");
  }
  const actorIds = input.actor === undefined ? undefined : await resolveUserIds(db, input.actor);
  const subjectIds = input.subject === undefined ? undefined : await resolveUserIds(db, input.subject);
  if ((actorIds !== undefined && actorIds.length === 0) || (subjectIds !== undefined && subjectIds.length === 0)) {
    return emptyList(snapshotAt, pageSize);
  }
  const workspaceProjectIds = filters.workspaceId === undefined ? undefined : await resolveWorkspaceProjectIds(db, filters.workspaceId);
  if (filters.workspaceId !== undefined && filters.projectId !== undefined && !workspaceProjectIds!.includes(filters.projectId)) {
    return emptyList(snapshotAt, pageSize);
  }
  const sources = (input.source === undefined ? SYSTEM_AUDIT_SOURCES : [input.source]).filter((source) => sourceSupportsFilters(source, filters));
  if (sources.length === 0) return emptyList(snapshotAt, pageSize);
  const rows = await Promise.all(sources.map((source) => fetchSource({ db, filters, actorIds, subjectIds, workspaceProjectIds, snapshotAt, cursor, take: pageSize + 1 }, source)));
  const merged = rows.flat().filter((event) => input.result === undefined || event.result === input.result).sort(compareEvents);
  const page = merged.slice(0, pageSize);
  const hasMore = merged.length > pageSize;
  const users = await hydrateUsers(db, page);
  const events = page.map((event) => toPublicEvent(event, users));
  const last = page.at(-1);
  const nextCursor = hasMore && last !== undefined
    ? await encodeCursor({ version: CURSOR_VERSION, filterHash: hash, snapshotAt: snapshotAt.toISOString(), createdAt: last.createdAt.toISOString(), source: last.source, id: last.id })
    : null;
  return Object.freeze({ events: Object.freeze(events), nextCursor, snapshotAt: snapshotAt.toISOString(), pageSize });
}

export async function getSystemAuditDetail(
  source: SystemAuditSource,
  auditId: string,
  db: PrismaClient = getDb(),
): Promise<SystemAuditEvent> {
  if (!z.string().uuid().safeParse(auditId).success) auditError("SYSTEM_AUDIT_NOT_FOUND", "审计记录不存在", 404);
  const now = new Date();
  const rows = await fetchSource({ db, filters: { source }, actorIds: undefined, subjectIds: undefined, workspaceProjectIds: undefined, snapshotAt: now, cursor: null, auditId, take: 1 }, source);
  const event = rows[0];
  if (event === undefined || event.id !== auditId) auditError("SYSTEM_AUDIT_NOT_FOUND", "审计记录不存在", 404);
  const users = await hydrateUsers(db, [event]);
  return toPublicEvent(event, users);
}

export const SYSTEM_AUDIT_DENYLIST_KEYS = [
  "secret",
  "credential",
  "token",
  "bearer",
  "authorization",
  "baseUrl",
  "repositoryPath",
  "trackedRef",
  "canonicalArguments",
  "canonicalArgumentsHash",
  "sanitizedPayload",
  "providerRequestId",
  "emailFingerprint",
  "safeSummary",
  "routeSnapshot",
  "fingerprint",
  "eventFingerprint",
  "resolvedAddressFingerprint",
  "credentialFingerprint",
  "definitionFingerprint",
  "actionFingerprint",
  "resultFingerprint",
  "preparedClientKeyHash",
  "consumedClientKeyHash",
  "clientKey",
  "consumedJobId",
  "body",
  "payload",
  "reason",
  "actionId",
  "attemptId",
  "runId",
  "rpcRequestId",
  "transactionId",
  "grantId",
  "delegationId",
  "connectionId",
  "toolDefinitionId",
  "attestationId",
  "providerConnectionId",
  "tokenCount",
  "networkFingerprint",
  "details",
  "metadata",
] as const;
