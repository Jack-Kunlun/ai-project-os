export const PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_ENV = "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL" as const;
export const PRODUCTION_UPGRADE_PREFLIGHT_LEGACY_DATABASE_URL_ENV = "DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL" as const;
export const PRODUCTION_UPGRADE_PREFLIGHT_APPLICATION_NAME = "ai-project-os-production-upgrade-preflight" as const;
export const PRODUCTION_UPGRADE_TARGET_TAG = "v0.3.0-dev.1" as const;
export const PRODUCTION_UPGRADE_TARGET_VERSION = "0.3.0-dev.1" as const;
export const PRODUCTION_UPGRADE_SOURCE_VERSION = "0.2.0-dev.1" as const;
export const PRODUCTION_UPGRADE_PREFLIGHT_CONNECTION_TIMEOUT_MILLIS = 5_000 as const;
export const PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS = 30_000 as const;
export const PRODUCTION_UPGRADE_PREFLIGHT_LOCK_TIMEOUT_MILLIS = 5_000 as const;

export const LEGACY_MIGRATION_MANIFEST = Object.freeze([
  Object.freeze({ name: "20260826021100_init", checksum: "615f559fe14e94d49f5f542e08d98c9a08fc642ae2e344d3ddab5fafd6f4254c" }),
  Object.freeze({ name: "20260826030732_integrity_boundaries", checksum: "a629ee244900080101d66700e542bb1d4f492b3007ee0381446c136e8ec14b22" }),
  Object.freeze({ name: "20260827090000_add_ai_runtime_governance", checksum: "99c0d1f1ec77e2c2ddea3d958144a4c66af94224d49112ad82e15a2af857ed58" }),
  Object.freeze({ name: "20260827120000_add_ai_memory_candidates", checksum: "d4ac14b216a0b9758c33e6a7ddf3bd9a6cda4107e7ab55ab298929eb06d115c7" }),
  Object.freeze({ name: "20260827140000_add_item_evidence_history", checksum: "aafd7217baf8987b06529f79e6e31b2279f5e9833f1112822b23b540fb9eb741" }),
  Object.freeze({ name: "20260828100000_add_source_chunks", checksum: "2a6361f145ee6958498362c96a87064c7dbb1306c28b90554205e1b203157bd9" }),
  Object.freeze({ name: "20260828123000_add_index_generations", checksum: "f97bde68e0f47ee198d68a39aad0a05cb2e6647909ce93469c30672f99fca21c" }),
  Object.freeze({ name: "20260828150000_publish_ai_candidate_items", checksum: "8f3aa8b60070ebe26a84d6538efed815e83fc090d05738819088273d23f4a6b5" }),
  Object.freeze({ name: "20260828170000_add_ai_operation_profiles", checksum: "2492f81c2590faa89d44b79f2e1361b7af03f6e71a80a856f9c1f6967827c7b8" }),
  Object.freeze({ name: "20260828210000_add_project_rag_snapshots", checksum: "e371c84d05620247746b5cdb30eb8d292e47d336c82d344c72cc94f437600003" }),
  Object.freeze({ name: "20260828233000_add_ai_derived_artifacts", checksum: "0f56930fe25c50dbbe90e0066e108cfced3206b2ecb3050d1d50936b21414894" }),
  Object.freeze({ name: "20260829010000_add_github_repository_ledger", checksum: "9f3e56411daa41389728a4d924fa7f2f13daa4fa989377d8eb79de7b4130501b" }),
  Object.freeze({ name: "20260829020000_bind_github_scan_security", checksum: "4f8b7b88491f5ed755757373306f084328e4087d3496d63bc8091ade8984f4b2" }),
  Object.freeze({ name: "20260829033000_add_repository_code_indexes", checksum: "df5ec514624822689459ac359a1ba32d1f0e0113f55b720849fa87b7d8f2272d" }),
  Object.freeze({ name: "20260829050000_add_repository_material_ledger", checksum: "a167a2608b8772a7335d97c74159c5265092521881e79d2f4ec633f116426b61" }),
  Object.freeze({ name: "20260829051000_harden_repository_material_policy", checksum: "1df21da2cffa0eff4d6ad1b1f79d969586d5d75b60fb5b534a2abec59c65d376" }),
  Object.freeze({ name: "20260829052000_seal_repository_material_terminal_rows", checksum: "906e7518e38fa25ee21cd79e5d8cfa87262c9c22432e62156f6efe5068fad43a" }),
  Object.freeze({ name: "20260829053000_add_repository_material_indexes", checksum: "cafeb8fbece555b1972328c42ce0aa3a59d4cde90055a1ee23d0c539e92d7aec" }),
  Object.freeze({ name: "20260829060000_add_repository_rag_snapshots", checksum: "4cd3b77f67c6161fda1c44c9b1f758d71f2b9955264bad46ef915250945c71ee" }),
  Object.freeze({ name: "20260829070000_restore_grant_operation_profile_guard", checksum: "6fe1f66d0d2b024b6e5cc6777de90e37a2561526297c654d09de0b37c52a6227" }),
  Object.freeze({ name: "20260829080000_add_web_control_plane", checksum: "be0e4ece76b1e33e0d60d09756423a5e7dfdc87834037f6f33d6344c012b972a" }),
  Object.freeze({ name: "20260829090000_expand_web_ai_jobs", checksum: "2bade6cf4d519f5aec78aee0a520839cab541d42b90b5ff7c28b1ea9199c2667" }),
  Object.freeze({ name: "20260829100000_add_project_intelligence", checksum: "288db41a0db15ce7ab085197ae8d328f4f2e1655dbd68e947b8af0882c6d32ed" }),
  Object.freeze({ name: "20260829110000_add_project_ai_route_revisions", checksum: "c5dc823b7beea1abd5c78900574984aa7cb912e8948b6f5bc9b0f253f94c332c" }),
  Object.freeze({ name: "20260829120000_add_recoverable_job_attempts", checksum: "cdec15d42bd3424d56d4d4169e675abe843964eafacd75d4fbb8c29534c4df78" }),
  Object.freeze({ name: "20260829130000_add_github_project_sync_job_kind", checksum: "309b0c5ec7c77fe4605b24b7cce1f40827ebd3f0f8d77a49ce1f3c0754933c4a" }),
  Object.freeze({ name: "20260829131000_add_project_github_sync_runs", checksum: "475cada69f5a750d88226e4608bc48aae7c41f07a9b7e53407974e2095764cbe" }),
  Object.freeze({ name: "20260829140000_add_memory_index_build_modes", checksum: "421febefa6d07b0ca88f1e0c0c42aaf8a2f5b3bd9c8bab0a87a979df3d4b5dd8" }),
  Object.freeze({ name: "20260829141000_add_memory_index_candidates", checksum: "ce36e06a2151b14dab80d76ff2750b9d78e0210abb380005f0cbba33aa08ff15" }),
  Object.freeze({ name: "20260829142000_add_background_job_reconciliations", checksum: "471c84b26a1b14bf1053b5abdfc0691f392c170cc69c15e5d587596a4cd76933" }),
  Object.freeze({ name: "20260829150000_add_project_lifecycle_and_export_audits", checksum: "057310970693a9723111f9ebd3dcabb065ad413e2a335bef561bbe3355ac0a16" }),
  Object.freeze({ name: "20260829151000_guard_archived_project_jobs", checksum: "f5093964b84ff9deaf4566ce0a0a11473365fd0e49185397ba18f3f90a8898a4" }),
  Object.freeze({ name: "20260829160000_add_project_assets", checksum: "5feca56a3894e4124767410f029e920cd16e9b901bd5ada6fd085427294b7d9d" }),
  Object.freeze({ name: "20260829170000_add_multi_git_repositories", checksum: "0a99fdf82e8cefc55f5954ccb7c16e10e39b71bd638993f3dfd86696d977e94a" }),
  Object.freeze({ name: "20260829180000_add_automation_worker", checksum: "8a9acd80cca997f7d20a2dd910148df77553dad9abc37c9bb575131680090676" }),
  Object.freeze({ name: "20260829190000_add_memory_quality", checksum: "fdb673e714708f5d57c54e45cba5862603dadbe30a7a17f32ef046b47b883b5e" }),
  Object.freeze({ name: "20260829200000_add_web_sources", checksum: "f1164ba8aa4d5bafc9f35726c3e3f215e971923b2f267ae2f090a4e411731fdc" }),
  Object.freeze({ name: "20260829210000_add_workspaces_rbac_oidc", checksum: "bc2eb6300540cdf67f6d3eccc37d01f1ab27b7066c0152081c25d36085b5d2db" }),
  Object.freeze({ name: "20260829211000_fix_long_path_constraints", checksum: "367a95521485efccdf92c65f8475cda975c493e3ddd94ddad036ce6c1aef8d7d" }),
  Object.freeze({ name: "20260829212000_scope_manual_source_deduplication", checksum: "546e9efd145a289a0247cb0ca7cfeb49aaa4a2bb263c4286a79fac618892fd8e" }),
  Object.freeze({ name: "20260829213000_add_oidc_endpoint_pinning", checksum: "9757178b9af07ac00710d473b49ec2691bc15a13b2a97bbdc47d716f12fec636" }),
  Object.freeze({ name: "20260829214000_align_oidc_discovery_defaults", checksum: "53932c27f069219a6a3b17b1775926772127d57fb81ab1e6a03f43ecf1498988" }),
  Object.freeze({ name: "20260829220000_add_project_action_engine", checksum: "7725f9a3f46fec35960ed2ec7d31be03adb0e1968ad00293c24bd995fcce6a33" }),
  Object.freeze({ name: "20260829230000_add_controlled_mcp_capabilities", checksum: "4598e2e4907a0818d781178852952be3d9f775c6f5d8994d9fbb25ab64f57c45" }),
  Object.freeze({ name: "20260830010000_add_action_result_intake", checksum: "cdb88242f11b834ae09dc50b1679d7bff1f154b60c474c6102580b079e8ff618" }),
  Object.freeze({ name: "20260830020000_add_evidence_driven_project_plan", checksum: "8395fcb093bdefc243e8fcb1c864ef4cefbafb1da31f5ba4323acc711a893b53" }),
  Object.freeze({ name: "20260830030000_add_project_operations_loop", checksum: "5a521071afeee4aeec89475de44c41da675767034283b8e97171523519ea93b7" }),
  Object.freeze({ name: "20260830040000_add_project_world_model", checksum: "eb0122e15e94c7e224265979787052940b54b99a423fbcac5fc4f83753d6d65c" }),
  Object.freeze({ name: "20260830050000_harden_source_provenance_and_mcp_attestation", checksum: "dd028e8b5a760fc10a389c9081c7da04b7eff53f2c5e04cb6abd3f4a1a7cef92" }),
  Object.freeze({ name: "20260831000000_add_worker_runtime_health", checksum: "4f2987d9975fb24aae25a7fec76c2a3f4b0d374ef0742e455bbbc074ddb5b921" }),
  Object.freeze({ name: "20260901000000_add_project_asset_upload_admission", checksum: "d6dc658be27b0f457fafe4d09c21459c1f3bf923d1c66235574a15a04ec54c88" }),
  Object.freeze({ name: "20260901010000_add_safe_project_deletion", checksum: "af7820446ea9e9d067b3cb6ca4b8c9d92748e59ac0393c2606cf24db05b3700e" }),
  Object.freeze({ name: "20260902000000_add_github_oauth_login", checksum: "83d97a52baf5b71d75ba70823f3fcc39ff59413d0d4faf764422437471de7009" }),
  Object.freeze({ name: "20260902010000_add_ai_entitlements_and_provider_scope", checksum: "18bcaa0993f1c22de35d94ac225f54ff8a350914b98138a8de3dea47f5db381b" }),
  Object.freeze({ name: "20260903010000_add_user_system_role_compatibility", checksum: "24ff51d078a0b40e9dd013ed3103c1fd2050ecd081274908b2368679313160eb" }),
  Object.freeze({ name: "20260903020000_add_user_ai_provider_scope", checksum: "ced51495c0d1d8b55e3bea6eb29976f1c5162ff556cffa8f199211a1daab1bd4" }),
  Object.freeze({ name: "20260903030000_add_platform_policies_and_connection_ownership", checksum: "6274b918af069abdb3fcdca976dc50d2999b67c8686cfda2b3e4875eb58306c7" }),
  Object.freeze({ name: "20260904010000_default_new_app_users_to_user", checksum: "933fc05135b5ec5b7d9eab0f7031ee17a48dee0549c0bc2041e84d16a34978cc" }),
  Object.freeze({ name: "20260904020000_add_platform_default_route_control_plane", checksum: "af4eb6352270d369773a6fb7052e09e8783fc569982c947a7beb41267ed4c0da" }),
  Object.freeze({ name: "20260904030000_add_ai_provider_ownership_audit", checksum: "58314b9e3326383ef0e1b37ad7faf47c9b1928d8b42e10f9daa489a29071128c" }),
  Object.freeze({ name: "20260904040000_add_membership_access_governance", checksum: "45d6ac7b85b80ffd4886d5f4be7fa8cfedd574450fb600c364dd55db08929d55" }),
  Object.freeze({ name: "20260904050000_add_membership_governance_manifest_evidence", checksum: "047b72411daae658da7382427fb3c4dac07a547951c3f884bac303df35e7e1aa" }),
  Object.freeze({ name: "20260904060000_add_runtime_ai_route_snapshots", checksum: "4291c08d7e9742354f418b1af753296ef68e903135c33dc695daee99ad725bb3" }),
  Object.freeze({ name: "20260904070000_add_runtime_ai_grant_billing_fences", checksum: "b09044f15eeaa7ced39af70981ad47975ab5fa6de5c5778a7f2c858683662e5e" }),
  Object.freeze({ name: "20260904080000_add_personal_ai_provider_ownership", checksum: "4657d5ce083dcd82caa7b452b5b8ca30521256bd63a7ac7ef38617c89d6f93f9" }),
  Object.freeze({ name: "20260904090000_add_project_ai_provider_delegations", checksum: "663cc73d308fcb28db75188a8bea5cb2ac0f106ab8ae7d0522bd247397947e40" }),
  Object.freeze({ name: "20260904100000_allow_delegation_owner_safety_switch", checksum: "c0d2666c42d1d6a6027daa29dcb858a4c77252e03d307a7ce40f528e567bd84e" }),
  Object.freeze({ name: "20260904110000_add_personal_ai_runtime_evidence", checksum: "580aa5abd4489aa4bc2b13cf97d20a050a569bec0e80658f45f0fa7c530cfc3a" }),
  Object.freeze({ name: "20260904120000_harden_personal_memory_runtime_invalidation", checksum: "71e47d5ad7cb0e6dad9d6344fd26ec8c0ea8f90730aa755a2826207472d2fa50" }),
  Object.freeze({ name: "20260904130000_bind_personal_memory_dispatch_admission", checksum: "b4c2a3813f6aaccf6356195182fdd6a2d38e7de6f2d3515ad8ccae3f374a0617" }),
  Object.freeze({ name: "20260904140000_scope_personal_git_mcp_connections", checksum: "e8896cfc4017717ff9bd000e5979b240e120e232c49cc8fa943339c7b82f24ec" }),
  Object.freeze({ name: "20260904150000_add_project_git_repository_delegations", checksum: "415d64628c2ec1bef763eda12541da53b5da9e6e3c78e8b91238d67cba75443d" }),
  Object.freeze({ name: "20260904160000_add_project_git_manual_runtime", checksum: "38c1e52c8b7d5db489f6d9facf8338fb114ad6fb2706f250a52b5575c0f58b27" }),
  Object.freeze({ name: "20260904170000_add_project_git_manual_run_reconciliation", checksum: "286dbb4802d822947143d4ba28663df737a9f6790b38bfd02041dfbc658ca2a9" }),
  Object.freeze({ name: "20260904180000_add_project_mcp_connection_delegations", checksum: "2e8fa5ba0c8c6511e6c803138354867132c455b72c57a287829b780586b82497" }),
  Object.freeze({ name: "20260904190000_add_mcp_control_plane_v2", checksum: "ccd6d9630e1dd9b13aec7bee3c8973e4f3a3dadd44079c6097d889884f57208a" }),
  Object.freeze({ name: "20260904200000_add_project_mcp_grant_retention_ledger", checksum: "48cbe1fdc0299447f9f4940c3fd45d6c4b367f9f8aae1b15a27f237aa9c8d057" }),
  Object.freeze({ name: "20260904210000_add_project_mcp_action_approval_control_plane", checksum: "a850f9144a19dde5b01da73ddfcaf2d46b2810d5225026dde9036e83098f39e4" }),
  Object.freeze({ name: "20260904220000_add_project_mcp_action_dispatch_runtime", checksum: "a70278fdc5d21270ec24743326aa8b5f87fd1b2191f7716f4a391c320e8e7d69" }),
  Object.freeze({ name: "20260904230000_quarantine_legacy_mcp_sources", checksum: "5dada7daab918307c5be45ba6977aff12b70a6803e83dd5ec42456424c121147" }),
  Object.freeze({ name: "20260905010000_harden_workspace_invitation_governance", checksum: "fca86f082f131d18cb8eda0f1c792571ebf70a166d6bff8f0a354147d5fbcf97" }),
  Object.freeze({ name: "20260905020000_harden_membership_subscription_lifecycle", checksum: "76a1637c09b4b764f9531bc2e140b07d6285f2c5514e24295fe815ed074642f6" }),
  Object.freeze({ name: "20260905030000_harden_account_access_lifecycle", checksum: "6b3b359fe8e737c3c3124f35385f453f959d9555e0036d62c03c499bfa95364c" }),
  Object.freeze({ name: "20260905040000_bind_personal_ai_owner_access_epoch", checksum: "83884c71ff2c67306f0c516e23f3a2e00048e0ac0458d5e4b1e1a419e2d7f004" }),
  Object.freeze({ name: "20260905045000_preserve_personal_ai_audit_on_project_deletion", checksum: "a5109e03d38d1f0c5003dbe6b9fb0525c9b6e304ef11a987663a7347f72320c3" }),
  Object.freeze({ name: "20260905046000_preserve_personal_ai_audit_multi_fk_cascade", checksum: "4e1493f865863417df2d1fa29a7b4fe3b786ae4945d0cf09766feaf44e6146ef" }),
  Object.freeze({ name: "20260905050000_bind_personal_git_owner_access_epoch", checksum: "fe08dea6d355039dbc3c6eba8259a959aa02f56b8e46e520379a0999a2282ac2" }),
  Object.freeze({ name: "20260905060000_bind_personal_mcp_owner_access_epoch", checksum: "83d727c121d46f48d1272512cc644da4f23e7fa1c5c399cc7101d9cc6715be20" }),
  Object.freeze({ name: "20260909010000_add_web_ai_confirmation_challenges", checksum: "7a513a44ff85227e969059572d262127f36b1fc6c6f06eec6047de14b96f699f" }),
  Object.freeze({ name: "20260910005000_fence_clean_slate_transition", checksum: "3a9965c5b6a9081277ed55c8d2a5bace9559c11a8cebdc6b7c142c02c2d2ed5e" }),
  Object.freeze({ name: "20260910010000_clean_slate_ai_provider_model", checksum: "8003f43bac43430f64c7878be40c2c698c0cb06194a43ab45dd0ec49d81afb13" }),
  Object.freeze({ name: "20260910020000_add_platform_provider_probe_budget", checksum: "2fd7f37dae2664653e55ceb45add1759d8aaebafee17fbcf572e87b00e70fe02" }),
  Object.freeze({ name: "20260910030000_add_platform_grant_offer_policy_governance", checksum: "bc949467bffe0b41f7f5c5430fdc97314daac44ed2beb443013abcc9e990afac" }),
  Object.freeze({ name: "20260910040000_add_account_entitlement_activation", checksum: "870f3fd22e0791133959c1cb3f093f672726a084e4d3309fd0953631fc5ebf8e" }),
  Object.freeze({ name: "20260910050000_harden_account_entitlement_database_principals", checksum: "d28ebf9ec8cdd2fba616f4f4a6877b56ccf641fd84c446bcc5bbe89cff5e9040" }),
  Object.freeze({ name: "20260911010000_add_platform_token_governance", checksum: "afa9fede786fe5e8b6f6f65307f459e4641f293e5372e503e23c33cc299c7f30" }),
  Object.freeze({ name: "20260912010000_add_membership_applications", checksum: "fae2e78e909601e2c7fed434650cb131a51592ecd2e15a6eb3b5ae5661d9719d" }),
  Object.freeze({ name: "20260912020000_add_workspace_role_governance", checksum: "b8740a7445c48bc1b80c858259b8d014899a9164f158f7e67024fca1413a3d17" }),
  Object.freeze({ name: "20260912030000_add_connection_governance", checksum: "dadcf934ebb65b87b84b8571bcc27967b6498729890e5227cf77e597ab4b9af0" }),
  Object.freeze({ name: "20260913010000_add_first_admin_onboarding", checksum: "83ee9dd44daf6799dece695435ab63bb6a78015dbbcb7bf4f5d253a8065e728d" }),
  Object.freeze({ name: "20260913020000_add_trustworthy_notification_subjects", checksum: "688266581dc9f07bc54a58185997f0d8c13b6fb0d87d461afcc0116e560b6722" }),
  Object.freeze({ name: "20260914010000_harden_git_manual_final_fence_and_connection_recovery", checksum: "43d2095b7111f4752ad90d1b20858558c134ee19278ef78f0f2338b9daa17b47" }),
] as const);

