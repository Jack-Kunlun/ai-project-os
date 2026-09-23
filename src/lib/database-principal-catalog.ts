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
  "ProjectGitRepositoryManualRun", "ProjectGitRepositoryManualRunEntry", "ProjectGitRepositoryManualPointer",
  "ProjectGitRepositoryManualRunAudit", "ProjectGitRepositoryManualRunReconciliation", "GitRepositorySnapshot",
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
  "AppUser", "PlatformBootstrap", "AppUserEmailVerificationAudit", "PersonalKnowledgeDocument", "PersonalKnowledgeRevision", "PersonalKnowledgeAudit", "PersonalKnowledgeIndexPointer", "PersonalKnowledgeRelation", "PersonalKnowledgeQaChallenge", "PersonalKnowledgeQaAudit", "PersonalKnowledgeSemanticIndexState", "PersonalKnowledgeSemanticGeneration", "PersonalKnowledgeSemanticEntry", "PersonalKnowledgeSemanticChallenge", "PersonalKnowledgeSemanticAudit", "PersonalConnectionProbeAttempt", "AccountAccessMutationPreview", "AccountAccessAudit",
  "MembershipSubscription", "MembershipMutationPreview", "MembershipSubscriptionAudit", "PlatformTokenGrant", "PlatformTokenGrantLegacyNullIssuerSnapshot",
  "MembershipApplication", "MembershipApplicationPreview", "MembershipApplicationAudit",
  "PlatformTokenReservation", "PlatformTokenReservationAllocation", "PlatformTokenLedgerEntry",
  "PlatformTokenGrantMutationPreview", "PlatformTokenGrantAudit", "AppSession", "Workspace", "WorkspaceMembership",
  "WorkspaceRoleMutationPreview", "WorkspaceRoleMutationAudit",
  "ProjectMembership", "MembershipAccessAudit", "MembershipGovernanceExecution", "MembershipGovernanceApproval",
  "WorkspaceInvitation", "WorkspaceInvitationAudit", "OidcProvider", "OidcIdentity", "OidcLoginAttempt",
  "GitHubIdentity", "GitHubOauthAttempt", "ExternalCredential", "McpConnection", "McpConnectionMutationPreview", "McpConnectionMutationAudit", "McpToolDefinition",
  "ProjectMcpToolGrant", "ProjectMcpToolGrantLedger", "ProjectMcpAction", "ProjectMcpActionDispatchAttempt",
  "ProjectMcpActionRuntimeLedger", "ProjectMcpActionDispatchResult", "ProjectMcpActionDecision",
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
  "ProjectActionApproval", "ProjectActionAudit", "MemoryQualityIssue", "WebSource", "WebSourceRevision",
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
  "McpConnectionMutationPreview",
  "McpConnectionMutationAudit",
  "PersonalKnowledgeQaChallenge",
  "PersonalKnowledgeQaAudit",
  "PersonalKnowledgeSemanticIndexState",
  "PersonalKnowledgeSemanticGeneration",
  "PersonalKnowledgeSemanticEntry",
  "PersonalKnowledgeSemanticChallenge",
  "PersonalKnowledgeSemanticAudit",
  "PersonalConnectionProbeAttempt",
  "McpToolReview",
  "McpToolReviewAudit",
  "Notification",
] as const);

export const SIGNUP_GRANT_RELATION = "PlatformTokenGrant" as const;
export const TOKEN_LEDGER_RELATION = "PlatformTokenLedgerEntry" as const;

export const PLATFORM_TOKEN_RUNTIME_FUNCTION = "platform_token_runtime_apply" as const;
export const PLATFORM_TOKEN_GOVERNANCE_FUNCTION = "platform_token_governance_apply" as const;
export const PLATFORM_TOKEN_PREVIEW_FUNCTION = "platform_token_governance_preview" as const;
export const ACCOUNT_ENTITLEMENT_SIGNUP_GRANT_CLOSURE_FUNCTION = "account_entitlement_signup_grant_has_closure" as const;

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
  reason: string;
}>;

function triggerFunction(
  name: string,
  identityArguments: string,
  reason: string,
): DatabasePrincipalTriggerFunction {
  return Object.freeze({ name, identityArguments, runtime: false, entitlementWriter: false, reason });
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
 * application principal.  They remain owned by the migrator and receive no
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
  triggerFunction("connection_mutation_audit_guard", "", "connection mutation audit trigger"),
  triggerFunction("mcp_tool_review_guard", "", "MCP tool review immutable trigger"),
  triggerFunction("mcp_tool_review_audit_guard", "", "MCP tool review audit immutable trigger"),
  triggerFunction("mcp_tool_review_audit_required", "", "MCP tool review audit completeness trigger"),
  triggerFunction("project_mcp_tool_grant_review_guard", "", "project MCP grant immutable-review eligibility trigger"),
  triggerFunction("project_git_manual_runtime_transition_audit_guard", "", "project Git manual runtime transition audit completeness trigger"),
  triggerFunction("project_git_manual_runtime_audit_guard", "", "project Git manual runtime audit and final-fence trigger"),
  triggerFunction("personal_knowledge_document_current_guard", "", "personal knowledge current revision integrity trigger"),
  triggerFunction("personal_knowledge_revision_immutable_guard", "", "personal knowledge immutable revision trigger"),
  triggerFunction("personal_knowledge_audit_immutable_guard", "", "personal knowledge append-only audit trigger"),
  triggerFunction("personal_knowledge_audit_references_guard", "", "personal knowledge audit reference shape trigger"),
  triggerFunction("personal_knowledge_relation_revoke_on_document_delete", "", "personal knowledge relation revocation trigger"),
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
] as const);

export function isKnownDatabasePrincipalRelation(value: string): boolean {
  return (DATABASE_PRINCIPAL_RELATIONS as readonly string[]).includes(value);
}

export function runtimeMutableRelations(): readonly string[] {
  const protectedSet = new Set<string>([
    ...ENTITLEMENT_PROTECTED_RELATIONS,
    ...RUNTIME_ONLY_CONTROL_PLANE_RELATIONS,
    SIGNUP_GRANT_RELATION,
    "PlatformTokenReservation",
    "PlatformTokenReservationAllocation",
    TOKEN_LEDGER_RELATION,
  ]);
  return Object.freeze(DATABASE_PRINCIPAL_RELATIONS.filter((relation) => !protectedSet.has(relation)));
}
