/**
 * The public relation inventory used by the production ACL reconciler.
 *
 * Keep this list explicit.  A new Prisma model must be reviewed and added
 * here before a deployment can grant either application principal access;
 * there are deliberately no ALTER DEFAULT PRIVILEGES shortcuts.
 */
export const DATABASE_PRINCIPAL_RELATIONS = Object.freeze([
  "Project", "ProjectLifecycleRevision", "ProjectDataExportAudit", "ProjectDeletionReceipt",
  "GitHubConnection", "GitHubRepository", "GitConnection", "GitConnectionMutationPreview", "GitConnectionMutationAudit", "GitRepository",
  "ProjectGitRepositoryLink", "ProjectGitRepositoryDelegation", "ProjectGitRepositoryDelegationAudit",
  "ProjectGitRepositoryAutomationGrant", "ProjectGitRepositoryAutomationGrantAudit",
  "ProjectGitRepositoryAutomationScheduleCursor", "ProjectGitRepositoryAutomationRun",
  "ProjectGitRepositoryAutomationRunAudit",
  "ProjectGitRepositoryMaterialCursor", "ProjectGitRepositoryMaterialRun",
  "ProjectGitRepositoryMaterialRunAudit", "ProjectGitRepositoryMaterialConsentAudit",
  "ProjectGitRepositoryMaterialPublicationVersion", "ProjectGitRepositoryMaterialPublicationHead",
  "ProjectGitRepositoryMaterialPublicationEntry", "ProjectGitRepositoryMaterialSourceVersion",
  "ProjectGitRepositoryManualRun", "ProjectGitRepositoryManualRunEntry", "ProjectGitRepositoryManualPointer",
  "ProjectGitRepositoryManualRunAudit", "ProjectGitRepositoryManualRunReconciliation", "GitRepositorySnapshot",
  "ProjectGitRepositoryPublicationVersion", "ProjectGitRepositoryPublicationEntry", "ProjectGitRepositoryPublicationHead",
  "GitRepositorySnapshotEntry", "GitRepositorySnapshotPointer", "ProjectRepositoryLink",
  "ProjectRepositoryLinkConfigVersion", "ProjectRepositoryLinkConfigPointer", "ProjectScanBatch",
  "ProjectScanBatchEntry", "RepoCodeScanRun", "RepositoryFile", "RepositoryFileRevision",
  "RepositoryCodeGeneration", "RepositoryCodeGenerationEntry", "RepositoryCodeGenerationPointer",
  "GitHubMaterialSyncRun", "GitHubSourceVersion", "RepositoryMaterialGeneration",
  "RepositoryMaterialGenerationEntry", "RepositoryMaterialGenerationPointer", "RepositoryMaterialModelGrant",
  "RepositoryMaterialModelGrantSource", "RepositoryMaterialChunk", "RepositoryMaterialIndexGeneration",
  "RepositoryMaterialIndexInput", "RepositoryMaterialIndexAttempt", "RepositoryMaterialEmbedding",
  "RepositoryMaterialIndexPointer", "GitHubMaterialQuarantine", "ProjectCodeSnapshot",
  "ProjectCodeSnapshotEntry", "ProjectCodeSnapshotPointer", "ProjectAsset", "ProjectAssetVersion",
  "ProjectAssetSegment", "ProjectAssetExtractionRun", "ProjectAssetUploadAdmission",
  "ProjectAssetUploadReservation", "ProjectSource", "ProjectItem", "ProjectItemEvidence",
  "ProjectItemRevision", "ProjectItemRevisionEvidence", "ProjectFactRelation", "ProjectWorldSnapshot",
  "ProjectWorldAudit", "EmbeddingProfile", "SourceChunk", "ProjectCorpusGeneration",
  "ProjectCorpusGenerationEntry", "IndexGeneration", "ProjectCorpusIndexGeneration",
  "IndexGenerationInputEntry", "RepositoryCodeIndexGeneration", "RepositoryCodeIndexInput",
  "RepositoryCodeIndexPointer", "ProjectCorpusIndexInput", "IndexBuildAttempt", "IndexWorkItem",
  "ChunkEmbedding", "ProjectCorpusIndexPointer", "RepositoryRagSnapshot", "RepositoryRagSnapshotPointer",
  "ProjectRepositoryRagSnapshot", "ProjectRepositoryRagSnapshotEntry", "ProjectRepositoryRagSnapshotPointer",
  "ProjectRagSnapshot", "ProjectRagSnapshotPointer", "AiDerivedArtifact", "ArtifactDependency",
  "ProjectScan", "ProjectSnapshot", "ProjectAiPolicyRevision", "ProjectAiPolicyOperationProfile",
  "ProjectAiPolicy", "ModelProcessingGrant", "ModelProcessingGrantSource", "ModelProcessingGrantOperation",
  "AiRun", "AiRunAttempt", "AiRunInputSource", "AiAuditEvent", "AiCandidateBatch", "AiCandidateClaim",
  "AppUser", "PlatformBootstrap", "AppUserEmailVerificationAudit", "PersonalKnowledgeDocument", "PersonalKnowledgeRevision", "PersonalKnowledgeAudit", "PersonalKnowledgeIndexPointer", "PersonalKnowledgeRelation", "PersonalKnowledgeGraphSuggestion", "PersonalKnowledgeExtractionAttempt", "PersonalKnowledgeQaChallenge", "PersonalKnowledgeQaAudit", "PersonalKnowledgeSemanticIndexState", "PersonalKnowledgeSemanticGeneration", "PersonalKnowledgeSemanticEntry", "PersonalKnowledgeSemanticChallenge", "PersonalKnowledgeSemanticAudit", "PersonalConnectionProbeAttempt", "AccountAccessMutationPreview", "AccountAccessAudit",
  "MembershipSubscription", "MembershipMutationPreview", "MembershipSubscriptionAudit", "PlatformTokenGrant", "PlatformTokenGrantLegacyNullIssuerSnapshot",
  "MembershipApplication", "MembershipApplicationPreview", "MembershipApplicationAudit",
  "PlatformTokenReservation", "PlatformTokenReservationAllocation", "PlatformTokenLedgerEntry",
  "PlatformTokenGrantMutationPreview", "PlatformTokenGrantAudit", "AppSession", "LocalRegistrationBudget", "McpExportGrant", "McpExportApproval", "McpExportDispatchAudit", "McpExportOAuthAuthorizationRequest", "McpExportOAuthCode", "McpExportOAuthAccessToken", "McpExportOAuthAdmissionBudget", "Workspace", "WorkspaceMembership",
  "WorkspaceRoleMutationPreview", "WorkspaceRoleMutationAudit",
  "ProjectMembership", "MembershipAccessAudit", "MembershipGovernanceExecution", "MembershipGovernanceApproval",
  "WorkspaceInvitation", "WorkspaceInvitationAudit", "OidcProvider", "OidcIdentity", "OidcLoginAttempt",
  "OidcIdentityLinkAttempt", "OidcIdentityLinkAudit",
  "GitHubIdentity", "GitHubOauthAttempt", "ExternalCredential", "McpConnection", "McpConnectionMutationPreview", "McpConnectionMutationAudit", "McpToolDefinition",
  "ProjectMcpToolGrant", "ProjectMcpToolGrantLedger", "ProjectMcpAction", "ProjectMcpActionDispatchAttempt",
  "ProjectMcpActionRuntimeLedger", "ProjectMcpActionDispatchResult", "ProjectMcpActionResultImport", "ProjectMcpActionDecision",
  "ProjectMcpActionLedger", "ProjectMcpConnectionDelegation", "ProjectMcpConnectionDelegationAudit",
  "McpToolAttestation", "McpToolAttestationAudit", "McpToolReview", "McpToolReviewAudit", "ProjectMcpToolGrantAudit", "AiProviderConnection",
  "PlatformProviderProbeBudget", "PlatformProviderProbeAttempt", "PlatformProviderProbeLedger",
  "PlatformGrantOfferPolicy", "PlatformGrantOfferPolicyAudit", "AccountEntitlementActivation",
  "AccountEntitlementActivationAudit", "AccountEntitlementBackfillRun", "AccountEntitlementBackfillItem",
  "AccountEntitlementBackfillAudit", "PlatformDefaultAiRoute", "PlatformDefaultAiRouteAudit",
  "ProjectAiProviderDelegation", "ProjectAiEffectiveRouteSelection", "ProjectAiProviderDelegationAudit",
  "WebAiGrant", "WebAiConfirmationChallenge", "BackgroundJob", "BackgroundJobAttempt",
  "BackgroundJobReconciliation", "AutomationRule", "AutomationRun", "WorkerRuntime", "Notification",
  "ProjectActionPolicy", "ProjectActionPolicyRevision", "ProjectAction", "ProjectActionResultImport",
  "ProjectActionApproval", "ProjectActionAudit", "MemoryQualityIssue", "WebSource", "WebSourceRevision", "WebSourceReviewAudit",
  "WebSourceIdentityFence",
  "WebSourcePointer", "ProjectGitHubSyncRun", "ProjectGitHubSyncEntry", "ProjectGitHubSyncChange",
  "ProjectGitHubSyncReconciliation", "MemoryIndexGeneration", "MemoryIndexPointer", "MemoryRecord",
  "MemoryIndexReconciliation", "RagAnswer", "ProjectIntelligenceReport", "ProjectAgentRun",
  "ProjectObjective", "ProjectWorkItem", "ProjectWorkItemDependency", "ProjectWorkItemEvidenceLink",
  "ProjectPlanImpactSuggestion", "ProjectPlanAudit", "WebAiCandidate", "ProviderCallAudit",
] as const);