export const REQUIRED_LEGACY_SCHEMA = Object.freeze({
  relations: Object.freeze([
    "AppUser",
    "AiProviderConnection",
    "ProjectAiProviderDelegation",
    "ProjectAiEffectiveRouteSelection",
    "Workspace",
  ] as const),
  columns: Object.freeze([
    Object.freeze({ relation: "AppUser", column: "id" }),
    Object.freeze({ relation: "AppUser", column: "role" }),
    Object.freeze({ relation: "AiProviderConnection", column: "id" }),
    Object.freeze({ relation: "AiProviderConnection", column: "scope" }),
    Object.freeze({ relation: "AiProviderConnection", column: "ownerUserId" }),
    Object.freeze({ relation: "ProjectAiProviderDelegation", column: "id" }),
    Object.freeze({ relation: "ProjectAiProviderDelegation", column: "projectId" }),
    Object.freeze({ relation: "ProjectAiProviderDelegation", column: "providerConnectionId" }),
    Object.freeze({ relation: "ProjectAiEffectiveRouteSelection", column: "id" }),
    Object.freeze({ relation: "ProjectAiEffectiveRouteSelection", column: "projectId" }),
    Object.freeze({ relation: "ProjectAiEffectiveRouteSelection", column: "delegationId" }),
    Object.freeze({ relation: "Workspace", column: "id" }),
  ] as const),
} as const);

