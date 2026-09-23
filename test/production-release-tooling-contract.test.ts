import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const productionDirectory = path.join(repositoryRoot, "deploy/production");
const updaterPath = path.join(productionDirectory, "ai-project-os-install-release-tooling");
const gatewayPath = path.join(productionDirectory, "ai-project-os-actions-gateway");
const installerPath = path.join(productionDirectory, "install-production-deploy.sh");
const backupArtifactHelperPath = path.join(productionDirectory, "ai_project_os_backup_artifact.py");
const sudoersPath = path.join(productionDirectory, "ai-project-os-deploy.sudoers");
const deploymentDocsPath = path.join(repositoryRoot, "docs/production-deployment.md");

/** Read every release-tooling contract file once so assertions share one snapshot. */
async function readContractFiles() {
  const [updater, gateway, installer, sudoers, deploymentDocs] = await Promise.all([
    readFile(updaterPath, "utf8"),
    readFile(gatewayPath, "utf8"),
    readFile(installerPath, "utf8"),
    readFile(sudoersPath, "utf8"),
    readFile(deploymentDocsPath, "utf8"),
  ]);
  return { updater, gateway, installer, sudoers, deploymentDocs };
}

test("forced-command gateway exposes only the exact release-tooling grammar", async () => {
  const { gateway } = await readContractFiles();

  assert.ok(gateway.includes("^install-release-tooling\\ (v0\\.6\\.[0-9]+(-dev\\.[1-9][0-9]*)?)\\ ([0-9a-f]{40})\\ (CONFIRM_INSTALL_RELEASE_TOOLING_V1)$"));
  assert.match(gateway, /CONFIRM_INSTALL_RELEASE_TOOLING_V1/u);
  assert.match(gateway, /exec sudo -n \/usr\/local\/sbin\/ai-project-os-install-release-tooling/u);
  assert.doesNotMatch(gateway, /\beval\s|bash -c|sh -c/u);

  for (const deniedCommand of [
    "install-release-tooling main " + "a".repeat(40) + " CONFIRM_INSTALL_RELEASE_TOOLING_V1",
    "install-release-tooling v0.7.0 " + "a".repeat(40) + " CONFIRM_INSTALL_RELEASE_TOOLING_V1",
    "install-release-tooling v0.6.0 " + "a".repeat(39) + " CONFIRM_INSTALL_RELEASE_TOOLING_V1",
    "install-release-tooling v0.6.0 " + "a".repeat(40) + " CONFIRM_INSTALL_RELEASE_TOOLING_V1; id",
    "install-release-tooling v0.6.0-dev.0 " + "a".repeat(40) + " CONFIRM_INSTALL_RELEASE_TOOLING_V1",
  ]) {
    const result = spawnSync("bash", [gatewayPath], {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: deniedCommand },
    });
    assert.equal(result.status, 64, deniedCommand);
    assert.match(result.stderr, /AI_PROJECT_OS_DEPLOY_COMMAND_DENIED/u, deniedCommand);
  }
});

test("root updater verifies tag identity, package version, CI, and a separate checkout", async () => {
  const { updater } = await readContractFiles();

  assert.match(updater, /\[\[ \$EUID -eq 0 \]\]/u);
  assert.ok(updater.includes("readonly RELEASE_TAG_PATTERN='^v0\\.6\\.[0-9]+(-dev\\.[1-9][0-9]*)?$'"));
  assert.ok(updater.includes('[[ "$EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]]'));
  assert.match(updater, /CONFIRM_INSTALL_RELEASE_TOOLING_V1/u);
  assert.match(updater, /REPOSITORY_URL=https:\/\/github\.com\/Jack-Kunlun\/ai-project-os\.git/u);
  assert.match(updater, /TOOLING_REPOSITORY_DIR=\/srv\/ai-project-os\/tooling-repository/u);
  assert.match(updater, /stat -c %U:%G/u);
  assert.match(updater, /TOOLING_REPOSITORY_DIR\/\.git/u);
  assert.match(updater, /remote get-url origin/u);
  assert.match(updater, /cat-file -t "refs\/tags\/\$RELEASE_TAG"/u);
  assert.match(updater, /refs\/tags\/\$RELEASE_TAG\^\{\}/u);
  assert.match(updater, /actions\/workflows\/ci\.yml\/runs\?event=push&status=success/u);
  assert.match(updater, /run\.get\("head_branch"\) == tag/u);
  assert.match(updater, /"v\$package_version" == "\$RELEASE_TAG"/u);
  assert.match(updater, /git -C "\$TOOLING_REPOSITORY_DIR" archive --format=tar "\$EXPECTED_REVISION"/u);
  assert.match(updater, /deploy\/production\/ai-project-os-actions-gateway/u);
  assert.match(updater, /scripts\/production-v06-patch-upgrade-preflight\.ts/u);
  assert.match(updater, /scripts\/production-v06-next-upgrade-preflight\.ts/u);
  assert.match(updater, /\[\[ -s "\$candidate_root\/scripts\/production-v06-patch-upgrade-preflight\.ts" \]\]/u);
  assert.doesNotMatch(updater, /\$CANDIDATE_DIR\/scripts\/production-v06-patch-upgrade-preflight\.ts/u);
  assert.doesNotMatch(updater, /package\.json deploy\/production \|/u);
  assert.doesNotMatch(updater, /\/srv\/ai-project-os\/repository/u);
  assert.doesNotMatch(updater, /install-production-deploy\.sh/u);
});