export const ENTITLEMENT_PROTECTED_RELATIONS = Object.freeze([
  "PlatformBootstrap",
  "PlatformGrantOfferPolicy",
  "PlatformGrantOfferPolicyAudit",
  "AccountEntitlementActivation",
  "AccountEntitlementActivationAudit",
  "AccountEntitlementBackfillRun",
  "AccountEntitlementBackfillItem",
  "AccountEntitlementBackfillAudit",
  "PlatformTokenGrantLegacyNullIssuerSnapshot",
  "PlatformTokenGrantMutationPreview",
  "PlatformTokenGrantAudit",
  "LocalRegistrationBudget",
] as const);

// Review decisions are written through the dedicated entitlement-writer
// session. Runtime may read the immutable audit record, but cannot forge it.
export const WRITER_APPEND_ONLY_RELATIONS = Object.freeze([
  "WebSourceReviewAudit",
] as const);

// Runtime and entitlement-writer trigger paths share this tiny coordination
// table. They may toggle only its lock version; keys remain immutable.
export const DATABASE_PRINCIPAL_COORDINATION_RELATIONS = Object.freeze([
  "WebSourceIdentityFence",
] as const);

// Membership application writes belong to the application/runtime control
// plane. They are catalogued and explicitly excluded from the entitlement
// writer's DML range, while the existing runtime principal may execute the
// guarded preview/transition service.
export const RUNTIME_ONLY_CONTROL_PLANE_RELATIONS = Object.freeze([
  "MembershipApplication",
  "MembershipApplicationPreview",
  "MembershipApplicationAudit",
  "WorkspaceRoleMutationPreview",
  "WorkspaceRoleMutationAudit",
  "GitConnectionMutationPreview",
  "GitConnectionMutationAudit",
  "ProjectGitRepositoryAutomationGrant",
  "ProjectGitRepositoryAutomationGrantAudit",
  "McpConnectionMutationPreview",
  "McpConnectionMutationAudit",
  "PersonalKnowledgeQaChallenge",
  "PersonalKnowledgeQaAudit",
  "PersonalKnowledgeGraphSuggestion",
  "PersonalKnowledgeExtractionAttempt",
  "PersonalKnowledgeSemanticIndexState",
  "PersonalKnowledgeSemanticGeneration",
  "PersonalKnowledgeSemanticEntry",
  "PersonalKnowledgeSemanticChallenge",
  "PersonalKnowledgeSemanticAudit",
  "PersonalConnectionProbeAttempt",
  "OidcIdentityLinkAttempt",
  "OidcIdentityLinkAudit",
  "McpExportOAuthAuthorizationRequest",
  "McpExportOAuthCode",
  "McpExportOAuthAccessToken",
  "McpExportOAuthAdmissionBudget",
  "McpToolReview",
  "McpToolReviewAudit",
  "Notification",
] as const);