export const CLEAN_SLATE_DATA_GATES = Object.freeze([
  "app_user_member",
  "workspace_provider_or_workspace_id",
  "project_ai_route",
  "project_ai_route_revision",
  "ai_provider_ownership_audit",
] as const);

export type ProductionUpgradePreflightPhase = "pre-stop" | "post-stop";

export type ProductionUpgradePreflightErrorCode =
  | "PRODUCTION_UPGRADE_PREFLIGHT_ARGUMENTS_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_REQUIRED"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_MISMATCH"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_CONNECT_FAILED"
  | "PRODUCTION_UPGRADE_PREFLIGHT_QUERY_FAILED"
  | "PRODUCTION_UPGRADE_PREFLIGHT_RESULT_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_TRANSACTION_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_MIGRATION_LEDGER_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_SCHEMA_INVALID"
  | "PRODUCTION_UPGRADE_PREFLIGHT_DATA_BLOCKED"
  | "PRODUCTION_UPGRADE_PREFLIGHT_CLIENT_BACKENDS_PRESENT"
  | "PRODUCTION_UPGRADE_PREFLIGHT_ROLLBACK_FAILED"
  | "PRODUCTION_UPGRADE_PREFLIGHT_FAILED";

export class ProductionUpgradePreflightError extends Error {
  readonly code: ProductionUpgradePreflightErrorCode;