test("updater promotes only the fixed validated control-plane allowlist", async () => {
  const { updater } = await readContractFiles();

  for (const sourceName of [
    "ai-project-os-actions-gateway",
    "ai-project-os-install-release-tooling",
    "ai-project-os-deploy",
    "ai-project-os-v06-deploy",
    "ai-project-os-v06-patch-deploy",
    "ai-project-os-v06-next-deploy",
    "ai-project-os-preserve-deploy",
    "ai-project-os-backup",
    "ai_project_os_backup_artifact.py",
    "ai-project-os-restore",
    "ai-project-os-configure-github-oauth",
    "compose.operations.yaml",
    "ai-project-os-deploy.sudoers",
  ]) {
    assert.match(updater, new RegExp(sourceName.replaceAll(".", "\\."), "u"), sourceName);
  }

  assert.match(updater, /\[\[ -f "\$candidate" && ! -L "\$candidate" && -s "\$candidate" \]\]/u);
  assert.match(updater, /bash -n "\$script"/u);
  assert.match(updater, /visudo -cf "\$SUDOERS"/u);
  assert.match(updater, /stage_install\(\)/u);
  assert.match(updater, /temporary=\$\(mktemp "\$\(dirname "\$destination"\)\/\.release-tooling/u);
  assert.match(updater, /STAGED_FILES\+=\("\$temporary"\)/u);
  assert.ok(
    updater.indexOf('stage_install "$GATEWAY"') < updater.indexOf('mv -f -- "$staged_updater"'),
    "all files must be staged before the first destination changes",
  );
  assert.ok(
    updater.indexOf('mv -f -- "$staged_sudoers"') < updater.indexOf('mv -f -- "$staged_gateway"'),
    "sudoers must be promoted before the gateway that can expose its commands",
  );
  assert.match(updater, /RELEASE_TOOLING_TARGET_DIRECTORY_INVALID/u);
  assert.match(updater, /RELEASE_TOOLING_PRESERVE_CONTRACT_INVALID/u);
  assert.match(updater, /RELEASE_TOOLING_V06_PATCH_DEPLOY_CONTRACT_INVALID/u);
  assert.match(updater, /RELEASE_TOOLING_V06_NEXT_DEPLOY_CONTRACT_INVALID/u);
  assert.match(updater, /production-v06-patch-upgrade-preflight\.ts/u);
  assert.match(updater, /python3 -m py_compile "\$BACKUP_ARTIFACT_HELPER"/u);
  assert.match(updater, /ast\.parse\(open\(sys\.argv\[1\]/u);
  assert.doesNotMatch(updater, /runpy\.run_path/u);
  assert.match(updater, /BACKUP_ARTIFACT_HELPER=\$CANDIDATE_DIR\/ai_project_os_backup_artifact\.py/u);
  assert.match(updater, /\/usr\/local\/libexec\/ai-project-os\/backup-artifact\.py/u);
  assert.match(updater, /RELEASE_TOOLING_BACKUP_HELPER_CONTRACT_INVALID/u);
  assert.match(updater, /pre-deploy-to-v0\\\.6\\\.0-dev\\\.7/u);
  assert.doesNotMatch(updater, /\$\{4-\}|readonly [A-Z_]+=\$\{4|read -r[^\n]*destination|\beval\s/u);
  assert.doesNotMatch(updater, /source "\$/u);
});

test("updater backup helper contract accepts existing and future 0.6 app artifacts", async () => {
  const helper = await readFile(backupArtifactHelperPath, "utf8");
  assert.ok(helper.includes("pre-deploy-to-v0\\.6\\.0-dev\\.(?:6|7|8|9|[1-9][0-9]+)"));
  const result = spawnSync("python3", [
    "-c",
    [
      "import ast, re, sys",
      "tree = ast.parse(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1])",
      "node = next(item for item in tree.body if isinstance(item, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'BACKUP_NAME' for target in item.targets))",
      "pattern = re.compile(ast.literal_eval(node.value.args[0]))",
      "samples = ['20260923T000000Z-pre-deploy-to-v0.6.0-dev.8.Abc123', '20260923T000000Z-pre-deploy-to-v0.6.0-dev.9.Abc123', '20260923T000000Z-pre-deploy-to-v0.6.0-dev.10.Abc123']",
      "raise SystemExit(0 if all(pattern.fullmatch(sample) is not None for sample in samples) else 1)",
    ].join("; "),
    backupArtifactHelperPath,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("one-time installer and sudoers retain a narrow stable bootstrap", async () => {
  const { installer, sudoers } = await readContractFiles();

  assert.match(installer, /ai-project-os-install-release-tooling/u);
  assert.match(installer, /ai-project-os-v06-patch-deploy/u);
  assert.match(installer, /ai-project-os-v06-next-deploy/u);
  assert.match(installer, /bash -n \/usr\/local\/sbin\/ai-project-os-install-release-tooling/u);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-install-release-tooling$/mu);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-v06-deploy$/mu);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-v06-patch-deploy$/mu);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-v06-next-deploy$/mu);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-preserve-deploy$/mu);
  assert.match(sudoers, /^ai-project-os-actions ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/ai-project-os-configure-github-oauth$/mu);
  assert.doesNotMatch(sudoers, /\/bin\/(ba)?sh|\/usr\/bin\/(ba)?sh|\*|ALL=\(ALL/u);
});

test("documentation describes tooling refresh and the controlled 0.6 cutover", async () => {
  const { deploymentDocs } = await readContractFiles();

  assert.match(deploymentDocs, /install-release-tooling/u);
  assert.match(deploymentDocs, /一次/u);
  assert.match(deploymentDocs, /0\.6/u);
  assert.match(deploymentDocs, /(deploy-v06|0\.6 专用)/u);
  assert.match(deploymentDocs, /(迁移|migration)/iu);
});
