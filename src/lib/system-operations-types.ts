export type BackupRunState = "running" | "succeeded" | "failed" | "skipped";
export type BackupRunTrigger = "daily" | "manual" | "pre-deploy";

export const RECOVERY_DRILL_RUNBOOK_HREF = "/admin/operations/backups#recovery-drill" as const;
export const RECOVERY_DRILL_FRESHNESS_THRESHOLD_MS = 7_776_000_000 as const;

export type RecoveryDrillCheckState = "passed" | "failed";
export type RecoveryDrillCheckResults = Readonly<{
  pgRestore: RecoveryDrillCheckState;
  migrationLedger: RecoveryDrillCheckState;
  securityCounts: RecoveryDrillCheckState;
  masterKeyVolume: RecoveryDrillCheckState;
  uploadsManifest: RecoveryDrillCheckState;
  serviceHealth: RecoveryDrillCheckState;
}>;

export type RecoveryDrillSecurityCounts = Readonly<{
  users: number;
  workspaces: number;
  projects: number;
  credentials: number;
  projectAssets: number;
}>;

export type RecoveryDrillSourceArtifact = Readonly<{
  name: string;
  sha256: string;
  kind: "local-consistent-snapshot" | "production-backup";
}>;

export type PublicRecoveryDrill = Readonly<{
  formatVersion: 1;
  drillId: string;
  environment: "local" | "production";
  scope: "isolated-local" | "isolated-host";
  status: "verified" | "failed";
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  sourceArtifact: RecoveryDrillSourceArtifact | null;
  checks: RecoveryDrillCheckResults;
  validationSha256: string | null;
  migrationCount: number;
  securityCounts: RecoveryDrillSecurityCounts;
  errorCode: string | null;
  /** Optional for compatibility with evidence written before cleanup failures were separated. */
  cleanupErrorCode?: string | null;
}>;

export type PublicBackupRun = Readonly<{
  formatVersion: 1;
  runId: string;
  state: BackupRunState;
  trigger: BackupRunTrigger;
  targetTag: string | null;
  startedAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
  backupName: string | null;
  archiveObject: string | null;
  archiveSha256: string | null;
  archiveBytes: number | null;
  retentionRemoved: number;
  verificationAttempts: number;
  errorCode: string | null;
  nextRunAt: string | null;
}>;

export type BackupOperationsSnapshot = Readonly<{
  sourceStatus: "ready" | "not_configured" | "invalid";
  current: PublicBackupRun | null;
  history: readonly PublicBackupRun[];
  recoveryDrillSourceStatus: "ready" | "not_configured" | "invalid";
  recoveryDrill: PublicRecoveryDrill | null;
  schedule: Readonly<{
    localTime: "03:20";
    randomizedDelayMinutes: 20;
    persistent: true;
  }>;
  readAt: string;
}>;
