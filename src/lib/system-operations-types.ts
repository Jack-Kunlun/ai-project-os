export type BackupRunState = "running" | "succeeded" | "failed" | "skipped";
export type BackupRunTrigger = "daily" | "manual" | "pre-deploy";

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
  schedule: Readonly<{
    localTime: "03:20";
    randomizedDelayMinutes: 20;
    persistent: true;
  }>;
  readAt: string;
}>;