// Only the dedicated Git automation worker polls these relations. Ledger
// relations remain unreadable to the Web runtime and entitlement writer.
export const GIT_AUTOMATION_WORKER_LEDGER_RELATIONS = Object.freeze([
  "ProjectGitRepositoryAutomationScheduleCursor",
  "ProjectGitRepositoryAutomationRun",
  "ProjectGitRepositoryAutomationRunAudit",
  "ProjectGitRepositoryMaterialCursor",
  "ProjectGitRepositoryMaterialRun",
  "ProjectGitRepositoryMaterialRunAudit",
  "ProjectGitRepositoryMaterialConsentAudit",
  "ProjectGitRepositoryMaterialPublicationVersion",
  "ProjectGitRepositoryMaterialPublicationHead",
  "ProjectGitRepositoryMaterialPublicationEntry",
  "ProjectGitRepositoryMaterialSourceVersion",
] as const);

// This is the complete direct SELECT surface currently required by the
// DB-only poller. Git I/O configuration and credential reads stay behind the
// lease-scoped SECURITY DEFINER capability below.
export const GIT_AUTOMATION_WORKER_POLL_COLUMNS = Object.freeze({
  ProjectGitRepositoryAutomationGrant: Object.freeze(["id", "status", "expiresAt", "activatedAt", "runIntervalMinutes", "issuesEnabled", "pullRequestsEnabled", "releasesEnabled"] as const),
  ProjectGitRepositoryAutomationScheduleCursor: Object.freeze(["grantId", "status", "nextRunAt"] as const),
  ProjectGitRepositoryAutomationRun: Object.freeze(["id", "status", "leaseExpiresAt"] as const),
  ProjectGitRepositoryMaterialCursor: Object.freeze(["grantId", "materialKind", "status", "nextRunAt"] as const),
  ProjectGitRepositoryMaterialRun: Object.freeze(["id", "grantId", "materialKind", "status", "leaseExpiresAt"] as const),
} as const);

