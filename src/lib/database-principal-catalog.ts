/**
 * The public relation inventory used by the production ACL reconciler.
 *
 * Keep this list explicit.  A new Prisma model must be reviewed and added
 * here before a deployment can grant either application principal access;
 * there are deliberately no ALTER DEFAULT PRIVILEGES shortcuts.
 */
export const DATABASE_PRINCIPAL_RELATIONS = Object.freeze([
  "Project", "ProjectLifecycleRevision", "ProjectDataExportAudit", "ProjectDeletionReceipt",
  "GitHubConnection", "GitHubRepository", "GitConnection", "GitRepository",
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
  "AppUser", "AppUserEmailVerificationAudit", "AccountAccessMutationPreview", "AccountAccessAudit",
  "MembershipSubscription", "MembershipMutationPreview", "MembershipSubscriptionAudit", "PlatformTokenGrant",
  "PlatformTokenReservation", "PlatformTokenLedgerEntry", "AppSession", "Workspace", "WorkspaceMembership",
  "ProjectMembership", "MembershipAccessAudit", "MembershipGovernanceExecution", "MembershipGovernanceApproval",
  "WorkspaceInvitation", "WorkspaceInvitationAudit", "OidcProvider", "OidcIdentity", "OidcLoginAttempt",
  "GitHubIdentity", "GitHubOauthAttempt", "ExternalCredential", "McpConnection", "McpToolDefinition",
  "ProjectMcpToolGrant", "ProjectMcpToolGrantLedger", "ProjectMcpAction", "ProjectMcpActionDispatchAttempt",
  "ProjectMcpActionRuntimeLedger", "ProjectMcpActionDispatchResult", "ProjectMcpActionDecision",
  "ProjectMcpActionLedger", "ProjectMcpConnectionDelegation", "ProjectMcpConnectionDelegationAudit",
  "McpToolAttestation", "McpToolAttestationAudit", "ProjectMcpToolGrantAudit", "AiProviderConnection",
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
  "PlatformGrantOfferPolicy",
  "PlatformGrantOfferPolicyAudit",
  "AccountEntitlementActivation",
  "AccountEntitlementActivationAudit",
  "AccountEntitlementBackfillRun",
  "AccountEntitlementBackfillItem",
  "AccountEntitlementBackfillAudit",
] as const);

export const SIGNUP_GRANT_RELATION = "PlatformTokenGrant" as const;
export const TOKEN_LEDGER_RELATION = "PlatformTokenLedgerEntry" as const;

export function isKnownDatabasePrincipalRelation(value: string): boolean {
  return (DATABASE_PRINCIPAL_RELATIONS as readonly string[]).includes(value);
}

export function runtimeMutableRelations(): readonly string[] {
  const protectedSet = new Set<string>([
    ...ENTITLEMENT_PROTECTED_RELATIONS,
    SIGNUP_GRANT_RELATION,
  ]);
  return Object.freeze(DATABASE_PRINCIPAL_RELATIONS.filter((relation) => !protectedSet.has(relation)));
}
