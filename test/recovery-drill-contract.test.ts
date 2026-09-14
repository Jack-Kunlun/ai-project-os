import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local recovery drill is isolated, real-dump based, and cleans only exact resources", async () => {
  const script = await readFile("scripts/recovery-drill-local.ts", "utf8");
  assert.match(script, /pg_dump[\s\S]*--format=custom/u);
  assert.match(script, /pg_restore[\s\S]*--list/u);
  assert.match(script, /pg_restore[\s\S]*--clean[\s\S]*--no-privileges/u);
  const restoreListInvocation = script.slice(script.indexOf("const restoreList"), script.indexOf("if (restoreList.code"));
  assert.doesNotMatch(restoreListInvocation, /--list",\s*"-d"/u);
  assert.match(script, /principal-bootstrap/u);
  assert.match(script, /--source-project/u);
  assert.match(script, /--project-name/u);
  assert.match(script, /isolatedCompose = \["compose", "--env-file", envFile, "--project-name", projectName, "--file", options\.composeFile, "--file", overrideFile\]/u);
  assert.doesNotMatch(script, /isolatedCompose = \[[^\]]*\.\.\.composeArgs/u);
  assert.match(script, /"ps", "--all", "--quiet", service/u);
  assert.match(script, /\.Image\}\}/u);
  assert.doesNotMatch(script, /\.Config\.Image/u);
  assert.match(script, /randomBytes\(16\)/u);
  const imageOverride = script.slice(script.indexOf("await writeFile(overrideFile"), script.indexOf("isolatedCompose ="));
  for (const service of ["principal-bootstrap", "migrate", "reconcile", "app", "worker"]) {
    assert.match(imageOverride, new RegExp(`${service}:[\\s\\S]*image:`, "u"), service);
  }
  assert.match(script, /pause[\s\S]*app[\s\S]*worker/u);
  assert.match(script, /unpause[\s\S]*app[\s\S]*worker/u);
  assert.match(script, /RECOVERY_DRILL_SOURCE_RESUME_FAILED/u);
  assert.match(script, /migrate/u);
  assert.match(script, /reconcile/u);
  assert.match(script, /\/api\/health/u);
  assert.match(script, /migrationCount/u);
  assert.match(script, /securityCounts/u);
  assert.match(script, /masterKey/u);
  assert.match(script, /uploads/u);
  assert.match(script, /const root = "\/volume"/u);
  assert.doesNotMatch(script, /image, "node", "-", "\/volume"/u);
  assert.equal((script.match(/"run", "--interactive"/gu) ?? []).length, 2);
  assert.doesNotMatch(script, /"run", "--rm"/u);
  assert.match(script, /type TrackedHelper =/u);
  assert.match(script, /function registerHelper[\s\S]*randomBytes\(16\)[\s\S]*trackedHelpers\.push/u);
  assert.match(script, /trackHelper[\s\S]*hasOwnership/u);
  assert.match(script, /RECOVERY_DRILL_PURPOSE_LABEL/u);
  assert.match(script, /"--name", helper\.name/u);
  assert.match(script, /"--label", `\$\{RECOVERY_DRILL_ID_LABEL\}=\$\{drillId\}`/u);
  assert.match(script, /function cleanup[\s\S]*trackedHelpers[\s\S]*helper\.id \?\? helper\.name/u);
  assert.match(script, /helperContainerName\(resource\) !== helper\.name/u);
  assert.match(script, /RECOVERY_DRILL_HELPER_CLEANUP_INSPECT_FAILED/u);
  assert.doesNotMatch(script, /runWithInputFile/u);
  assert.match(script, /const DUMP_CONTAINER_PATH = "\/tmp\/ai-project-os-recovery\.dump"/u);
  assert.match(script, /function enumerateProjectContainers[\s\S]*listProjectContainerIds/u);
  assert.match(script, /function composeUpAndTrack[\s\S]*enumerateProjectContainers/u);
  assert.match(script, /function composeServiceFromLabels[\s\S]*composeServices[\s\S]*com\.docker\.compose\.service/u);
  assert.match(script, /docker", \["cp", dumpPath, `\$\{isolatedPostgresContainerId\}:\$\{DUMP_CONTAINER_PATH\}`\]/u);
  const restoreCommands = script.slice(script.indexOf("await requireProcess(\"docker\", [\"cp\""), script.indexOf("const restoredMigrations"));
  assert.equal((restoreCommands.match(/"pg_restore"/gu) ?? []).length, 2);
  assert.match(restoreCommands, /"pg_restore", "--list", DUMP_CONTAINER_PATH/u);
  assert.match(restoreCommands, /"pg_restore", "--clean", "--if-exists", "--no-privileges", "-U", CLUSTER_ADMIN_ROLE, "-d", DATABASE_NAME, DUMP_CONTAINER_PATH/u);
  assert.doesNotMatch(restoreCommands, /--no-owner/u);
  assert.doesNotMatch(restoreCommands, /stdin|runWithInput/u);
  assert.match(script, /function waitForOneShotSuccess[\s\S]*status === "exited"[\s\S]*exitCode === "0"/u);
  assert.match(script, /oneShotFailureCodes[\s\S]*principal-bootstrap[\s\S]*RECOVERY_DRILL_PRINCIPAL_BOOTSTRAP_ONE_SHOT_FAILED/u);
  assert.match(script, /oneShotFailureCodes[\s\S]*migrate:[\s\S]*RECOVERY_DRILL_MIGRATE_ONE_SHOT_FAILED/u);
  assert.match(script, /oneShotFailureCodes[\s\S]*reconcile:[\s\S]*RECOVERY_DRILL_RECONCILE_ONE_SHOT_FAILED/u);
  assert.match(script, /fail\(oneShotFailureCodes\[service\]\)/u);
  assert.doesNotMatch(script, /fail\("RECOVERY_DRILL_ONE_SHOT_FAILED"\)/u);
  assert.match(script, /docker", \["logs", "--tail", ONE_SHOT_LOG_TAIL_LINES, container\]/u);
  assert.match(script, /DATABASE_PRINCIPAL_\[A-Z0-9_\]\+/u);
  assert.match(script, /slice\(0, ONE_SHOT_DIAGNOSTIC_BYTES\)/u);
  const diagnosticSection = script.slice(script.indexOf("function emitPrincipalDiagnostics"), script.indexOf("async function emitOneShotPrincipalDiagnostics"));
  assert.match(diagnosticSection, /process\.stderr\.write\(`diagnostic=\$\{diagnostic\}\\n`\)/u);
  assert.doesNotMatch(diagnosticSection, /write\([^)]*(?:stdout|stderr|logs)/u);
  assert.doesNotMatch(script, /runPostRestoreNormalization|RECOVERY_DRILL_POST_RESTORE_NORMALIZATION_FAILED/u);
  const restoreChainStart = script.indexOf('await requireProcess("docker", ["exec", isolatedPostgresContainerId, "pg_restore", "--clean"');
  const restoreChainEnd = script.indexOf("const completedAt", restoreChainStart);
  assert.ok(restoreChainStart >= 0 && restoreChainEnd > restoreChainStart, "restore chain must be present");
  const restoreChain = script.slice(restoreChainStart, restoreChainEnd);
  const restoreChainMarkers = [
    'await requireProcess("docker", ["exec", isolatedPostgresContainerId, "pg_restore", "--clean"',
    'await composeUpAndTrack(isolatedCompose, isolatedEnvironment, projectName, drillId, ["principal-bootstrap"]',
    'await waitForOneShotSuccess(isolatedCompose, isolatedEnvironment, "principal-bootstrap")',
    'const restoredMigrations = Number(',
    'const restoredCounts = await readSecurityCounts',
    'await composeUpAndTrack(isolatedCompose, isolatedEnvironment, projectName, drillId, ["migrate"]',
    'await waitForOneShotSuccess(isolatedCompose, isolatedEnvironment, "migrate")',
    'await composeUpAndTrack(isolatedCompose, isolatedEnvironment, projectName, drillId, ["reconcile"]',
    'await waitForOneShotSuccess(isolatedCompose, isolatedEnvironment, "reconcile")',
    'await composeUpAndTrack(isolatedCompose, isolatedEnvironment, projectName, drillId, ["app", "worker"]',
  ];
  const restoreChainPositions = restoreChainMarkers.map((marker) => {
    const position = restoreChain.indexOf(marker);
    assert.ok(position >= 0, `missing restore chain marker: ${marker}`);
    return position;
  });
  assert.deepEqual(restoreChainPositions, [...restoreChainPositions].sort((left, right) => left - right));
  assert.equal((restoreChain.match(/waitForOneShotSuccess\(isolatedCompose, isolatedEnvironment, "(?:principal-bootstrap|migrate|reconcile)"\)/gu) ?? []).length, 3);
  assert.match(script, /function verifyMasterKeyVolume[\s\S]*credentialCount > 0/u);
  assert.match(script, /source\.masterKey\.present !== target\.masterKey\.present/u);
  assert.match(script, /!source\.masterKey\.secure \|\| !target\.masterKey\.secure/u);
  assert.match(script, /sourceCounts\.credentials/u);
  assert.match(script, /finally/u);
  assert.match(script, /docker", \["volume", "rm", owned\.name\]/u);
  assert.match(script, /function preflightProjectResources/u);
  assert.match(script, /function reserveVolume/u);
  assert.match(script, /function reserveNetwork/u);
  assert.match(script, /RECOVERY_DRILL_ID_LABEL/u);
  assert.match(script, /function enumerateProjectContainers/u);
  assert.match(script, /function trackComposeNetwork/u);
  assert.doesNotMatch(script, /--remove-orphans/u);
  assert.doesNotMatch(script, /compose-down/u);
  assert.doesNotMatch(script, /docker (?:system|volume|image) prune/u);
  assert.doesNotMatch(script, /down[\s\S]*--volumes/u);
  assert.match(script, /--no-publish/u);
  assert.match(script, /RECOVERY_DRILL_CLEANUP_FAILED/u);
  assert.doesNotMatch(script, /sourceBackup|archiveSha256/u);
  assert.match(script, /function missingDockerResource[\s\S]*no such \(\?:object\|container\|volume\|network\)/u);
  assert.match(script, /primaryFailureCode/u);
  assert.match(script, /cleanupFailureCode/u);
  assert.match(script, /primary=\$\{primaryFailureCode/u);
  assert.match(script, /cleanup=\$\{cleanupFailureCode/u);
  assert.match(script, /cleanupFailureCode \?\?=/u);
  assert.match(script, /finalPrimaryFailureCode = primaryFailureCode \?\? "RECOVERY_DRILL_CLEANUP_ONLY"/u);
  assert.match(script, /cleanupErrorCode: cleanupErrorCode/u);
  assert.match(script, /failedEvidence[\s\S]*cleanupFailureCode\)/u);
  assert.match(script, /const DOCKER_CLIENT_ENV_KEYS/u);
  assert.match(script, /const sourceEnvironment = sourceComposeEnvironment\(process\.env\)/u);
  assert.match(script, /const isolatedEnvironment: NodeJS\.ProcessEnv = \{[\s\S]*\.\.\.dockerEnvironment/u);
  assert.doesNotMatch(script, /const isolatedEnvironment: NodeJS\.ProcessEnv = \{[\s\S]*\.\.\.sourceEnvironment/u);
  assert.match(script, /const MAX_VOLUME_MANIFEST_ENTRIES/u);
  assert.match(script, /const MAX_VOLUME_MANIFEST_PATH_BYTES/u);
  assert.match(script, /const MAX_VOLUME_MANIFEST_METADATA_BYTES/u);
  assert.match(script, /optionalResourceString[\s\S]*CreatedAt/u);
  assert.match(script, /optionalResourceString[\s\S]*Mountpoint/u);
  assert.match(script, /createdAt[\s\S]*created[\s\S]*mountpoint/u);
  assert.match(script, /fs\.opendir\(absolute\)[\s\S]*for await \(const child of directory\)/u);
  assert.match(script, /fs\.opendir\(root\)[\s\S]*for await \(const child of rootDirectory\)/u);
  assert.match(script, /const volumeCopyScript[\s\S]*fs\.opendir\(from\)[\s\S]*for await \(const child of directory\)/u);
  const copyScript = script.slice(script.indexOf("const volumeCopyScript"), script.indexOf("async function copyVolume"));
  assert.match(copyScript, /sourceMetadata[\s\S]*targetMetadata[\s\S]*fs\.opendir\(source\)[\s\S]*for await \(const child of sourceDirectory\) await copy\(child\.name\)/u);
  assert.doesNotMatch(copyScript, /copy\(""\)/u);
  assert.doesNotMatch(script, /fs\.readdir/u);
  assert.match(script, /checkEntryPath[\s\S]*entryCount \+= 1[\s\S]*MAX_ENTRIES/u);
  assert.match(script, /checkEntryPath[\s\S]*MAX_PATH_BYTES/u);
  assert.match(script, /trackedVolumes\.push\(provisional\)/u);
  assert.match(script, /onCreated\(provisional\)/u);
  const volumeReservation = script.slice(script.indexOf("async function reserveVolume"), script.indexOf("async function reserveNetwork"));
  assert.ok(volumeReservation.indexOf("trackedVolumes.push(provisional)") < volumeReservation.indexOf('await requireProcess("docker", ["volume", "create"'));
  const networkReservation = script.slice(script.indexOf("async function reserveNetwork"), script.indexOf("async function trackComposeNetwork"));
  assert.ok(networkReservation.indexOf("onCreated(provisional)") < networkReservation.indexOf('await requireProcess("docker", ['));
  assert.match(script, /fingerprint !== null && fingerprint !== owned\.fingerprint/u);
  assert.match(script, /function acquireSourceLock[\s\S]*mkdir\(lockPath[\s\S]*EEXIST[\s\S]*RECOVERY_DRILL_SOURCE_BUSY/u);
  assert.match(script, /function releaseSourceLock[\s\S]*metadata\.dev !== lock\.dev[\s\S]*metadata\.ino !== lock\.ino[\s\S]*rmdir\(lock\.path\)/u);
  assert.doesNotMatch(script, /rm\(lock\.path[\s\S]*recursive/u);
  assert.match(script, /const SOURCE_LOCK_ROOT = "\/tmp\//u);
  assert.match(script, /sourceLock = await acquireSourceLock\(options\.sourceProject\)/u);
  assert.match(script, /sourceLock[\s\S]*releaseSourceLock\(sourceLock\)/u);
  assert.match(script, /RECOVERY_DRILL_SOURCE_LOCK_RELEASE_FAILED/u);
  assert.match(script, /process\.on\("SIGINT", requestInterruption\)/u);
  assert.match(script, /process\.on\("SIGTERM", requestInterruption\)/u);
  assert.match(script, /process\.off\("SIGINT", requestInterruption\)/u);
  assert.match(script, /process\.off\("SIGTERM", requestInterruption\)/u);
  assert.match(script, /let activeChild: ChildProcess \| null = null/u);
  assert.match(script, /let activeStreamAbort: AbortController \| null = null/u);
  assert.match(script, /function terminateChild[\s\S]*SIGTERM[\s\S]*SIGKILL/u);
  assert.match(script, /function requestInterruption[\s\S]*activeStreamAbort\?\.abort\(\)/u);
  assert.match(script, /RECOVERY_DRILL_INTERRUPTED/u);
  assert.match(script, /const SUBPROCESS_TIMEOUT_MS =/u);
  assert.match(script, /setTimeout\([\s\S]*SUBPROCESS_TIMEOUT_MS/u);
  assert.match(script, /const MAX_DATABASE_DUMP_BYTES =/u);
  assert.match(script, /function sha256File[\s\S]*AbortController[\s\S]*createReadStream\(filePath, \{ highWaterMark: 1024 \* 1024, signal: abortController\.signal \}\)[\s\S]*interruptRequested[\s\S]*MAX_DATABASE_DUMP_BYTES[\s\S]*RECOVERY_DRILL_PG_DUMP_HASH_TIMEOUT/u);
  assert.match(script, /cleanupInProgress = true/u);
  assert.match(script, /function sourceVolumeMountName[\s\S]*Mounts[\s\S]*function sourceDataVolumes[\s\S]*SOURCE_SECRETS_DESTINATION[\s\S]*SOURCE_UPLOADS_DESTINATION/u);
  assert.match(script, /sourceVolumes = await sourceDataVolumes\(sourceServices\.app\.container, sourceServices\.worker\.container/u);
  assert.doesNotMatch(script, /composeVolumeNames/u);
  assert.doesNotMatch(script, /\[\s*"config"/u);
  assert.match(script, /function requireLocalDockerContext[\s\S]*DOCKER_HOST[\s\S]*context", "inspect[\s\S]*unix:\/\//u);
  assert.match(script, /RECOVERY_DRILL_REMOTE_DOCKER_UNSUPPORTED/u);
  assert.match(script, /sourceWriterPreflight[\s\S]*Running[\s\S]*Paused[\s\S]*false/u);
  assert.match(script, /sourcePaused = true;[\s\S]*pauseSource\(sourceWriters/u);
  assert.match(script, /function resumeSource[\s\S]*readSourceWriterPausedState[\s\S]*\["unpause", \.\.\.pausedIds\]/u);
  assert.match(script, /RECOVERY_DRILL_SOURCE_WRITER_OWNERSHIP_INVALID/u);
  assert.match(script, /command: \[\\"node\\", \\"node_modules\/tsx\/dist\/cli\.mjs\\", \\"scripts\/recovery-drill-worker\.ts\\"\]/u);
  assert.match(script, /createReadStream\(absolute/u);
  assert.doesNotMatch(script, /const entries = \[\]/u);
  assert.doesNotMatch(script, /fs\.readFile\(absolute/u);
  assert.match(script, /verifyCredentialRecovery[\s\S]*--user", "node"/u);
  assert.match(script, /verifyCredentialRecovery[\s\S]*"--env", `EXPECT_MASTER_KEY=\$\{masterKeyPresent \? "1" : "0"\}`/u);
  assert.match(script, /verifyCredentialRecovery[\s\S]*credentialCount: number,[\s\S]*masterKeyPresent: boolean/u);
  assert.match(script, /credentialCount === 0 && !masterKeyPresent/u);
  assert.match(script, /const currentContainers = await listProjectContainerIds[\s\S]*container-untracked/u);
  assert.match(script, /const cleanupContainers = \[\.\.\.trackedContainers\]/u);
  assert.match(script, /tracked === undefined[\s\S]*composeServiceFromLabels[\s\S]*cleanupContainers\.push\(recovered\)/u);
  assert.match(script, /for \(const tracked of cleanupContainers\)/u);
});

test("recovery drill evidence never accepts a host-provided Runbook URL", async () => {
  const [types, reader, docs] = await Promise.all([
    readFile("src/lib/system-operations-types.ts", "utf8"),
    readFile("src/lib/system-operations.ts", "utf8"),
    readFile("docs/recovery-drill.md", "utf8"),
  ]);
  const publicEvidence = types.slice(types.indexOf("export type PublicRecoveryDrill"), types.indexOf("export type PublicBackupRun"));
  assert.doesNotMatch(publicEvidence, /runbookHref/u);
  assert.match(publicEvidence, /sourceArtifact/u);
  assert.match(publicEvidence, /cleanupErrorCode\?: string \| null/u);
  assert.doesNotMatch(publicEvidence, /sourceBackup|archiveSha256/u);
  assert.doesNotMatch(reader.slice(reader.indexOf("const publicRecoveryDrillSchema"), reader.indexOf("type OperationsUser")), /runbookHref/u);
  assert.match(reader, /cleanupErrorCode: z\.string\(\)\.regex\(SAFE_ERROR_CODE_PATTERN\)\.nullable\(\)\.optional\(\)/u);
  assert.match(types, /RECOVERY_DRILL_RUNBOOK_HREF = "/u);
  assert.match(docs, /它不等同生产异地主机恢复/u);
  assert.match(docs, /使用唯一随机回环端口/u);
  assert.doesNotMatch(docs, /PostgreSQL 不发布主机端口/u);
  assert.match(docs, /外部凭据为零[\s\S]*都没有 `master\.key`/u);
  assert.match(docs, /若已有 `master\.key`，即使凭据为零，也会在隔离 worker 中以非 root 用户执行只读可读性检查/u);
  assert.match(docs, /外部数据库写入者/u);
  assert.match(docs, /根拥有者/u);
  assert.match(docs, /`errorCode`[\s\S]*`cleanupErrorCode`/u);
});

test("system operations client presents only sanitized API failures", async () => {
  const client = await readFile("src/app/system/operations/system-operations-client.tsx", "utf8");
  assert.match(client, /safeResponseError/u);
  assert.doesNotMatch(client, /body\.error(?:\?\.)?message|function readError/u);
  assert.match(client, /<dl className="min-w-0 bg-white px-5 py-4 sm:col-span-2"><dt[\s\S]*固定检查[\s\S]*<\/dt><dd[\s\S]*<\/dd><\/dl>/u);
  assert.doesNotMatch(client, /<div className="min-w-0 bg-white px-5 py-4 sm:col-span-2"><dt/u);
});

test("admin backup card requires production recovery evidence before showing ready", async () => {
  const client = await readFile("src/components/admin-overview-client.tsx", "utf8");
  const completeEvidence = client.slice(client.indexOf("const completeEvidence"), client.indexOf("const tone", client.indexOf("const completeEvidence")));
  assert.match(completeEvidence, /environment === "production"/u);
  assert.match(completeEvidence, /scope === "isolated-host"/u);
  assert.match(completeEvidence, /sourceArtifactKind === "production-backup"/u);
});

test("credential recovery check is bounded, read-only, and never emits secret material", async () => {
  const [script, vault] = await Promise.all([
    readFile("scripts/recovery-drill-credential-check.ts", "utf8"),
    readFile("src/lib/credential-vault.ts", "utf8"),
  ]);
  assert.match(script, /take: SAMPLE_SIZE/u);
  assert.match(script, /orderBy: \{ id: "asc" \}/u);
  assert.match(script, /readExistingMasterKey/u);
  assert.match(script, /EXPECT_MASTER_KEY !== "0" && EXPECT_MASTER_KEY !== "1"/u);
  assert.match(script, /EXPECT_MASTER_KEY === "0"[\s\S]*credentials\.length !== 0/u);
  assert.match(script, /EXPECT_MASTER_KEY === "0"[\s\S]*CREDENTIAL_CHECK_ZERO/u);
  assert.match(script, /EXPECT_MASTER_KEY === "0"[\s\S]*return;[\s\S]*const key = await readExistingMasterKey/u);
  assert.match(script, /openSealedSecret/u);
  assert.match(script, /process\.getuid\(\) === 0/u);
  assert.doesNotMatch(script, /console\.log\(|JSON\.stringify|credential\.id/u);
  assert.match(vault, /export async function readExistingMasterKey/u);
});

test("recovery drill uses only the heartbeat-only worker in its isolated target", async () => {
  const worker = await readFile("scripts/recovery-drill-worker.ts", "utf8");
  assert.match(worker, /getDb/u);
  assert.match(worker, /recordWorkerHeartbeat/u);
  assert.match(worker, /getWorkerName/u);
  assert.match(worker, /WORKER_HEARTBEAT_INTERVAL_MS/u);
  assert.doesNotMatch(worker, /automation-worker|runAutomation|runProjectAction|reconcileDatabase|assetParse|deleteProject/iu);
  assert.doesNotMatch(worker, /exec|spawn|fetch|queue/iu);
});