// These remain unavailable to the worker as direct table reads. In particular,
// ProjectSource content and sealed credentials are exposed only through the
// validated lease-bound function, and no source body is returned by that API.
export const GIT_AUTOMATION_WORKER_CONTEXT_RELATIONS = Object.freeze([
  "GitConnection",
  "ProjectGitRepositoryDelegation",
  "ExternalCredential",
  "ProjectSource",
  "ProjectGitRepositoryPublicationVersion",
  "ProjectGitRepositoryPublicationEntry",
  "ProjectGitRepositoryPublicationHead",
  "ProjectGitRepositoryMaterialPublicationVersion",
  "ProjectGitRepositoryMaterialPublicationEntry",
  "ProjectGitRepositoryMaterialPublicationHead",
  "ProjectGitRepositoryMaterialSourceVersion",
] as const);

export const SIGNUP_GRANT_RELATION = "PlatformTokenGrant" as const;
export const TOKEN_LEDGER_RELATION = "PlatformTokenLedgerEntry" as const;

export const PLATFORM_TOKEN_RUNTIME_FUNCTION = "platform_token_runtime_apply" as const;
export const PLATFORM_TOKEN_GOVERNANCE_FUNCTION = "platform_token_governance_apply" as const;
export const PLATFORM_TOKEN_PREVIEW_FUNCTION = "platform_token_governance_preview" as const;
export const ACCOUNT_ENTITLEMENT_SIGNUP_GRANT_CLOSURE_FUNCTION = "account_entitlement_signup_grant_has_closure" as const;

export const DATABASE_PRINCIPAL_GIT_AUTOMATION_WORKER_DEFINER_FUNCTION_MATRIX = Object.freeze([
  Object.freeze({ name: "project_git_automation_claim_due", identityArguments: "uuid, character varying", reason: "claim one live and due inert Git automation interval" }),
  Object.freeze({ name: "project_git_automation_mutate_lease", identityArguments: "uuid, character varying, uuid, character varying", reason: "fenced Git automation heartbeat or one-way dispatch" }),
  Object.freeze({ name: "project_git_automation_reconcile_expired", identityArguments: "uuid", reason: "terminalize an actually expired Git automation lease" }),
  Object.freeze({ name: "project_git_automation_finalize_result", identityArguments: "uuid, character varying, uuid, character varying, character varying, jsonb", reason: "validate and atomically finalize one fenced automatic Git result" }),
  Object.freeze({ name: "project_git_automation_read_context", identityArguments: "uuid, character varying, uuid", reason: "read only the live dispatched run configuration and shared-head baseline" }),
  Object.freeze({ name: "project_git_material_claim_due", identityArguments: "uuid, public.\"ProjectGitRepositoryMaterialKind\", character varying", reason: "claim one consented and due material import interval" }),
  Object.freeze({ name: "project_git_material_mutate_lease", identityArguments: "uuid, character varying, uuid, character varying", reason: "fenced material import heartbeat or one-way dispatch" }),
  Object.freeze({ name: "project_git_material_reconcile_expired", identityArguments: "uuid", reason: "terminalize an actually expired material lease without replay" }),
  Object.freeze({ name: "project_git_material_finalize_result", identityArguments: "uuid, character varying, uuid, bigint, character varying, character varying, jsonb", reason: "validate and atomically finalize one per-kind material publication" }),
  Object.freeze({ name: "project_git_material_read_context", identityArguments: "uuid, character varying, uuid", reason: "read only the live dispatched material configuration and material-head identity" }),
] as const);

export const DATABASE_PRINCIPAL_PRIVATE_FUNCTION_MATRIX = Object.freeze([
  Object.freeze({ name: "project_git_automation_grant_eligibility", identityArguments: "uuid, uuid, timestamp without time zone", reason: "pure SQL Git automation live-eligibility predicate used only by transition functions" }),
  Object.freeze({ name: "project_git_automation_lock_grant", identityArguments: "uuid", reason: "canonical access and Git advisory lock sequence used only by transition functions" }),
  Object.freeze({ name: "project_git_automation_run_snapshot_matches", identityArguments: "uuid", reason: "immutable run-to-grant snapshot comparison used only by transition functions" }),
  Object.freeze({ name: "project_git_automation_deterministic_uuid", identityArguments: "text", reason: "canonical Git source identities matching the manual publisher" }),
  Object.freeze({ name: "project_git_automation_glob_matches", identityArguments: "text, text", reason: "stored Git soft-exclude semantics used by the finalizer" }),
  Object.freeze({ name: "project_git_automation_path_allowed", identityArguments: "text, jsonb, jsonb", reason: "bounded Git path and grant-scope validation used by the finalizer" }),
  Object.freeze({ name: "project_git_material_run_snapshot_matches", identityArguments: "uuid", reason: "compare material lease snapshots with current consent and delegation" }),
] as const);

export type DatabasePrincipalInvokerFunction = Readonly<{
  name: string;
  identityArguments: string;
  runtime: boolean;
  entitlementWriter: boolean;
  reason: string;
}>;