  constructor(code: ProductionUpgradePreflightErrorCode) {
    super(code);
    this.name = "ProductionUpgradePreflightError";
    this.code = code;
  }
}

export type ProductionUpgradePreflightDatabaseConfig = Readonly<{
  host: "postgres";
  port: 5432;
  user: string;
  password: string;
  database: string;
  application_name: typeof PRODUCTION_UPGRADE_PREFLIGHT_APPLICATION_NAME;
  connectionTimeoutMillis: typeof PRODUCTION_UPGRADE_PREFLIGHT_CONNECTION_TIMEOUT_MILLIS;
  query_timeout: typeof PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS;
  statement_timeout: typeof PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS;
  ssl: false;
}>;

function invalidDatabaseUrl(): never {
  throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_INVALID");
}

function decodeComponent(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return invalidDatabaseUrl();
  }
  if (decoded.length === 0 || /[\u0000-\u001f\u007f]/u.test(decoded)) return invalidDatabaseUrl();
  return decoded;
}

export function parseProductionUpgradePreflightArguments(args: readonly string[]): ProductionUpgradePreflightPhase {
  if (args.length !== 1 || (args[0] !== "pre-stop" && args[0] !== "post-stop")) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_ARGUMENTS_INVALID");
  }
  return args[0];
}