function invokerFunction(
  name: string,
  identityArguments: string,
  runtime: boolean,
  entitlementWriter: boolean,
  reason: string,
): DatabasePrincipalInvokerFunction {
  return Object.freeze({ name, identityArguments, runtime, entitlementWriter, reason });
}

export type DatabasePrincipalTriggerFunction = Readonly<{
  name: string;
  identityArguments: string;
  runtime: false;
  entitlementWriter: false;
  securityDefiner: boolean;
  reason: string;
}>;

function triggerFunction(
  name: string,
  identityArguments: string,
  reason: string,
  securityDefiner = false,
): DatabasePrincipalTriggerFunction {
  return Object.freeze({ name, identityArguments, runtime: false, entitlementWriter: false, securityDefiner, reason });
}

/**
 * Explicit SECURITY INVOKER helper ACLs required by runtime and entitlement
 * writer trigger paths.  Keep SECURITY DEFINER API functions out of this
 * matrix; their independent ACLs are reconciled below.
 */
export const DATABASE_PRINCIPAL_INVOKER_FUNCTION_MATRIX = Object.freeze([
  // Runtime and entitlement-writer paths share these validation helpers.
  invokerFunction("personal_ai_memory_generation_epoch_valid", "uuid", true, true, "personal AI memory generation validation"),
  invokerFunction("personal_memory_frozen_evidence_valid", "uuid, boolean", true, true, "personal memory frozen evidence validation"),
  invokerFunction("personal_memory_require_final_evidence", "uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid", true, true, "personal memory final evidence validation"),
  invokerFunction("personal_memory_scope_has_stale_evidence", "uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid", true, true, "personal memory stale evidence validation"),
  invokerFunction("project_ai_require_dependent_invalidation", "uuid, uuid, uuid, uuid, uuid, uuid", true, true, "project AI dependent invalidation validation"),
  invokerFunction("personal_memory_frozen_evidence_valid_without_epoch", "uuid, boolean", true, true, "personal memory legacy evidence validation"),
  invokerFunction("workspace_role_check_owner", "uuid", true, true, "workspace enabled-owner invariant validation"),

  // Signup closure is invoked by the entitlement-writer activation path only.
  invokerFunction(ACCOUNT_ENTITLEMENT_SIGNUP_GRANT_CLOSURE_FUNCTION, "uuid", false, true, "signup grant activation closure validation"),

  // Runtime-only invoker helpers.
  invokerFunction("MembershipGovernanceExecution_validate_evidence", "uuid", true, false, "membership governance evidence validation"),
  invokerFunction("assert_ai_candidate_item_consistency", "uuid, uuid", true, false, "AI candidate item consistency validation"),
  invokerFunction("assert_project_item_history_consistency", "uuid, uuid", true, false, "project item history consistency validation"),
  invokerFunction("assert_project_item_revision_evidence", "uuid, uuid, uuid", true, false, "project item revision evidence validation"),
  invokerFunction("assert_project_item_supersession_consistency", "uuid, uuid", true, false, "project item supersession consistency validation"),
  invokerFunction("mcp_tool_attestation_v2_tuple_valid", "\"McpToolAttestation\"", true, false, "MCP tool attestation tuple validation"),
  invokerFunction("mcp_tool_attestation_review_eligible", "\"McpToolAttestation\"", true, false, "MCP attestation immutable-review eligibility validation"),
  invokerFunction("personal_ai_owner_account_access_epoch_valid", "uuid, integer", true, false, "personal AI owner access validation"),
  invokerFunction("personal_git_manual_run_legacy_chain_valid", "\"ProjectGitRepositoryManualRun\"", true, false, "personal Git legacy chain validation"),
  invokerFunction("personal_git_owner_account_access_epoch_valid", "uuid, integer", true, false, "personal Git owner access validation"),
  invokerFunction("personal_mcp_action_epoch_valid", "\"ProjectMcpAction\"", true, false, "personal MCP action access validation"),
  invokerFunction("personal_mcp_action_legacy_chain_valid", "\"ProjectMcpAction\"", true, false, "personal MCP legacy chain validation"),
  invokerFunction("personal_mcp_owner_account_access_epoch_valid", "uuid, integer", true, false, "personal MCP owner access validation"),
  invokerFunction("personal_memory_index_live_evidence_valid", "uuid, boolean", true, false, "personal memory live evidence validation"),
  invokerFunction("project_ai_validate_delegation_evidence", "uuid", true, false, "project AI delegation evidence validation"),
  invokerFunction("project_ai_validate_selection_evidence", "uuid", true, false, "project AI selection evidence validation"),
  invokerFunction("project_git_manual_runtime_manifest", "uuid", true, false, "project Git runtime manifest validation"),
  invokerFunction("project_git_repository_publication_manifest", "uuid", true, false, "shared project Git publication manifest validation"),
  invokerFunction("project_git_automation_grant_invalidate", "uuid, uuid, uuid, character varying", true, false, "project Git automatic grant invalidation helper"),
  invokerFunction("project_git_repository_delegation_validate_evidence", "uuid", true, false, "project Git delegation evidence validation"),
  invokerFunction("project_mcp_action_actor_valid", "uuid, uuid, uuid, timestamp without time zone", true, false, "project MCP action actor validation"),
  invokerFunction("project_mcp_action_evidence_valid", "\"ProjectMcpAction\"", true, false, "project MCP action evidence validation"),
  invokerFunction("project_mcp_action_result_depth", "jsonb", true, false, "project MCP result depth validation"),
  invokerFunction("project_mcp_action_result_nodes", "jsonb", true, false, "project MCP result node validation"),
  invokerFunction("project_mcp_action_snapshot_fingerprint", "\"ProjectMcpAction\"", true, false, "project MCP snapshot validation"),
  invokerFunction("project_mcp_action_source_tuple_valid", "\"ProjectMcpAction\"", true, false, "project MCP source tuple validation"),
  invokerFunction("project_mcp_action_timestamp_token", "timestamp without time zone", true, false, "project MCP timestamp validation"),
  invokerFunction("project_mcp_connection_delegation_validate_evidence", "uuid", true, false, "project MCP connection delegation validation"),
  invokerFunction("project_mcp_tool_grant_v2_create_evidence_valid", "\"ProjectMcpToolGrant\"", true, false, "project MCP grant create evidence validation"),
  invokerFunction("project_mcp_tool_grant_v2_history_valid", "\"ProjectMcpToolGrant\"", true, false, "project MCP grant history validation"),
  invokerFunction("project_mcp_tool_grant_v2_retention_complete", "\"ProjectMcpToolGrant\"", true, false, "project MCP grant retention validation"),
  invokerFunction("project_mcp_tool_grant_v2_revoke_evidence_valid", "\"ProjectMcpToolGrant\"", true, false, "project MCP grant revoke evidence validation"),
  invokerFunction("project_mcp_tool_grant_v2_tuple_valid", "\"ProjectMcpToolGrant\"", true, false, "project MCP grant tuple validation"),
  invokerFunction("project_repository_rag_snapshot_is_current", "uuid, uuid", true, false, "project repository RAG snapshot validation"),
  invokerFunction("repository_rag_snapshot_boundary_is_current", "uuid, uuid, integer, integer, boolean, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text", true, false, "repository RAG boundary validation"),
  invokerFunction("repository_rag_snapshot_is_current", "uuid, uuid, uuid", true, false, "repository RAG scoped snapshot validation"),
  invokerFunction("personal_memory_dispatch_evidence_valid", "uuid, uuid, uuid, uuid, text", true, false, "personal memory dispatch validation"),
  invokerFunction("personal_memory_index_live_evidence_valid_without_epoch", "uuid, boolean", true, false, "personal memory legacy live evidence validation"),
] as const);

/**
 * Trigger functions are invoked by PostgreSQL's trigger manager, never by an
 * application principal. They remain owned by the migrator and receive no
 * EXECUTE privilege for PUBLIC, runtime, or entitlement-writer roles.
 */
export const DATABASE_PRINCIPAL_TRIGGER_FUNCTION_MATRIX = Object.freeze([
  triggerFunction("notification_subject_context_guard", "", "notification subject and intent immutability trigger"),
  triggerFunction("git_connection_governance_security_guard", "", "Git connection security-field governance trigger"),
  triggerFunction("git_connection_configuration_version_guard", "", "Git connection configuration-version trigger"),
  triggerFunction("mcp_connection_configuration_revision_guard", "", "MCP connection configuration-revision trigger"),
  triggerFunction("mcp_connection_governance_security_guard", "", "MCP connection security-field governance trigger"),
  triggerFunction("git_connection_mutation_preview_guard", "", "Git connection mutation-preview trigger"),
  triggerFunction("mcp_connection_mutation_preview_guard", "", "MCP connection mutation-preview trigger"),
  triggerFunction("reject_mcp_export_dispatch_audit_mutation", "", "outbound MCP dispatch audit immutability trigger"),
  triggerFunction("project_mcp_action_result_import_guard", "", "project MCP action result import immutability trigger"),
  triggerFunction("connection_mutation_audit_guard", "", "connection mutation audit trigger"),
  triggerFunction("mcp_tool_review_guard", "", "MCP tool review immutable trigger"),
  triggerFunction("mcp_tool_review_audit_guard", "", "MCP tool review audit immutable trigger"),
  triggerFunction("mcp_tool_review_audit_required", "", "MCP tool review audit completeness trigger"),
  triggerFunction("project_mcp_tool_grant_review_guard", "", "project MCP grant immutable-review eligibility trigger"),
  triggerFunction("project_git_manual_runtime_transition_audit_guard", "", "project Git manual runtime transition audit completeness trigger"),
  triggerFunction("project_git_manual_runtime_audit_guard", "", "project Git manual runtime audit and final-fence trigger"),
  triggerFunction("project_git_manual_runtime_unchanged_shape_guard", "", "project Git unchanged run transition shape trigger"),
  triggerFunction("project_git_manual_runtime_unchanged_audit_guard", "", "project Git unchanged audit evidence trigger"),
  triggerFunction("project_git_manual_runtime_unchanged_guard", "", "project Git unchanged shared publication baseline integrity trigger"),
  triggerFunction("project_git_publication_row_immutable", "", "project Git publication version and entry immutability trigger"),
  triggerFunction("project_git_manual_expected_publication_guard", "", "project Git manual run shared publication cursor guard"),
  triggerFunction("project_git_publication_version_insert_guard", "", "project Git publication predecessor cursor compare trigger"),
  triggerFunction("project_git_publication_head_guard", "", "project Git publication head CAS and source retirement trigger"),
  triggerFunction("project_git_publication_version_required", "", "project Git publication version completeness trigger"),
  triggerFunction("project_git_manual_publication_success_guard", "", "project Git manual publication head completeness trigger"),
  triggerFunction("project_git_automation_grant_global_lock", "", "project Git automatic grant global serialization trigger"),
  triggerFunction("project_git_automation_grant_shape_guard", "", "project Git automatic grant immutable scope and state trigger"),
  triggerFunction("project_git_automation_grant_delete_guard", "", "project Git automatic grant deletion guard"),
  triggerFunction("project_git_automation_grant_audit_entity_guard", "", "project Git automatic grant audit integrity trigger"),
  triggerFunction("project_git_automation_grant_append_audit", "", "project Git automatic grant append-only audit trigger"),
  triggerFunction("project_git_automation_grant_validate_live", "", "project Git automatic grant live entitlement trigger"),
  triggerFunction("project_git_automation_grant_audit_required", "", "project Git automatic grant audit completeness trigger"),
  triggerFunction("project_git_automation_grant_invalidate_base", "", "project Git automatic grant base-delegation invalidation trigger"),
  triggerFunction("project_git_automation_grant_invalidate_connection", "", "project Git automatic grant connection invalidation trigger"),
  triggerFunction("project_git_automation_grant_invalidate_archived_project", "", "project Git automatic grant project-archive invalidation trigger"),
  triggerFunction("project_git_automation_cursor_shape_guard", "", "project Git automatic schedule cursor transition trigger"),
  triggerFunction("project_git_automation_run_shape_guard", "", "project Git automatic run lease transition trigger"),
  triggerFunction("project_git_automation_run_audit_append_only", "", "project Git automatic run audit immutability trigger"),
  triggerFunction("project_git_automation_run_audit_insert_guard", "", "project Git automatic run audit insertion trigger"),
  triggerFunction("project_git_automation_cursor_audit_required", "", "project Git automatic cursor audit completeness trigger"),
  triggerFunction("project_git_automation_run_audit_required", "", "project Git automatic run audit completeness trigger"),
  triggerFunction("project_git_automation_pause_cursor_on_grant_terminal", "", "project Git automatic grant terminal cursor pause trigger", true),
  triggerFunction("project_git_automation_cursor_audit_capture", "", "project Git automation cursor state-derived audit trigger"),
  triggerFunction("project_git_automation_run_audit_capture", "", "project Git automation run state-derived audit trigger"),
  triggerFunction("project_git_automation_pause_cursor_after_unknown", "", "project Git unknown run terminal cursor pause trigger", true),
  triggerFunction("project_git_automation_publication_version_insert_guard", "", "project Git automatic publication run and predecessor guard"),
  triggerFunction("project_git_automation_publication_version_required", "", "project Git automatic publication source and head completeness trigger"),
  triggerFunction("project_git_automation_publication_result_required", "", "project Git automatic terminal outcome integrity trigger"),
  triggerFunction("project_git_material_guard_grant_scope", "", "project Git material consent immutability and GitHub-only scope trigger", true),
  triggerFunction("project_git_material_consent_audit_capture", "", "project Git per-kind consent audit snapshot trigger", true),
  triggerFunction("project_git_material_append_only_guard", "", "project Git material ledger append-only trigger"),
  triggerFunction("project_git_material_cursor_shape_guard", "", "project Git material cursor transition trigger"),
  triggerFunction("project_git_material_run_shape_guard", "", "project Git material lease transition trigger"),
  triggerFunction("project_git_material_cursor_audit_capture", "", "project Git material cursor state-derived audit trigger", true),
  triggerFunction("project_git_material_run_audit_capture", "", "project Git material run state-derived audit trigger", true),
  triggerFunction("project_git_material_initialize_cursors", "", "project Git per-kind cursor initialization trigger", true),
  triggerFunction("project_git_material_pause_on_grant_terminal", "", "project Git material grant terminal fencing trigger", true),
  triggerFunction("project_git_material_pause_cursor_after_unknown", "", "project Git material unknown outcome pause trigger", true),
  triggerFunction("project_git_material_insert_guard", "", "project Git material publication insertion trigger"),
  triggerFunction("project_git_material_head_guard", "", "project Git material publication head CAS trigger"),
  triggerFunction("legacy_mcp_source_reference_guard", "", "legacy MCP source reference defense on Git publication ledgers"),
  triggerFunction("project_git_automation_guard_project_delete", "", "project Git automation archived-project deletion fence", true),
  triggerFunction("project_git_automation_ledger_delete_guard", "", "project Git automation ledger deletion and truncate rejection trigger"),
  triggerFunction("personal_knowledge_document_current_guard", "", "personal knowledge current revision integrity trigger"),
  triggerFunction("personal_knowledge_revision_immutable_guard", "", "personal knowledge immutable revision trigger"),
  triggerFunction("personal_knowledge_audit_immutable_guard", "", "personal knowledge append-only audit trigger"),
  triggerFunction("personal_knowledge_audit_references_guard", "", "personal knowledge audit reference shape trigger"),
  triggerFunction("personal_knowledge_relation_revoke_on_document_delete", "", "personal knowledge relation revocation trigger"),
  triggerFunction("personal_knowledge_graph_suggestion_guard", "", "reviewed personal graph suggestion integrity trigger"),
  triggerFunction("personal_knowledge_extraction_attempt_guard", "", "one-use personal extraction audit trigger"),
  triggerFunction("personal_knowledge_qa_challenge_guard", "", "personal knowledge QA challenge integrity trigger"),
  triggerFunction("personal_knowledge_qa_audit_guard", "", "personal knowledge QA audit settlement trigger"),
  triggerFunction("personal_knowledge_semantic_invalidate_owner", "", "personal semantic document invalidation trigger"),
  triggerFunction("personal_knowledge_semantic_provider_invalidate", "", "personal semantic provider invalidation trigger"),
  triggerFunction("personal_knowledge_semantic_mutation_guard", "", "personal semantic owner integrity trigger"),
  triggerFunction("personal_knowledge_semantic_challenge_immutable_guard", "", "personal semantic challenge integrity trigger"),
  triggerFunction("personal_knowledge_semantic_audit_immutable_guard", "", "personal semantic audit settlement trigger"),
  triggerFunction("personal_connection_probe_updated_at", "", "personal connection probe timestamp trigger"),
  triggerFunction("personal_connection_probe_guard", "", "personal connection probe integrity trigger"),
  triggerFunction("personal_connection_probe_create_guard", "", "personal connection probe create admission trigger"),
  triggerFunction("personal_connection_probe_update_guard", "", "personal connection probe update admission trigger"),
  triggerFunction("oidc_identity_link_attempt_guard", "", "single-use OIDC identity link attempt trigger"),
  triggerFunction("reject_oidc_identity_link_audit_mutation", "", "OIDC identity link audit immutability trigger"),
  triggerFunction("web_source_bearer_credential_guard", "", "authenticated web source credential binding trigger"),
  triggerFunction("web_source_authenticated_configuration_guard", "", "authenticated web source configuration retirement trigger"),
  triggerFunction("web_source_authenticated_lifecycle_guard", "", "authenticated web source identity and URL lifecycle trigger"),
  triggerFunction("external_credential_web_source_guard", "", "bound authenticated web source credential mutation guard"),
  triggerFunction("web_source_pointer_delete_guard", "", "authenticated web source pointer deletion guard"),
  triggerFunction("web_source_review_audit_guard", "", "authenticated web source review audit integrity trigger"),
  triggerFunction("web_source_pointer_review_guard", "", "authenticated web source publication review trigger"),
  triggerFunction("web_source_reviewed_revision_guard", "", "accepted web source revision immutability trigger"),
  triggerFunction("web_source_identity_fence_touch", "", "cross-isolation web source identity concurrency fence"),
  triggerFunction("web_source_bearer_project_source_review_chain_guard", "", "deferred bearer source final-state guard"),
] as const);

export function isKnownDatabasePrincipalRelation(value: string): boolean {
  return (DATABASE_PRINCIPAL_RELATIONS as readonly string[]).includes(value);
}

export function runtimeMutableRelations(): readonly string[] {
  const protectedSet = new Set<string>([
    ...ENTITLEMENT_PROTECTED_RELATIONS,
    ...RUNTIME_ONLY_CONTROL_PLANE_RELATIONS,
    ...GIT_AUTOMATION_WORKER_LEDGER_RELATIONS,
    ...DATABASE_PRINCIPAL_COORDINATION_RELATIONS,
    SIGNUP_GRANT_RELATION,
    "PlatformTokenReservation",
    "PlatformTokenReservationAllocation",
    TOKEN_LEDGER_RELATION,
  ]);
  return Object.freeze(DATABASE_PRINCIPAL_RELATIONS.filter((relation) => !protectedSet.has(relation)));
}