export function parseProductionUpgradePreflightDatabaseUrl(value: string): ProductionUpgradePreflightDatabaseConfig {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\u0000-\u0020\u007f]/u.test(value)
  ) return invalidDatabaseUrl();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidDatabaseUrl();
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || parsed.hostname !== "postgres"
    || parsed.port !== "5432"
    || parsed.pathname.length <= 1
    || parsed.pathname.slice(1).includes("/")
    || parsed.username.length === 0
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) return invalidDatabaseUrl();

  const user = decodeComponent(parsed.username);
  const password = decodeComponent(parsed.password);
  const database = decodeComponent(parsed.pathname.slice(1));
  if (database.includes("/")) return invalidDatabaseUrl();
  return Object.freeze({
    host: "postgres",
    port: 5432,
    user,
    password,
    database,
    application_name: PRODUCTION_UPGRADE_PREFLIGHT_APPLICATION_NAME,
    connectionTimeoutMillis: PRODUCTION_UPGRADE_PREFLIGHT_CONNECTION_TIMEOUT_MILLIS,
    query_timeout: PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS,
    statement_timeout: PRODUCTION_UPGRADE_PREFLIGHT_QUERY_TIMEOUT_MILLIS,
    ssl: false,
  });
}

export function readProductionUpgradePreflightDatabaseConfig(
  env: Readonly<Record<string, string | undefined>>,
): ProductionUpgradePreflightDatabaseConfig {
  const targetValue = env[PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_ENV];
  if (typeof targetValue !== "string" || targetValue.length === 0) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_URL_REQUIRED");
  }
  const target = parseProductionUpgradePreflightDatabaseUrl(targetValue);
  const legacyValue = env[PRODUCTION_UPGRADE_PREFLIGHT_LEGACY_DATABASE_URL_ENV];
  if (typeof legacyValue !== "string" || legacyValue.length === 0) return target;
  const legacy = parseProductionUpgradePreflightDatabaseUrl(legacyValue);
  if (legacy.host !== target.host || legacy.port !== target.port || legacy.database !== target.database) {
    throw new ProductionUpgradePreflightError("PRODUCTION_UPGRADE_PREFLIGHT_DATABASE_MISMATCH");
  }
  return legacy;
}

export function safeProductionUpgradePreflightErrorCode(error: unknown): ProductionUpgradePreflightErrorCode {
  return error instanceof ProductionUpgradePreflightError ? error.code : "PRODUCTION_UPGRADE_PREFLIGHT_FAILED";
}

export function buildProductionUpgradePreflightFailure(error: unknown): { ok: false; error: { code: ProductionUpgradePreflightErrorCode } } {
  return { ok: false, error: { code: safeProductionUpgradePreflightErrorCode(error) } };
}

export type ProductionUpgradePreflightReport = Readonly<{
  ok: true;
  kind: "production-upgrade-preflight";
  phase: ProductionUpgradePreflightPhase;
  targetTag: typeof PRODUCTION_UPGRADE_TARGET_TAG;
  sourceVersion: typeof PRODUCTION_UPGRADE_SOURCE_VERSION;
  checks: Readonly<{
    transaction: "read-only-repeatable-read";
    migrationLedger: "verified";
    legacySchema: "verified";
    cleanSlateData: "clear";
    clientBackends: "clear" | "not-applicable";
    rollback: "verified";
  }>;
}>;

export function buildProductionUpgradePreflightReport(
  phase: ProductionUpgradePreflightPhase,
): ProductionUpgradePreflightReport {
  return Object.freeze({
    ok: true,
    kind: "production-upgrade-preflight",
    phase,
    targetTag: PRODUCTION_UPGRADE_TARGET_TAG,
    sourceVersion: PRODUCTION_UPGRADE_SOURCE_VERSION,
    checks: Object.freeze({
      transaction: "read-only-repeatable-read",
      migrationLedger: "verified",
      legacySchema: "verified",
      cleanSlateData: "clear",
      clientBackends: phase === "post-stop" ? "clear" : "not-applicable",
      rollback: "verified",
    }),
  });
}
